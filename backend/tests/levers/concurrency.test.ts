// Admin writes that race a publish: a transaction holds the category lock and changes the lever while the
// request waits on the lock. The request must decide on the lever as it is after that commit.
import { LeverStatus } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { api, bearer, cleanup } from '../helpers'
import { addCandidates, deleteCategories, productIn, publishedCategory, registerAdmin } from './helpers'

let admin: Awaited<ReturnType<typeof registerAdmin>>
const categoryIds: string[] = []

beforeAll(async () => { admin = await registerAdmin() })
afterAll(async () => {
  await deleteCategories(categoryIds)
  await cleanup([admin.id])
})

/** Run `change` inside a transaction that holds the category lock, while `request` is sent and waits. */
async function whileLocked<T>(categoryId: string, change: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>, request: () => Promise<T>): Promise<T> {
  let pending: Promise<T> | undefined
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "categories" WHERE id = ${categoryId} FOR UPDATE`
    await change(tx)
    pending = request()
    await new Promise((r) => setTimeout(r, 400)) // the request is now blocked on the category lock
  })
  if (!pending) throw new Error('request not sent')
  return pending
}

it('retire: a candidate published while the retire waits is refused with 409 (not a 500)', async () => {
  const { category, levers } = await publishedCategory()
  categoryIds.push(category.id)
  const [cand] = await addCandidates(category.id, [{ name: 'Late entry', type: 'BOOLEAN', unit: null }])
  const res = await whileLocked(category.id, async (tx) => {
    // Swap the candidate into the published set in place of lever 5.
    await tx.valueLever.update({ where: { id: levers[4].id }, data: { status: LeverStatus.RETIRED, position: null } })
    await tx.valueLever.update({ where: { id: cand.id }, data: { status: LeverStatus.APPROVED, position: 5, approvedAt: new Date() } })
  }, () => api().post(`/api/admin/levers/${cand.id}/retire`).set(bearer(admin.accessToken)).then((r) => r))
  expect(res.status).toBe(409)
  expect((await prisma.valueLever.findUniqueOrThrow({ where: { id: cand.id } })).status).toBe(LeverStatus.APPROVED)
})

it('value write: a lever retired while the write waits is refused with 409 and nothing is written', async () => {
  const { category, levers } = await publishedCategory()
  categoryIds.push(category.id)
  const product = await productIn(category.id, category.slug)
  const [replacement] = await addCandidates(category.id, [{ name: 'Replacement', type: 'BOOLEAN', unit: null }])
  const canopy = levers[4]
  const res = await whileLocked(category.id, async (tx) => {
    await tx.valueLever.update({ where: { id: canopy.id }, data: { status: LeverStatus.RETIRED, position: null } })
    await tx.valueLever.update({ where: { id: replacement.id }, data: { status: LeverStatus.APPROVED, position: 5, approvedAt: new Date() } })
  }, () => api().put(`/api/admin/products/${product.id}/levers/${canopy.id}`).set(bearer(admin.accessToken))
    .send({ bool: true, source: { type: 'ADMIN_ENTERED' } }).then((r) => r))
  expect(res.status).toBe(409)
  expect(await prisma.productLeverValue.count({ where: { productId: product.id } })).toBe(0)
})

it('lever edit: a lever published while the edit waits keeps the published-category rule', async () => {
  const { category, levers } = await publishedCategory()
  categoryIds.push(category.id)
  const [cand] = await addCandidates(category.id, [{ name: 'Seat fabric', type: 'CATEGORY', unit: null, allowedValues: ['Mesh', 'Canvas'] }])
  const res = await whileLocked(category.id, async (tx) => {
    await tx.valueLever.update({ where: { id: levers[4].id }, data: { status: LeverStatus.RETIRED, position: null } })
    await tx.valueLever.update({ where: { id: cand.id }, data: { status: LeverStatus.APPROVED, position: 5, approvedAt: new Date() } })
  }, () => api().patch(`/api/admin/levers/${cand.id}`).set(bearer(admin.accessToken)).send({ allowedValues: [] }).then((r) => r))
  expect(res.status).toBe(400)
  expect((await prisma.valueLever.findUniqueOrThrow({ where: { id: cand.id } })).allowedValues).toEqual(['Mesh', 'Canvas'])
})
