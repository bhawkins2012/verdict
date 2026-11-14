import { dueDateFor, planThreadNudge } from '../../src/nudges/planner'

const anchor = new Date('2026-01-10T10:00:00Z')
const plan = (o: Partial<Parameters<typeof planThreadNudge>[0]>) =>
  planThreadNudge({ anchor, reviewedStages: ['INITIAL'], latestReviewAt: anchor, skippedStages: [], now: anchor, ...o })

describe('nudge planner', () => {
  it('due dates are calendar offsets from the anchor (with month-end clamping)', () => {
    expect(dueDateFor(anchor, 'ONE_WEEK').toISOString()).toBe('2026-01-17T10:00:00.000Z')
    expect(dueDateFor(anchor, 'ONE_MONTH').toISOString()).toBe('2026-02-10T10:00:00.000Z')
    expect(dueDateFor(anchor, 'THREE_MONTHS').toISOString()).toBe('2026-04-10T10:00:00.000Z')
    expect(dueDateFor(anchor, 'TWO_YEARS').toISOString()).toBe('2028-01-10T10:00:00.000Z')
    expect(dueDateFor(new Date('2026-01-31T00:00:00Z'), 'ONE_MONTH').toISOString()).toBe('2026-02-28T00:00:00.000Z')
  })

  it('a fresh thread targets the first upcoming stage', () => {
    expect(plan({})).toMatchObject({ stage: 'ONE_WEEK', dueAt: new Date('2026-01-17T10:00:00Z') })
  })

  it('anchoring when late: a 1-month review written on day 50 leaves 3 months due on day ~90, not day 50+60', () => {
    const day50 = new Date(anchor.getTime() + 50 * 86_400_000)
    const p = plan({ reviewedStages: ['INITIAL', 'ONE_MONTH'], latestReviewAt: day50, now: day50 })
    expect(p?.stage).toBe('THREE_MONTHS')
    expect(p?.dueAt.toISOString()).toBe('2026-04-10T10:00:00.000Z') // anchor + 3 months
  })

  it('overdue collapse: several stages already due -> only the latest due one', () => {
    const fourMonthsLater = new Date('2026-05-15T00:00:00Z') // 1 week, 1 month, 3 months all due
    expect(plan({ now: fourMonthsLater })?.stage).toBe('THREE_MONTHS')
  })

  it('a purchase date anchors the schedule instead of the start date', () => {
    const p = plan({ anchor: new Date('2025-12-01T00:00:00Z'), now: new Date('2026-01-10T10:00:00Z') })
    expect(p?.stage).toBe('ONE_MONTH') // 1 month after Dec 1 is due; 3 months is not yet
  })

  it('never sooner than 7 days after the latest review', () => {
    const now = new Date('2026-05-15T00:00:00Z')
    const p = plan({ reviewedStages: ['INITIAL'], latestReviewAt: now, now })
    expect(p?.notBefore.toISOString()).toBe('2026-05-22T00:00:00.000Z')
  })

  it('skipped stages are never targeted; reviewed stages and everything before them are done', () => {
    expect(plan({ skippedStages: ['ONE_WEEK'] })?.stage).toBe('ONE_MONTH')
    expect(plan({ reviewedStages: ['INITIAL', 'SIX_MONTHS'] })?.stage).toBe('ONE_YEAR')
  })

  it('CUSTOM reviews do not affect the plan, and a finished thread has nothing to ask', () => {
    expect(plan({ reviewedStages: ['INITIAL', 'CUSTOM'] })?.stage).toBe('ONE_WEEK')
    expect(plan({ reviewedStages: ['INITIAL', 'TWO_YEARS'] })).toBeNull()
  })
})
