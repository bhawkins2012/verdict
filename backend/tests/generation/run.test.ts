// The generation run end to end with a stub model and a fake web (docs/adr-generation-run.md D5, section 5):
// stages, automated product approval and the needs-attention list, brand confirmation, PDFs, caps, resume,
// stuck-stage detection, retention and model failures.
import {
  CatalogStatus, FetchedKind, GenerationRunStatus, ItemStatus, LeverOrigin, RunStage, StageStatus, ValueStatus,
} from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { flushGenerationRuns, reconcileGeneration, STALE_MS } from '../../src/generation/runs'
import { CapError, reserveCall, runSpendUsd, worstCaseUsd } from '../../src/generation/costs'
import { DISCOVERY_MAX_SEARCHES, MAX_PAUSE_RESUMES } from '../../src/generation/model'
import { setTransactionalProviderForTests } from '../../src/auth/mailer'
import { makeTextPdf } from '../../src/generation/fixtures/pdf'
import { api, bearer, cleanup } from '../helpers'
import { mockProvider } from '../nudges/fixtures'
import {
  deleteTree, FakeWeb, forgetHosts, homePage, leverSet, liveMode, PLACEMENT, productPage, registerAdmin, resetGenerationEnv, StubModel,
  testTree, TestTree, uid,
} from './helpers'

let admin: Awaited<ReturnType<typeof registerAdmin>>
const trees: TestTree[] = []
const hosts: string[] = []
const mail = mockProvider()

beforeAll(async () => {
  admin = await registerAdmin()
  setTransactionalProviderForTests(mail.provider)
})
afterEach(() => resetGenerationEnv())
afterAll(async () => {
  setTransactionalProviderForTests(null)
  for (const t of trees) await deleteTree(t)
  await forgetHosts(hosts)
  await cleanup([admin.id])
})

interface Spec { brand: string; host: string; model: string; title?: string; specs?: string[]; links?: { href: string; text: string }[]; fit?: 'HIGH' | 'MEDIUM' | 'LOW'; status?: number }

/** A brand site with verified-looking home page and product pages. */
function web(specs: Spec[], extra: (w: FakeWeb) => void = () => undefined) {
  const w = new FakeWeb()
  for (const s of specs) {
    hosts.push(s.host)
    w.set(`https://${s.host}/robots.txt`, { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' })
    if (!w.routes.has(`https://${s.host}/`)) w.page(`https://${s.host}/`, homePage(s.brand))
    w.set(`https://${s.host}/p/${encodeURIComponent(s.model)}`, s.status
      ? { status: s.status }
      : { body: productPage(`${s.brand} ${s.model}`, s.specs ?? ['Weight: 9 lb'], { links: s.links, title: s.title }) })
  }
  extra(w)
  w.install()
  return w
}

const url = (s: Spec) => `https://${s.host}/p/${encodeURIComponent(s.model)}`

/** A stub model that proposes these products and extracts "Weight: N lb" as lever L1. */
function model(specs: Spec[], levers = leverSet(10)) {
  return new StubModel({
    place: { output: PLACEMENT },
    levers: { output: levers },
    discover: { output: { products: specs.map((s) => ({ brand: s.brand, model: s.model, manufacturerUrl: url(s), rationale: 'Popular.' })) }, stopReason: 'tool_use' },
    extract: (input: never) => {
      const i = input as { product: { url: string }; levers: { key: string }[]; documents: { key: string; text: string }[] }
      const s = specs.find((x) => url(x) === i.product.url)
      const weight = /Weight: (\d+(?:\.\d+)?) lb/.exec(i.documents.map((d) => d.text).join('\n'))
      const doc = i.documents.find((d) => /Weight:/.test(d.text))
      return {
        output: {
          nodeFit: { belongs: s?.fit !== 'LOW', confidence: s?.fit ?? 'HIGH', reason: s?.fit && s.fit !== 'HIGH' ? 'Looks like another type.' : 'Clearly this type.' },
          values: i.levers.map((l, n) => n === 0 && weight && doc
            ? { lever: l.key, found: true, statedValue: weight[1], statedUnit: 'lb', dimensions: null, items: null, choice: null, bool: null, oneHandFold: null, quote: `Weight: ${weight[1]} lb`, source: doc.key, confidence: 'HIGH' }
            : { lever: l.key, found: false, statedValue: null, statedUnit: null, dimensions: null, items: null, choice: null, bool: null, oneHandFold: null, quote: null, source: null, confidence: 'HIGH' }),
        },
      }
    },
  }).install()
}

function specs(n: number, brand = `Acme${uid()}`): Spec[] {
  const host = `${brand.toLowerCase()}.example`
  return Array.from({ length: n }, (_, i) => ({ brand, host, model: `Glide ${i + 1}`, specs: [`Weight: ${9 + i} lb`] }))
}

async function run(tree: TestTree) {
  const res = await api().post(`/api/admin/nodes/${tree.nodeId}/runs`).set(bearer(admin.accessToken)).send({})
  expect(res.status).toBe(202)
  await flushGenerationRuns()
  return prisma.generationRun.findUniqueOrThrow({ where: { id: res.body.runId }, include: { stages: true } })
}

const products = (runId: string) => prisma.product.findMany({ where: { discoveredByRunId: runId }, orderBy: { name: 'asc' } })

describe('a run end to end', () => {
  it('runs every stage, approves products that pass every check, stores values with evidence, and notifies once', async () => {
    const tree = await testTree(); trees.push(tree)
    const s = specs(10)
    web(s)
    model(s)
    mail.sent.length = 0
    const r = await run(tree)
    expect(r.status).toBe(GenerationRunStatus.READY_FOR_REVIEW)
    expect(r.stages.map((x) => [x.stage, x.status]).sort()).toEqual([
      [RunStage.DISCOVER, StageStatus.DONE], [RunStage.EXTRACT, StageStatus.DONE], [RunStage.LEVERS, StageStatus.DONE],
      [RunStage.PLACE, StageStatus.DONE], [RunStage.VERIFY, StageStatus.DONE],
    ])
    const ps = await products(r.id)
    expect(ps).toHaveLength(10)
    expect(ps.every((p) => p.catalogStatus === CatalogStatus.APPROVED && p.approvedVia === 'AUTO')).toBe(true)
    // Ten candidate levers on the node; the first has a value with its quote for every product.
    const levers = await prisma.nodeLever.findMany({ where: { nodeId: tree.nodeId }, orderBy: { createdAt: 'asc' } })
    expect(levers).toHaveLength(10)
    const values = await prisma.productLeverValue.findMany({ where: { runId: r.id, definitionId: levers[0].definitionId } })
    expect(values).toHaveLength(10)
    expect(values.every((v) => !v.isUnknown && v.status === ValueStatus.PROPOSED && v.evidenceQuote?.startsWith('Weight:') && v.sourceUrl?.startsWith('https://'))).toBe(true)
    const unknowns = await prisma.productLeverValue.count({ where: { runId: r.id, isUnknown: true, unknownReason: 'not_stated' } })
    expect(unknowns).toBe(90)
    // Fetched text is kept for at most 24 hours.
    const page = await prisma.fetchedPage.findFirstOrThrow({ where: { runId: r.id, kind: FetchedKind.PAGE } })
    expect(page.expiresAt.getTime() - page.fetchedAt.getTime()).toBe(24 * 60 * 60 * 1000)
    // The admin who started it gets one email.
    const name = (await prisma.taxonomyNode.findUniqueOrThrow({ where: { id: tree.nodeId } })).name
    expect(mail.sent.filter((m) => m.subject === `Ready for review: ${name}`)).toHaveLength(1)
  })

  it('failed checks go to "needs attention" with the check and reason, and do not stop the run', async () => {
    const tree = await testTree(); trees.push(tree)
    const base = specs(10)
    const id = uid()
    const odd: Spec[] = [
      { brand: base[0].brand, host: base[0].host, model: 'Wrong Name', title: 'Something Else Entirely' },
      { brand: base[0].brand, host: base[0].host, model: 'Maybe', fit: 'MEDIUM' },
      { brand: base[0].brand, host: base[0].host, model: 'Unlikely', fit: 'LOW' },
      { brand: base[0].brand, host: base[0].host, model: 'Twin' },
      { brand: `Petal${id}`, host: `petal${id}-deals.example`, model: 'Bloom' },
      { brand: 'Amazon', host: 'www.amazon.com', model: 'Basics' },
      { brand: base[0].brand, host: base[0].host, model: 'Gone', status: 403 },
    ]
    const w = web([...base, ...odd], (x) => x.page(`https://petal${id}-deals.example/`, homePage('Deal Depot')))
    // A product with the same brand and name already sits in another node.
    await prisma.product.create({ data: { name: 'Twin', brand: base[0].brand, category: 'x', nodeId: tree.otherNodeId } })
    model([...base, ...odd])
    const r = await run(tree)
    expect(r.status).toBe(GenerationRunStatus.READY_FOR_REVIEW)
    const ps = await products(r.id)
    const by = (m: string) => ps.find((p) => p.name === m)
    expect(by('Wrong Name')).toMatchObject({ catalogStatus: CatalogStatus.NEEDS_ATTENTION, attentionCheck: 'modelNamed' })
    expect(by('Maybe')).toMatchObject({ catalogStatus: CatalogStatus.NEEDS_ATTENTION, attentionCheck: 'nodeFit' })
    expect(by('Unlikely')).toMatchObject({ catalogStatus: CatalogStatus.NEEDS_ATTENTION, attentionCheck: 'nodeFit' })
    expect(by('Twin')).toMatchObject({ catalogStatus: CatalogStatus.NEEDS_ATTENTION, attentionCheck: 'duplicate' })
    expect(by('Bloom')).toMatchObject({ catalogStatus: CatalogStatus.NEEDS_ATTENTION, attentionCheck: 'brand_domain' })
    // A retailer URL is dropped at discovery: no product row at all.
    expect(by('Basics')).toBeUndefined()
    expect(r.stages.find((x) => x.stage === RunStage.DISCOVER)?.output).toMatchObject({ droppedRetailers: 1 })
    expect(by('Gone')).toMatchObject({ catalogStatus: CatalogStatus.NEEDS_ATTENTION, attentionCheck: 'fetch' })
    expect(by('Gone')?.attentionReason).toMatch(/BLOCKED/)
    expect(ps.filter((p) => p.catalogStatus === CatalogStatus.APPROVED)).toHaveLength(10)
    // Nothing was ever requested from the retailer.
    expect(w.urls().some((u) => u.includes('amazon'))).toBe(false)
    // The lookalike's product waits for an admin; its domain is on the confirm list.
    const bloomItem = await prisma.extractionItem.findFirstOrThrow({ where: { runId: r.id, productId: by('Bloom')?.id } })
    expect(bloomItem.status).toBe(ItemStatus.WAITING)
    const brands = await api().get('/api/admin/brands?status=PENDING_CONFIRMATION').set(bearer(admin.accessToken))
    const pending = brands.body.find((b: { host: string }) => b.host === `petal${id}-deals.example`)
    expect(pending.waitingProducts).toEqual(['Bloom'])

    // One click: the domain is verified and the waiting product is processed (and approved: its checks pass).
    w.page(`https://petal${id}-deals.example/p/Bloom`, productPage(`Petal${id} Bloom`, ['Weight: 8 lb']))
    const confirm = await api().post(`/api/admin/brands/${pending.id}/confirm`).set(bearer(admin.accessToken))
    expect(confirm.status).toBe(200)
    expect(confirm.body.requeued).toBe(1)
    await flushGenerationRuns()
    expect(await prisma.product.findUniqueOrThrow({ where: { id: by('Bloom')?.id } })).toMatchObject({ catalogStatus: CatalogStatus.APPROVED, approvedVia: 'AUTO' })
    expect(await prisma.brandDomain.findUniqueOrThrow({ where: { host: `petal${id}-deals.example` } })).toMatchObject({ status: 'VERIFIED', verifiedVia: 'ADMIN' })

    // An admin can approve a needs-attention product by hand.
    const approve = await api().post('/api/admin/products/approve').set(bearer(admin.accessToken)).send({ productIds: [by('Maybe')?.id] })
    expect(approve.body.approved).toBe(1)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: by('Maybe')?.id } })).toMatchObject({ catalogStatus: CatalogStatus.APPROVED, approvedVia: 'ADMIN' })
  })

  it('reads text-based PDF manuals linked from the page, and skips scanned ones', async () => {
    const tree = await testTree(); trees.push(tree)
    const s = specs(10)
    const pdfHost = `cdn${uid()}.example`
    hosts.push(pdfHost)
    s[0].specs = ['Colour: grey']
    s[0].links = [{ href: `https://${pdfHost}/glide-manual.pdf`, text: 'User manual (PDF)' }, { href: '/scan.pdf', text: 'Instructions (PDF)' }]
    web(s, (w) => {
      w.set(`https://${pdfHost}/robots.txt`, { status: 404 })
      w.set(`https://${pdfHost}/glide-manual.pdf`, { type: 'application/pdf', body: makeTextPdf([['Owner manual', 'Weight: 12.5 lb'], ['Read this manual before using the product.']]) })
      w.set(`https://${s[0].host}/scan.pdf`, { type: 'application/pdf', body: makeTextPdf([[], []]) })
    })
    model(s)
    const r = await run(tree)
    const p = (await products(r.id)).find((x) => x.name === 'Glide 1')
    const lever = await prisma.nodeLever.findFirstOrThrow({ where: { nodeId: tree.nodeId }, orderBy: { createdAt: 'asc' } })
    const v = await prisma.productLeverValue.findUniqueOrThrow({ where: { productId_definitionId: { productId: p?.id ?? '', definitionId: lever.definitionId } } })
    expect(v).toMatchObject({ isUnknown: false, valueNumber: 12.5, sourceUrl: `https://${pdfHost}/glide-manual.pdf` })
    const item = await prisma.extractionItem.findFirstOrThrow({ where: { runId: r.id, productId: p?.id } })
    expect(item.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'pdf', outcome: 'OK', url: `https://${pdfHost}/glide-manual.pdf` }),
      expect.objectContaining({ kind: 'pdf', outcome: 'SCANNED_PDF' }),
    ]))
  }, 30_000)

  it('accepts 10 to 14 products with a warning, and fails below 10 without storing any', async () => {
    const a = await testTree(); trees.push(a)
    const twelve = specs(12)
    web(twelve); model(twelve)
    const ra = await run(a)
    expect(ra.status).toBe(GenerationRunStatus.READY_FOR_REVIEW)
    expect(ra.warning).toMatch(/Only 12 products found/)

    const b = await testTree(); trees.push(b)
    const nine = specs(9)
    web(nine); model(nine)
    const rb = await run(b)
    expect(rb.status).toBe(GenerationRunStatus.FAILED)
    expect(rb.stages.find((x) => x.stage === RunStage.DISCOVER)).toMatchObject({ status: StageStatus.FAILED })
    expect(rb.error).toMatch(/too_few_products/)
    expect(await prisma.product.count({ where: { discoveredByRunId: rb.id } })).toBe(0)
  })

  it('a re-extraction never overwrites an accepted value', async () => {
    const tree = await testTree(); trees.push(tree)
    const s = specs(10)
    const w = web(s); model(s)
    const r1 = await run(tree)
    const lever = await prisma.nodeLever.findFirstOrThrow({ where: { nodeId: tree.nodeId }, orderBy: { createdAt: 'asc' } })
    const v = await prisma.productLeverValue.findFirstOrThrow({ where: { runId: r1.id, definitionId: lever.definitionId } })
    await api().post(`/api/admin/values/${v.id}/accept`).set(bearer(admin.accessToken)).expect(200)
    await api().post(`/api/admin/runs/${r1.id}/cancel`).set(bearer(admin.accessToken))
    // The pages change; a second run extracts again.
    for (const x of s) w.page(url(x), productPage(`${x.brand} ${x.model}`, ['Weight: 99 lb']))
    model(s)
    await run(tree)
    const after = await prisma.productLeverValue.findUniqueOrThrow({ where: { id: v.id } })
    expect(after).toMatchObject({ status: ValueStatus.ACCEPTED, valueNumber: v.valueNumber })
    const others = await prisma.productLeverValue.findMany({ where: { definitionId: lever.definitionId, id: { not: v.id }, product: { nodeId: tree.nodeId } } })
    expect(others.every((o) => o.valueNumber === 99)).toBe(true)
  })

  it('a re-extraction never overwrites a value an admin corrected (still proposed)', async () => {
    const tree = await testTree(); trees.push(tree)
    const s = specs(10)
    const w = web(s); model(s)
    const r1 = await run(tree)
    const lever = await prisma.nodeLever.findFirstOrThrow({ where: { nodeId: tree.nodeId }, orderBy: { createdAt: 'asc' } })
    const v = await prisma.productLeverValue.findFirstOrThrow({ where: { runId: r1.id, definitionId: lever.definitionId } })
    await api().patch(`/api/admin/values/${v.id}`).set(bearer(admin.accessToken)).send({ number: 42 }).expect(200)
    await api().post(`/api/admin/runs/${r1.id}/cancel`).set(bearer(admin.accessToken))
    for (const x of s) w.page(url(x), productPage(`${x.brand} ${x.model}`, ['Weight: 99 lb']))
    model(s)
    await run(tree)
    const after = await prisma.productLeverValue.findUniqueOrThrow({ where: { id: v.id } })
    expect(after.status).toBe(ValueStatus.PROPOSED)
    expect(Number(after.valueNumber)).toBe(42)
    expect(after.editedAt).not.toBeNull()
  })
})

describe('model output and failures', () => {
  it('a lever set outside the rules fails the stage and stores nothing', async () => {
    const tree = await testTree(); trees.push(tree)
    const s = specs(10)
    web(s)
    model(s, leverSet(9))
    const r = await run(tree)
    expect(r.status).toBe(GenerationRunStatus.FAILED)
    expect(r.error).toMatch(/LEVERS: validation_failed/)
    expect(await prisma.nodeLever.count({ where: { nodeId: tree.nodeId } })).toBe(0)
  })

  it('an unknown definition id to reuse fails validation', async () => {
    const tree = await testTree(); trees.push(tree)
    const s = specs(10)
    web(s)
    const set = leverSet(10)
    set.candidates[0] = { reuseDefinitionId: 'no-such-definition', definition: null, note: null }
    model(s, set)
    const r = await run(tree)
    expect(r.error).toMatch(/unknown definition id/)
  })

  it('reuses shared definitions instead of duplicating them', async () => {
    const tree = await testTree(); trees.push(tree)
    const s = specs(10)
    web(s)
    const set = leverSet(10)
    const existing = await prisma.leverDefinition.create({ data: { name: `Shared ${uid()}`, nameKey: `shared ${uid()}`, type: 'BOOLEAN', explanation: 'Shared lever for testing.', relatedNeeds: [], allowedValues: [], origin: LeverOrigin.ADMIN } })
    set.candidates[1] = { reuseDefinitionId: existing.id, definition: null, note: 'reused' }
    model(s, set)
    const r = await run(tree)
    expect(r.status).toBe(GenerationRunStatus.READY_FOR_REVIEW)
    expect(await prisma.nodeLever.findFirst({ where: { nodeId: tree.nodeId, definitionId: existing.id } })).not.toBeNull()
  })

  it('a refusal fails the stage', async () => {
    const tree = await testTree(); trees.push(tree)
    const s = specs(10)
    web(s)
    const m = model(s)
    m.answers.place = { output: null, stopReason: 'refusal' }
    const r = await run(tree)
    expect(r.error).toBe('PLACE: refusal')
  })
})

describe('caps, resume and stuck stages', () => {
  it('a call that could exceed the run cap is not made; the run stalls with run_cap', async () => {
    liveMode({ GENERATION_RUN_CAP_USD: '0.01' })
    const tree = await testTree(); trees.push(tree)
    const s = specs(10)
    web(s)
    const m = model(s)
    const r = await run(tree)
    expect(r.status).toBe(GenerationRunStatus.STALLED)
    expect(r.error).toBe('PLACE: run_cap')
    expect(m.calls.place).toBe(0)
    expect(await prisma.generationCall.count({ where: { runId: r.id } })).toBe(0)
  })

  it('the daily cap holds across runs, and two concurrent reservations at the limit cannot both pass', async () => {
    const tree = await testTree(); trees.push(tree)
    const runs = await Promise.all([0, 1].map(() => prisma.generationRun.create({ data: { nodeId: tree.nodeId, kind: 'NODE', mode: 'LIVE', model: 'claude-opus-5-5', capUsd: 100, status: 'CANCELLED' } })))
    const daySpent = Number((await prisma.$queryRaw<{ s: number | null }[]>`SELECT SUM(COALESCE("costUsd","reservedUsd"))::float AS s FROM "generation_calls" WHERE "createdAt" >= now() - interval '24 hours'`)[0]?.s ?? 0)
    const cap = daySpent + 1.5
    const results = await Promise.allSettled(runs.map((r) => reserveCall({ runId: r.id, stage: RunStage.EXTRACT, model: 'claude-opus-5-5', reservedUsd: 1, runCapUsd: 100, dailyCapUsd: cap })))
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((x): x is PromiseRejectedResult => x.status === 'rejected')
    expect(rejected?.reason).toBeInstanceOf(CapError)
    expect((rejected?.reason as CapError).cap).toBe('daily_cap')
    await prisma.generationCall.deleteMany({ where: { runId: { in: runs.map((r) => r.id) } } })
  })

  it('resume continues from the stage that stopped, without repeating earlier stages', async () => {
    const tree = await testTree(); trees.push(tree)
    const s = specs(10)
    web(s)
    const m = model(s)
    const good = m.answers.levers
    m.answers.levers = () => { throw new Error('boom') }
    const r = await run(tree)
    expect(r.status).toBe(GenerationRunStatus.FAILED)
    expect(r.error).toBe('LEVERS: api_error:unknown')
    expect(m.calls).toMatchObject({ place: 1, levers: 1 })
    m.answers.levers = good
    expect((await api().post(`/api/admin/runs/${r.id}/resume`).set(bearer(admin.accessToken))).status).toBe(202)
    await flushGenerationRuns()
    const after = await prisma.generationRun.findUniqueOrThrow({ where: { id: r.id } })
    expect(after.status).toBe(GenerationRunStatus.READY_FOR_REVIEW)
    expect(m.calls.place).toBe(1)
    expect(m.calls.levers).toBe(2)
    expect(m.calls.extract).toBe(10)
  })

  it('a stage that stops heartbeating is marked stalled; stale items go back to pending', async () => {
    const tree = await testTree(); trees.push(tree)
    const old = new Date(Date.now() - STALE_MS - 60_000)
    const r = await prisma.generationRun.create({
      data: { nodeId: tree.nodeId, kind: 'NODE', mode: 'DRY_RUN', model: 'dry-run', capUsd: 10, stages: { create: [{ stage: RunStage.EXTRACT, status: StageStatus.RUNNING, heartbeatAt: old }] } },
    })
    const product = await prisma.product.create({ data: { name: 'Stale', category: 'x', nodeId: tree.nodeId } })
    await prisma.extractionItem.create({ data: { runId: r.id, productId: product.id, status: ItemStatus.RUNNING, heartbeatAt: old } })
    await reconcileGeneration()
    expect(await prisma.generationRun.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: GenerationRunStatus.STALLED, error: 'EXTRACT: stalled' })
    expect(await prisma.generationRunStage.findFirstOrThrow({ where: { runId: r.id } })).toMatchObject({ status: StageStatus.STALLED })
    expect(await prisma.extractionItem.findFirstOrThrow({ where: { runId: r.id } })).toMatchObject({ status: ItemStatus.PENDING })
  })

  it('discovery reserves the worst case of every request it may make (pause_turn resumes included)', async () => {
    liveMode({ GENERATION_RUN_CAP_USD: '1000', GENERATION_DAILY_CAP_USD: '10000' })
    const tree = await testTree(); trees.push(tree)
    const s = specs(10)
    web(s); model(s)
    const r = await run(tree)
    const call = await prisma.generationCall.findFirstOrThrow({ where: { runId: r.id, stage: RunStage.DISCOVER } })
    const one = worstCaseUsd('claude-opus-5-5', 4_000, Number(process.env.GENERATION_MAX_TOKENS ?? 16000), DISCOVERY_MAX_SEARCHES, DISCOVERY_MAX_SEARCHES * 10_000)
    expect(Number(call.reservedUsd)).toBeCloseTo((one ?? 0) * (MAX_PAUSE_RESUMES + 1), 4)
  })

  it('a live call that fails without usage keeps counting its reservation (cost stays null, not 0)', async () => {
    liveMode({ GENERATION_RUN_CAP_USD: '1000', GENERATION_DAILY_CAP_USD: '10000' })
    const tree = await testTree(); trees.push(tree)
    const s = specs(10)
    web(s)
    const m = model(s)
    m.answers.place = () => { throw new Error('boom') }
    const r = await run(tree)
    const call = await prisma.generationCall.findFirstOrThrow({ where: { runId: r.id, stage: RunStage.PLACE } })
    expect(call.costUsd).toBeNull()
    expect(Number(call.reservedUsd)).toBeGreaterThan(0)
    expect(await runSpendUsd(r.id)).toBeCloseTo(Number(call.reservedUsd), 6)
  })

  it('resume puts back only items whose worker stopped; a live item is not run twice', async () => {
    const tree = await testTree(); trees.push(tree)
    const r = await prisma.generationRun.create({ data: { nodeId: tree.nodeId, kind: 'NODE', mode: 'DRY_RUN', model: 'dry-run', capUsd: 10, status: 'READY_FOR_REVIEW' } })
    const [a, b] = await Promise.all(['Live', 'Stopped'].map((name) => prisma.product.create({ data: { name: `${name} ${uid()}`, category: 'x', nodeId: tree.nodeId } })))
    const live = await prisma.extractionItem.create({ data: { runId: r.id, productId: a.id, status: ItemStatus.RUNNING, heartbeatAt: new Date() } })
    const stopped = await prisma.extractionItem.create({ data: { runId: r.id, productId: b.id, status: ItemStatus.RUNNING, heartbeatAt: new Date(Date.now() - STALE_MS - 60_000) } })
    expect((await api().post(`/api/admin/runs/${r.id}/resume`).set(bearer(admin.accessToken))).status).toBe(202)
    await flushGenerationRuns()
    expect(await prisma.extractionItem.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ status: ItemStatus.RUNNING, attempts: live.attempts })
    expect(await prisma.extractionItem.findUniqueOrThrow({ where: { id: stopped.id } })).toMatchObject({ status: ItemStatus.DONE, attempts: stopped.attempts + 1 })
    await prisma.extractionItem.deleteMany({ where: { runId: r.id } })
  })

  it('one open run per node', async () => {
    const tree = await testTree(); trees.push(tree)
    await prisma.generationRun.create({ data: { nodeId: tree.nodeId, kind: 'NODE', mode: 'DRY_RUN', model: 'dry-run', capUsd: 10, status: 'STALLED' } })
    const res = await api().post(`/api/admin/nodes/${tree.nodeId}/runs`).set(bearer(admin.accessToken)).send({})
    expect(res.status).toBe(409)
  })
})

describe('retention of fetched text', () => {
  it('expired text is purged and never kept longer than 24 hours', async () => {
    const now = new Date()
    const expired = await prisma.fetchedPage.create({ data: { url: 'https://x.example/', kind: FetchedKind.PAGE, text: 't', contentHash: 'h', fetchedAt: new Date(now.getTime() - 25 * 3600_000), expiresAt: new Date(now.getTime() - 3600_000) } })
    const fresh = await prisma.fetchedPage.create({ data: { url: 'https://x.example/', kind: FetchedKind.PAGE, text: 't', contentHash: 'h', fetchedAt: now, expiresAt: new Date(now.getTime() + 3600_000) } })
    await reconcileGeneration()
    expect(await prisma.fetchedPage.findUnique({ where: { id: expired.id } })).toBeNull()
    expect(await prisma.fetchedPage.findUnique({ where: { id: fresh.id } })).not.toBeNull()
    await prisma.fetchedPage.delete({ where: { id: fresh.id } })
    await expect(prisma.fetchedPage.create({ data: { url: 'https://x.example/', kind: FetchedKind.PAGE, text: 't', contentHash: 'h', fetchedAt: now, expiresAt: new Date(now.getTime() + 25 * 3600_000) } })).rejects.toThrow(/fetched_pages_expires_within_a_day/)
  })
})
