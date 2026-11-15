// npm run email:smoke -- <address>
//
// Sends ONE verification-style email through the configured provider and prints the provider's answer,
// to verify real delivery (docs/adr-email-verification.md D11). Refuses to run with the dry-run provider.
// It touches no database and creates no token: the message only looks like a verification email, and its
// link opens Verdict's home page. See CLAUDE.md ("Email smoke test") for the exact setup.
import 'dotenv/config' // backend/.env, like the app
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { renderVerificationEmail } from '../auth/emails'
import { loadNudgeConfig } from '../nudges/config'
import { createProvider, EmailProvider, EmailProviderError } from '../nudges/providers'

export type SmokeResult =
  | { ok: true; provider: string; providerMessageId: string; to: string; idempotencyKey: string }
  | { ok: false; error: string; status?: number; retryable?: boolean }

export async function runEmailSmoke(rawAddress: string | undefined, env: NodeJS.ProcessEnv, providerOverride?: EmailProvider): Promise<SmokeResult> {
  const address = z.string().trim().toLowerCase().email().safeParse(rawAddress ?? '')
  if (!address.success) return { ok: false, error: 'Usage: npm run email:smoke -- <address>' }

  let config
  try {
    config = loadNudgeConfig(env)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const provider = providerOverride ?? createProvider(config)
  if (!provider.real) {
    return {
      ok: false,
      error: `Refusing to run: NUDGE_EMAIL_PROVIDER is "${config.provider}" (dry run, nothing would be sent). Set NUDGE_EMAIL_PROVIDER=resend and RESEND_API_KEY, NUDGE_FROM_EMAIL, NUDGE_POSTAL_ADDRESS.`,
    }
  }

  const id = randomUUID()
  const message = renderVerificationEmail({ to: address.data, link: `${config.frontendUrl}/`, tokenId: `smoke-${id}` }, config)
  message.subject = `[Smoke test] ${message.subject}`
  message.text = `This is a delivery test from Verdict's email:smoke command. There is nothing to confirm.\n\n${message.text}`
  message.html = `<p><strong>This is a delivery test from Verdict's email:smoke command. There is nothing to confirm.</strong></p>\n${message.html}`
  message.idempotencyKey = `smoke/${id}`
  try {
    const { providerMessageId } = await provider.send(message)
    return { ok: true, provider: provider.name, providerMessageId, to: address.data, idempotencyKey: message.idempotencyKey }
  } catch (err) {
    if (err instanceof EmailProviderError) return { ok: false, error: err.message, status: err.status, retryable: err.retryable }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

if (require.main === module) {
  runEmailSmoke(process.argv[2], process.env).then((result) => {
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.ok ? 0 : 1)
  })
}
