import { runEmailSmoke } from '../src/scripts/emailSmoke'
import { EmailProviderError } from '../src/nudges/providers'
import { mockProvider } from './nudges/fixtures'

const resendEnv = {
  ...process.env,
  NUDGE_EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test_dummy',
  NUDGE_FROM_EMAIL: 'Verdict <onboarding@resend.dev>',
  NUDGE_POSTAL_ADDRESS: '1 Test Street, Testville',
}

describe('npm run email:smoke', () => {
  it('refuses to run with the dry-run provider', async () => {
    const result = await runEmailSmoke('me@example.com', { ...process.env, NUDGE_EMAIL_PROVIDER: 'console' })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^Refusing to run: NUDGE_EMAIL_PROVIDER is "console"/) })
  })

  it('needs an address', async () => {
    expect(await runEmailSmoke(undefined, resendEnv)).toMatchObject({ ok: false, error: expect.stringMatching(/^Usage/) })
    expect(await runEmailSmoke('not-an-address', resendEnv)).toMatchObject({ ok: false })
  })

  it('reports a missing Resend setting instead of sending', async () => {
    const { NUDGE_POSTAL_ADDRESS: _omit, ...env } = resendEnv
    expect(await runEmailSmoke('me@example.com', env)).toMatchObject({ ok: false, error: expect.stringContaining('NUDGE_POSTAL_ADDRESS') })
  })

  it('sends one verification-style email through a real provider and returns its answer', async () => {
    const real = mockProvider({ real: true })
    const result = await runEmailSmoke(' Me@Example.com ', resendEnv, real.provider)
    expect(result).toMatchObject({ ok: true, provider: 'resend', providerMessageId: 'mock-1', to: 'me@example.com', idempotencyKey: expect.stringMatching(/^smoke\//) })
    expect(real.sent).toHaveLength(1)
    expect(real.sent[0]).toMatchObject({ from: 'Verdict <onboarding@resend.dev>', subject: '[Smoke test] Confirm your email for Verdict' })
    expect(real.sent[0].text).toContain('1 Test Street, Testville')
    expect(real.sent[0].text).toContain('nothing to confirm')
  })

  it('prints the provider error with its status', async () => {
    const failing = mockProvider({ real: true, send: async () => { throw new EmailProviderError('Resend API 403: domain not verified', false, 403) } })
    expect(await runEmailSmoke('me@example.com', resendEnv, failing.provider)).toEqual({ ok: false, error: 'Resend API 403: domain not verified', status: 403, retryable: false })
  })
})
