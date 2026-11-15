import { EmailMessage, EmailProviderError, ResendProvider } from '../../src/nudges/providers'
import { loadNudgeConfig } from '../../src/nudges/config'
import { redisConnectionFromUrl, jobIdFor } from '../../src/nudges/queue'

const message: EmailMessage = {
  to: 'u@example.com', from: 'Verdict <r@verdict.test>', subject: 's', text: 't', html: '<p>t</p>',
  headers: { 'List-Unsubscribe': '<http://x>' }, idempotencyKey: 'nudge/n1',
}

function fakeFetch(respond: () => Promise<Response>) {
  return jest.fn((_url: string | URL | Request, _init?: RequestInit) => respond())
}

describe('ResendProvider (fetch mocked; real Resend behaviour is unverified without a key)', () => {
  it('posts the message with auth and the Idempotency-Key header, and returns the id', async () => {
    const f = fakeFetch(async () => new Response(JSON.stringify({ id: 're_123' }), { status: 200 }))
    const r = await new ResendProvider('key_abc', 1000, f as unknown as typeof fetch).send(message)
    expect(r.providerMessageId).toBe('re_123')
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer key_abc')
    expect(headers['Idempotency-Key']).toBe('nudge/n1')
    expect(JSON.parse(String(init?.body))).toMatchObject({ to: ['u@example.com'], subject: 's', headers: message.headers })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([429, 500, 502, 503])('HTTP %i is transient (retryable)', async (status) => {
    const f = fakeFetch(async () => new Response('busy', { status }))
    const err = await new ResendProvider('k', 1000, f as unknown as typeof fetch).send(message).catch((e) => e)
    expect(err).toBeInstanceOf(EmailProviderError)
    expect(err).toMatchObject({ retryable: true, status })
  })

  it.each([400, 401, 403, 404, 422])('HTTP %i is permanent (fails immediately)', async (status) => {
    const f = fakeFetch(async () => new Response('nope', { status }))
    const err = await new ResendProvider('k', 1000, f as unknown as typeof fetch).send(message).catch((e) => e)
    expect(err).toMatchObject({ retryable: false, status })
  })

  it('a network error is transient', async () => {
    const f = fakeFetch(async () => { throw new TypeError('fetch failed') })
    await expect(new ResendProvider('k', 1000, f as unknown as typeof fetch).send(message)).rejects.toMatchObject({ retryable: true })
  })

  it('a timeout (AbortSignal) is transient and actually aborts the request', async () => {
    const f = jest.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')))
      })
    )
    const started = Date.now()
    const err = await new ResendProvider('k', 50, f as unknown as typeof fetch).send(message).catch((e) => e)
    expect(err).toMatchObject({ retryable: true })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a 2xx with an unexpected body is not retried (it may have been sent)', async () => {
    const f = fakeFetch(async () => new Response('{}', { status: 200 }))
    await expect(new ResendProvider('k', 1000, f as unknown as typeof fetch).send(message)).rejects.toMatchObject({ retryable: false })
  })
})

describe('nudge configuration', () => {
  const base = { NODE_ENV: 'test', JWT_SECRET: 'jwt-secret-0123456789-0123456789-xx', JWT_REFRESH_SECRET: 'refresh-0123456789-0123456789-xx' }

  it('defaults: dry-run provider, verified email required, cap 1, 5 attempts', () => {
    expect(loadNudgeConfig(base)).toMatchObject({ provider: 'console', requireVerifiedEmail: true, dailyCap: 1, maxAttempts: 5, enabled: true })
  })

  it('resend without a key, from address or postal address fails fast', () => {
    expect(() => loadNudgeConfig({ ...base, NUDGE_EMAIL_PROVIDER: 'resend' })).toThrow(/RESEND_API_KEY, NUDGE_FROM_EMAIL, NUDGE_POSTAL_ADDRESS/)
  })

  it('production requires UNSUBSCRIBE_SECRET, and it must differ from the JWT secrets', () => {
    expect(() => loadNudgeConfig({ ...base, NODE_ENV: 'production' })).toThrow(/UNSUBSCRIBE_SECRET/)
    expect(() => loadNudgeConfig({ ...base, UNSUBSCRIBE_SECRET: base.JWT_SECRET })).toThrow(/different from the JWT secrets/)
  })

  it('NUDGE_REQUIRE_VERIFIED_EMAIL can be turned off explicitly, and garbage is rejected', () => {
    expect(loadNudgeConfig({ ...base, NUDGE_REQUIRE_VERIFIED_EMAIL: 'false' }).requireVerifiedEmail).toBe(false)
    expect(() => loadNudgeConfig({ ...base, NUDGE_REQUIRE_VERIFIED_EMAIL: 'maybe' })).toThrow()
  })
})

describe('Redis connection from REDIS_URL (regression: password was ignored)', () => {
  it('keeps the password (URL-decoded), username, db index and TLS', () => {
    expect(redisConnectionFromUrl('redis://:s3cr%40t@cache:6380/2')).toEqual({ host: 'cache', port: 6380, password: 's3cr@t', db: 2 })
    expect(redisConnectionFromUrl('rediss://user:pw@host')).toEqual({ host: 'host', port: 6379, username: 'user', password: 'pw', tls: {} })
    expect(redisConnectionFromUrl('redis://localhost:6379')).toEqual({ host: 'localhost', port: 6379 })
  })

  it('rejects non-redis schemes and bad database indexes', () => {
    expect(() => redisConnectionFromUrl('http://localhost:6379')).toThrow(/redis:\/\//)
    expect(() => redisConnectionFromUrl('redis://localhost/abc')).toThrow(/database index/)
  })

  it('job ids avoid ":" (BullMQ rejects it) and change with the send time', () => {
    const a = jobIdFor('n1', new Date(1000))
    expect(a).not.toContain(':')
    expect(jobIdFor('n1', new Date(2000))).not.toBe(a)
  })
})
