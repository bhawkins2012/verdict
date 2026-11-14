// Sending one nudge (docs/adr-nudges.md D2, D5, D7).
//
// Exactly-once claim, at-least-once email: a worker may only send after atomically moving the nudge
// from PENDING to SENDING (two workers cannot both win). If the process dies after the provider accepted
// the email but before the nudge is marked SENT, the reconciler later returns the stale claim to PENDING
// and it is sent again; the provider's idempotency key (same key every attempt) is the only guard
// against that duplicate. So delivery is at-least-once on a crash-after-send.
import { Prisma, PrismaClient } from '@prisma/client'
import { logger } from '../lib/logger'
import { NudgeConfig } from './config'
import { renderNudgeEmail } from './email'
import { EmailProvider, EmailProviderError } from './providers'
import { localDayBounds, nextLocalSendTime } from './time'

/** Retry delays after the 1st, 2nd, 3rd, 4th failed attempt (ADR Q7). */
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]

export type ProcessOutcome =
  | { kind: 'missing' }
  | { kind: 'not-claimed' }
  | { kind: 'completed' }
  | { kind: 'in-app'; reason: 'opted-out' | 'unverified-email' }
  | { kind: 'deferred'; sendAt: Date }
  | { kind: 'sent'; providerMessageId: string }
  | { kind: 'retry'; sendAt: Date; error: string }
  | { kind: 'failed'; error: string }

export interface SenderDeps {
  db: PrismaClient
  provider: EmailProvider
  config: Pick<NudgeConfig, 'dailyCap' | 'maxAttempts' | 'requireVerifiedEmail' | 'frontendUrl' | 'fromEmail' | 'unsubscribeSecret' | 'postalAddress'>
  now?: () => Date
}

const nudgeForSend = {
  include: {
    user: true,
    thread: { include: { product: { select: { id: true, name: true } }, reviews: { select: { stage: true } } } },
  },
} satisfies Prisma.NudgeDefaultArgs
type NudgeForSend = Prisma.NudgeGetPayload<typeof nudgeForSend>

type ClaimResult = Exclude<ProcessOutcome, { kind: 'sent' } | { kind: 'retry' } | { kind: 'failed' }> | { kind: 'send'; nudge: NudgeForSend }

/**
 * Claim and send one nudge. Safe to call concurrently for the same id from any number of workers:
 * at most one call gets past the claim.
 * `ignoreCapAndHour` is for the dev-only "send now" route.
 */
export async function processNudge(nudgeId: string, deps: SenderDeps, opts: { ignoreCapAndHour?: boolean } = {}): Promise<ProcessOutcome> {
  const clock = deps.now ?? (() => new Date())

  const claim: ClaimResult = await deps.db.$transaction(async (tx) => {
    const owner = await tx.nudge.findUnique({ where: { id: nudgeId }, select: { userId: true } })
    if (!owner) return { kind: 'missing' }

    // Serialise all sends for one user, so the daily-cap count below cannot race.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'nudge-user:' + owner.userId}))`

    const now = clock()
    const won = await tx.nudge.updateMany({
      where: { id: nudgeId, status: 'PENDING', sendAt: { lte: now } },
      data: { status: 'SENDING', claimedAt: now },
    })
    if (won.count === 0) return { kind: 'not-claimed' }

    const nudge = await tx.nudge.findUniqueOrThrow({ where: { id: nudgeId }, ...nudgeForSend })

    // The user may have reviewed this stage since it was scheduled.
    if (nudge.thread.reviews.some((r) => r.stage === nudge.targetStage)) {
      await tx.nudge.update({
        where: { id: nudgeId },
        data: { status: 'COMPLETED', completedAt: now, endedReason: 'REVIEW_SUBMITTED', claimedAt: null },
      })
      return { kind: 'completed' }
    }

    // Email only with consent, and (for a real provider) only to verified addresses unless disabled.
    const optedOut = !nudge.user.emailNudgesEnabled
    const unverified = deps.provider.real && deps.config.requireVerifiedEmail && !nudge.user.emailVerified
    if (optedOut || unverified) {
      await tx.nudge.update({
        where: { id: nudgeId },
        data: { status: 'SENT', channel: 'IN_APP', sentAt: now, claimedAt: null },
      })
      return { kind: 'in-app', reason: optedOut ? 'opted-out' : 'unverified-email' }
    }

    if (!opts.ignoreCapAndHour) {
      const { start, end } = localDayBounds(now, nudge.user.timezone)
      // Emails already sent today plus other nudges currently being sent (all of which are emails:
      // in-app/deferred/completed outcomes are resolved inside this transaction).
      const used = await tx.nudge.count({
        where: {
          userId: nudge.userId,
          id: { not: nudgeId },
          OR: [{ channel: 'EMAIL', sentAt: { gte: start, lt: end } }, { status: 'SENDING' }],
        },
      })
      if (used >= deps.config.dailyCap) {
        const sendAt = nextLocalSendTime(end, nudge.user.timezone, nudge.user.nudgeSendHour)
        await tx.nudge.update({ where: { id: nudgeId }, data: { status: 'PENDING', sendAt, claimedAt: null } })
        return { kind: 'deferred', sendAt }
      }
    }

    return { kind: 'send', nudge }
  })

  if (claim.kind !== 'send') return claim
  const nudge = claim.nudge

  const message = renderNudgeEmail(
    {
      nudgeId: nudge.id,
      stage: nudge.targetStage,
      productId: nudge.thread.product.id,
      productName: nudge.thread.product.name,
      userId: nudge.userId,
      to: nudge.user.email,
      displayName: nudge.user.displayName ?? nudge.user.username,
      fromPurchase: nudge.thread.purchasedAt !== null,
    },
    deps.config
  )

  const attempts = nudge.attempts + 1
  let providerMessageId: string
  try {
    ;({ providerMessageId } = await deps.provider.send(message))
  } catch (err) {
    return recordFailure(deps, nudge.id, attempts, err, clock())
  }

  // The email is out. Recording it is separate from the send: if this fails (e.g. the database is
  // briefly unavailable) the nudge stays SENDING and the reconciler recovers it later, which re-sends
  // (at-least-once). It is not a failed send and must not count as an attempt or retry in a minute.
  try {
    const at = clock()
    const sentFields = { sentAt: at, channel: 'EMAIL' as const, providerMessageId, attempts, lastAttemptAt: at, lastError: null }
    const marked = await deps.db.nudge.updateMany({
      where: { id: nudge.id, status: 'SENDING' },
      data: { ...sentFields, status: 'SENT', claimedAt: null },
    })
    if (marked.count === 0) {
      // Completed/cancelled while we were sending. Keep the delivery record (it counts toward the cap).
      await deps.db.nudge.update({ where: { id: nudge.id }, data: sentFields })
    }
  } catch (err) {
    logger.error('Nudge email sent but not recorded; the reconciler will recover the claim', {
      nudgeId: nudge.id, providerMessageId, error: err instanceof Error ? err.message : String(err),
    })
  }
  logger.info('Nudge email sent', { nudgeId: nudge.id, provider: deps.provider.name, providerMessageId })
  return { kind: 'sent', providerMessageId }
}

async function recordFailure(deps: SenderDeps, nudgeId: string, attempts: number, err: unknown, at: Date): Promise<ProcessOutcome> {
  const error = err instanceof Error ? err.message.slice(0, 500) : String(err)
  // Unknown errors are treated as transient; EmailProviderError says explicitly.
  const retryable = err instanceof EmailProviderError ? err.retryable : true
  if (retryable && attempts < deps.config.maxAttempts) {
    const sendAt = new Date(at.getTime() + RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)])
    await deps.db.nudge.updateMany({
      where: { id: nudgeId, status: 'SENDING' },
      data: { status: 'PENDING', sendAt, attempts, lastAttemptAt: at, lastError: error, claimedAt: null },
    })
    logger.warn('Nudge email failed; will retry', { nudgeId, attempts, sendAt, error })
    return { kind: 'retry', sendAt, error }
  }
  await deps.db.nudge.updateMany({
    where: { id: nudgeId, status: 'SENDING' },
    data: { status: 'FAILED', attempts, lastAttemptAt: at, lastError: error, claimedAt: null },
  })
  logger.error('Nudge email dead-lettered', { nudgeId, attempts, retryable, error })
  return { kind: 'failed', error }
}
