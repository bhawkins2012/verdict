// The publish gate and atomic publish (docs/adr-generation-run.md D10), and the public side (D12).
import { CatalogStatus, LeverStatus, ValueStatus } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { api, bearer, cleanup } from '../helpers'
import { acceptAll, addLevers, addProducts, deleteTree, registerAdmin, testTree, TestTree } from '../generation/helpers'

let admin: Awaited<ReturnType<typeof registerAdmin>>
const trees: TestTree[] = []
beforeAll(async () => { admin = await registerAdmin() })
afterAll(async () => {
  for (const t of trees) await deleteTree(t)
  await cleanup([admin.id])
})

const publish = (nodeId: string, leverIds: string[]) => api().post(`/api/admin/nodes/${nodeId}/publish`).set(bearer(admin.accessToken)).send({ leverIds })

/** A node with 20 approved products, six candidate levers, values accepted for all but `missing` products on lever 0. */
async function ready(missing = 0) {
  const t = await testTree(); trees.push(t)
  const levers = await addLevers(t.nodeId, [
    { name: 'Weight', type: 'MEASUREMENT', unit: 'lb' }, { name: 'Width', type: 'MEASUREMENT', unit: 'in' },
    { name: 'Fits', type: 'COMPATIBILITY_LIST', unit: null }, { name: 'Wheels', type: 'CATEGORY', unit: null, allowedValues: ['Rubber', 'Plastic'] },
    { name: 'Canopy', type: 'BOOLEAN', unit: null }, { name: 'Spare', type: 'BOOLEAN', unit: null },
  ])
  const products = await addProducts(t.nodeId, 20)
  await acceptAll(products.map((p) => p.id), levers.slice(0, 5), (p, l) => l === 0 && p < missing)
  return { t, levers, products, five: levers.slice(0, 5).map((l) => l.id) }
}

describe('publish gate', () => {
  it('refuses when a lever is under 80% (15 of 20), naming the lever and its coverage', async () => {
    const { t, five, levers } = await ready(5)
    const res = await publish(t.nodeId, five)
    expect(res.status).toBe(400)
    expect(res.body.error).toContain(`${levers[0].definition.name} 15 of 20 (75%)`)
    expect(res.body.failing).toEqual([{ lever: levers[0].definition.name, accepted: 15, products: 20 }])
    expect((await prisma.taxonomyNode.findUniqueOrThrow({ where: { id: t.nodeId } })).publishedAt).toBeNull()
  })

  it('passes at exactly 80% (16 of 20)', async () => {
    const { t, five } = await ready(4)
    expect((await publish(t.nodeId, five)).status).toBe(200)
  })

  it('an accepted "unknown" does not count toward coverage', async () => {
    const { t, five, levers, products } = await ready(4)
    await prisma.productLeverValue.update({
      where: { productId_definitionId: { productId: products[5].id, definitionId: levers[0].definitionId } },
      data: { isUnknown: true, valueNumber: null, unit: null, evidenceQuote: null, sourceUrl: null },
    })
    const res = await publish(t.nodeId, five)
    expect(res.status).toBe(400)
    expect(res.body.failing[0]).toMatchObject({ accepted: 15, products: 20 })
  })

  it('proposed (not accepted) values do not count', async () => {
    const { t, five, levers, products } = await ready(0)
    await prisma.productLeverValue.updateMany({
      where: { definitionId: levers[1].definitionId, productId: { in: products.slice(0, 5).map((p) => p.id) } },
      data: { status: ValueStatus.PROPOSED, acceptMode: null },
    })
    expect((await publish(t.nodeId, five)).status).toBe(400)
  })

  it('needs exactly five levers and at least the minimum of approved products', async () => {
    const { t, five } = await ready(0)
    expect((await publish(t.nodeId, five.slice(0, 4))).status).toBe(400)
    await prisma.product.updateMany({ where: { nodeId: t.nodeId }, data: { catalogStatus: CatalogStatus.NEEDS_ATTENTION, approvedVia: null, attentionCheck: 'fetch' } })
    const res = await publish(t.nodeId, five)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/approved products/)
  })

  it('refuses while a run is still writing to the node', async () => {
    const { t, five } = await ready(0)
    await prisma.generationRun.create({ data: { nodeId: t.nodeId, kind: 'NODE', mode: 'DRY_RUN', model: 'dry-run', capUsd: 10, status: 'ACTIVE' } })
    expect((await publish(t.nodeId, five)).status).toBe(409)
  })

  it('dry-run products can be published only in development or test', async () => {
    const { t, five } = await ready(0)
    await prisma.product.updateMany({ where: { nodeId: t.nodeId }, data: { isDryRun: true } })
    const before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const res = await publish(t.nodeId, five)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/dry-run/)
    } finally {
      process.env.NODE_ENV = before
    }
  })
})

describe('atomic publish', () => {
  it('the node, its five levers in order, the listed products and a copy of their values go live together', async () => {
    const { t, five, levers, products } = await ready(0)
    await prisma.product.update({ where: { id: products[19].id }, data: { catalogStatus: CatalogStatus.REJECTED, approvedVia: null } })
    const res = await publish(t.nodeId, [five[4], ...five.slice(0, 4)])
    expect(res.status).toBe(200)
    const approved = await prisma.nodeLever.findMany({ where: { nodeId: t.nodeId, status: LeverStatus.APPROVED }, orderBy: { position: 'asc' } })
    expect(approved.map((l) => l.id)).toEqual([five[4], ...five.slice(0, 4)])
    expect(approved.every((l) => l.approvedById === admin.id && l.published !== null)).toBe(true)
    expect(await prisma.product.count({ where: { nodeId: t.nodeId, listed: true } })).toBe(19)
    expect(await prisma.publishedLeverValue.count({ where: { nodeId: t.nodeId } })).toBe(19 * 5)
    expect(await prisma.publishedLeverValue.count({ where: { nodeId: t.nodeId, definitionId: levers[5].definitionId } })).toBe(0)
  })

  it('a failure inside the transaction leaves nothing published', async () => {
    const { t, five } = await ready(0)
    // Make the very last write of the publish fail.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_publish() RETURNS trigger AS $$ BEGIN IF NEW."id" = '${t.nodeId}' AND NEW."publishedAt" IS NOT NULL THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_fail_publish BEFORE UPDATE ON "taxonomy_nodes" FOR EACH ROW EXECUTE FUNCTION test_fail_publish()')
    try {
      expect((await publish(t.nodeId, five)).status).toBe(500)
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_fail_publish ON "taxonomy_nodes"')
      await prisma.$executeRawUnsafe('DROP FUNCTION test_fail_publish()')
    }
    expect(await prisma.nodeLever.count({ where: { nodeId: t.nodeId, status: LeverStatus.APPROVED } })).toBe(0)
    expect(await prisma.product.count({ where: { nodeId: t.nodeId, listed: true } })).toBe(0)
    expect(await prisma.publishedLeverValue.count({ where: { nodeId: t.nodeId } })).toBe(0)
    expect((await prisma.taxonomyNode.findUniqueOrThrow({ where: { id: t.nodeId } })).publishedAt).toBeNull()
  })

  it('the database keeps 0 or 5 approved levers per node', async () => {
    const { t, five } = await ready(0)
    await publish(t.nodeId, five).expect(200)
    await expect(prisma.nodeLever.update({ where: { id: five[0] }, data: { status: LeverStatus.CANDIDATE, position: null } })).rejects.toThrow(/exactly 0 or 5/)
  })

  it('republishing retires the old five and unlists products rejected since', async () => {
    const { t, five, levers, products } = await ready(0)
    await publish(t.nodeId, five).expect(200)
    await acceptAll(products.map((p) => p.id), [levers[5]])
    await prisma.product.update({ where: { id: products[0].id }, data: { catalogStatus: CatalogStatus.REJECTED, approvedVia: null } })
    await publish(t.nodeId, [...five.slice(1), levers[5].id]).expect(200)
    expect((await prisma.nodeLever.findUniqueOrThrow({ where: { id: five[0] } })).status).toBe(LeverStatus.RETIRED)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: products[0].id } })).listed).toBe(false)
  })
})

describe('public side', () => {
  it('an unpublished node is hidden from browse and its page is 404; search says it is being prepared', async () => {
    const { t } = await ready(0)
    expect((await api().get(`/api/categories/${t.slug}`)).status).toBe(404)
    const browse = await api().get('/api/categories')
    expect(JSON.stringify(browse.body)).not.toContain(t.slug)
    const search = await api().get(`/api/categories/search?q=${encodeURIComponent(t.slug.replace(/-/g, ' '))}`)
    expect(search.body.nodes.find((n: { slug: string }) => n.slug === t.slug)).toMatchObject({ published: false })
  })

  it('a published decision node shows its five levers as filters, listed products and published values only', async () => {
    const { t, five, levers, products } = await ready(0)
    await publish(t.nodeId, five).expect(200)
    const page = await api().get(`/api/categories/${t.slug}`)
    expect(page.status).toBe(200)
    expect(page.body.kind).toBe('DECISION')
    expect(page.body.levers.map((l: { id: string }) => l.id)).toEqual(five)
    expect(page.body.products).toHaveLength(20)
    expect(page.body.breadcrumbs.map((c: { name: string }) => c.name)).toHaveLength(3)
    // A filter on the first lever (weights 10..29).
    const filtered = await api().get(`/api/categories/${t.slug}?lever[${five[0]}][min]=25`)
    expect(filtered.body.products).toHaveLength(5)
    // The spare candidate lever never appears publicly.
    expect(JSON.stringify(page.body)).not.toContain(levers[5].definition.name)
    // A product page carries the published values with their evidence.
    const p = await api().get(`/api/products/${products[0].id}`)
    expect(p.body.levers).toHaveLength(5)
    expect(p.body.levers[0].value).toMatchObject({ unknown: false, number: 10, evidence: { quote: 'Spec: value', url: 'https://brand.example/p' } })
  })

  it('changes after a publish stay invisible until the next publish', async () => {
    const { t, five, levers, products } = await ready(0)
    await publish(t.nodeId, five).expect(200)
    // An admin edits a value and renames a lever after publishing.
    await prisma.productLeverValue.update({ where: { productId_definitionId: { productId: products[0].id, definitionId: levers[0].definitionId } }, data: { valueNumber: 999 } })
    await prisma.leverDefinition.update({ where: { id: levers[0].definitionId }, data: { name: `Renamed ${levers[0].id}` } })
    const p = await api().get(`/api/products/${products[0].id}`)
    expect(p.body.levers[0].value.number).toBe(10)
    expect(p.body.levers[0].lever.name).toBe(levers[0].definition.name)
    await publish(t.nodeId, five).expect(200)
    const after = await api().get(`/api/products/${products[0].id}`)
    expect(after.body.levers[0].value.number).toBe(999)
  })

  it('a discovered product is not public until a publish lists it', async () => {
    const t = await testTree(); trees.push(t)
    const run = await prisma.generationRun.create({ data: { nodeId: t.nodeId, kind: 'NODE', mode: 'DRY_RUN', model: 'dry-run', capUsd: 10, status: 'READY_FOR_REVIEW' } })
    const [p, auto] = await addProducts(t.nodeId, 2, { status: CatalogStatus.PROPOSED })
    await prisma.product.update({ where: { id: p.id }, data: { catalogStatus: CatalogStatus.NEEDS_ATTENTION, attentionCheck: 'fetch', discoveredByRunId: run.id } })
    // Approved automatically but not yet published: not public either (review finding 3).
    await prisma.product.update({ where: { id: auto.id }, data: { catalogStatus: CatalogStatus.APPROVED, approvedVia: 'AUTO', discoveredByRunId: run.id } })
    expect((await api().get(`/api/products/${auto.id}`)).status).toBe(404)
    expect((await api().get(`/api/products/${p.id}`)).status).toBe(404)
    const list = await api().get(`/api/products?q=${encodeURIComponent(p.name)}`)
    expect(list.body.products).toHaveLength(0)
  })

  it('a navigation node is public once its explainer is approved and a child is published', async () => {
    const { t, five } = await ready(0)
    await publish(t.nodeId, five).expect(200)
    expect((await api().get(`/api/categories/${(await prisma.taxonomyNode.findUniqueOrThrow({ where: { id: t.navId } })).slug}`)).status).toBe(404)
    const navSlug = (await prisma.taxonomyNode.findUniqueOrThrow({ where: { id: t.navId } })).slug
    const node = await prisma.taxonomyNode.findUniqueOrThrow({ where: { id: t.nodeId } })
    await api().post(`/api/admin/nodes/${t.navId}/explainer`).set(bearer(admin.accessToken))
      .send({ explainer: 'These differ in size and how they fold, and who they suit.', childLines: { [node.slug]: 'The compact kind.' } }).expect(200)
    const nav = await api().get(`/api/categories/${navSlug}`)
    expect(nav.status).toBe(200)
    expect(nav.body).toMatchObject({ kind: 'NAVIGATION', explainer: 'These differ in size and how they fold, and who they suit.' })
    expect(nav.body.children).toEqual([expect.objectContaining({ slug: node.slug, line: 'The compact kind.', productCount: 20 })])
    const search = await api().get(`/api/categories/search?q=${encodeURIComponent(navSlug.replace(/-/g, ' '))}`)
    expect(search.body.nodes[0]).toMatchObject({ slug: navSlug, published: true, explainer: expect.any(String) })
  })
})
