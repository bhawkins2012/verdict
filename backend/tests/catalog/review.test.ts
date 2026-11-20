// Value review (docs/adr-generation-run.md D9, section 5 A4): single accepts, no bulk accept on safety levers
// or manual values (API and database), manual and admin-attested values, admin-only routes.
import { AcceptMode, Confidence, UserRole, ValueOrigin, ValueStatus } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { coverage } from '../../src/catalog/publish'
import { api, bearer, cleanup, registerUser } from '../helpers'
import {
  addLevers, addProducts, deleteTree, FakeWeb, forgetHosts, productPage, registerAdmin, resetGenerationEnv, setValue, testTree, TestTree, uid,
  verifiedBrand,
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

async function column(opts: { safety?: boolean; safetyNode?: boolean } = {}) {
  const t = await testTree({ safety: opts.safetyNode }); trees.push(t)
  const [lever] = await addLevers(t.nodeId, [{ name: 'Weight', type: 'MEASUREMENT', unit: 'lb', safetyFlag: opts.safety }])
  const products = await addProducts(t.nodeId, 4)
  const values = []
  for (const [i, p] of products.entries()) values.push(await setValue(p.id, lever.definitionId, { status: ValueStatus.PROPOSED, number: 9 + i, confidence: i === 3 ? Confidence.LOW : Confidence.HIGH }))
  return { t, lever, products, values }
}

describe('accepting values', () => {
  it('one at a time records who and when', async () => {
    const { values } = await column()
    await api().post(`/api/admin/values/${values[0].id}/accept`).set(as()).expect(200)
    expect(await prisma.productLeverValue.findUniqueOrThrow({ where: { id: values[0].id } })).toMatchObject({
      status: ValueStatus.ACCEPTED, acceptMode: AcceptMode.SINGLE, reviewedById: admin.id,
    })
  })

  it('bulk accept takes only high-confidence proposals of a non-safety lever', async () => {
    const { t, lever, values } = await column()
    const res = await api().post(`/api/admin/nodes/${t.nodeId}/values/bulk-accept`).set(as()).send({ definitionId: lever.definitionId })
    expect(res.body).toEqual({ accepted: 3 })
    expect((await prisma.productLeverValue.findUniqueOrThrow({ where: { id: values[3].id } })).status).toBe(ValueStatus.PROPOSED)
  })

  it.each([
    ['a safety-flagged lever', { safety: true }],
    ['any lever of a safety-critical node (car seats)', { safetyNode: true }],
  ])('bulk accept is refused on %s', async (_label, opts) => {
    const { t, lever, values } = await column(opts)
    const res = await api().post(`/api/admin/nodes/${t.nodeId}/values/bulk-accept`).set(as()).send({ definitionId: lever.definitionId })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/one by one/)
    expect(await prisma.productLeverValue.count({ where: { id: { in: values.map((v) => v.id) }, status: ValueStatus.ACCEPTED } })).toBe(0)
    // Single accepts still work.
    await api().post(`/api/admin/values/${values[0].id}/accept`).set(as()).expect(200)
  })

  it('the database refuses a bulk accept of a safety value or a manual value, whatever the API does', async () => {
    const { values } = await column({ safetyNode: true })
    await expect(prisma.productLeverValue.update({
      where: { id: values[0].id }, data: { status: ValueStatus.ACCEPTED, acceptMode: AcceptMode.BULK, reviewedAt: new Date() },
    })).rejects.toThrow(/one by one/)
    const plain = await column()
    await prisma.productLeverValue.update({ where: { id: plain.values[1].id }, data: { origin: ValueOrigin.MANUAL } })
    await expect(prisma.productLeverValue.update({
      where: { id: plain.values[1].id }, data: { status: ValueStatus.ACCEPTED, acceptMode: AcceptMode.BULK, reviewedAt: new Date() },
    })).rejects.toThrow(/manual values/)
  })

  it('a correction goes back to proposed, keeps the evidence and the original, and must be accepted again', async () => {
    const { values } = await column()
    await api().post(`/api/admin/values/${values[0].id}/accept`).set(as()).expect(200)
    await api().patch(`/api/admin/values/${values[0].id}`).set(as()).send({ number: 4.3 }).expect(200)
    const v = await prisma.productLeverValue.findUniqueOrThrow({ where: { id: values[0].id } })
    expect(v).toMatchObject({ status: ValueStatus.PROPOSED, valueNumber: 4.3, evidenceQuote: 'Spec: value', editedById: admin.id })
    expect(v.originalValue).toMatchObject({ number: 9 })
  })

  it('a Phase A value (no evidence) can never be accepted', async () => {
    const { values } = await column()
    await prisma.productLeverValue.update({ where: { id: values[0].id }, data: { origin: ValueOrigin.PHASE_A, evidenceQuote: null } })
    expect((await api().post(`/api/admin/values/${values[0].id}/accept`).set(as())).status).toBe(400)
  })

  it('mark unknown stores an explicit unknown that does not count toward coverage', async () => {
    const { t, lever, values } = await column()
    await api().post(`/api/admin/values/${values[0].id}/unknown`).set(as()).expect(200)
    expect(await prisma.productLeverValue.findUniqueOrThrow({ where: { id: values[0].id } })).toMatchObject({ isUnknown: true, status: ValueStatus.ACCEPTED })
    expect((await coverage(prisma, t.nodeId)).byDefinition.get(lever.definitionId)?.accepted ?? 0).toBe(0)
  })
})

describe('manual values', () => {
  async function setup(status = 200, robots = 'User-agent: *\nAllow: /\n') {
    const { t, lever, products } = await column()
    const brand = `Acme${uid()}`
    const host = `${brand.toLowerCase()}.example`
    hosts.push(host)
    await prisma.product.update({ where: { id: products[0].id }, data: { brand } })
    await verifiedBrand(brand, host)
    const web = new FakeWeb()
    web.set(`https://${host}/robots.txt`, { type: 'text/plain', body: robots })
    web.set(`https://${host}/specs`, status === 200 ? { body: productPage('Acme Glide', ['Weight: 9.5 lb']) } : { status })
    web.install()
    const post = (body: object) => api().post(`/api/admin/products/${products[0].id}/values`).set(as()).send(body)
    return { t, lever, product: products[0], host, web, post }
  }

  it('a quote found in a fresh fetch of a verified page is stored, accepted, and counts toward coverage', async () => {
    const { t, lever, host, post } = await setup()
    const res = await post({ definitionId: lever.definitionId, value: { number: 9.5 }, sourceUrl: `https://${host}/specs`, quote: 'Weight: 9.5 lb' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ status: 'ACCEPTED', adminAttested: false })
    expect((await coverage(prisma, t.nodeId)).byDefinition.get(lever.definitionId)?.accepted).toBe(1)
  })

  it('a quote that is not on the page is refused', async () => {
    const { lever, host, post } = await setup()
    const res = await post({ definitionId: lever.definitionId, value: { number: 9.5 }, sourceUrl: `https://${host}/specs`, quote: 'Weighs about 9.5 pounds' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not on the source page/)
  })

  it.each([[403, 'BLOCKED'], [200, 'ROBOTS_DISALLOWED']])('a blocked fetch (%i) is stored as admin-attested with the outcome', async (status, outcome) => {
    const { lever, host, post } = await setup(status, outcome === 'ROBOTS_DISALLOWED' ? 'User-agent: *\nDisallow: /specs\n' : undefined)
    const res = await post({ definitionId: lever.definitionId, value: { number: 9.5 }, sourceUrl: `https://${host}/specs`, quote: 'Weight: 9.5 lb' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ adminAttested: true, attestedFetchOutcome: outcome })
  })

  it('a source off the brand\'s verified domains is refused, without a fetch', async () => {
    const { lever, post, web } = await setup()
    const res = await post({ definitionId: lever.definitionId, value: { number: 9.5 }, sourceUrl: 'https://reviews.example/glide', quote: 'Weight: 9.5 lb' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/verified domain/)
    expect(web.urls().some((u) => u.includes('reviews.example'))).toBe(false)
  })
})

describe('admin-only', () => {
  const ROUTES: [method: 'get' | 'post' | 'patch' | 'delete', path: string][] = [
    ['get', '/api/admin/config'], ['get', '/api/admin/summary'], ['get', '/api/admin/nodes'], ['post', '/api/admin/nodes'],
    ['get', '/api/admin/nodes/x'], ['patch', '/api/admin/nodes/x'], ['post', '/api/admin/nodes/x/explainer'], ['post', '/api/admin/nodes/x/runs'],
    ['get', '/api/admin/runs/x'], ['post', '/api/admin/runs/x/resume'], ['post', '/api/admin/runs/x/cancel'], ['get', '/api/admin/nodes/x/review'],
    ['post', '/api/admin/nodes/x/levers'], ['patch', '/api/admin/levers/x'], ['post', '/api/admin/levers/x/retire'],
    ['post', '/api/admin/products/approve'], ['post', '/api/admin/products/reject'], ['get', '/api/admin/products/unplaced'],
    ['patch', '/api/admin/products/x'], ['post', '/api/admin/products/x/values'], ['post', '/api/admin/values/x/accept'],
    ['post', '/api/admin/values/x/reject'], ['post', '/api/admin/values/x/unknown'], ['patch', '/api/admin/values/x'],
    ['post', '/api/admin/nodes/x/values/bulk-accept'], ['get', '/api/admin/brands'], ['post', '/api/admin/brands/x/confirm'],
    ['post', '/api/admin/brands/x/reject'], ['delete', '/api/admin/brands/x'], ['post', '/api/admin/nodes/x/publish'],
    ['post', '/api/admin/nodes/x/unpublish'], ['post', '/api/admin/nodes/x/survey'],
  ]

  it.each(ROUTES)('%s %s: 401 without a token, 403 for a normal user', async (method, path) => {
    expect((await api()[method](path).send({})).status).toBe(401)
    expect((await api()[method](path).set(bearer(user.accessToken)).send({})).status).toBe(403)
  })

  it('reads the role from the database: a demoted admin is refused with the same token', async () => {
    const temp = await registerAdmin()
    expect((await api().get('/api/admin/nodes').set(bearer(temp.accessToken))).status).toBe(200)
    await prisma.user.update({ where: { id: temp.id }, data: { role: UserRole.USER } })
    expect((await api().get('/api/admin/nodes').set(bearer(temp.accessToken))).status).toBe(403)
    await cleanup([temp.id])
  })
})
