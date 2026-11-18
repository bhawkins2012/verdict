import { LeverStatus, UserRole } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { setAdminRole } from '../../src/scripts/adminRole'
import { api, bearer, cleanup, registerUser } from '../helpers'
import { addCandidates, createCategory, deleteCategories, publishedCategory, registerAdmin, resetLeverEnv } from './helpers'

let admin: Awaited<ReturnType<typeof registerAdmin>>
let user: Awaited<ReturnType<typeof registerUser>>
const categoryIds: string[] = []

beforeAll(async () => {
  admin = await registerAdmin()
  user = await registerUser()
})
afterAll(async () => {
  resetLeverEnv()
  await deleteCategories(categoryIds)
  await cleanup([admin.id, user.id])
})

const track = <T extends { id: string }>(c: T) => { categoryIds.push(c.id); return c }

// Every admin route, with a body that would be valid enough to reach the handler.
const ROUTES: [method: 'get' | 'post' | 'patch' | 'put', path: string][] = [
  ['get', '/api/admin/config'],
  ['get', '/api/admin/categories'],
  ['post', '/api/admin/categories'],
  ['get', '/api/admin/categories/x'],
  ['post', '/api/admin/categories/x/runs'],
  ['get', '/api/admin/runs/x'],
  ['post', '/api/admin/categories/x/levers'],
  ['patch', '/api/admin/levers/x'],
  ['post', '/api/admin/levers/x/retire'],
  ['post', '/api/admin/categories/x/publish'],
  ['post', '/api/admin/categories/x/survey'],
  ['get', '/api/admin/products/x/levers'],
  ['put', '/api/admin/products/x/levers/y'],
  ['post', '/api/admin/categories/x/lever-values/import'],
]

describe('admin-only access', () => {
  it.each(ROUTES)('%s %s: 401 without a token, 403 for a normal user', async (method, path) => {
    expect((await api()[method](path).send({})).status).toBe(401)
    const res = await api()[method](path).set(bearer(user.accessToken)).send({})
    expect(res.status).toBe(403)
  })

  it('reads the role from the database: a demoted admin is refused with the same token', async () => {
    const temp = await registerAdmin()
    expect((await api().get('/api/admin/categories').set(bearer(temp.accessToken))).status).toBe(200)
    await prisma.user.update({ where: { id: temp.id }, data: { role: UserRole.USER } })
    expect((await api().get('/api/admin/categories').set(bearer(temp.accessToken))).status).toBe(403)
    await cleanup([temp.id])
  })

  it('a normal user cannot start a generation run (no run row is created)', async () => {
    const c = track(await createCategory())
    expect((await api().post(`/api/admin/categories/${c.id}/runs`).set(bearer(user.accessToken)).send({})).status).toBe(403)
    expect(await prisma.leverCandidateRun.count({ where: { categoryId: c.id } })).toBe(0)
  })

  it('/auth/me and login report the role', async () => {
    expect((await api().get('/api/auth/me').set(bearer(admin.accessToken))).body.role).toBe('ADMIN')
    expect((await api().get('/api/auth/me').set(bearer(user.accessToken))).body.role).toBe('USER')
    const login = await api().post('/api/auth/login').send({ email: user.email, password: user.password })
    expect(login.body.user.role).toBe('USER')
  })

  it('admin:grant and admin:revoke change the role by normalized address', async () => {
    const u = await registerUser()
    expect(await setAdminRole(prisma, 'grant', `  ${u.email.toUpperCase()} `)).toMatchObject({ ok: true })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role).toBe(UserRole.ADMIN)
    expect(await setAdminRole(prisma, 'revoke', u.email)).toMatchObject({ ok: true })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role).toBe(UserRole.USER)
    expect(await setAdminRole(prisma, 'grant', 'nobody-here@example.com')).toMatchObject({ ok: false })
    expect(await setAdminRole(prisma, 'promote', u.email)).toMatchObject({ ok: false })
    await cleanup([u.id])
  })
})

describe('categories', () => {
  it('creates a category with a derived slug; a duplicate slug is 409', async () => {
    const name = `Bunk beds ${Date.now()}`
    const res = await api().post('/api/admin/categories').set(bearer(admin.accessToken)).send({ name, searchTerms: ['bunk bed'] })
    expect(res.status).toBe(201)
    track(res.body)
    expect(res.body.slug).toBe(name.toLowerCase().replace(/ /g, '-'))
    expect(res.body.leversPublishedAt).toBeNull()
    expect((await api().post('/api/admin/categories').set(bearer(admin.accessToken)).send({ name })).status).toBe(409)
  })
})

describe('exactly five published levers', () => {
  const publish = (categoryId: string, leverIds: string[]) =>
    api().post(`/api/admin/categories/${categoryId}/publish`).set(bearer(admin.accessToken)).send({ leverIds })

  it('publishes five in order, recording who approved them and when', async () => {
    const c = track(await createCategory())
    const levers = await addCandidates(c.id)
    const order = [levers[2], levers[0], levers[1], levers[4], levers[3]].map((l) => l.id)
    const res = await publish(c.id, order)
    expect(res.status).toBe(200)
    expect(res.body.levers.map((l: { id: string }) => l.id)).toEqual(order)
    const stored = await prisma.valueLever.findMany({ where: { categoryId: c.id }, orderBy: { position: 'asc' } })
    expect(stored.every((l) => l.status === LeverStatus.APPROVED && l.approvedById === admin.id && l.approvedAt)).toBe(true)
    expect((await prisma.category.findUniqueOrThrow({ where: { id: c.id } })).leversPublishedById).toBe(admin.id)
  })

  it.each([4, 6])('refuses %i levers', async (n) => {
    const c = track(await createCategory())
    const levers = [...(await addCandidates(c.id)), ...(await addCandidates(c.id, undefined, 'More '))]
    expect((await publish(c.id, levers.slice(0, n).map((l) => l.id))).status).toBe(400)
    expect(await prisma.valueLever.count({ where: { categoryId: c.id, status: LeverStatus.APPROVED } })).toBe(0)
  })

  it('refuses duplicates, levers from another category, retired levers and a category lever without values', async () => {
    const c = track(await createCategory())
    const other = track(await createCategory())
    const levers = await addCandidates(c.id)
    const foreign = await addCandidates(other.id)
    const ids = levers.map((l) => l.id)
    expect((await publish(c.id, [ids[0], ids[0], ids[1], ids[2], ids[3]])).status).toBe(400)
    expect((await publish(c.id, [...ids.slice(0, 4), foreign[0].id])).status).toBe(400)
    await prisma.valueLever.update({ where: { id: ids[4] }, data: { status: LeverStatus.RETIRED } })
    expect((await publish(c.id, ids)).status).toBe(400)
    await prisma.valueLever.update({ where: { id: ids[4] }, data: { status: LeverStatus.CANDIDATE } })
    await prisma.valueLever.update({ where: { id: ids[3] }, data: { allowedValues: ['Only one'] } }) // the CATEGORY lever
    const res = await publish(c.id, ids)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/two allowed values/)
  })

  it('republishing retires the levers left out of the new set', async () => {
    const { category, levers } = await publishedCategory()
    track(category)
    const [extra] = await addCandidates(category.id, [{ name: 'Basket size', type: 'MEASUREMENT', unit: 'lb' }])
    const next = [extra.id, ...levers.slice(1).map((l) => l.id)]
    expect((await publish(category.id, next)).status).toBe(200)
    const dropped = await prisma.valueLever.findUniqueOrThrow({ where: { id: levers[0].id } })
    expect(dropped).toMatchObject({ status: LeverStatus.RETIRED, position: null, retiredById: admin.id })
    expect(await prisma.valueLever.count({ where: { categoryId: category.id, status: LeverStatus.APPROVED } })).toBe(5)
  })

  it('the database refuses a commit that leaves a category with 4 approved levers', async () => {
    const { category, levers } = await publishedCategory()
    track(category)
    await expect(
      prisma.valueLever.update({ where: { id: levers[0].id }, data: { status: LeverStatus.RETIRED, position: null } })
    ).rejects.toThrow(/exactly 0 or 5/)
    expect(await prisma.valueLever.count({ where: { categoryId: category.id, status: LeverStatus.APPROVED } })).toBe(5)
  })

  it('the database refuses a sixth approved lever, and an approved lever without a position', async () => {
    const { category } = await publishedCategory()
    track(category)
    const [extra] = await addCandidates(category.id, [{ name: 'Sixth', type: 'BOOLEAN', unit: null }])
    await expect(prisma.valueLever.update({ where: { id: extra.id }, data: { status: LeverStatus.APPROVED, approvedAt: new Date() } })).rejects.toThrow()
    await expect(prisma.valueLever.update({ where: { id: extra.id }, data: { status: LeverStatus.APPROVED, position: 6, approvedAt: new Date() } })).rejects.toThrow()
  })

  it('an approved lever cannot be retired on its own; a candidate can', async () => {
    const { category, levers } = await publishedCategory()
    track(category)
    const res = await api().post(`/api/admin/levers/${levers[0].id}/retire`).set(bearer(admin.accessToken))
    expect(res.status).toBe(409)
    const [cand] = await addCandidates(category.id, [{ name: 'Throwaway', type: 'BOOLEAN', unit: null }])
    expect((await api().post(`/api/admin/levers/${cand.id}/retire`).set(bearer(admin.accessToken))).status).toBe(200)
  })
})

describe('lever edits', () => {
  const edit = (id: string, body: object) => api().patch(`/api/admin/levers/${id}`).set(bearer(admin.accessToken)).send(body)

  it('edits a candidate and records who edited it', async () => {
    const c = track(await createCategory())
    const [l] = await addCandidates(c.id, [{ name: 'Weight', type: 'MEASUREMENT', unit: 'lb' }])
    const res = await edit(l.id, { name: 'Total weight', unit: 'kg', explanation: 'Heavier frames are harder to carry upstairs.' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ name: 'Total weight', unit: 'kg', editedById: admin.id })
  })

  it('enforces the shape rules: unit iff measurement, dimensions only in cu ft, one-line explanation', async () => {
    const c = track(await createCategory())
    const [m, b] = await addCandidates(c.id, [{ name: 'Weight', type: 'MEASUREMENT', unit: 'lb' }, { name: 'Canopy', type: 'BOOLEAN', unit: null }])
    expect((await edit(m.id, { unit: null })).status).toBe(400)
    expect((await edit(b.id, { unit: 'lb' })).status).toBe(400)
    expect((await edit(m.id, { inputFormat: 'DIMENSIONS' })).status).toBe(400) // still in lb
    expect((await edit(m.id, { inputFormat: 'DIMENSIONS', unit: 'cu ft' })).status).toBe(200)
    expect((await edit(b.id, { explanation: 'Line one is here.\nLine two.' })).status).toBe(400)
    expect((await edit(b.id, { type: 'MEASUREMENT', unit: 'in' })).status).toBe(200)
  })

  it('a duplicate name in the category is 409 (case-insensitive)', async () => {
    const c = track(await createCategory())
    const [a] = await addCandidates(c.id, [{ name: 'Weight', type: 'MEASUREMENT', unit: 'lb' }, { name: 'Canopy', type: 'BOOLEAN', unit: null }])
    expect((await edit(a.id, { name: ' canopy ' })).status).toBe(409)
  })

  it('adds a lever by hand as a candidate', async () => {
    const c = track(await createCategory())
    const res = await api().post(`/api/admin/categories/${c.id}/levers`).set(bearer(admin.accessToken))
      .send({ name: 'Harness type', type: 'CATEGORY', allowedValues: ['3-point', '5-point'], explanation: 'A five-point harness keeps a wriggly child safer.' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ status: 'CANDIDATE', origin: 'ADMIN', unit: null })
  })
})
