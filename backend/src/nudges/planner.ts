// Pure nudge planning (docs/adr-nudges.md D3). No database, no clock: everything comes in as input,
// so the rules are testable on their own.
import { ReviewStage } from '@prisma/client'

/** Stages that get a nudge, in order. INITIAL is the first review; CUSTOM is ad hoc. */
export const SCHEDULED_STAGES: readonly ReviewStage[] = [
  'ONE_WEEK',
  'ONE_MONTH',
  'THREE_MONTHS',
  'SIX_MONTHS',
  'ONE_YEAR',
  'TWO_YEARS',
]

export const STAGE_LABEL: Record<ReviewStage, string> = {
  INITIAL: 'first impression',
  ONE_WEEK: '1 week',
  ONE_MONTH: '1 month',
  THREE_MONTHS: '3 months',
  SIX_MONTHS: '6 months',
  ONE_YEAR: '1 year',
  TWO_YEARS: '2 years',
  CUSTOM: 'custom',
}

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

/** When a stage is due: a fixed calendar offset from the anchor (purchase or start date). */
export function dueDateFor(anchor: Date, stage: ReviewStage): Date {
  switch (stage) {
    case 'ONE_WEEK': return addUtcDays(anchor, 7)
    case 'ONE_MONTH': return addUtcMonths(anchor, 1)
    case 'THREE_MONTHS': return addUtcMonths(anchor, 3)
    case 'SIX_MONTHS': return addUtcMonths(anchor, 6)
    case 'ONE_YEAR': return addUtcMonths(anchor, 12)
    case 'TWO_YEARS': return addUtcMonths(anchor, 24)
    default: throw new Error(`Stage ${stage} has no schedule`)
  }
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
 * - Candidates: scheduled stages after the latest reviewed scheduled stage, not reviewed, not skipped.
 * - If several are already due, only the latest due one (the most relevant) is targeted.
 * - Otherwise the earliest upcoming one.
 * - Never sooner than MIN_GAP_AFTER_REVIEW_MS after the latest review.
 */
export function planThreadNudge(input: PlanInput): PlanTarget | null {
  const reviewed = new Set(input.reviewedStages)
  const skipped = new Set(input.skippedStages)
  const lastReviewedIndex = SCHEDULED_STAGES.reduce((acc, s, i) => (reviewed.has(s) ? i : acc), -1)

  const candidates = SCHEDULED_STAGES
    .slice(lastReviewedIndex + 1)
    .filter((s) => !reviewed.has(s) && !skipped.has(s))
    .map((stage) => ({ stage, dueAt: dueDateFor(input.anchor, stage) }))
  if (candidates.length === 0) return null

  const due = candidates.filter((c) => c.dueAt.getTime() <= input.now.getTime())
  const target = due.length > 0 ? due[due.length - 1] : candidates[0]

  const gapEnd = input.latestReviewAt ? input.latestReviewAt.getTime() + MIN_GAP_AFTER_REVIEW_MS : 0
  return { ...target, notBefore: new Date(Math.max(target.dueAt.getTime(), gapEnd)) }
}
