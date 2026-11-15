// Database-backed rate limits for email (docs/adr-email-verification.md D4). Stored in Postgres so they hold
// across processes and restarts, and keyed by a hash of the address so they work when no user exists.
// Each check runs under a transaction-scoped advisory lock on its key, so concurrent requests cannot both
// pass the count.
import { EmailRateKind, PrismaClient } from '@prisma/client'
import { addressKey } from './emailAddress'

/** At most one verification email, and one "someone tried to sign up" email, per address per hour. */
export const ADDRESS_WINDOW_MS = 60 * 60 * 1000
/** Email-change attempts per user per hour (right or wrong password). */
export const EMAIL_CHANGE_ATTEMPTS_PER_HOUR = 5
const HOUR_MS = 60 * 60 * 1000
/**
 * An address slot whose email was never marked sent (the process died between claiming it and sending)
 * stops counting after this long, so a crash cannot block Resend for the rest of the hour.
 */
export const UNSENT_SLOT_GRACE_MS = 5 * 60 * 1000

export type Limited = { allowed: true; eventId: string } | { allowed: false; retryAfterSeconds: number }

async function take(
  db: PrismaClient,
  kind: EmailRateKind,
  key: string,
  max: number,
  windowMs: number,
  now: Date,
  opts: { onlySent?: boolean } = {}
): Promise<Limited> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`email-rate:${kind}:${key}`}))`
    const since = new Date(now.getTime() - windowMs)
    const recent = await tx.emailRateEvent.findMany({
      where: {
        kind,
        key,
        createdAt: { gt: since },
        // Address slots: sent emails, or sends still in flight (claimed in the last few minutes).
        ...(opts.onlySent ? { OR: [{ sentAt: { not: null } }, { createdAt: { gt: new Date(now.getTime() - UNSENT_SLOT_GRACE_MS) } }] } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    })
    if (recent.length >= max) {
      const freesAt = recent[recent.length - max].createdAt.getTime() + windowMs
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((freesAt - now.getTime()) / 1000)) }
    }
    const event = await tx.emailRateEvent.create({ data: { kind, key, createdAt: now }, select: { id: true } })
    return { allowed: true, eventId: event.id }
  })
}

/** Claim the hourly slot for one email of `kind` to `email`. Release it if the send fails. */
export function claimAddressSlot(
  db: PrismaClient,
  kind: Extract<EmailRateKind, 'VERIFICATION_EMAIL' | 'SIGNUP_ATTEMPT_EMAIL'>,
  email: string,
  now: Date
): Promise<Limited> {
  return take(db, kind, addressKey(email), 1, ADDRESS_WINDOW_MS, now, { onlySent: true })
}

/** The provider accepted the email: the slot now counts for the full hour. */
export async function markSlotSent(db: PrismaClient, eventId: string, at: Date): Promise<void> {
  await db.emailRateEvent.updateMany({ where: { id: eventId }, data: { sentAt: at } })
}

/** Give a slot back (the provider did not accept the email), so the user can try again at once. */
export async function releaseSlot(db: PrismaClient, eventId: string): Promise<void> {
  await db.emailRateEvent.deleteMany({ where: { id: eventId } })
}

/** Count one email-change attempt for the user, or refuse it if they already made 5 in the last hour. */
export function takeEmailChangeAttempt(db: PrismaClient, userId: string, now: Date): Promise<Limited> {
  return take(db, 'EMAIL_CHANGE_ATTEMPT', userId, EMAIL_CHANGE_ATTEMPTS_PER_HOUR, HOUR_MS, now)
}

/** Housekeeping (run on the reconciler's hourly sweep): old tokens and rate-limit events are not needed. */
export async function pruneAccountEmailRecords(db: PrismaClient, now: Date): Promise<{ tokens: number; events: number }> {
  const tokens = await db.emailVerificationToken.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * 24 * HOUR_MS) } } })
  const events = await db.emailRateEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 24 * HOUR_MS) } } })
  return { tokens: tokens.count, events: events.count }
}
