// Email verification (docs/adr-email-verification.md). Real Postgres; the email provider is mocked.
import bcrypt from 'bcryptjs'
import type { Express } from 'express'
import request from 'supertest'
import { prisma } from '../src/lib/prisma'
import { addressKey } from '../src/auth/emailAddress'
import { claimAddressSlot, markSlotSent, takeEmailChangeAttempt, UNSENT_SLOT_GRACE_MS } from '../src/auth/emailLimits'
import { afterResponse, flushAccountEmails, setTransactionalProviderForTests } from '../src/auth/mailer'
import { AddressChangedError, consumeVerificationToken, issueVerificationToken, TOKEN_TTL_MS } from '../src/auth/verificationTokens'
import { logger } from '../src/lib/logger'
import { EmailMessage, EmailProvider } from '../src/nudges/providers'
import { processNudge } from '../src/nudges/sender'
import { syncThreadNudges } from '../src/nudges/lifecycle'
import { api, bearer, cleanup, registerUser, uniqueUser } from './helpers'
import { makeThread, mockProvider, raceOnTable, senderDeps } from './nudges/fixtures'

const userIds: string[] = []
let sent: EmailMessage[] = []
let provider: EmailProvider & { send: jest.Mock }

beforeEach(() => {
  const m = mockProvider()
  sent = m.sent
  provider = m.provider
  setTransactionalProviderForTests(provider)
})
afterEach(async () => {
  await flushAccountEmails()
  setTransactionalProviderForTests(null)
})
afterAll(async () => {
  await cleanup(userIds)
  await prisma.$disconnect()
})

async function newUser() {
  const u = await registerUser()
  userIds.push(u.id)
  await flushAccountEmails()
  return u
}
const linkFrom = (m: EmailMessage) => {
  const fragment = m.text.match(/\/verify-email#(\S+)/)?.[1] ?? ''
  const p = new URLSearchParams(fragment)
  return { id: p.get('id') ?? '', token: p.get('t') ?? '' }
}
const emailsTo = (to: string) => sent.filter((m) => m.to === to)
/** Make the user's tokens look older, to step past the 60 s resend cooldown. */
const ageTokens = (userId: string, ms: number) =>
  prisma.$executeRaw`UPDATE "email_verification_tokens" SET "createdAt" = "createdAt" - (${ms} * interval '1 millisecond') WHERE "userId" = ${userId}`

describe('tokens', () => {
  async function tokenFor(now: Date) {
    const u = await newUser()
    const t = await prisma.$transaction((tx) => issueVerificationToken(tx, u.id, u.email, now))
    return { u, t }
  }

  it('expire after 24 hours (23:59 works, 24:01 does not)', async () => {
    const now = new Date()
    const a = await tokenFor(now)
    expect(await consumeVerificationToken(prisma, a.t.id, a.t.verifier, new Date(now.getTime() + TOKEN_TTL_MS - 60_000))).toEqual({ ok: true, userId: a.u.id })
    const b = await tokenFor(now)
    expect(await consumeVerificationToken(prisma, b.t.id, b.t.verifier, new Date(now.getTime() + TOKEN_TTL_MS + 60_000))).toEqual({ ok: false, reason: 'expired' })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.u.id } })).emailVerified).toBe(false)
  })

  it('work once, including two concurrent confirmations (exactly one succeeds)', async () => {
    const { u, t } = await tokenFor(new Date())
    // Forced race: all three read the unused token at the same instant.
    const settled = await raceOnTable('email_verification_tokens', [1, 2, 3].map(() => () => consumeVerificationToken(prisma, t.id, t.verifier, new Date())))
    const results = settled.map((r) => (r.status === 'fulfilled' ? r.value : { ok: false }))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await consumeVerificationToken(prisma, t.id, t.verifier, new Date())).toEqual({ ok: false, reason: 'used' })
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ emailVerified: true, emailVerifiedAt: expect.any(Date) })
  })

  it('reject tampering: a changed verifier, another token\'s id, malformed input', async () => {
    const a = await tokenFor(new Date())
    const b = await tokenFor(new Date())
    const flipped = (a.t.verifier[0] === 'A' ? 'B' : 'A') + a.t.verifier.slice(1)
    expect(await consumeVerificationToken(prisma, a.t.id, flipped, new Date())).toEqual({ ok: false, reason: 'mismatch' })
    expect(await consumeVerificationToken(prisma, b.t.id, a.t.verifier, new Date())).toEqual({ ok: false, reason: 'mismatch' })
    expect(await consumeVerificationToken(prisma, 'no-such-id', a.t.verifier, new Date())).toEqual({ ok: false, reason: 'unknown' })
    for (const bad of [undefined, '', a.t.verifier.slice(1), `${a.t.verifier}x`, 123]) {
      expect(await consumeVerificationToken(prisma, a.t.id, bad, new Date())).toEqual({ ok: false, reason: 'malformed' })
    }
    // The real token still works afterwards.
    expect((await consumeVerificationToken(prisma, a.t.id, a.t.verifier, new Date())).ok).toBe(true)
  })

  it('a newer token supersedes the older one', async () => {
    const { u, t: older } = await tokenFor(new Date())
    const newer = await prisma.$transaction((tx) => issueVerificationToken(tx, u.id, u.email, new Date()))
    expect(await consumeVerificationToken(prisma, older.id, older.verifier, new Date())).toEqual({ ok: false, reason: 'superseded' })
    expect((await consumeVerificationToken(prisma, newer.id, newer.verifier, new Date())).ok).toBe(true)
  })

  it('only the hash of the verifier is stored', async () => {
    const { t } = await tokenFor(new Date())
    const row = await prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: t.id } })
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(t.verifier)
  })
})

describe('POST /api/auth/verify-email', () => {
  it('the link in the registration email verifies the address (no login needed)', async () => {
    const u = await newUser()
    const mail = emailsTo(u.email)
    expect(mail).toHaveLength(1)
    expect(mail[0].subject).toBe('Confirm your email for Verdict')
    expect(mail[0].text).toMatch(/\/verify-email#id=/) // token in the fragment, never in a query string
    const res = await api().post('/api/auth/verify-email').send(linkFrom(mail[0]))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ verified: true })
    const me = await api().get('/api/auth/me').set(bearer(u.accessToken))
    expect(me.body).toMatchObject({ emailVerified: true, emailVerifiedAt: expect.any(String) })
  })

  it('every failure gets the same 400 body', async () => {
    const u = await newUser()
    const good = linkFrom(emailsTo(u.email)[0])
    const bodies = []
    for (const attempt of [{ ...good, token: good.token.replace(/.$/, good.token.endsWith('A') ? 'B' : 'A') }, { id: 'nope', token: good.token }, {}, { id: good.id }]) {
      const res = await api().post('/api/auth/verify-email').send(attempt)
      expect(res.status).toBe(400)
      bodies.push(res.body)
    }
    await api().post('/api/auth/verify-email').send(good)
    const reused = await api().post('/api/auth/verify-email').send(good)
    bodies.push(reused.body)
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1)
    expect(bodies[0]).toEqual({ error: 'This link is invalid or has expired.' })
  })
})

describe('no account enumeration', () => {
  it('register: identical status and body for a known and an unknown address; similar timing; the password is hashed on both paths', async () => {
    const known = await newUser()
    const hash = jest.spyOn(bcrypt, 'hash')
    const time = async (email: string) => {
      const started = process.hrtime.bigint()
      const res = await api().post('/api/auth/register').send({ ...uniqueUser(), email })
      return { res, ms: Number(process.hrtime.bigint() - started) / 1e6 }
    }
    const runs: { known: number[]; unknown: number[] } = { known: [], unknown: [] }
    let knownRes, unknownRes
    for (let i = 0; i < 5; i++) {
      const k = await time(known.email.toUpperCase()) // any case, any spacing: the same account
      const n = await time(uniqueUser().email)
      knownRes = k.res
      unknownRes = n.res
      runs.known.push(k.ms)
      runs.unknown.push(n.ms)
    }
    for (const u of await prisma.user.findMany({ where: { email: { startsWith: 't_' } }, select: { id: true } })) userIds.push(u.id)
    expect(hash).toHaveBeenCalledTimes(10)
    hash.mockRestore()
    await flushAccountEmails()
    for (const u of await prisma.user.findMany({ where: { email: { startsWith: 't_' } }, select: { id: true } })) userIds.push(u.id)

    expect(knownRes?.status).toBe(202)
    expect(unknownRes?.status).toBe(202)
    expect(knownRes?.body).toEqual(unknownRes?.body)
    // Headers, values included, apart from the ones that vary per response.
    const stable = (h: Record<string, string> | undefined) =>
      Object.fromEntries(Object.entries(h ?? {}).filter(([k]) => !['date', 'etag'].includes(k) && !k.startsWith('ratelimit')))
    expect(stable(knownRes?.headers)).toEqual(stable(unknownRes?.headers))
    // Timing: before the response both paths do the same work (username check + bcrypt); the email
    // lookup and account creation happen after it. Medians of 5 within a factor of 1.5.
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[2]
    const ratio = median(runs.known) / median(runs.unknown)
    expect(ratio).toBeGreaterThan(1 / 1.5)
    expect(ratio).toBeLessThan(1.5)
    // Nothing changed for the known account; its owner got one notice, not a link.
    expect(await prisma.user.count({ where: { email: known.email } })).toBe(1)
    await flushAccountEmails()
    const notices = emailsTo(known.email).filter((m) => m.idempotencyKey.startsWith('signup-attempt/'))
    expect(notices).toHaveLength(1) // three attempts, one notice per address per hour
  })

  it('register: a taken username is 409 whether or not the email is registered (checked first)', async () => {
    const known = await newUser()
    const withKnownEmail = await api().post('/api/auth/register').send({ ...uniqueUser(), email: known.email, username: known.username })
    const withNewEmail = await api().post('/api/auth/register').send({ ...uniqueUser(), username: known.username })
    expect(withKnownEmail.status).toBe(409)
    expect(withKnownEmail.body).toEqual(withNewEmail.body)
  })

  it('login: an unknown address and a wrong password give the same answer and both run bcrypt', async () => {
    const u = await newUser()
    const compare = jest.spyOn(bcrypt, 'compare')
    const unknown = await api().post('/api/auth/login').send({ email: uniqueUser().email, password: 'password123' })
    const wrong = await api().post('/api/auth/login').send({ email: u.email, password: 'wrong-password' })
    expect(compare).toHaveBeenCalledTimes(2)
    compare.mockRestore()
    expect(unknown.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(unknown.body).toEqual(wrong.body)
  })
})

describe('email normalization', () => {
  it('stores trimmed lower-case addresses; register, login and lookups ignore case and spaces', async () => {
    const u = uniqueUser()
    const res = await api().post('/api/auth/register').send({ ...u, email: `  ${u.email.toUpperCase()} ` })
    expect(res.status).toBe(202)
    await flushAccountEmails()
    const row = await prisma.user.findUniqueOrThrow({ where: { email: u.email } })
    userIds.push(row.id)
    expect(row.email).toBe(u.email)
    const login = await api().post('/api/auth/login').send({ email: ` ${u.email.replace(/^t/, 'T')}`, password: u.password })
    expect(login.status).toBe(200)
  })

  it('the database refuses an address that is not normalized', async () => {
    const u = await newUser()
    await expect(prisma.user.update({ where: { id: u.id }, data: { email: `X${u.email}` } })).rejects.toThrow(/users_email_normalized/)
  })
})

describe('resend', () => {
  const resend = (token: string) => api().post('/api/auth/verification/resend').set(bearer(token))

  it('per user: 60 s cooldown, then one email per address per hour (429 with Retry-After)', async () => {
    const u = await newUser() // registration sent one link
    const first = await resend(u.accessToken)
    expect(first.status).toBe(429)
    expect(Number(first.headers['retry-after'])).toBeGreaterThan(0)
    expect(first.body.error).toMatch(/wait a minute/)

    await ageTokens(u.id, 90_000) // past the cooldown, but the address got an email < 1 h ago
    const second = await resend(u.accessToken)
    expect(second.status).toBe(429)
    expect(second.body.error).toMatch(/recently sent a link/)
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(3000)
    expect(emailsTo(u.email)).toHaveLength(1)
    // A refused resend issues nothing: the link already in the inbox still works.
    expect((await api().post('/api/auth/verify-email').send(linkFrom(emailsTo(u.email)[0]))).status).toBe(200)
  })

  it('works once the address slot is free; the new link supersedes the old one', async () => {
    const u = await newUser()
    const old = linkFrom(emailsTo(u.email)[0])
    await ageTokens(u.id, 90_000)
    await prisma.emailRateEvent.deleteMany({ where: { key: addressKey(u.email) } }) // an hour has passed
    const res = await resend(u.accessToken)
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ sentTo: expect.stringMatching(/^t\*\*\*@example\.com$/) })
    await flushAccountEmails()
    const mails = emailsTo(u.email)
    expect(mails).toHaveLength(2)
    expect((await api().post('/api/auth/verify-email').send(old)).status).toBe(400)
    expect((await api().post('/api/auth/verify-email').send(linkFrom(mails[1]))).status).toBe(200)
    expect((await resend(u.accessToken)).body).toEqual({ alreadyVerified: true })
  })

  it('per user: at most 5 links per hour', async () => {
    const u = await newUser()
    for (let i = 0; i < 4; i++) await prisma.$transaction((tx) => issueVerificationToken(tx, u.id, u.email, new Date()))
    await ageTokens(u.id, 90_000)
    await prisma.emailRateEvent.deleteMany({ where: { key: addressKey(u.email) } })
    const res = await resend(u.accessToken)
    expect(res.status).toBe(429)
    expect(res.body.error).toMatch(/Too many links/)
  })

  it('a send the provider rejects releases the address slot, so the user can retry', async () => {
    const failing = mockProvider({ send: async () => { throw new Error('provider down') } })
    setTransactionalProviderForTests(failing.provider)
    const u = await newUser()
    expect(failing.send).toHaveBeenCalledTimes(1)
    expect(await prisma.emailRateEvent.count({ where: { key: addressKey(u.email) } })).toBe(0)
    setTransactionalProviderForTests(provider)
    await ageTokens(u.id, 90_000)
    expect((await resend(u.accessToken)).status).toBe(202)
  })
})

describe('per-address limit (works without a user)', () => {
  it('one verification email and one sign-up notice per address per hour, keyed by a hash of the address', async () => {
    const address = uniqueUser().email
    const now = new Date()
    const first = await claimAddressSlot(prisma, 'VERIFICATION_EMAIL', address, now)
    expect(first.allowed).toBe(true)
    expect(await claimAddressSlot(prisma, 'VERIFICATION_EMAIL', ` ${address.toUpperCase()}`, now)).toMatchObject({ allowed: false })
    expect((await claimAddressSlot(prisma, 'SIGNUP_ATTEMPT_EMAIL', address, now)).allowed).toBe(true) // separate kind
    expect((await claimAddressSlot(prisma, 'VERIFICATION_EMAIL', address, new Date(now.getTime() + 61 * 60_000))).allowed).toBe(true)
    const rows = await prisma.emailRateEvent.findMany({ where: { key: addressKey(address) } })
    expect(rows.every((r) => r.key !== address && /^[0-9a-f]{64}$/.test(r.key))).toBe(true)
    await prisma.emailRateEvent.deleteMany({ where: { key: addressKey(address) } })
  })

  it('concurrent claims for one address: exactly one wins', async () => {
    const address = uniqueUser().email
    const results = await Promise.all([1, 2, 3, 4].map(() => claimAddressSlot(prisma, 'VERIFICATION_EMAIL', address, new Date())))
    expect(results.filter((r) => r.allowed)).toHaveLength(1)
    await prisma.emailRateEvent.deleteMany({ where: { key: addressKey(address) } })
  })
})

describe('PUT /api/users/me/email', () => {
  const change = (token: string, body: object) => api().put('/api/users/me/email').set(bearer(token)).send(body)

  it('resets verification, supersedes links, emails the new address and notifies the old one', async () => {
    const u = await newUser()
    const oldLink = linkFrom(emailsTo(u.email)[0])
    const next = uniqueUser().email
    const res = await change(u.accessToken, { email: ` ${next.toUpperCase()}`, currentPassword: u.password })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ email: next, emailVerified: false, changed: true })
    await flushAccountEmails()

    const notice = emailsTo(u.email).find((m) => m.idempotencyKey.startsWith('email-changed/'))
    expect(notice?.text).toContain(`changed to ${next[0]}***@example.com`)
    expect(notice?.text).not.toContain(next)
    const link = emailsTo(next)
    expect(link).toHaveLength(1)
    // The link sent to the old address no longer works; the new one does.
    expect((await api().post('/api/auth/verify-email').send(oldLink)).status).toBe(400)
    expect((await api().post('/api/auth/verify-email').send(linkFrom(link[0]))).status).toBe(200)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(next)
  })

  it('a verified user who changes address is unverified again', async () => {
    const u = await newUser()
    await api().post('/api/auth/verify-email').send(linkFrom(emailsTo(u.email)[0]))
    await change(u.accessToken, { email: uniqueUser().email, currentPassword: u.password })
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ emailVerified: false, emailVerifiedAt: null })
  })

  it('a token issued for the old address cannot verify the new one', async () => {
    const u = await newUser()
    const forOld = await prisma.$transaction((tx) => issueVerificationToken(tx, u.id, u.email, new Date()))
    await prisma.user.update({ where: { id: u.id }, data: { email: uniqueUser().email } }) // without superseding
    expect(await consumeVerificationToken(prisma, forOld.id, forOld.verifier, new Date())).toEqual({ ok: false, reason: 'email-changed' })
  })

  it('needs the current password (403), refuses an address in use (409, any case), and a no-op for the same address', async () => {
    const u = await newUser()
    const other = await newUser()
    expect((await change(u.accessToken, { email: uniqueUser().email, currentPassword: 'wrong' })).status).toBe(403)
    const taken = await change(u.accessToken, { email: other.email.toUpperCase(), currentPassword: u.password })
    expect(taken.status).toBe(409)
    const same = await change(u.accessToken, { email: u.email, currentPassword: u.password })
    expect(same.body).toEqual({ email: u.email, emailVerified: false, changed: false })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(u.email)
  })

  it('at most 5 attempts per user per hour, right or wrong password (429 with Retry-After)', async () => {
    const u = await newUser()
    for (let i = 0; i < 5; i++) expect((await change(u.accessToken, { email: uniqueUser().email, currentPassword: 'wrong' })).status).toBe(403)
    const sixth = await change(u.accessToken, { email: uniqueUser().email, currentPassword: u.password })
    expect(sixth.status).toBe(429)
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0)
    expect((await takeEmailChangeAttempt(prisma, u.id, new Date(Date.now() + 61 * 60_000))).allowed).toBe(true)
  })

  it('keeps email-reminder consent (Q4)', async () => {
    const u = await newUser()
    await api().put('/api/users/me/notification-settings').set(bearer(u.accessToken)).send({ emailNudgesEnabled: true })
    await change(u.accessToken, { email: uniqueUser().email, currentPassword: u.password })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).emailNudgesEnabled).toBe(true)
  })
})

describe('transactional emails ignore the nudge rules', () => {
  it('verification email goes to an unverified, opted-out user through a REAL provider with NUDGE_REQUIRE_VERIFIED_EMAIL=true', async () => {
    const real = mockProvider({ real: true })
    setTransactionalProviderForTests(real.provider)
    const prev = process.env.NUDGE_REQUIRE_VERIFIED_EMAIL
    process.env.NUDGE_REQUIRE_VERIFIED_EMAIL = 'true'
    try {
      const u = await newUser() // unverified, email reminders off
      expect(real.sent.map((m) => m.to)).toEqual([u.email])
      expect(real.sent[0].idempotencyKey).toMatch(/^verify\//)
      // The sign-up notice too.
      await api().post('/api/auth/register').send({ ...uniqueUser(), email: u.email })
      await flushAccountEmails()
      expect(real.sent.map((m) => m.idempotencyKey.split('/')[0])).toEqual(['verify', 'signup-attempt'])
    } finally {
      // Assigning undefined would store the string "undefined"; delete instead.
      if (prev === undefined) delete process.env.NUDGE_REQUIRE_VERIFIED_EMAIL
      else process.env.NUDGE_REQUIRE_VERIFIED_EMAIL = prev
    }
  })
})

describe('the verified gate on nudge emails', () => {
  it('real provider: in-app only until the address is verified, then by email', async () => {
    const u = await newUser()
    await prisma.user.update({ where: { id: u.id }, data: { emailNudgesEnabled: true } })
    const real = mockProvider({ real: true })
    const now = new Date()
    const nudgeFor = async () => {
      const thread = await makeThread(u.id, [{ stage: 'INITIAL', at: new Date(now.getTime() - 40 * 86_400_000) }])
      const [id] = await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now))
      await prisma.nudge.update({ where: { id }, data: { sendAt: new Date(now.getTime() - 60_000) } })
      return id
    }
    expect(await processNudge(await nudgeFor(), senderDeps(real.provider, now))).toMatchObject({ kind: 'in-app', reason: 'unverified-email' })
    expect(real.send).not.toHaveBeenCalled()

    await api().post('/api/auth/verify-email').send(linkFrom(emailsTo(u.email)[0]))
    expect((await processNudge(await nudgeFor(), senderDeps(real.provider, new Date(now.getTime() + 86_400_000)))).kind).toBe('sent')
    expect(real.send).toHaveBeenCalledTimes(1)
  })
})

describe('GET /api/auth/dev/verification-link', () => {
  it('returns your newest link from the dry-run outbox in test/development', async () => {
    setTransactionalProviderForTests(null) // the configured dry-run provider
    const u = await newUser()
    const res = await api().get('/api/auth/dev/verification-link').set(bearer(u.accessToken))
    expect(res.status).toBe(200)
    expect(res.body.link).toMatch(/^http:\/\/localhost:5173\/verify-email#id=[^&]+&t=[A-Za-z0-9_-]{43}$/)
  })

  it.each(['production', 'staging', ''])('does not exist when NODE_ENV=%j', async (env) => {
    setTransactionalProviderForTests(null) // the dry-run outbox holds a link, so a 404 can only come from the guard
    const u = await newUser()
    expect((await api().get('/api/auth/dev/verification-link').set(bearer(u.accessToken))).status).toBe(200)
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = env
    try {
      const res = await api().get('/api/auth/dev/verification-link').set(bearer(u.accessToken))
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'Not found' })
    } finally {
      process.env.NODE_ENV = prev
    }
  })
})

describe('per-IP limits on account-email routes', () => {
  let app: Express
  beforeAll(async () => {
    process.env.VERIFY_RATE_LIMIT_MAX = '2'
    jest.resetModules()
    app = (await import('../src/app')).app
  })
  afterAll(() => {
    process.env.VERIFY_RATE_LIMIT_MAX = '10000'
  })

  it.each([
    ['register', (ip: string) => request(app).post('/api/auth/register').set('X-Forwarded-For', ip).send({})],
    ['verify-email', (ip: string) => request(app).post('/api/auth/verify-email').set('X-Forwarded-For', ip).send({})],
  ])('%s: 429 after the limit for one IP; another IP is unaffected', async (_name, hit) => {
    expect((await hit('198.51.100.7')).status).toBe(400)
    expect((await hit('198.51.100.7')).status).toBe(400)
    const limited = await hit('198.51.100.7')
    expect(limited.status).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
    expect((await hit('198.51.100.8')).status).toBe(400)
  })

  it.each([
    ['resend', (token: string, ip: string) => request(app).post('/api/auth/verification/resend').set(bearer(token)).set('X-Forwarded-For', ip)],
    ['email change', (token: string, ip: string) => request(app).put('/api/users/me/email').set(bearer(token)).set('X-Forwarded-For', ip).send({})],
  ])('%s: the per-IP limiter answers the third request from one IP', async (_name, hit) => {
    const u = await newUser()
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`
    await hit(u.accessToken, ip)
    await hit(u.accessToken, ip)
    const limited = await hit(u.accessToken, ip)
    expect(limited.status).toBe(429)
    expect(limited.body).toEqual({ error: 'Too many requests. Please try again later.' })
    expect((await hit(u.accessToken, '203.0.113.99')).body).not.toEqual({ error: 'Too many requests. Please try again later.' })
  })
})

describe('review findings (Sprint 2 full-diff review)', () => {
  it('an address slot whose email was never sent stops counting after a few minutes; a sent one lasts the hour', async () => {
    const address = uniqueUser().email
    const t0 = new Date()
    const unsent = await claimAddressSlot(prisma, 'VERIFICATION_EMAIL', address, t0) // process "dies" here
    expect(unsent.allowed).toBe(true)
    expect((await claimAddressSlot(prisma, 'VERIFICATION_EMAIL', address, new Date(t0.getTime() + 60_000))).allowed).toBe(false)
    const later = new Date(t0.getTime() + UNSENT_SLOT_GRACE_MS + 60_000)
    const again = await claimAddressSlot(prisma, 'VERIFICATION_EMAIL', address, later)
    expect(again.allowed).toBe(true)
    if (again.allowed) await markSlotSent(prisma, again.eventId, later)
    expect((await claimAddressSlot(prisma, 'VERIFICATION_EMAIL', address, new Date(later.getTime() + 30 * 60_000))).allowed).toBe(false)
    await prisma.emailRateEvent.deleteMany({ where: { key: addressKey(address) } })
  })

  it('a delivered email marks its slot sent, so it counts for the whole hour', async () => {
    const u = await newUser()
    const [event] = await prisma.emailRateEvent.findMany({ where: { key: addressKey(u.email) } })
    expect(event.sentAt).toEqual(expect.any(Date))
    const tenMinutesLater = new Date(Date.now() + UNSENT_SLOT_GRACE_MS + 5 * 60_000)
    expect((await claimAddressSlot(prisma, 'VERIFICATION_EMAIL', u.email, tenMinutesLater)).allowed).toBe(false)
  })

  it('a task that throws synchronously (e.g. bad config) is caught, not thrown into the finished request', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger)
    expect(() => afterResponse({ task: 'registration' }, () => { throw new Error('config broke') })).not.toThrow()
    await flushAccountEmails()
    expect(error).toHaveBeenCalledWith('Account email task failed', { task: 'registration', userId: undefined, errorClass: 'Error', error: 'config broke' })
    error.mockRestore()
  })

  it('two concurrent registrations of one new address: one account, one verification email, no slot left behind', async () => {
    const u = uniqueUser()
    const [a, b] = await Promise.all([
      api().post('/api/auth/register').send(u),
      api().post('/api/auth/register').send({ ...uniqueUser(), email: u.email }),
    ])
    expect([a.status, b.status]).toEqual([202, 202])
    await flushAccountEmails()
    const users = await prisma.user.findMany({ where: { email: u.email } })
    userIds.push(...users.map((x) => x.id))
    expect(users).toHaveLength(1)
    expect(emailsTo(u.email).filter((m) => m.idempotencyKey.startsWith('verify/'))).toHaveLength(1)
  })

  it('a token is never issued for an address that is no longer the user\'s (resend racing an email change)', async () => {
    const u = await newUser()
    await prisma.user.update({ where: { id: u.id }, data: { email: uniqueUser().email } })
    await expect(prisma.$transaction((tx) => issueVerificationToken(tx, u.id, u.email, new Date()))).rejects.toBeInstanceOf(AddressChangedError)
  })

  it('verify and email change at the same instant: no deadlock, no 500', async () => {
    for (let i = 0; i < 3; i++) {
      const u = await newUser()
      const link = linkFrom(emailsTo(u.email)[0])
      const settled = await raceOnTable('users', [
        () => api().post('/api/auth/verify-email').send(link),
        () => api().put('/api/users/me/email').set(bearer(u.accessToken)).send({ email: uniqueUser().email, currentPassword: u.password }),
      ])
      const statuses = settled.map((r) => (r.status === 'fulfilled' ? r.value.status : 0))
      expect(statuses).not.toContain(500)
      expect(statuses[1]).toBe(200)
    }
  })

  it('consume and an email-change transaction racing on one user: no deadlock (both lock the user row first)', async () => {
    for (let i = 0; i < 5; i++) {
      const u = await newUser()
      const link = linkFrom(emailsTo(u.email)[0])
      const next = uniqueUser().email
      const settled = await raceOnTable<unknown>('users', [
        () => consumeVerificationToken(prisma, link.id, link.token, new Date()),
        // What PUT /api/users/me/email does in its transaction.
        () =>
          prisma.$transaction(async (tx) => {
            await tx.user.update({ where: { id: u.id }, data: { email: next, emailVerified: false, emailVerifiedAt: null } })
            return issueVerificationToken(tx, u.id, next, new Date())
          }),
      ])
      const errors = settled.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))
      expect(errors).toEqual([])
    }
  })

  it('in dry run outside development/test the verification link is NOT logged', async () => {
    setTransactionalProviderForTests(null) // the configured dry-run provider
    const info = jest.spyOn(logger, 'info')
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'staging'
    try {
      const u = uniqueUser()
      await api().post('/api/auth/register').send(u)
      await flushAccountEmails()
      const row = await prisma.user.findUniqueOrThrow({ where: { email: u.email } })
      userIds.push(row.id)
    } finally {
      process.env.NODE_ENV = prev
    }
    expect(info.mock.calls.some(([msg]) => String(msg).startsWith('Verification link'))).toBe(false)
    expect(info.mock.calls.some(([msg]) => String(msg) === 'Account email sent')).toBe(true)
    info.mockRestore()
  })

  it('in development/test the dry-run link is logged', async () => {
    setTransactionalProviderForTests(null)
    const info = jest.spyOn(logger, 'info')
    await newUser()
    expect(info.mock.calls.some(([msg]) => String(msg).startsWith('Verification link'))).toBe(true)
    info.mockRestore()
  })
})
