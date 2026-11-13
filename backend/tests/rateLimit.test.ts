import type { Express } from 'express'
import request from 'supertest'

// Behind a reverse proxy every request reaches Express from the proxy's address and the real client is
// only in X-Forwarded-For. Unless Express is told how many proxy hops to trust, rate limiting keys on the
// proxy's address and all users share one bucket (and express-rate-limit logs
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR). These tests load a fresh app with a small limit.

const PROBE = '/api/auth/me' // counted by the /api limiter; answers 401 without touching the database

async function loadApp(env: Record<string, string | undefined>): Promise<Express> {
  process.env.RATE_LIMIT_MAX = '3'
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  jest.resetModules()
  return (await import('../src/app')).app
}

const hit = (app: Express, forwardedFor: string) => request(app).get(PROBE).set('X-Forwarded-For', forwardedFor)

describe('rate limiting with the default TRUST_PROXY (one proxy hop)', () => {
  let app: Express
  let errorSpy: jest.SpyInstance

  beforeAll(async () => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    app = await loadApp({ TRUST_PROXY: undefined })
  })
  afterAll(() => errorSpy.mockRestore())

  it('counts clients with different X-Forwarded-For addresses in separate buckets', async () => {
    for (let i = 0; i < 3; i++) expect((await hit(app, '203.0.113.10')).status).toBe(401)
    expect((await hit(app, '203.0.113.10')).status).toBe(429) // client A is over its limit...

    expect((await hit(app, '203.0.113.11')).status).toBe(401) // ...but client B has its own bucket
    expect((await hit(app, '203.0.113.12')).status).toBe(401)
  })

  it('does not trigger express-rate-limit\'s unexpected-X-Forwarded-For validation error', async () => {
    await hit(app, '198.51.100.7')
    const logged = errorSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    expect(logged).not.toMatch(/ERR_ERL_UNEXPECTED_X_FORWARDED_FOR/)
  })
})

describe('TRUST_PROXY=0 (no proxy trusted)', () => {
  it('is honored: X-Forwarded-For is ignored, so every client shares the direct peer\'s bucket', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const app = await loadApp({ TRUST_PROXY: '0' })
      for (let i = 0; i < 3; i++) expect((await hit(app, `192.0.2.${i + 1}`)).status).toBe(401)
      expect((await hit(app, '192.0.2.99')).status).toBe(429)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('TRUST_PROXY=true', () => {
  it('is refused at startup rather than letting clients spoof their IP', async () => {
    await expect(loadApp({ TRUST_PROXY: 'true' })).rejects.toThrow(/spoof/)
  })
})
