// Pure nudge planning (docs/adr-nudges.md D3). No database, no clock: everything comes in as input,
// so the rules are testable on their own.
import { ReviewStage } from '@prisma/client'
import { CadenceEntry, CalendarOffset, NUDGE_CADENCE, stageRank } from '../stages'

/** Minimum time between the user's latest review and the next nudge email (ADR Q12). */
export const MIN_GAP_AFTER_REVIEW_MS = 7 * 24 * 60 * 60 * 1000

function addUtcDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000)
}

/** Calendar months in UTC, clamping the day (Jan 31 + 1 month = Feb 28/29). Keeps time of day. */
function addUtcMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + months
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())
  )
}

/** Apply a calendar offset to the anchor, in UTC. */
export function addOffset(anchor: Date, offset: CalendarOffset): Date {
  return 'days' in offset ? addUtcDays(anchor, offset.days) : addUtcMonths(anchor, offset.months)
}

/** When a cadence stage is due: its calendar offset from the anchor (purchase or start date). */
export function dueDateFor(anchor: Date, stage: ReviewStage, cadence: readonly CadenceEntry[] = NUDGE_CADENCE): Date {
  const entry = cadence.find((c) => c.stage === stage)
  if (!entry) throw new Error(`Stage ${stage} is not in the nudge cadence`)
  return addOffset(anchor, entry.offset)
}

export interface PlanInput {
  /** thread.purchasedAt ?? thread.startedAt */
  anchor: Date
  /** Stages the user has reviewed (any, including INITIAL/CUSTOM). */
  reviewedStages: readonly ReviewStage[]
  /** capturedAt of the user's latest review in this thread, if any. */
  latestReviewAt: Date | null
  /** Stages whose nudge the user skipped; they are never targeted again. */
  skippedStages: readonly ReviewStage[]
  now: Date
}

export interface PlanTarget {
  stage: ReviewStage
  dueAt: Date
  /** Earliest moment an email may go out (before rounding to the user's send hour). */
  notBefore: Date
}

/**
 * The single stage this thread should be nudged about, or null if there is nothing left to ask.
 * - Candidates: cadence stages later (on the full timeline) than every reviewed or skipped stage.
 * - If several are already due, only the latest due one (the most relevant) is targeted.
 * - Otherwise the earliest upcoming one.
 * - Never sooner than MIN_GAP_AFTER_REVIEW_MS after the latest review.
 */
export function planThreadNudge(input: PlanInput, cadence: readonly CadenceEntry[] = NUDGE_CADENCE): PlanTarget | null {
  const reviewed = new Set(input.reviewedStages)
  const skipped = new Set(input.skippedStages)
  // A reviewed or skipped stage closes itself and every earlier point on the timeline, whether or not it
  // is a cadence stage: a 1-month review written by hand means a 2-week check-in no longer makes sense,
  // and skipping 3 months must not bring back a 2-week nudge it had superseded.
  const lastClosedRank = Math.max(-1, ...[...reviewed, ...skipped].map(stageRank))

  const candidates = cadence
    .filter((c) => stageRank(c.stage) > lastClosedRank && !reviewed.has(c.stage) && !skipped.has(c.stage))
    .map((c) => ({ stage: c.stage, dueAt: addOffset(input.anchor, c.offset) }))
  if (candidates.length === 0) return null

  const due = candidates.filter((c) => c.dueAt.getTime() <= input.now.getTime())
  const target = due.length > 0 ? due[due.length - 1] : candidates[0]

  const gapEnd = input.latestReviewAt ? input.latestReviewAt.getTime() + MIN_GAP_AFTER_REVIEW_MS : 0
  return { ...target, notBefore: new Date(Math.max(target.dueAt.getTime(), gapEnd)) }
}
