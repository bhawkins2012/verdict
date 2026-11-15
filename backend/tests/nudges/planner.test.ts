import { addOffset, dueDateFor, planThreadNudge } from '../../src/nudges/planner'
import { NUDGE_CADENCE } from '../../src/stages'

const anchor = new Date('2026-01-10T10:00:00Z')
const plan = (o: Partial<Parameters<typeof planThreadNudge>[0]>) =>
  planThreadNudge({ anchor, reviewedStages: ['INITIAL'], latestReviewAt: anchor, skippedStages: [], now: anchor, ...o })

describe('nudge cadence offsets (2 weeks, 3 months, 1 year, 2 years)', () => {
  it('the cadence is exactly the four product stages, in order', () => {
    expect(NUDGE_CADENCE.map((c) => c.stage)).toEqual(['TWO_WEEKS', 'THREE_MONTHS', 'ONE_YEAR', 'TWO_YEARS'])
  })

  it('due dates are calendar offsets from the anchor', () => {
    expect(dueDateFor(anchor, 'TWO_WEEKS').toISOString()).toBe('2026-01-24T10:00:00.000Z')
    expect(dueDateFor(anchor, 'THREE_MONTHS').toISOString()).toBe('2026-04-10T10:00:00.000Z')
    expect(dueDateFor(anchor, 'ONE_YEAR').toISOString()).toBe('2027-01-10T10:00:00.000Z')
    expect(dueDateFor(anchor, 'TWO_YEARS').toISOString()).toBe('2028-01-10T10:00:00.000Z')
  })

  it('month-end: Jan 31 + 3 months is Apr 30 (clamped), and 2 weeks crosses the month boundary', () => {
    const jan31 = new Date('2026-01-31T08:00:00Z')
    expect(dueDateFor(jan31, 'THREE_MONTHS').toISOString()).toBe('2026-04-30T08:00:00.000Z')
    expect(dueDateFor(jan31, 'TWO_WEEKS').toISOString()).toBe('2026-02-14T08:00:00.000Z')
  })

  it('leap years: Nov 29 + 3 months is Feb 29 in a leap year; Feb 29 + 1/2 years clamps to Feb 28', () => {
    expect(dueDateFor(new Date('2027-11-29T00:00:00Z'), 'THREE_MONTHS').toISOString()).toBe('2028-02-29T00:00:00.000Z')
    const leapDay = new Date('2028-02-29T00:00:00Z')
    expect(dueDateFor(leapDay, 'ONE_YEAR').toISOString()).toBe('2029-02-28T00:00:00.000Z')
    expect(dueDateFor(leapDay, 'TWO_YEARS').toISOString()).toBe('2030-02-28T00:00:00.000Z')
    expect(dueDateFor(new Date('2028-02-20T00:00:00Z'), 'TWO_WEEKS').toISOString()).toBe('2028-03-05T00:00:00.000Z') // 14 days incl. Feb 29
  })

  it('stages outside the cadence have no due date', () => {
    for (const stage of ['ONE_WEEK', 'ONE_MONTH', 'SIX_MONTHS', 'INITIAL', 'CUSTOM'] as const) {
      expect(() => dueDateFor(anchor, stage)).toThrow(/not in the nudge cadence/)
    }
    expect(addOffset(anchor, { days: 14 }).getTime()).toBe(dueDateFor(anchor, 'TWO_WEEKS').getTime())
  })
})

describe('nudge planner', () => {
  it('a fresh thread targets the 2-week check-in; the 7-day post-review gap does not delay it', () => {
    const p = plan({})
    expect(p).toMatchObject({ stage: 'TWO_WEEKS', dueAt: new Date('2026-01-24T10:00:00Z') })
    expect(p?.notBefore.toISOString()).toBe('2026-01-24T10:00:00.000Z') // max(due day 14, review + 7 days)
  })

  it('late reviews do not shift later stages: a 2-week review on day 50 leaves 3 months due at anchor + 3 months', () => {
    const day50 = new Date(anchor.getTime() + 50 * 86_400_000)
    const p = plan({ reviewedStages: ['INITIAL', 'TWO_WEEKS'], latestReviewAt: day50, now: day50 })
    expect(p?.stage).toBe('THREE_MONTHS')
    expect(p?.dueAt.toISOString()).toBe('2026-04-10T10:00:00.000Z')
  })

  it('a 3-month review written very late leaves 1 year due at anchor + 1 year', () => {
    const day200 = new Date(anchor.getTime() + 200 * 86_400_000)
    const p = plan({ reviewedStages: ['INITIAL', 'THREE_MONTHS'], latestReviewAt: day200, now: day200 })
    expect(p?.dueAt.toISOString()).toBe('2027-01-10T10:00:00.000Z')
  })

  it('overdue collapse: 2 weeks and 3 months both due -> only 3 months', () => {
    expect(plan({ now: new Date('2026-05-15T00:00:00Z') })?.stage).toBe('THREE_MONTHS')
  })

  it('a purchase date anchors the schedule instead of the start date', () => {
    // Bought Dec 1: 2 weeks is due on Jan 10; 3 months is not.
    expect(plan({ anchor: new Date('2025-12-01T00:00:00Z'), now: new Date('2026-01-10T10:00:00Z') })?.stage).toBe('TWO_WEEKS')
  })

  it('never sooner than 7 days after the latest review', () => {
    const now = new Date('2026-05-15T00:00:00Z')
    const p = plan({ reviewedStages: ['INITIAL'], latestReviewAt: now, now })
    expect(p?.notBefore.toISOString()).toBe('2026-05-22T00:00:00.000Z')
  })

  it('skipping a stage also closes every earlier stage (they never come back)', () => {
    // 2 weeks and 3 months are both due; the user skips 3 months. 2 weeks must not be resurrected.
    const p = plan({ now: new Date('2026-05-15T00:00:00Z'), skippedStages: ['THREE_MONTHS'] })
    expect(p?.stage).toBe('ONE_YEAR')
  })

  it('a manual review of an out-of-cadence stage closes the check-ins before it', () => {
    // The user wrote a 1-month review by hand: asking for the 2-week one no longer makes sense.
    expect(plan({ reviewedStages: ['INITIAL', 'ONE_MONTH'] })?.stage).toBe('THREE_MONTHS')
    // ...and a 6-month one closes 3 months too.
    expect(plan({ reviewedStages: ['INITIAL', 'SIX_MONTHS'] })?.stage).toBe('ONE_YEAR')
    // ONE_WEEK is before 2 weeks, so the 2-week check-in stays.
    expect(plan({ reviewedStages: ['INITIAL', 'ONE_WEEK'] })?.stage).toBe('TWO_WEEKS')
  })

  it('only cadence stages are ever targeted', () => {
    const targets = new Set<string>()
    for (let day = 0; day <= 800; day += 5) {
      const p = plan({ now: new Date(anchor.getTime() + day * 86_400_000) })
      if (p) targets.add(p.stage)
    }
    expect([...targets].sort()).toEqual(['ONE_YEAR', 'THREE_MONTHS', 'TWO_WEEKS', 'TWO_YEARS'])
  })

  it('CUSTOM reviews do not affect the plan, and a finished thread has nothing to ask', () => {
    expect(plan({ reviewedStages: ['INITIAL', 'CUSTOM'] })?.stage).toBe('TWO_WEEKS')
    expect(plan({ reviewedStages: ['INITIAL', 'TWO_YEARS'] })).toBeNull()
  })
})
