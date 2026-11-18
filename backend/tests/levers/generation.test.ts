import Anthropic from '@anthropic-ai/sdk'
import { LeverRunMode, LeverRunStatus, LeverStatus } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { flushLeverRuns, expireStaleRuns, RUN_TIMEOUT_MS } from '../../src/levers/runs'
import { loadLeverConfig, DEFAULT_ANTHROPIC_MODEL } from '../../src/levers/config'
import { api, bearer, cleanup } from '../helpers'
import { addCandidates, createCategory, deleteCategories, fakeClient, liveMode, registerAdmin, resetLeverEnv, validCandidates } from './helpers'

let admin: Awaited<ReturnType<typeof registerAdmin>>
const categoryIds: string[] = []

beforeAll(async () => { admin = await registerAdmin() })
afterAll(async () => {
  resetLeverEnv()
  await deleteCategories(categoryIds)
  await cleanup([admin.id])
})
beforeEach(async () => {
  resetLeverEnv()
  await prisma.leverCandidateRun.deleteMany({ where: { mode: LeverRunMode.LIVE } }) // the daily limit is global
})

async function newCategory() {
  const c = await createCategory()
  categoryIds.push(c.id)
  return c
}

async function runFor(categoryId: string, body: object = {}) {
  const res = await api().post(`/api/admin/categories/${categoryId}/runs`).set(bearer(admin.accessToken)).send(body)
  await flushLeverRuns()
  return res
}

const runRow = (id: string) => prisma.leverCandidateRun.findUniqueOrThrow({ where: { id } })
const candidateCount = (categoryId: string) => prisma.valueLever.count({ where: { categoryId } })

describe('configuration', () => {
  it('defaults to dry run with the documented model, token cap and daily limit', () => {
    expect(loadLeverConfig({})).toEqual({ mode: 'dry_run', model: DEFAULT_ANTHROPIC_MODEL, maxTokens: 16000, dailyLimit: 10, apiKey: undefined })
    expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-opus-5-5')
  })

  it('refuses live mode without an API key, and does not echo a key in errors', () => {
    expect(() => loadLeverConfig({ LEVER_GEN_MODE: 'live' })).toThrow('LEVER_GEN_MODE=live requires ANTHROPIC_API_KEY')
    expect(() => loadLeverConfig({ LEVER_GEN_MODE: 'live', ANTHROPIC_API_KEY: '  ' })).toThrow('requires ANTHROPIC_API_KEY')
    expect(() => loadLeverConfig({ LEVER_GEN_MODE: 'sometimes', ANTHROPIC_API_KEY: 'sk-secret' })).toThrow(/LEVER_GEN_MODE/)
    try { loadLeverConfig({ LEVER_GEN_MODE: 'sometimes', ANTHROPIC_API_KEY: 'sk-secret' }) } catch (e) { expect(String(e)).not.toContain('sk-secret') }
  })

  it('rejects an out-of-range token cap or limit', () => {
    expect(() => loadLeverConfig({ LEVER_GEN_MAX_TOKENS: '100' })).toThrow(/LEVER_GEN_MAX_TOKENS/)
    // Above ~21333 the SDK refuses non-streaming requests; fail at startup, not on every run.
    expect(() => loadLeverConfig({ LEVER_GEN_MAX_TOKENS: '21001' })).toThrow(/at most 21000/)
    expect(loadLeverConfig({ LEVER_GEN_MAX_TOKENS: '21000' }).maxTokens).toBe(21000)
    expect(() => loadLeverConfig({ LEVER_GEN_DAILY_LIMIT: '-1' })).toThrow(/LEVER_GEN_DAILY_LIMIT/)
  })
})

describe('dry run (the default)', () => {
  it('stores fixture candidates without calling the API', async () => {
    const client = fakeClient(() => { throw new Error('the API must not be called in dry run') })
    const c = await newCategory()
    const res = await runFor(c.id)
    expect(res.status).toBe(202)
    expect(res.body.mode).toBe(LeverRunMode.DRY_RUN)
    expect(client.calls).toBe(0)
    const run = await runRow(res.body.runId)
    expect(run).toMatchObject({ status: LeverRunStatus.SUCCEEDED, mode: LeverRunMode.DRY_RUN, model: 'dry-run', error: null })
    expect(run.costUsd?.toString()).toBe('0')
    expect(await candidateCount(c.id)).toBe(10)
    const levers = await prisma.valueLever.findMany({ where: { categoryId: c.id } })
    expect(levers.every((l) => l.status === LeverStatus.CANDIDATE && l.runId === run.id)).toBe(true)
  })

  it('does not count towards the daily limit', async () => {
    process.env.LEVER_GEN_DAILY_LIMIT = '0'
    const c = await newCategory()
    expect((await runFor(c.id)).status).toBe(202)
  })
})

describe('live run with a mocked API', () => {
  it('stores validated candidates with tokens and cost', async () => {
    liveMode()
    const client = fakeClient({ output: validCandidates(12), usage: { inputTokens: 1000, outputTokens: 5000, cacheReadTokens: 0 } })
    const c = await newCategory()
    const res = await runFor(c.id, { notes: 'families who fly' })
    expect(res.status).toBe(202)
    expect(client.calls).toBe(1)
    const run = await runRow(res.body.runId)
    expect(run).toMatchObject({ status: LeverRunStatus.SUCCEEDED, mode: LeverRunMode.LIVE, model: 'claude-opus-5-5', servedModel: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 5000 })
    // 1000 * $4/M + 5000 * $20/M
    expect(run.costUsd?.toString()).toBe('0.104')
    expect(run.input).toMatchObject({ notes: 'families who fly', maxTokens: 16000, effort: 'high' })
    expect(await candidateCount(c.id)).toBe(12)
  })

  it('skips candidates whose names already exist in the category', async () => {
    liveMode()
    fakeClient({ output: validCandidates(10) })
    const c = await newCategory()
    await addCandidates(c.id, [{ name: 'CANDIDATE 1', type: 'BOOLEAN', unit: null }])
    const res = await runFor(c.id)
    expect((await runRow(res.body.runId)).status).toBe(LeverRunStatus.SUCCEEDED)
    expect(await candidateCount(c.id)).toBe(10) // 1 existing + 9 new
  })

  const bad: [string, () => unknown][] = [
    ['9 candidates', () => validCandidates(9)],
    ['13 candidates', () => validCandidates(13)],
    ['a measurement without a unit', () => { const s = validCandidates(); s.candidates[0].unit = null; return s }],
    ['a boolean with a unit', () => { const s = validCandidates(); s.candidates[1].unit = 'lb'; return s }],
    ['an unknown type', () => { const s = validCandidates(); s.candidates[0].type = 'COLOUR'; return s }],
    ['duplicate names (case-insensitive)', () => { const s = validCandidates(); s.candidates[1].name = 'candidate 1 '; return s }],
    ['a multi-line explanation', () => { const s = validCandidates(); s.candidates[2].explanation = 'Line one of it.\nLine two of it.'; return s }],
    ['an empty explanation', () => { const s = validCandidates(); s.candidates[2].explanation = '   '; return s }],
    ['no related needs', () => { const s = validCandidates(); s.candidates[2].relatedNeeds = []; return s }],
    ['an extra field', () => { const s = validCandidates(); return { ...s, candidates: s.candidates.map((c) => ({ ...c, brand: 'Acme' })) } }],
    ['no structured output (parse failed)', () => null],
    ['a string instead of an object', () => 'here are your levers'],
  ]
  it.each(bad)('rejects malformed output: %s; nothing stored, tokens still recorded', async (_label, make) => {
    liveMode()
    fakeClient({ output: make() })
    const c = await newCategory()
    const res = await runFor(c.id)
    const run = await runRow(res.body.runId)
    expect(run).toMatchObject({ status: LeverRunStatus.FAILED, error: 'validation_failed', inputTokens: 1500, outputTokens: 4000 })
    expect(run.output).toBeNull()
    expect(await candidateCount(c.id)).toBe(0)
  })

  it.each(['refusal', 'max_tokens'])('fails the run on stop_reason %s even with valid-looking output', async (stopReason) => {
    liveMode()
    fakeClient({ output: validCandidates(), stopReason })
    const c = await newCategory()
    const run = await runRow((await runFor(c.id)).body.runId)
    expect(run).toMatchObject({ status: LeverRunStatus.FAILED, error: stopReason })
    expect(await candidateCount(c.id)).toBe(0)
  })

  it('records an API error by status only', async () => {
    liveMode()
    fakeClient(() => { throw Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'secret request echo' } }, 'Overloaded', new Headers()) })
    const c = await newCategory()
    const run = await runRow((await runFor(c.id)).body.runId)
    expect(run).toMatchObject({ status: LeverRunStatus.FAILED, error: 'api_error:529' })
    expect(JSON.stringify(run)).not.toContain('secret request echo')
  })

  it('prices a served model name that is not in the table at the requested model\'s price', async () => {
    liveMode()
    fakeClient({ output: validCandidates(), servedModel: 'claude-opus-5-5-20261101', usage: { inputTokens: 1000, outputTokens: 5000, cacheReadTokens: 0 } })
    const c = await newCategory()
    const run = await runRow((await runFor(c.id)).body.runId)
    expect(run.servedModel).toBe('claude-opus-5-5-20261101')
    expect(run.costUsd?.toString()).toBe('0.104')
  })

  it('records a null cost for a model without a price', async () => {
    liveMode({ ANTHROPIC_MODEL: 'claude-future-9' })
    fakeClient({ output: validCandidates(), servedModel: 'claude-future-9' })
    const c = await newCategory()
    const run = await runRow((await runFor(c.id)).body.runId)
    expect(run.status).toBe(LeverRunStatus.SUCCEEDED)
    expect(run.costUsd).toBeNull()
  })
})

describe('daily run limit', () => {
  it('refuses live runs over the limit with 429 and a retry time, and stores no run', async () => {
    liveMode({ LEVER_GEN_DAILY_LIMIT: '2' })
    fakeClient({ output: validCandidates() })
    const c = await newCategory()
    expect((await runFor(c.id)).status).toBe(202)
    expect((await runFor(c.id)).status).toBe(202)
    const before = await prisma.leverCandidateRun.count({ where: { categoryId: c.id } })
    const res = await runFor(c.id)
    expect(res.status).toBe(429)
    expect(res.body.retryAt).toEqual(expect.any(String))
    expect(new Date(res.body.retryAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000)
    expect(await prisma.leverCandidateRun.count({ where: { categoryId: c.id } })).toBe(before)
  })

  it('counts a rolling 24 hours: older runs do not count', async () => {
    liveMode({ LEVER_GEN_DAILY_LIMIT: '1' })
    fakeClient({ output: validCandidates() })
    const c = await newCategory()
    await prisma.leverCandidateRun.create({
      data: { categoryId: c.id, mode: LeverRunMode.LIVE, model: 'm', input: {}, status: LeverRunStatus.SUCCEEDED, createdAt: new Date(Date.now() - 25 * 3600 * 1000) },
    })
    expect((await runFor(c.id)).status).toBe(202)
  })

  it('lets exactly one of two concurrent requests through when one slot is left', async () => {
    liveMode({ LEVER_GEN_DAILY_LIMIT: '1' })
    fakeClient({ output: validCandidates() })
    const c = await newCategory()
    for (let attempt = 0; attempt < 3; attempt++) {
      await prisma.leverCandidateRun.deleteMany({ where: { mode: LeverRunMode.LIVE } })
      const pair = await Promise.all([
        api().post(`/api/admin/categories/${c.id}/runs`).set(bearer(admin.accessToken)).send({}),
        api().post(`/api/admin/categories/${c.id}/runs`).set(bearer(admin.accessToken)).send({}),
      ])
      await flushLeverRuns()
      expect(pair.map((r) => r.status).sort()).toEqual([202, 429])
      expect(await prisma.leverCandidateRun.count({ where: { mode: LeverRunMode.LIVE } })).toBe(1)
    }
  })

  it('LEVER_GEN_DAILY_LIMIT=0 disables live runs', async () => {
    liveMode({ LEVER_GEN_DAILY_LIMIT: '0' })
    fakeClient({ output: validCandidates() })
    const c = await newCategory()
    const res = await runFor(c.id)
    expect(res.status).toBe(429)
    expect(res.body.error).toMatch(/disabled/)
  })
})

describe('stale runs', () => {
  it('fails a run still RUNNING after the timeout', async () => {
    const c = await newCategory()
    const stale = await prisma.leverCandidateRun.create({
      data: { categoryId: c.id, mode: LeverRunMode.LIVE, model: 'm', input: {}, createdAt: new Date(Date.now() - RUN_TIMEOUT_MS - 1000) },
    })
    const fresh = await prisma.leverCandidateRun.create({ data: { categoryId: c.id, mode: LeverRunMode.LIVE, model: 'm', input: {} } })
    await expireStaleRuns()
    expect(await runRow(stale.id)).toMatchObject({ status: LeverRunStatus.FAILED, error: 'timeout' })
    expect((await runRow(fresh.id)).status).toBe(LeverRunStatus.RUNNING)
    // GET /runs/:id expires stale runs before answering, so the admin screen never polls forever.
    const res = await api().get(`/api/admin/runs/${fresh.id}`).set(bearer(admin.accessToken))
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('RUNNING')
  })

  it('a run that already timed out is not overwritten when its late result arrives', async () => {
    liveMode()
    const c = await newCategory()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    fakeClient({}) // replaced below
    const { setLeverClientForTests } = await import('../../src/levers/client')
    setLeverClientForTests({
      async generate() {
        await gate
        return { output: validCandidates(), stopReason: 'end_turn', servedModel: 'claude-opus-5-5', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } }
      },
    })
    const res = await api().post(`/api/admin/categories/${c.id}/runs`).set(bearer(admin.accessToken)).send({})
    await prisma.leverCandidateRun.update({ where: { id: res.body.runId }, data: { createdAt: new Date(Date.now() - RUN_TIMEOUT_MS - 1000) } })
    await expireStaleRuns()
    release()
    await flushLeverRuns()
    // The late call was billed: its usage is recorded on the failed run.
    expect(await runRow(res.body.runId)).toMatchObject({ status: LeverRunStatus.FAILED, error: 'timeout', inputTokens: 1, outputTokens: 1 })
    expect(await candidateCount(c.id)).toBe(0)
  })

  it('a late failure (e.g. invalid output) also records its usage on a run that already timed out', async () => {
    liveMode()
    const c = await newCategory()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const { setLeverClientForTests } = await import('../../src/levers/client')
    setLeverClientForTests({
      async generate() {
        await gate
        return { output: { candidates: [] }, stopReason: 'end_turn', servedModel: 'claude-opus-5-5', usage: { inputTokens: 7, outputTokens: 9, cacheReadTokens: 0 } }
      },
    })
    const res = await api().post(`/api/admin/categories/${c.id}/runs`).set(bearer(admin.accessToken)).send({})
    await prisma.leverCandidateRun.update({ where: { id: res.body.runId }, data: { createdAt: new Date(Date.now() - RUN_TIMEOUT_MS - 1000) } })
    await expireStaleRuns()
    release()
    await flushLeverRuns()
    expect(await runRow(res.body.runId)).toMatchObject({ status: LeverRunStatus.FAILED, error: 'timeout', inputTokens: 7, outputTokens: 9 })
  })

  it('the API call can never outlast the run timeout (timeout × attempts < RUN_TIMEOUT_MS)', async () => {
    const { REQUEST_TIMEOUT_MS, MAX_RETRIES } = await import('../../src/levers/client')
    expect(REQUEST_TIMEOUT_MS * (MAX_RETRIES + 1) + 60_000).toBeLessThan(RUN_TIMEOUT_MS)
  })
})

describe('real client guard', () => {
  it('the real Anthropic client cannot be constructed in tests', async () => {
    const { leverClient, setLeverClientForTests } = await import('../../src/levers/client')
    setLeverClientForTests(null)
    expect(() => leverClient()).toThrow(/Tests must inject/)
  })
})
