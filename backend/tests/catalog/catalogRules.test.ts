// Catalog rules from the code review: user-added products, public product pages, moves, waiting items,
// stale review decisions, retailer products and manual values on challenge pages.
import { CatalogStatus, ItemStatus, ValueStatus } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { api, bearer, cleanup, registerUser } from '../helpers'
import {
  acceptAll, addLevers, addProducts, deleteTree, FakeWeb, forgetHosts, productPage, registerAdmin, resetGenerationEnv, setValue, testTree,
  TestTree, uid, verifiedBrand,
} from '../generation/helpers'

let admin: Awaited<ReturnType<typeof registerAdmin>>
let user: Awaited<ReturnType<typeof registerUser>>
const trees: TestTree[] = []
const hosts: string[] = []
beforeAll(async () => { admin = await registerAdmin(); user = await registerUser() })
afterEach(() => resetGenerationEnv())
afterAll(async () => {
  for (const t of trees) await deleteTree(t)
  await forgetHosts(hosts)
  await cleanup([admin.id, user.id])
})
const as = () => bearer(admin.accessToken)

async function ready() {
  const t = await testTree(); trees.push(t)
  const levers = await addLevers(t.nodeId)
  const products = await addProducts(t.nodeId, 10)
  await acceptAll(products.map((p) => p.id), levers)
  return { t, levers, products, ids: levers.map((l) => l.id) }
}

describe('products added by users', () => {
  it('are not in the catalog: not counted by the gate, not listed, shown to admins as proposed; an admin can approve or reject them', async () => {
    const { t, ids } = await ready()
    const slug = (await prisma.taxonomyNode.findUniqueOrThrow({ where: { id: t.nodeId } })).slug
    const extra: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await api().post('/api/products').set(bearer(user.accessToken)).send({ name: `User thing ${uid()}`, brand: 'Someone', category: slug })
      expect(r.status).toBe(201)
      extra.push(r.body.id as string)
    }
    // 10 of 10 accepted: the three user products do not lower the gate to 10 of 13.
    expect((await api().post(`/api/admin/nodes/${t.nodeId}/publish`).set(as()).send({ leverIds: ids })).status).toBe(200)
    expect(await prisma.product.count({ where: { id: { in: extra }, listed: true } })).toBe(0)
    // Their own pages stay public (user content), but they are not on the node's page.
    expect((await api().get(`/api/products/${extra[0]}`).set(bearer(user.accessToken))).status).toBe(200)
    const page = await api().get(`/api/categories/${slug}`)
    expect(page.body.products.map((p: { id: string }) => p.id)).not.toContain(extra[0])
    const review = await api().get(`/api/admin/nodes/${t.nodeId}/review`).set(as())
    expect(review.body.products.find((p: { id: string }) => p.id === extra[0])).toMatchObject({ status: 'PROPOSED', attentionCheck: 'not_in_catalog' })
    // Approve one into the catalog; reject another.
    expect((await api().post('/api/admin/products/approve').set(as()).send({ productIds: [extra[0]] })).body).toEqual({ approved: 1 })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: extra[0] } })).toMatchObject({ catalogStatus: CatalogStatus.APPROVED, approvedVia: 'ADMIN' })
    expect((await api().post('/api/admin/products/reject').set(as()).send({ productIds: [extra[1]] })).body).toEqual({ rejected: 1 })
    expect((await api().get(`/api/products/${extra[1]}`).set(bearer(user.accessToken))).status).toBe(404)
    // Now the gate counts the approved one: 10 of 11 still passes (≥ 80%).
    expect((await api().post(`/api/admin/nodes/${t.nodeId}/publish`).set(as()).send({ leverIds: ids })).status).toBe(200)
    await prisma.product.deleteMany({ where: { id: { in: extra } } })
  })

  it('a product linking to a retailer cannot be approved by hand', async () => {
    const t = await testTree(); trees.push(t)
    const [p] = await addProducts(t.nodeId, 1, { status: CatalogStatus.PROPOSED })
    await prisma.product.update({ where: { id: p.id }, data: { websiteUrl: 'https://www.amazon.com/dp/B0' } })
    const res = await api().post('/api/admin/products/approve').set(as()).send({ productIds: [p.id] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/retailer/)
  })
})

describe('public product pages', () => {
  it('a listed dry-run product is hidden outside development and test', async () => {
    const { t, ids, products } = await ready()
    await api().post(`/api/admin/nodes/${t.nodeId}/publish`).set(as()).send({ leverIds: ids }).expect(200)
    await prisma.product.update({ where: { id: products[0].id }, data: { isDryRun: true } })
    expect((await api().get(`/api/products/${products[0].id}`)).status).toBe(200)
    const before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect((await api().get(`/api/products/${products[0].id}`)).status).toBe(404)
    } finally {
      process.env.NODE_ENV = before
    }
  })
})

describe('moving a product', () => {
  it('drops its old public copy, so the new node publishes and the old one no longer counts it', async () => {
    const a = await ready()
    await api().post(`/api/admin/nodes/${a.t.nodeId}/publish`).set(as()).send({ leverIds: a.ids }).expect(200)
    // The other node shares the same definitions.
    const other = a.t.otherNodeId
    const shared: { id: string }[] = []
    for (const l of a.levers) shared.push(await prisma.nodeLever.create({ data: { nodeId: other, definitionId: l.definitionId, origin: 'ADMIN' } }))
    const moved = a.products[0]
    expect((await api().patch(`/api/admin/products/${moved.id}`).set(as()).send({ nodeId: other })).status).toBe(200)
    expect(await prisma.publishedLeverValue.count({ where: { productId: moved.id } })).toBe(0)
    const more = await addProducts(other, 9)
    await acceptAll(more.map((p) => p.id), a.levers)
    expect((await api().post(`/api/admin/nodes/${other}/publish`).set(as()).send({ leverIds: shared.map((l) => l.id) })).status).toBe(200)
    expect(await prisma.publishedLeverValue.count({ where: { productId: moved.id, nodeId: other } })).toBe(5)
  })
})

describe('waiting items', () => {
  it('confirming a brand after its run was published does not block the node\'s next publish', async () => {
    const { t, ids, products } = await ready()
    const host = `late${uid()}.example`
    hosts.push(host)
    const run = await prisma.generationRun.create({ data: { nodeId: t.nodeId, kind: 'NODE', mode: 'DRY_RUN', model: 'dry-run', capUsd: 10, status: 'PUBLISHED' } })
    const [p] = await addProducts(t.nodeId, 1, { status: CatalogStatus.PROPOSED })
    await prisma.product.update({ where: { id: p.id }, data: { manufacturerUrl: `https://${host}/p`, discoveredByRunId: run.id } })
    const item = await prisma.extractionItem.create({ data: { runId: run.id, productId: p.id, status: ItemStatus.WAITING } })
    const b = await prisma.brandDomain.create({ data: { brand: 'Late', brandKey: 'late', host, status: 'PENDING_CONFIRMATION' } })
    expect((await api().post(`/api/admin/brands/${b.id}/confirm`).set(as())).body.requeued).toBe(0)
    expect(await prisma.extractionItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: ItemStatus.FAILED })
    expect((await api().post(`/api/admin/nodes/${t.nodeId}/publish`).set(as()).send({ leverIds: ids })).status).toBe(200)
    void products
  })
})

describe('stale review decisions', () => {
  it('an accept of a value that changed since the admin saw it is refused (409)', async () => {
    const t = await testTree(); trees.push(t)
    const [l] = await addLevers(t.nodeId, [{ name: 'Weight', type: 'MEASUREMENT', unit: 'lb' }])
    const [p] = await addProducts(t.nodeId, 1)
    const v = await setValue(p.id, l.definitionId, { status: ValueStatus.PROPOSED, number: 9 })
    const seen = v.updatedAt.toISOString()
    // A re-extraction replaces it before the admin presses Accept.
    await new Promise((r) => setTimeout(r, 5))
    await prisma.productLeverValue.update({ where: { id: v.id }, data: { valueNumber: 12 } })
    const res = await api().post(`/api/admin/values/${v.id}/accept`).set(as()).send({ seen })
    expect(res.status).toBe(409)
    expect((await prisma.productLeverValue.findUniqueOrThrow({ where: { id: v.id } })).status).toBe(ValueStatus.PROPOSED)
    const fresh = (await prisma.productLeverValue.findUniqueOrThrow({ where: { id: v.id } })).updatedAt.toISOString()
    expect((await api().post(`/api/admin/values/${v.id}/accept`).set(as()).send({ seen: fresh })).status).toBe(200)
  })
})

describe('manual values on a challenge page', () => {
  it('a bot challenge is a block: the value is admin-attested and the host is paused', async () => {
    const t = await testTree(); trees.push(t)
    const [l] = await addLevers(t.nodeId, [{ name: 'Weight', type: 'MEASUREMENT', unit: 'lb' }])
    const [p] = await addProducts(t.nodeId, 1)
    const brand = `Acme${uid()}`
    const host = `${brand.toLowerCase()}.example`
    hosts.push(host)
    await prisma.product.update({ where: { id: p.id }, data: { brand } })
    await verifiedBrand(brand, host)
    const web = new FakeWeb()
    web.set(`https://${host}/robots.txt`, { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' })
    web.page(`https://${host}/specs`, '<html><head><title>Just a moment...</title></head><body><h1>Checking your browser</h1></body></html>')
    web.install()
    const res = await api().post(`/api/admin/products/${p.id}/values`).set(as())
      .send({ definitionId: l.definitionId, value: { number: 9.5 }, sourceUrl: `https://${host}/specs`, quote: 'Weight: 9.5 lb' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ adminAttested: true, attestedFetchOutcome: 'BLOCKED' })
    expect((await prisma.fetchHost.findUniqueOrThrow({ where: { host } })).blockedUntil).not.toBeNull()
    void productPage
  })
})

describe('people already reviewing a product', () => {
  it('keep seeing and reviewing it after an admin rejects it; everyone else gets 404', async () => {
    const t = await testTree(); trees.push(t)
    const slug = (await prisma.taxonomyNode.findUniqueOrThrow({ where: { id: t.nodeId } })).slug
    const other = await registerUser()
    try {
      const made = await api().post('/api/products').set(bearer(user.accessToken)).send({ name: `Kept ${uid()}`, brand: 'Someone', category: slug })
      const id = made.body.id as string
      await api().post('/api/reviews').set(bearer(user.accessToken)).send({ productId: id, stage: 'INITIAL', scoreOverall: 8 }).expect(201)
      await api().post('/api/admin/products/reject').set(as()).send({ productIds: [id] }).expect(200)
      // The reviewer: the page (the check-in links to it) and the next stage both still work.
      expect((await api().get(`/api/products/${id}`).set(bearer(user.accessToken))).status).toBe(200)
      expect((await api().post('/api/reviews').set(bearer(user.accessToken)).send({ productId: id, stage: 'TWO_WEEKS', scoreOverall: 7 })).status).toBe(201)
      // Anyone else, signed in or not: gone.
      expect((await api().get(`/api/products/${id}`)).status).toBe(404)
      expect((await api().get(`/api/products/${id}`).set(bearer(other.accessToken))).status).toBe(404)
      expect((await api().post('/api/reviews').set(bearer(other.accessToken)).send({ productId: id, stage: 'INITIAL', scoreOverall: 5 })).status).toBe(404)
      // A bad token reads as anonymous on the public page (no 401, so no refresh loop).
      expect((await api().get(`/api/products/${id}`).set('Authorization', 'Bearer nonsense')).status).toBe(404)
      await prisma.product.delete({ where: { id } })
    } finally {
      await cleanup([other.id])
    }
  })

  it('a discovered product that a later publish unlists stays reviewable by its reviewers', async () => {
    process.env.GENERATION_MIN_PRODUCTS = '5' // so the node still publishes with one product fewer
    const { t, ids, products } = await ready()
    const run = await prisma.generationRun.create({ data: { nodeId: t.nodeId, kind: 'NODE', mode: 'DRY_RUN', model: 'dry-run', capUsd: 10, status: 'READY_FOR_REVIEW' } })
    await prisma.product.update({ where: { id: products[0].id }, data: { discoveredByRunId: run.id } })
    await api().post(`/api/admin/nodes/${t.nodeId}/publish`).set(as()).send({ leverIds: ids }).expect(200)
    await api().post('/api/reviews').set(bearer(user.accessToken)).send({ productId: products[0].id, stage: 'INITIAL', scoreOverall: 8 }).expect(201)
    await api().post('/api/admin/products/reject').set(as()).send({ productIds: [products[0].id] }).expect(200)
    await api().post(`/api/admin/nodes/${t.nodeId}/publish`).set(as()).send({ leverIds: ids }).expect(200)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: products[0].id } })).listed).toBe(false)
    expect((await api().get(`/api/products/${products[0].id}`)).status).toBe(404)
    expect((await api().get(`/api/products/${products[0].id}`).set(bearer(user.accessToken))).status).toBe(200)
    expect((await api().post('/api/reviews').set(bearer(user.accessToken)).send({ productId: products[0].id, stage: 'TWO_WEEKS', scoreOverall: 6 })).status).toBe(201)
    await prisma.reviewThread.deleteMany({ where: { productId: products[0].id } })
  })
})

describe('retailer check on approval', () => {
  it('uses the manufacturer page when a run found one, and catches http:// retailer links', async () => {
    const t = await testTree(); trees.push(t)
    const [a, b] = await addProducts(t.nodeId, 2, { status: CatalogStatus.PROPOSED })
    // Added with an Amazon link, then a run found the brand's page: approvable.
    await prisma.product.update({ where: { id: a.id }, data: { websiteUrl: 'https://www.amazon.com/dp/B0', manufacturerUrl: 'https://acme.example/glide' } })
    expect((await api().post('/api/admin/products/approve').set(as()).send({ productIds: [a.id] })).status).toBe(200)
    // An http:// retailer link is still a retailer.
    await prisma.product.update({ where: { id: b.id }, data: { websiteUrl: 'http://www.walmart.com/ip/1', manufacturerUrl: null } })
    expect((await api().post('/api/admin/products/approve').set(as()).send({ productIds: [b.id] })).status).toBe(400)
  })
})

describe('stale corrections', () => {
  it('a correction of a value that changed since the admin opened it is refused (409)', async () => {
    const t = await testTree(); trees.push(t)
    const [l] = await addLevers(t.nodeId, [{ name: 'Weight', type: 'MEASUREMENT', unit: 'lb' }])
    const [p] = await addProducts(t.nodeId, 1)
    const v = await setValue(p.id, l.definitionId, { status: ValueStatus.PROPOSED, number: 9 })
    const seen = v.updatedAt.toISOString()
    await new Promise((r) => setTimeout(r, 5))
    await prisma.productLeverValue.update({ where: { id: v.id }, data: { valueNumber: 12, evidenceQuote: 'Weight: 12 lb' } })
    expect((await api().patch(`/api/admin/values/${v.id}`).set(as()).send({ number: 9.5, seen })).status).toBe(409)
    const fresh = (await prisma.productLeverValue.findUniqueOrThrow({ where: { id: v.id } })).updatedAt.toISOString()
    expect((await api().patch(`/api/admin/values/${v.id}`).set(as()).send({ number: 12.5, seen: fresh })).status).toBe(200)
  })
})
