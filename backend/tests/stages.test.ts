import { ReviewStage } from '@prisma/client'
import request from 'supertest'
import type { Express } from 'express'
import { CadenceEntry, consentCopy, NUDGE_CADENCE, STAGE_ORDER, stageRank } from '../src/stages'
import { addOffset } from '../src/nudges/planner'

const EXACT_COPY = 'Email me check-ins at 2 weeks, 3 months, 1 year, and 2 years.'

describe('stage order and cadence (single source of truth)', () => {
  it('STAGE_ORDER lists every ReviewStage exactly once, CUSTOM last', () => {
    expect([...STAGE_ORDER].sort()).toEqual(Object.values(ReviewStage).sort())
    expect(new Set(STAGE_ORDER).size).toBe(STAGE_ORDER.length)
    expect(STAGE_ORDER[STAGE_ORDER.length - 1]).toBe('CUSTOM')
    expect(STAGE_ORDER.indexOf('TWO_WEEKS')).toBe(STAGE_ORDER.indexOf('ONE_WEEK') + 1)
  })

  it('the cadence is in chronological order, by rank and by due date', () => {
    const anchor = new Date('2026-01-31T00:00:00Z')
    for (let i = 1; i < NUDGE_CADENCE.length; i++) {
      expect(stageRank(NUDGE_CADENCE[i].stage)).toBeGreaterThan(stageRank(NUDGE_CADENCE[i - 1].stage))
      expect(addOffset(anchor, NUDGE_CADENCE[i].offset).getTime()).toBeGreaterThan(addOffset(anchor, NUDGE_CADENCE[i - 1].offset).getTime())
    }
  })

  it('the consent copy is exactly the approved text for the current cadence', () => {
    expect(consentCopy()).toBe(EXACT_COPY)
  })

  it('the consent copy is generated from the cadence it is given', () => {
    const two: CadenceEntry[] = [{ stage: 'ONE_MONTH', offset: { months: 1 } }, { stage: 'ONE_YEAR', offset: { months: 12 } }]
    expect(consentCopy(two)).toBe('Email me check-ins at 1 month and 1 year.')
    expect(consentCopy(two.slice(0, 1))).toBe('Email me check-ins at 1 month.')
  })
})

describe('GET /api/config', () => {
  afterEach(() => {
    jest.resetModules()
    jest.dontMock('../src/stages')
  })

  it('serves stage order, the cadence with labels and offsets, and the consent copy (no auth)', async () => {
    const { app } = await import('../src/app')
    const res = await request(app).get('/api/config')
    expect(res.status).toBe(200)
    expect(res.body.stages.map((s: { stage: string }) => s.stage)).toEqual(STAGE_ORDER)
    expect(res.body.nudgeCadence).toEqual([
      { stage: 'TWO_WEEKS', label: '2 weeks', offset: { days: 14 } },
      { stage: 'THREE_MONTHS', label: '3 months', offset: { months: 3 } },
      { stage: 'ONE_YEAR', label: '1 year', offset: { months: 12 } },
      { stage: 'TWO_YEARS', label: '2 years', offset: { months: 24 } },
    ])
    expect(res.body.consentCopy).toBe(EXACT_COPY)
  })

  it('cannot drift: with a different cadence, the API copy follows it (fails if the copy is hardcoded)', async () => {
    jest.resetModules()
    jest.doMock('../src/stages', () => {
      const actual = jest.requireActual<typeof import('../src/stages')>('../src/stages')
      const cadence: CadenceEntry[] = [{ stage: 'ONE_MONTH', offset: { months: 1 } }, { stage: 'SIX_MONTHS', offset: { months: 6 } }]
      return { ...actual, NUDGE_CADENCE: cadence, stageConfig: () => actual.stageConfig(cadence) }
    })
    const { app } = (await import('../src/app')) as { app: Express }
    const res = await request(app).get('/api/config')
    expect(res.body.nudgeCadence.map((c: { stage: string }) => c.stage)).toEqual(['ONE_MONTH', 'SIX_MONTHS'])
    expect(res.body.consentCopy).toBe('Email me check-ins at 1 month and 6 months.')
  })
})
