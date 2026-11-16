// Registration must not lose the account when the email path fails (Codespace run: BEGIN, INSERT users,
// SELECT ... FOR UPDATE, ROLLBACK, "Account email task failed", after a 202).
import * as tokens from '../src/auth/verificationTokens'
import { prisma } from '../src/lib/prisma'
import { flushAccountEmails, setTransactionalProviderForTests } from '../src/auth/mailer'
import { logger } from '../src/lib/logger'
import { api, bearer, cleanup, registerUser, uniqueUser } from './helpers'
import { mockProvider } from './nudges/fixtures'
import { Prisma } from '@prisma/client'
import { safeErrorMessage } from '../src/lib/safeError'

const userIds: string[] = []
const emails: string[] = [] // addresses this file registered; only their users are cleaned up
afterEach(async () => {
  jest.restoreAllMocks()
  setTransactionalProviderForTests(null)
  const rows = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } })
  userIds.push(...rows.map((r) => r.id))
})
afterAll(async () => {
  await cleanup(userIds)
  await prisma.$disconnect()
})

async function register() {
  const u = uniqueUser()
  emails.push(u.email)
  const res = await api().post('/api/auth/register').send(u)
  await flushAccountEmails()
  return { u, res }
}

describe('register: the account survives a failing email path', () => {
  it('token issuance throws: the 202 is unchanged and the user still exists (unverified, can sign in)', async () => {
    jest.spyOn(tokens, 'issueVerificationToken').mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'updateMany')"))
    const { u, res } = await register()
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ message: 'Check your email, then sign in.' })
    const user = await prisma.user.findUnique({ where: { email: u.email } })
    expect(user).not.toBeNull()
    expect(user?.emailVerified).toBe(false)
    const login = await api().post('/api/auth/login').send({ email: u.email, password: u.password })
    expect(login.status).toBe(200)
    // The banner's Resend works: the failed attempt left no slot and no token behind.
    jest.restoreAllMocks()
    const resend = await api().post('/api/auth/verification/resend').set(bearer(login.body.accessToken))
    expect(resend.status).toBe(202)
  })

  it('the provider throws: the user and the token still exist', async () => {
    const failing = mockProvider({ send: async () => { throw new Error('provider down') } })
    setTransactionalProviderForTests(failing.provider)
    const { u, res } = await register()
    expect(res.status).toBe(202)
    expect(failing.send).toHaveBeenCalledTimes(1)
    const user = await prisma.user.findUniqueOrThrow({ where: { email: u.email } })
    expect(await prisma.emailVerificationToken.count({ where: { userId: user.id, usedAt: null, supersededAt: null } })).toBe(1)
  })
})

describe('email change: the change survives a failing email path', () => {
  it('token issuance throws: the address still changes (unverified), old links are void, the old address is told', async () => {
    const sent = mockProvider()
    setTransactionalProviderForTests(sent.provider)
    const u = await registerUser()
    userIds.push(u.id)
    const before = await prisma.emailVerificationToken.findFirstOrThrow({ where: { userId: u.id } })
    jest.spyOn(tokens, 'issueVerificationToken').mockRejectedValue(new TypeError('token store unavailable'))
    const next = uniqueUser().email
    const res = await api().put('/api/users/me/email').set(bearer(u.accessToken)).send({ email: next, currentPassword: u.password })
    await flushAccountEmails()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ email: next, emailVerified: false, changed: true })
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ email: next, emailVerified: false })
    expect((await prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: before.id } })).supersededAt).not.toBeNull()
    expect(sent.sent.filter((m) => m.to === u.email && m.idempotencyKey.startsWith('email-changed/'))).toHaveLength(1)
  })
})

describe('failure logging', () => {
  it('a failed email task is logged with the user id, task name and error class, and the 202 is unchanged', async () => {
    const error = jest.spyOn(logger, 'error')
    jest.spyOn(tokens, 'issueVerificationToken').mockRejectedValue(new TypeError('boom'))
    const { u, res } = await register()
    expect(res.status).toBe(202)
    const user = await prisma.user.findUniqueOrThrow({ where: { email: u.email } })
    expect(error).toHaveBeenCalledWith('Account email task failed', expect.objectContaining({ task: 'verification-email', userId: user.id, errorClass: 'TypeError', error: 'boom' }))
  })

  it('a provider failure is logged with the user id and error class', async () => {
    const error = jest.spyOn(logger, 'error')
    setTransactionalProviderForTests(mockProvider({ send: async () => { throw new RangeError('provider down') } }).provider)
    const { u } = await register()
    const user = await prisma.user.findUniqueOrThrow({ where: { email: u.email } })
    expect(error).toHaveBeenCalledWith('Account email failed; the user can resend', expect.objectContaining({ kind: 'verification', userId: user.id, errorClass: 'RangeError' }))
  })
})

describe('logs never carry the address, a password hash or a token', () => {
  /** A real PrismaClientValidationError whose message dumps the call's arguments, as with a stale client. */
  async function validationErrorFor(email: string): Promise<Error> {
    const data = { email, tokenHash: 'x', expiresAt: new Date(), userId: 'nope', claimedAt: new Date() } as unknown as Prisma.EmailVerificationTokenUncheckedCreateInput
    try {
      await prisma.emailVerificationToken.create({ data })
    } catch (e) {
      if (e instanceof Error) return e
    }
    throw new Error('expected a validation error')
  }

  it('safeErrorMessage keeps the explanation of a Prisma validation error and drops the dumped arguments', async () => {
    const err = await validationErrorFor('secret.person@example.com')
    expect(err.name).toBe('PrismaClientValidationError')
    expect(err.message).toContain('secret.person@example.com') // what used to be logged
    const safe = safeErrorMessage(err)
    expect(safe).toMatch(/Unknown argument `claimedAt`/)
    expect(safe).not.toContain('secret.person')
  })

  it('redacts addresses, bcrypt hashes and tokens in any other error text', () => {
    const hash = '$2a$12$WCkHyIdzticnuyVuE9TI7ebDTuIPpoHHWEBzavnHVCYVZOPp/GeB6'
    const token = 'A'.repeat(43)
    expect(safeErrorMessage(new Error(`Resend API 403: cannot send to jane.doe@example.com (${hash}, ${token})`))).toBe('Resend API 403: cannot send to [email] ([hash], [token])')
  })

  it('register with a failing token step: the logged meta does not contain the address', async () => {
    const error = jest.spyOn(logger, 'error')
    const u = uniqueUser()
    emails.push(u.email)
    const thrown = await validationErrorFor(u.email)
    jest.spyOn(tokens, 'issueVerificationToken').mockRejectedValue(thrown)
    await api().post('/api/auth/register').send(u)
    await flushAccountEmails()
    const logged = JSON.stringify(error.mock.calls)
    expect(logged).toContain('Unknown argument')
    expect(logged).not.toContain(u.email)
  })

  it('a provider error that quotes the recipient is logged without it', async () => {
    const error = jest.spyOn(logger, 'error')
    setTransactionalProviderForTests(mockProvider({ send: async (m) => { throw new Error(`rejected recipient ${m.to}`) } }).provider)
    const { u } = await register()
    const logged = JSON.stringify(error.mock.calls)
    expect(logged).toContain('rejected recipient [email]')
    expect(logged).not.toContain(u.email)
  })
})
