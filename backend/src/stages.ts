// Review stages: the single source of truth for stage order, labels and the nudge cadence.
// Served to the frontend by GET /api/config; the frontend derives its stage lists, the "next stage"
// call to action and the email consent copy from that response. See docs/adr-nudges.md section 7.
import { ReviewStage } from '@prisma/client'

/** A calendar offset from the thread's anchor (purchase date, else first review). */
export type CalendarOffset = { days: number } | { months: number }

export interface CadenceEntry {
  stage: ReviewStage
  offset: CalendarOffset
}

/**
 * Every stage in chronological order. Not the cadence: it also contains stages users can write by
 * hand (1 week, 1 month, 6 months) and is used to order reviews and compute drift. CUSTOM is ad hoc
 * and comes last.
 */
export const STAGE_ORDER: readonly ReviewStage[] = [
  'INITIAL',
  'ONE_WEEK',
  'TWO_WEEKS',
  'ONE_MONTH',
  'THREE_MONTHS',
  'SIX_MONTHS',
  'ONE_YEAR',
  'TWO_YEARS',
  'CUSTOM',
]

/** Short labels, used in emails and in the consent copy ("2 weeks"). */
export const STAGE_LABEL: Record<ReviewStage, string> = {
  INITIAL: 'first impression',
  ONE_WEEK: '1 week',
  TWO_WEEKS: '2 weeks',
  ONE_MONTH: '1 month',
  THREE_MONTHS: '3 months',
  SIX_MONTHS: '6 months',
  ONE_YEAR: '1 year',
  TWO_YEARS: '2 years',
  CUSTOM: 'custom',
}

/**
 * The nudge cadence, in order. The ONLY place it is defined: the planner, the API, the consent copy and
 * the frontend all derive from it. Changed in Sprint 1 from 1 week/1, 3, 6 months/1, 2 years to this.
 */
export const NUDGE_CADENCE: readonly CadenceEntry[] = [
  { stage: 'TWO_WEEKS', offset: { days: 14 } },
  { stage: 'THREE_MONTHS', offset: { months: 3 } },
  { stage: 'ONE_YEAR', offset: { months: 12 } },
  { stage: 'TWO_YEARS', offset: { months: 24 } },
]

/** Chronological position of a stage; CUSTOM has none (-1) because it is not on the timeline. */
export function stageRank(stage: ReviewStage): number {
  return stage === 'CUSTOM' ? -1 : STAGE_ORDER.indexOf(stage)
}

/** "a", "a and b", "a, b, and c" */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/** The opt-in text shown to users. Generated from the cadence so it cannot drift from what we send. */
export function consentCopy(cadence: readonly CadenceEntry[] = NUDGE_CADENCE): string {
  return `Email me check-ins at ${listOf(cadence.map((c) => STAGE_LABEL[c.stage]))}.`
}

/** The payload of GET /api/config. */
export function stageConfig(cadence: readonly CadenceEntry[] = NUDGE_CADENCE) {
  return {
    stages: STAGE_ORDER.map((stage) => ({ stage, label: STAGE_LABEL[stage] })),
    nudgeCadence: cadence.map((c) => ({ stage: c.stage, label: STAGE_LABEL[c.stage], offset: c.offset })),
    consentCopy: consentCopy(cadence),
  }
}
