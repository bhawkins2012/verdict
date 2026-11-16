// Sending transactional account emails (docs/adr-email-verification.md D5).
//
// These are NOT nudges. They deliberately ignore the nudge rules: the user's email-reminder opt-in
// (emailNudgesEnabled), the nudge daily cap, and NUDGE_REQUIRE_VERIFIED_EMAIL. A verification email
// goes, by definition, to an address that is not verified yet.
//
// Delivery is inline and best-effort, once, after the HTTP response: a failure is logged and the
// per-address slot is released so the user can press "Resend" (the soft gate means nobody is locked out).
import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'
import { safeErrorMessage } from '../lib/safeError'
import { loadNudgeConfig } from '../nudges/config'
import { createProvider, EmailMessage, EmailProvider } from '../nudges/providers'
import { isDevEnvironment } from '../middleware/devOnly'
import { markSlotSent, releaseSlot } from './emailLimits'
import { renderVerificationEmail } from './emails'
import { IssuedToken, verificationLink } from './verificationTokens'

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
/** Which after-response task failed, for whom: logged with every failure (never the address or a token). */
export interface TaskContext {
  task: 'registration' | 'verification-email' | 'signup-attempt-email' | 'email-changed-email'
  userId?: string
}

/** "TypeError", "PrismaClientKnownRequestError", "EmailProviderError", ... */
export function errorClass(err: unknown): string {
  if (err instanceof Error) return err.constructor?.name || err.name
  return typeof err
}

export async function sendAccountEmail(kind: EmailKind, message: EmailMessage, slotEventId?: string, userId?: string): Promise<boolean> {
  const provider = transactionalProvider()
  try {
    const { providerMessageId } = await provider.send(message)
    logger.info('Account email sent', { kind, provider: provider.name, providerMessageId, idempotencyKey: message.idempotencyKey })
    if (slotEventId) await markSlotSent(prisma, slotEventId, new Date()).catch(() => undefined)
    if (!provider.real && kind === 'verification' && isDevEnvironment()) {
      // Dry run in development/test only: make the link easy to find in the logs (also served by
      // GET /api/auth/dev/verification-link). Never elsewhere: a log line with a live token would let
      // anyone who can read the logs verify the address.
      logger.info('Verification link (dry run, not sent)', { to: message.to, link: message.text.match(/https?:\/\/\S+\/verify-email#\S+/)?.[0] })
    }
    return true
  } catch (err) {
    logger.error('Account email failed; the user can resend', {
      kind, userId, provider: provider.name, idempotencyKey: message.idempotencyKey, errorClass: errorClass(err),
      error: safeErrorMessage(err),
    })
    if (slotEventId) await releaseSlot(prisma, slotEventId).catch(() => undefined)
    return false
  }
}

// ── After-response delivery ─────────────────────────────────────────────────────────────────────────
// Sends run after the response so provider latency never shows in response times (no enumeration by
// timing, D3). Tests await them with flushAccountEmails().
const inFlight = new Set<Promise<unknown>>()

export function afterResponse(context: TaskContext, task: () => Promise<unknown>): void {
  // Promise.resolve().then: a synchronous throw inside the task (e.g. invalid config) is caught here too,
  // instead of escaping into a route whose response was already sent. A failure never changes the
  // response (it has been sent); it is logged with the task, the user id and the error class.
  const p: Promise<unknown> = Promise.resolve()
    .then(task)
    .catch((err) =>
      logger.error('Account email task failed', {
        task: context.task, userId: context.userId, errorClass: errorClass(err), error: safeErrorMessage(err),
      })
    )
    .finally(() => inFlight.delete(p))
  inFlight.add(p)
}

export async function flushAccountEmails(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight])
}

/** On shutdown: give in-flight account emails up to `timeoutMs` to finish. */
export async function drainAccountEmails(timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), timeoutMs)))
  const done = await Promise.race([flushAccountEmails().then(() => true as const), timeout])
  clearTimeout(timer)
  return done
}

export function accountEmailSettings() {
  const c = loadNudgeConfig()
  return { frontendUrl: c.frontendUrl, fromEmail: c.fromEmail, postalAddress: c.postalAddress }
}

/** The task that emails a verification link (run after the response). */
export function verificationEmailTask(token: Pick<IssuedToken, 'id' | 'verifier'>, to: string, slotEventId: string | null, userId?: string) {
  return () => {
    const settings = accountEmailSettings()
    const message = renderVerificationEmail({ to, link: verificationLink(settings.frontendUrl, token), tokenId: token.id }, settings)
    return sendAccountEmail('verification', message, slotEventId ?? undefined, userId)
  }
}

