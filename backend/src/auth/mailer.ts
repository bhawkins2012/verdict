// Sending transactional account emails (docs/adr-email-verification.md D5).
//
// These are NOT nudges. They deliberately ignore the nudge rules: the user's email-reminder opt-in
// (emailNudgesEnabled), the nudge daily cap, and NUDGE_REQUIRE_VERIFIED_EMAIL. A verification email
// goes, by definition, to an address that is not verified yet.
//
// Delivery is inline and best-effort, once, after the HTTP response: a failure is logged and the
// per-address slot is released so the user can press "Resend" (the soft gate means nobody is locked out).
import { EmailRateKind } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'
import { loadNudgeConfig } from '../nudges/config'
import { createProvider, EmailMessage, EmailProvider } from '../nudges/providers'
import { releaseSlot } from './emailLimits'

let providerOverride: EmailProvider | null = null

/** Tests only: route transactional email through a mock provider (null restores the configured one). */
export function setTransactionalProviderForTests(provider: EmailProvider | null): void {
  providerOverride = provider
}

export function transactionalProvider(): EmailProvider {
  return providerOverride ?? createProvider(loadNudgeConfig())
}

export type EmailKind = 'verification' | 'signup-attempt' | 'email-changed'

/**
 * Send one account email. `slotEventId` is the per-address rate-limit event claimed before the email was
 * prepared; it is released if the provider does not accept the message.
 */
export async function sendAccountEmail(kind: EmailKind, message: EmailMessage, slotEventId?: string): Promise<boolean> {
  const provider = transactionalProvider()
  try {
    const { providerMessageId } = await provider.send(message)
    logger.info('Account email sent', { kind, provider: provider.name, providerMessageId, idempotencyKey: message.idempotencyKey })
    if (!provider.real && kind === 'verification') {
      // Dry run: make the link easy to find in the logs (also served by GET /api/auth/dev/verification-link).
      logger.info('Verification link (dry run, not sent)', { to: message.to, link: message.text.match(/https?:\/\/\S+\/verify-email#\S+/)?.[0] })
    }
    return true
  } catch (err) {
    logger.error('Account email failed; the user can resend', {
      kind, provider: provider.name, idempotencyKey: message.idempotencyKey, error: err instanceof Error ? err.message : String(err),
    })
    if (slotEventId) await releaseSlot(prisma, slotEventId).catch(() => undefined)
    return false
  }
}

// ── After-response delivery ─────────────────────────────────────────────────────────────────────────
// Sends run after the response so provider latency never shows in response times (no enumeration by
// timing, D3). Tests await them with flushAccountEmails().
const inFlight = new Set<Promise<unknown>>()

export function afterResponse(task: () => Promise<unknown>): void {
  const p: Promise<unknown> = task()
    .catch((err) => logger.error('Account email task failed', { error: err instanceof Error ? err.message : String(err) }))
    .finally(() => inFlight.delete(p))
  inFlight.add(p)
}

export async function flushAccountEmails(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight])
}

export type AddressSlotKind = Extract<EmailRateKind, 'VERIFICATION_EMAIL' | 'SIGNUP_ATTEMPT_EMAIL'>
