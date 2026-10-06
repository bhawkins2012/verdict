import { api, bearer, cleanup, registerUser, uniqueUser } from './helpers'
import { prisma } from '../src/lib/prisma'

const createdUserIds: string[] = []

afterAll(async () => {
  await cleanup(createdUserIds)
  await prisma.$disconnect()
})

describe('POST /api/auth/register', () => {
  it('creates a user and returns tokens', async () => {
    const user = uniqueUser()
    const res = await api().post('/api/auth/register').send(user)

    expect(res.status).toBe(201)
    expect(res.body.user).toMatchObject({ email: user.email, username: user.username })
    expect(res.body.accessToken).toEqual(expect.any(String))
    expect(res.body.refreshToken).toEqual(expect.any(String))
    expect(res.body.user.passwordHash).toBeUndefined()
    createdUserIds.push(res.body.user.id)
  })

  it('rejects a duplicate email or username with 409', async () => {
    const existing = await registerUser()
    createdUserIds.push(existing.id)

    const sameEmail = await api().post('/api/auth/register').send({ ...uniqueUser(), email: existing.email })
    const sameUsername = await api().post('/api/auth/register').send({ ...uniqueUser(), username: existing.username })

    expect(sameEmail.status).toBe(409)
    expect(sameUsername.status).toBe(409)
  })

  it.each([
    ['short password', { password: 'short' }],
    ['bad email', { email: 'not-an-email' }],
    ['bad username', { username: 'no spaces!' }],
  ])('rejects %s with 400', async (_name, override) => {
    const res = await api().post('/api/auth/register').send({ ...uniqueUser(), ...override })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials', async () => {
    const user = await registerUser()
    createdUserIds.push(user.id)

    const res = await api().post('/api/auth/login').send({ email: user.email, password: user.password })

    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe(user.email)
    expect(res.body.accessToken).toEqual(expect.any(String))
    expect(res.body.refreshToken).toEqual(expect.any(String))
  })

  it('returns 401 for a wrong password and an unknown email, without crashing the request cycle', async () => {
    const user = await registerUser()
    createdUserIds.push(user.id)

    const wrongPassword = await api().post('/api/auth/login').send({ email: user.email, password: 'wrong-password' })
    const unknownEmail = await api().post('/api/auth/login').send({ email: 'nobody@example.com', password: 'password123' })

    expect(wrongPassword.status).toBe(401)
    expect(unknownEmail.status).toBe(401)
    // Regression: async AppErrors used to become unhandled rejections and kill the process.
    expect((await api().get('/health')).status).toBe(200)
  })
})

describe('GET /api/auth/me', () => {
  it('requires a valid bearer token', async () => {
    const user = await registerUser()
    createdUserIds.push(user.id)

    expect((await api().get('/api/auth/me')).status).toBe(401)
    expect((await api().get('/api/auth/me').set(bearer('garbage'))).status).toBe(401)

    const ok = await api().get('/api/auth/me').set(bearer(user.accessToken))
    expect(ok.status).toBe(200)
    expect(ok.body.email).toBe(user.email)
  })
})

describe('POST /api/auth/refresh', () => {
  it('rotates the refresh token: the new one differs and the old one stops working', async () => {
    const user = await registerUser()
    createdUserIds.push(user.id)

    // Immediately after registration (same second): regression for identical-token rotation.
    const refreshed = await api().post('/api/auth/refresh').send({ refreshToken: user.refreshToken })
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.refreshToken).not.toBe(user.refreshToken)
    expect(refreshed.body.accessToken).toEqual(expect.any(String))

    const reuse = await api().post('/api/auth/refresh').send({ refreshToken: user.refreshToken })
    expect(reuse.status).toBe(401)

    const next = await api().post('/api/auth/refresh').send({ refreshToken: refreshed.body.refreshToken })
    expect(next.status).toBe(200)
  })

  it('allows only one of several concurrent uses of the same refresh token', async () => {
    const user = await registerUser()
    createdUserIds.push(user.id)

    const results = await Promise.all(
      Array.from({ length: 5 }, () => api().post('/api/auth/refresh').send({ refreshToken: user.refreshToken }))
    )
    const statuses = results.map(r => r.status).sort()

    expect(statuses.filter(s => s === 200)).toHaveLength(1)
    expect(statuses.filter(s => s === 401)).toHaveLength(4)
  })

  it('rejects missing, malformed and access tokens', async () => {
    const user = await registerUser()
    createdUserIds.push(user.id)

    expect((await api().post('/api/auth/refresh').send({})).status).toBe(401)
    expect((await api().post('/api/auth/refresh').send({ refreshToken: 'nope' })).status).toBe(401)
    // An access token is signed with a different secret and must not be accepted.
    expect((await api().post('/api/auth/refresh').send({ refreshToken: user.accessToken })).status).toBe(401)
  })
})
