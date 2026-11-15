import { describe, expect, it } from 'vitest'
import { sortByStage, StageConfig, trackedStages } from './stages'

// The shape and values GET /api/config returns today (backend/src/stages.ts).
const config: StageConfig = {
  stages: ['INITIAL', 'ONE_WEEK', 'TWO_WEEKS', 'ONE_MONTH', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR', 'TWO_YEARS', 'CUSTOM'].map(
    (stage) => ({ stage: stage as StageConfig['stages'][number]['stage'], label: stage })
  ),
  nudgeCadence: [
    { stage: 'TWO_WEEKS', label: '2 weeks', offset: { days: 14 } },
    { stage: 'THREE_MONTHS', label: '3 months', offset: { months: 3 } },
    { stage: 'ONE_YEAR', label: '1 year', offset: { months: 12 } },
    { stage: 'TWO_YEARS', label: '2 years', offset: { months: 24 } },
  ],
  consentCopy: 'Email me check-ins at 2 weeks, 3 months, 1 year, and 2 years.',
}

describe('stage lists follow the API (nothing hardcoded)', () => {
  it('the progress stages follow whatever cadence the API returns', () => {
    const other: StageConfig = { ...config, nudgeCadence: [{ stage: 'ONE_MONTH', label: '1 month', offset: { months: 1 } }] }
    expect(trackedStages(other)).toEqual(['INITIAL', 'ONE_MONTH'])
  })
})

describe('stage ordering and progress', () => {
  it('sorts reviews chronologically with TWO_WEEKS between ONE_WEEK and ONE_MONTH, CUSTOM last', () => {
    const sorted = sortByStage(config, [{ stage: 'CUSTOM' }, { stage: 'ONE_MONTH' }, { stage: 'TWO_WEEKS' }, { stage: 'INITIAL' }, { stage: 'ONE_WEEK' }])
    expect(sorted.map((r) => r.stage)).toEqual(['INITIAL', 'ONE_WEEK', 'TWO_WEEKS', 'ONE_MONTH', 'CUSTOM'])
  })

  it('the dashboard progress bar is the first impression plus each check-in', () => {
    expect(trackedStages(config)).toEqual(['INITIAL', 'TWO_WEEKS', 'THREE_MONTHS', 'ONE_YEAR', 'TWO_YEARS'])
  })
})
