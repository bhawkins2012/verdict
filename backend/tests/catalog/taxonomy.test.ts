// Taxonomy rules (docs/adr-generation-run.md D1): no cycles (primary and secondary edges), parents are
// navigation nodes, products and levers only at decision nodes, safety inherited.
import { LeverOrigin, NodeKind } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { loadTaxonomy } from '../../src/catalog/taxonomy'
import { api, bearer, cleanup } from '../helpers'
import { addLevers, deleteTree, registerAdmin, testTree, TestTree, uid } from '../generation/helpers'

let admin: Awaited<ReturnType<typeof registerAdmin>>
const trees: TestTree[] = []
beforeAll(async () => { admin = await registerAdmin() })
afterAll(async () => {
  for (const t of trees) await deleteTree(t)
  await cleanup([admin.id])
})

async function tree() { const t = await testTree(); trees.push(t); return t }
const patch = (id: string, body: object) => api().patch(`/api/admin/nodes/${id}`).set(bearer(admin.accessToken)).send(body)

describe('no cycles', () => {
  it('a node cannot move under its own descendant (API 400, naming the path)', async () => {
    const t = await tree()
    const res = await patch(t.rootId, { parentId: t.navId })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cycle/)
  })

  it('a secondary parent cannot close a cycle either', async () => {
    const t = await tree()
    const res = await patch(t.rootId, { secondaryParentIds: [t.navId] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cycle/)
  })

  it('the database refuses a cycle written directly (primary or secondary)', async () => {
    const t = await tree()
    await expect(prisma.taxonomyNode.update({ where: { id: t.rootId }, data: { parentId: t.navId } })).rejects.toThrow(/cycle/)
    await expect(prisma.nodeSecondaryParent.create({ data: { nodeId: t.rootId, parentId: t.navId } })).rejects.toThrow(/cycle/)
    await expect(prisma.taxonomyNode.update({ where: { id: t.navId }, data: { parentId: t.navId } })).rejects.toThrow()
  })

  it('two concurrent edits cannot together make a cycle', async () => {
    const s = uid()
    const a = await prisma.taxonomyNode.create({ data: { slug: `c-a-${s}`, name: 'A', kind: NodeKind.NAVIGATION, searchTerms: [] } })
    const b = await prisma.taxonomyNode.create({ data: { slug: `c-b-${s}`, name: 'B', kind: NodeKind.NAVIGATION, searchTerms: [] } })
    trees.push({ rootId: a.id, navId: b.id, nodeId: a.id, otherNodeId: b.id, slug: a.slug, ids: [a.id, b.id] })
    const results = await Promise.allSettled([
      prisma.taxonomyNode.update({ where: { id: a.id }, data: { parentId: b.id } }),
      prisma.taxonomyNode.update({ where: { id: b.id }, data: { parentId: a.id } }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    await prisma.taxonomyNode.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { parentId: null } })
  })

  it('"also listed in" works when it makes no cycle', async () => {
    const t = await tree()
    const other = await tree()
    const res = await patch(t.nodeId, { secondaryParentIds: [other.navId] })
    expect(res.status).toBe(200)
    const tax = await loadTaxonomy()
    expect(tax.children(other.navId).some((c) => c.node.id === t.nodeId && c.viaSecondary)).toBe(true)
  })
})

describe('node kinds', () => {
  it('only navigation nodes have children', async () => {
    const t = await tree()
    const res = await api().post('/api/admin/nodes').set(bearer(admin.accessToken)).send({ name: `Child ${uid()}`, kind: 'DECISION', parentId: t.nodeId })
    expect(res.status).toBe(400)
    await expect(prisma.taxonomyNode.create({ data: { slug: `x-${uid()}`, name: 'X', kind: NodeKind.DECISION, parentId: t.nodeId, searchTerms: [] } })).rejects.toThrow(/navigation/)
  })

  it('products and levers belong to decision nodes only (database rule)', async () => {
    const t = await tree()
    await expect(prisma.product.create({ data: { name: 'P', category: 'x', nodeId: t.navId } })).rejects.toThrow(/decision/)
    const def = await prisma.leverDefinition.create({ data: { name: `D ${uid()}`, nameKey: `d ${uid()}`, type: 'BOOLEAN', explanation: 'A test lever definition.', relatedNeeds: [], allowedValues: [], origin: LeverOrigin.ADMIN } })
    await expect(prisma.nodeLever.create({ data: { nodeId: t.navId, definitionId: def.id, origin: LeverOrigin.ADMIN } })).rejects.toThrow(/decision/)
    await prisma.leverDefinition.delete({ where: { id: def.id } })
  })
})

describe('safety is inherited from a safety-critical ancestor', () => {
  it('every lever under a safety-critical node is flagged, whatever its definition says', async () => {
    const t = await testTree({ safety: true }); trees.push(t)
    const [l] = await addLevers(t.nodeId, [{ name: 'Weight', type: 'MEASUREMENT', unit: 'lb', safetyFlag: false }])
    expect(l.safety).toBe(true)
    expect((await loadTaxonomy()).safetyCritical(t.nodeId)).toBe(true)
  })

  it('marking an ancestor safety-critical later flags the levers below it', async () => {
    const t = await tree()
    const [l] = await addLevers(t.nodeId, [{ name: 'Weight', type: 'MEASUREMENT', unit: 'lb' }])
    expect(l.safety).toBe(false)
    await patch(t.rootId, { safetyCritical: true })
    expect((await prisma.nodeLever.findUniqueOrThrow({ where: { id: l.id } })).safety).toBe(true)
  })

  it('the launch taxonomy: every Car seats decision node is safety-critical, strollers are not', async () => {
    const tax = await loadTaxonomy()
    for (const slug of ['infant-car-seats', 'convertible-car-seats', 'booster-seats']) expect(tax.safetyCritical(tax.bySlug(slug)?.id ?? '')).toBe(true)
    for (const slug of ['full-size-strollers', 'travel-strollers']) expect(tax.safetyCritical(tax.bySlug(slug)?.id ?? '')).toBe(false)
    const carSeats = tax.bySlug('car-seats')
    const seats = tax.bySlug('seats')
    expect(tax.secondary.some((e) => e.nodeId === carSeats?.id && e.parentId === seats?.id)).toBe(true)
    expect(tax.nodes.filter((n) => n.kind === NodeKind.DECISION && tax.path(n.id)[0]?.slug === 'baby-and-kids').map((n) => n.slug).sort()).toEqual([
      'booster-seats', 'convertible-car-seats', 'double-strollers', 'full-size-strollers', 'infant-car-seats', 'jogging-strollers', 'travel-strollers',
    ])
  })
})
