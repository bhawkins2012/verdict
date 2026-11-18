import { LeverStatus } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { api, bearer, cleanup, registerUser } from '../helpers'
import { addCandidates, createCategory, deleteCategories, productIn, publishedCategory, registerAdmin } from './helpers'

let admin: Awaited<ReturnType<typeof registerAdmin>>
let user: Awaited<ReturnType<typeof registerUser>>
const categoryIds: string[] = []
let ctx: Awaited<ReturnType<typeof publishedCategory>>
let hidden: Awaited<ReturnType<typeof createCategory>>
let a: { id: string }, b: { id: string }, c: { id: string }

const ADMIN_SRC = { type: 'ADMIN_ENTERED' }
const set = (productId: string, leverIndex: number, body: object) =>
  api().put(`/api/admin/products/${productId}/levers/${ctx.levers[leverIndex].id}`).set(bearer(admin.accessToken)).send({ source: ADMIN_SRC, ...body })

beforeAll(async () => {
  admin = await registerAdmin()
  user = await registerUser()
  ctx = await publishedCategory()
  hidden = await createCategory() // no levers: hidden from browse
  categoryIds.push(ctx.category.id, hidden.id)
  // Candidates and a retired lever next to the published five: none may ever be public.
  const extra = await addCandidates(ctx.category.id, [
    { name: 'SECRET candidate', type: 'BOOLEAN', unit: null },
    { name: 'SECRET retired', type: 'BOOLEAN', unit: null },
  ])
  await prisma.valueLever.update({ where: { id: extra[1].id }, data: { status: LeverStatus.RETIRED } })
  await addCandidates(hidden.id, undefined, 'SECRET ')

  a = await productIn(ctx.category.id, ctx.category.slug, 'Alpha')
  b = await productIn(ctx.category.id, ctx.category.slug, 'Bravo')
  c = await productIn(ctx.category.id, ctx.category.slug, 'Charlie')
  // Fold size, Weight, Compatibility, Wheel material, Has canopy
  for (const [p, dims, weight, compat, wheels, canopy] of [
    [a, [20, 16, 8], 12, ['Seat A'], 'Plastic', true],
    [b, [30, 24, 12], 25, ['Seat A', 'Seat B'], 'Rubber', false],
  ] as const) {
    expect((await set(p.id, 0, { dimensions: { lengthIn: dims[0], widthIn: dims[1], heightIn: dims[2] }, oneHandFold: canopy })).status).toBe(200)
    expect((await set(p.id, 1, { number: weight })).status).toBe(200)
    expect((await set(p.id, 2, { list: [...compat] })).status).toBe(200)
    expect((await set(p.id, 3, { text: wheels })).status).toBe(200)
    expect((await set(p.id, 4, { bool: canopy })).status).toBe(200)
  }
  expect((await set(c.id, 1, { unknown: true })).status).toBe(200) // Charlie: weight unknown, the rest missing
})
afterAll(async () => {
  await deleteCategories(categoryIds)
  await cleanup([admin.id, user.id])
})

describe('unapproved levers are never public', () => {
  it('no public response contains a candidate, a retired lever or an unpublished category\'s levers', async () => {
    const responses = await Promise.all([
      api().get('/api/categories'),
      api().get(`/api/categories/${ctx.category.slug}`),
      api().get(`/api/categories/search?q=${encodeURIComponent(hidden.slug)}`),
      api().get(`/api/categories/${hidden.slug}`),
      api().get(`/api/products/${a.id}`),
      api().get('/api/products/categories/list'),
    ])
    for (const res of responses) expect(JSON.stringify(res.body)).not.toContain('SECRET')
    const page = responses[1].body
    expect(page.levers.map((l: { id: string }) => l.id)).toEqual(ctx.levers.map((l) => l.id))
    const product = responses[4].body
    expect(product.levers.map((l: { lever: { id: string } }) => l.lever.id)).toEqual(ctx.levers.map((l) => l.id))
  })

  it('a category whose levers were approved but which is not published shows none', async () => {
    await prisma.category.update({ where: { id: ctx.category.id }, data: { leversPublishedAt: null } })
    try {
      expect((await api().get(`/api/categories/${ctx.category.slug}`)).status).toBe(404)
      expect((await api().get(`/api/products/${a.id}`)).body.levers).toEqual([])
    } finally {
      await prisma.category.update({ where: { id: ctx.category.id }, data: { leversPublishedAt: new Date() } })
    }
  })
})

describe('browse and search', () => {
  it('browse lists only categories with published levers', async () => {
    const slugs = (await api().get('/api/categories')).body.map((x: { slug: string }) => x.slug)
    expect(slugs).toContain(ctx.category.slug)
    expect(slugs).not.toContain(hidden.slug)
    const legacy = (await api().get('/api/products/categories/list')).body.map((x: { name: string }) => x.name)
    expect(legacy).toContain(ctx.category.slug)
    expect(legacy).not.toContain(hidden.slug)
  })

  it('search finds an unpublished category and marks it as not published (being prepared)', async () => {
    // The slug's random suffix is unique to this category (it appears in its search term and name).
    const res = await api().get(`/api/categories/search?q=${encodeURIComponent(hidden.slug.slice(-8))}`)
    expect(res.body).toEqual([{ slug: hidden.slug, name: hidden.name, published: false }])
    const pub = await api().get(`/api/categories/search?q=${encodeURIComponent(ctx.category.slug.slice(-8))}`)
    expect(pub.body).toEqual([expect.objectContaining({ slug: ctx.category.slug, published: true })])
    expect((await api().get('/api/categories/search?q=a')).body).toEqual([])
    // A whole-word match inside a longer query also finds the category.
    const sentence = await api().get(`/api/categories/search?q=${encodeURIComponent(`best ${ctx.category.slug} for twins`)}`)
    expect(sentence.body.map((x: { slug: string }) => x.slug)).toContain(ctx.category.slug)
  })
})

describe('category page filters', () => {
  const page = (query = '') => api().get(`/api/categories/${ctx.category.slug}${query}`)
  const names = (res: { body: { products: { name: string }[] } }) => res.body.products.map((p) => p.name)
  const id = (i: number) => ctx.levers[i].id

  it('lists every product with its values when unfiltered', async () => {
    const res = await page()
    expect(names(res)).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(res.body.totalInCategory).toBe(3)
    expect(res.body.levers[1].options).toEqual({ min: 12, max: 25 })
    expect(res.body.levers[2].options).toEqual({ values: ['Seat A', 'Seat B'] })
  })

  it('filters a measurement by range; unknown values never match', async () => {
    expect(names(await page(`?lever[${id(1)}][max]=20`))).toEqual(['Alpha'])
    expect(names(await page(`?lever[${id(1)}][min]=20`))).toEqual(['Bravo'])
    expect(names(await page(`?lever[${id(1)}][min]=0`))).toEqual(['Alpha', 'Bravo'])
  })

  it('filters fold size by the computed volume and by one-hand fold', async () => {
    // Alpha 20×16×8 = 1.48 cu ft, Bravo 30×24×12 = 5 cu ft
    expect(names(await page(`?lever[${id(0)}][max]=2`))).toEqual(['Alpha'])
    expect(names(await page(`?lever[${id(0)}][is]=yes`))).toEqual(['Alpha'])
  })

  it('filters category, compatibility and yes/no levers, and combines filters', async () => {
    expect(names(await page(`?lever[${id(3)}][in]=rubber,foam-filled`))).toEqual(['Bravo'])
    expect(names(await page(`?lever[${id(2)}][has]=Seat%20B`))).toEqual(['Bravo'])
    expect(names(await page(`?lever[${id(4)}][is]=no`))).toEqual(['Bravo'])
    expect(names(await page(`?lever[${id(2)}][has]=Seat%20A&lever[${id(1)}][max]=20`))).toEqual(['Alpha'])
  })

  it('answers 400, not 500, for bad filters', async () => {
    for (const q of [
      `?lever[nope][min]=1`,
      `?lever[${id(1)}][min]=abc`,
      `?lever[${id(1)}][in]=x`,
      `?lever[${id(3)}][in]=Wood`,
      `?lever[${id(4)}][is]=maybe`,
      `?lever[${id(1)}][bogus]=1`,
      `?lever=1`,
    ]) expect([q, (await page(q)).status]).toEqual([q, 400])
  })

  it('an unknown or unpublished category is 404', async () => {
    expect((await api().get('/api/categories/no-such-category')).status).toBe(404)
    expect((await api().get(`/api/categories/${hidden.slug}`)).status).toBe(404)
  })
})

describe('product page', () => {
  it('shows each lever with value, source and the category typical value', async () => {
    const res = await api().get(`/api/products/${a.id}`)
    expect(res.status).toBe(200)
    const [fold, weight, compat, wheels, canopy] = res.body.levers
    expect(fold.value).toMatchObject({ dimensions: { lengthIn: 20, widthIn: 16, heightIn: 8 }, number: 1.48, unit: 'cu ft', bool: true })
    expect(weight).toMatchObject({ value: { number: 12, source: { type: 'ADMIN_ENTERED', url: null } }, typical: 18.5 })
    expect(compat).toMatchObject({ value: { list: ['Seat A'] }, typical: null })
    expect(wheels.value.text).toBe('Plastic')
    expect(canopy.value.bool).toBe(true)
  })

  it('missing values are null; unknown is explicit', async () => {
    const res = await api().get(`/api/products/${c.id}`)
    expect(res.body.levers[0].value).toBeNull()
    expect(res.body.levers[1].value).toMatchObject({ unknown: true, number: null })
  })

  it('a product in a category without published levers has none', async () => {
    const p = await productIn(hidden.id, hidden.slug)
    expect((await api().get(`/api/products/${p.id}`)).body.levers).toEqual([])
  })
})

describe('POST /api/products categories', () => {
  it('rejects an unknown category with a 400 that lists the valid ones', async () => {
    const res = await api().post('/api/products').set(bearer(user.accessToken)).send({ name: 'Thing', category: 'gadgets-that-do-not-exist' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Unknown category "gadgets-that-do-not-exist"\. Valid categories: /)
    expect(res.body.validCategories).toEqual(expect.arrayContaining([ctx.category.slug, hidden.slug]))
  })

  it('links a product to an existing category by slug (case-insensitive) and ignores unknown fields', async () => {
    const res = await api().post('/api/products').set(bearer(user.accessToken))
      .send({ name: 'New stroller', category: ` ${ctx.category.slug.toUpperCase()} ` })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ category: ctx.category.slug, categoryId: ctx.category.id, createdBy: user.id })
    const forged = await api().post('/api/products').set(bearer(user.accessToken))
      .send({ name: 'Forged', category: ctx.category.slug, totalReviewCount: 999, driftScoreAvg: 9 })
    expect(forged.status).toBe(201)
    expect(forged.body).toMatchObject({ totalReviewCount: 0, driftScoreAvg: null })
  })
})
