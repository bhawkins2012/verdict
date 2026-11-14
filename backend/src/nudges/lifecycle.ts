// Nudge lifecycle in the database (docs/adr-nudges.md D3, D4). The DB is the source of truth:
// syncThreadNudges() makes a thread's nudge rows match the planner, and is safe to run any number of
// times (on review submit, skip, snooze, and from the reconciler's sweep).
import { NudgeStatus, Prisma, ReviewStage } from '@prisma/client'
import { planThreadNudge } from './planner'
import { nextLocalSendTime } from './time'

type Db = Prisma.TransactionClient

/** Nudges that still matter: not completed, skipped or cancelled. */
export const ACTIVE_STATUSES: NudgeStatus[] = ['PENDING', 'SENDING', 'SENT', 'FAILED']

export const MAX_SNOOZES = 3

/**
 * The in-app "check-ins due" set. The nav badge, the dashboard banner and list, and the stats count all
 * use this one definition (ADR Q13): due (scheduledFor <= now), not snoozed, still active.
 */
export function dueNudgesWhere(userId: string, now: Date): Prisma.NudgeWhereInput {
  return {
    userId,
    status: { in: ACTIVE_STATUSES },
    scheduledFor: { lte: now },
    OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
  }
}

/**
 * Bring one thread's nudges in line with the plan. Returns ids of PENDING nudges whose delivery job
 * should be (re)scheduled.
 */
export async function syncThreadNudges(db: Db, threadId: string, now: Date): Promise<string[]> {
  const thread = await db.reviewThread.findUnique({
    where: { id: threadId },
    include: {
      reviews: { select: { stage: true, capturedAt: true } },
      nudges: true,
      user: { select: { timezone: true, nudgeSendHour: true } },
    },
  })
  if (!thread) return []

  const reviewed = new Set<ReviewStage>(thread.reviews.map((r) => r.stage))
  const latestReviewAt = thread.reviews.reduce<Date | null>(
    (latest, r) => (!latest || r.capturedAt > latest ? r.capturedAt : latest),
    null
  )
  const plan = planThreadNudge({
    anchor: thread.purchasedAt ?? thread.startedAt,
    reviewedStages: [...reviewed],
    latestReviewAt,
    skippedStages: thread.nudges.filter((n) => n.status === 'SKIPPED').map((n) => n.targetStage),
    now,
  })

  // Close out active nudges that are no longer the target.
  for (const n of thread.nudges) {
    if (!ACTIVE_STATUSES.includes(n.status)) continue
    if (reviewed.has(n.targetStage)) {
      await db.nudge.update({
        where: { id: n.id },
        data: { status: 'COMPLETED', completedAt: now, endedReason: 'REVIEW_SUBMITTED', claimedAt: null },
      })
    } else if (!plan || n.targetStage !== plan.stage) {
      await db.nudge.update({
        where: { id: n.id },
        data: { status: 'CANCELLED', endedReason: 'SUPERSEDED', claimedAt: null },
      })
    }
  }

  if (!plan) return []

  const notBefore = new Date(Math.max(plan.notBefore.getTime(), now.getTime()))
  const sendAt = nextLocalSendTime(notBefore, thread.user.timezone, thread.user.nudgeSendHour)
  const existing = thread.nudges.find((n) => n.targetStage === plan.stage)

  if (!existing) {
    // skipDuplicates (ON CONFLICT DO NOTHING) so two concurrent syncs cannot abort each other's
    // transaction on the (threadId, targetStage) unique index.
    await db.nudge.createMany({
      data: [{ userId: thread.userId, threadId, targetStage: plan.stage, scheduledFor: plan.dueAt, sendAt }],
      skipDuplicates: true,
    })
    const created = await db.nudge.findUnique({
      where: { threadId_targetStage: { threadId, targetStage: plan.stage } },
      select: { id: true, status: true },
    })
    return created?.status === 'PENDING' ? [created.id] : []
  }

  if (existing.status === 'PENDING') {
    // A retry backoff or a snooze may already have pushed sendAt later; never pull it earlier.
    const keepLater = existing.attempts > 0 || (existing.snoozedUntil !== null && existing.snoozedUntil > now)
    const nextSendAt = keepLater && existing.sendAt > sendAt ? existing.sendAt : sendAt
    if (existing.scheduledFor.getTime() !== plan.dueAt.getTime() || existing.sendAt.getTime() !== nextSendAt.getTime()) {
      await db.nudge.update({ where: { id: existing.id }, data: { scheduledFor: plan.dueAt, sendAt: nextSendAt } })
    }
    return [existing.id]
  }

  if (existing.status === 'CANCELLED') {
    // The stage became the target again (e.g. the purchase date changed): start it over.
    await db.nudge.update({
      where: { id: existing.id },
      data: {
        status: 'PENDING', scheduledFor: plan.dueAt, sendAt, endedReason: null, channel: null,
        sentAt: null, claimedAt: null, attempts: 0, lastError: null, lastAttemptAt: null,
        snoozedUntil: null, snoozeCount: 0,
      },
    })
    return [existing.id]
  }

  // SENDING, SENT or FAILED: already being delivered or delivered; leave it.
  return []
}

/**
 * A review for `stage` was submitted: complete that stage's nudge and re-plan the thread (which also
 * cancels earlier nudges). Call inside the same transaction as the review insert.
 */
export async function completeNudgesForReview(db: Db, threadId: string, stage: ReviewStage, now: Date): Promise<string[]> {
  await db.nudge.updateMany({
    where: { threadId, targetStage: stage, status: { in: ACTIVE_STATUSES } },
    data: { status: 'COMPLETED', completedAt: now, endedReason: 'REVIEW_SUBMITTED', claimedAt: null },
  })
  return syncThreadNudges(db, threadId, now)
}

export class NudgeActionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function ownedNudge(db: Db, nudgeId: string, userId: string) {
  const nudge = await db.nudge.findUnique({
    where: { id: nudgeId },
    include: { user: { select: { timezone: true, nudgeSendHour: true } } },
  })
  if (!nudge) throw new NudgeActionError(404, 'Nudge not found')
  if (nudge.userId !== userId) throw new NudgeActionError(403, 'Not your nudge')
  return nudge
}

/** Skip: never nudge for this stage; move on to the next one. */
export async function skipNudge(db: Db, nudgeId: string, userId: string, now: Date): Promise<string[]> {
  const nudge = await ownedNudge(db, nudgeId, userId)
  if (!['PENDING', 'SENT', 'FAILED'].includes(nudge.status)) {
    throw new NudgeActionError(409, `A ${nudge.status.toLowerCase()} nudge cannot be skipped`)
  }
  await db.nudge.update({
    where: { id: nudgeId },
    data: { status: 'SKIPPED', endedReason: 'USER_SKIPPED', claimedAt: null },
  })
  return syncThreadNudges(db, nudge.threadId, now)
}

/** Snooze: hide it for `days` and email again after that (at most MAX_SNOOZES times). */
export async function snoozeNudge(db: Db, nudgeId: string, userId: string, days: number, now: Date): Promise<string[]> {
  const nudge = await ownedNudge(db, nudgeId, userId)
  if (!['PENDING', 'SENT'].includes(nudge.status)) {
    throw new NudgeActionError(409, `A ${nudge.status.toLowerCase()} nudge cannot be snoozed`)
  }
  if (nudge.snoozeCount >= MAX_SNOOZES) throw new NudgeActionError(409, `A nudge can be snoozed at most ${MAX_SNOOZES} times`)
  const snoozedUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
  const sendAt = nextLocalSendTime(snoozedUntil, nudge.user.timezone, nudge.user.nudgeSendHour)
  await db.nudge.update({
    where: { id: nudgeId },
    data: { status: 'PENDING', snoozedUntil, sendAt, snoozeCount: { increment: 1 }, claimedAt: null },
  })
  return [nudgeId]
}
