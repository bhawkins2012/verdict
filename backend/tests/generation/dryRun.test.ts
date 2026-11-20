// The Infant car seats dry run end to end (docs/adr-generation-run.md D11): the dry-run model and the fixture
// pages through the real fetcher (only the clock is faked), then review and publish through the API.
import { CatalogStatus, ItemStatus, LeverStatus, ValueStatus } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { flushGenerationRuns } from '../../src/generation/runs'
import { Fetcher, setFetcherForTests } from '../../src/generation/fetch/fetcher'
import { fixtureTransport } from '../../src/generation/fixtures/site'
import { INFANT_CAR_SEATS } from '../../src/generation/fixtures/infantCarSeats'
import { hostKey } from '../../src/generation/fetch/hosts'
import { api, bearer, cleanup } from '../helpers'
import { registerAdmin, resetGenerationEnv } from './helpers'

let admin: Awaited<ReturnType<typeof registerAdmin>>
let nodeId = ''
const hosts = INFANT_CAR_SEATS.brands.map((b) => hostKey(b.host))

async function reset() {
  const node = await prisma.taxonomyNode.findUniqueOrThrow({ where: { slug: 'infant-car-seats' } })
  nodeId = node.id
  await prisma.publishedLeverValue.deleteMany({ where: { nodeId } })
  await prisma.nodeLever.updateMany({ where: { nodeId, status: LeverStatus.APPROVED }, data: { status: LeverStatus.CANDIDATE, position: null } })
  await prisma.taxonomyNode.update({ where: { id: nodeId }, data: { publishedAt: null } })
  await prisma.product.deleteMany({ where: { nodeId } })
  await prisma.nodeLever.deleteMany({ where: { nodeId } })
  await prisma.generationRun.deleteMany({ where: { nodeId } })
  await prisma.brandDomain.deleteMany({ where: { host: { in: hosts } } })
  await prisma.fetchHost.deleteMany({ where: { host: { in: hosts } } })
}

beforeAll(async () => {
  admin = await registerAdmin()
  await reset()
  let clock = Date.now()
  setFetcherForTests(new Fetcher({ transport: fixtureTransport(), now: () => clock, sleep: async (ms) => { clock += ms }, retryDelayMs: 0 }))
})
afterAll(async () => {
  resetGenerationEnv()
  await reset()
  await cleanup([admin.id])
})

const as = () => bearer(admin.accessToken)

it('generates, verifies, extracts, is reviewed and published', async () => {
  const start = await api().post(`/api/admin/nodes/${nodeId}/runs`).set(as()).send({})
  expect(start.status).toBe(202)
  expect(start.body).toMatchObject({ mode: 'DRY_RUN', kind: 'NODE', estimateUsd: 0 })
  await flushGenerationRuns()

  const review = (await api().get(`/api/admin/nodes/${nodeId}/review`).set(as())).body
  expect(review.run.status).toBe('READY_FOR_REVIEW')
  expect(review.node.safetyCritical).toBe(true)

  // Products: every check as the fixtures intend.
  const p = (model: string) => review.products.find((x: { name: string }) => x.name === model)
  const approved = review.products.filter((x: { status: string }) => x.status === CatalogStatus.APPROVED).map((x: { brand: string; name: string }) => `${x.brand} ${x.name}`).sort()
  expect(approved).toEqual([
    'Brightway Halo', 'Brightway Halo Max', 'Kinderwise Guard', 'Kinderwise Guard Plus', 'LullaCarry Air', 'LullaCarry City', 'LullaCarry Glide',
    'Nestwell Cloud', 'Nestwell Roam', 'Nestwell Snug', 'RoamBaby Trip', 'RoamBaby Trip Lite',
  ])
  expect(p('Nest')).toMatchObject({ status: 'NEEDS_ATTENTION', attentionCheck: 'fetch' })
  expect(p('Nest').attentionReason).toMatch(/ROBOTS_DISALLOWED/)
  expect(p('Anchor').attentionReason).toMatch(/BLOCKED/)
  expect(p('Bloom')).toMatchObject({ attentionCheck: 'brand_domain' })
  expect(p('Bloom').item.status).toBe(ItemStatus.WAITING)
  expect(p('Grow 3-in-1')).toMatchObject({ attentionCheck: 'nodeFit' })
  expect(p('Pebble Infant')).toMatchObject({ attentionCheck: 'modelNamed' })

  // Levers: eleven candidates, all safety-flagged (car seats); the shared Weight reused where it exists.
  expect(review.levers).toHaveLength(11)
  expect(review.levers.every((l: { safety: boolean }) => l.safety)).toBe(true)

  // Values: the evidence rules applied.
  const lever = (name: string) => review.levers.find((l: { name: string }) => l.name === name)
  const value = (model: string, leverName: string) => review.values.find((v: { productId: string; definitionId: string }) => v.productId === p(model).id && v.definitionId === lever(leverName).definitionId)
  const weight = lever('Carrier weight') ?? lever('Weight')
  expect(value('Roam', weight.name)).toMatchObject({ value: { number: 9.48, unit: 'lb' }, statedValue: '4.3', statedUnit: 'kg', confidence: 'MEDIUM' })
  expect(value('Guard Plus', 'Maximum child height')).toMatchObject({ value: { number: 31.89 }, statedUnit: 'cm' })
  expect(value('Glide', 'Maximum child height').sourceUrl).toMatch(/manual\.pdf$/)
  expect(value('Halo', 'Expiration')).toMatchObject({ value: { unknown: true }, unknownReason: 'quote_not_found' })
  expect(value('Snug', 'Anti-rebound bar')).toMatchObject({ value: { unknown: true }, unknownReason: 'no_not_explicit' })
  expect(p('Trip').item.documents).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'SCANNED_PDF' })]))

  // Safety levers: bulk accept is refused; each value is accepted one by one.
  expect((await api().post(`/api/admin/nodes/${nodeId}/values/bulk-accept`).set(as()).send({ definitionId: weight.definitionId })).status).toBe(400)
  const five = [weight, lever('Maximum child weight'), lever('Maximum child height'), lever('Load leg'), lever('Base installation')]
  const ids = new Set(review.products.filter((x: { status: string }) => x.status === 'APPROVED').map((x: { id: string }) => x.id))
  const toAccept = review.values.filter((v: { productId: string; definitionId: string; value: { unknown: boolean } }) =>
    ids.has(v.productId) && five.some((l) => l.definitionId === v.definitionId) && !v.value.unknown)
  for (const v of toAccept) await api().post(`/api/admin/values/${v.id}/accept`).set(as()).expect(200)
  expect(await prisma.productLeverValue.count({ where: { id: { in: toAccept.map((v: { id: string }) => v.id) }, status: ValueStatus.ACCEPTED, acceptMode: 'SINGLE' } })).toBe(toAccept.length)

  const res = await api().post(`/api/admin/nodes/${nodeId}/publish`).set(as()).send({ leverIds: five.map((l) => l.id) })
  expect(res.status).toBe(200)
  expect(res.body.products).toBe(12)

  const page = await api().get('/api/categories/infant-car-seats')
  expect(page.status).toBe(200)
  expect(page.body.products).toHaveLength(12)
  expect(page.body.products.every((x: { isDryRun: boolean }) => x.isDryRun)).toBe(true)
  expect(page.body.levers.map((l: { name: string }) => l.name)).toEqual(five.map((l) => l.name))
}, 120_000)
