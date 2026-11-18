import { ValueSourceType } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { foldedVolumeCuFt } from '../../src/levers/values'
import { api, bearer, cleanup } from '../helpers'
import { addCandidates, createCategory, deleteCategories, productIn, publishedCategory, registerAdmin } from './helpers'

let admin: Awaited<ReturnType<typeof registerAdmin>>
const categoryIds: string[] = []
let ctx: Awaited<ReturnType<typeof publishedCategory>>
let product: { id: string }
let otherProduct: { id: string }

beforeAll(async () => {
  admin = await registerAdmin()
  ctx = await publishedCategory()
  categoryIds.push(ctx.category.id)
  product = await productIn(ctx.category.id, ctx.category.slug, 'Value test stroller')
  otherProduct = await productIn(ctx.category.id, ctx.category.slug, 'Other stroller')
})
afterAll(async () => {
  await deleteCategories(categoryIds)
  await cleanup([admin.id])
})

const [FOLD, WEIGHT, COMPAT, WHEELS, CANOPY] = [0, 1, 2, 3, 4]
const lever = (i: number) => ctx.levers[i]
const put = (i: number, body: object, productId = product.id) =>
  api().put(`/api/admin/products/${productId}/levers/${lever(i).id}`).set(bearer(admin.accessToken)).send(body)
const ADMIN_SRC = { type: 'ADMIN_ENTERED' }
const csv = (text: string, dryRun = false) =>
  api().post(`/api/admin/categories/${ctx.category.id}/lever-values/import${dryRun ? '?dryRun=true' : ''}`)
    .set(bearer(admin.accessToken)).set('Content-Type', 'text/csv').send(text)

describe('source is required on every value', () => {
  it('the form refuses a value without a source', async () => {
    const res = await put(WEIGHT, { number: 20 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/source/)
    expect(await prisma.productLeverValue.count({ where: { productId: product.id, leverId: lever(WEIGHT).id } })).toBe(0)
  })

  it.each([
    ['an empty URL', { type: 'URL', url: '' }],
    ['a non-http URL', { type: 'URL', url: 'javascript:alert(1)' }],
    ['a URL source without a URL', { type: 'URL' }],
    ['an unknown source type', { type: 'BRAND' }],
  ])('the form refuses %s', async (_l, source) => {
    expect((await put(WEIGHT, { number: 20, source })).status).toBe(400)
  })

  it('stores a URL source, and who recorded it and when', async () => {
    const res = await put(WEIGHT, { number: 21.5, source: { type: 'URL', url: 'https://maker.example/spec' }, sourceLabel: 'Spec page' })
    expect(res.status).toBe(200)
    const v = await prisma.productLeverValue.findUniqueOrThrow({ where: { productId_leverId: { productId: product.id, leverId: lever(WEIGHT).id } } })
    expect(v).toMatchObject({ valueNumber: 21.5, unit: 'lb', sourceType: ValueSourceType.URL, sourceUrl: 'https://maker.example/spec', sourceLabel: 'Spec page', recordedById: admin.id, isSample: false })
  })

  it('the database refuses a URL source without a URL, and a URL on an admin-entered source', async () => {
    await expect(prisma.productLeverValue.create({ data: { productId: otherProduct.id, leverId: lever(CANOPY).id, valueBool: true, sourceType: ValueSourceType.URL } })).rejects.toThrow()
    await expect(prisma.productLeverValue.create({ data: { productId: otherProduct.id, leverId: lever(CANOPY).id, valueBool: true, sourceType: ValueSourceType.ADMIN_ENTERED, sourceUrl: 'https://x.example' } })).rejects.toThrow()
  })

  it('a CSV row without a source fails the whole file; nothing is written', async () => {
    const res = await csv(`product_id,lever,value,source\n${otherProduct.id},Weight,19,entered by admin\n${otherProduct.id},Has canopy,yes,\n`)
    expect(res.status).toBe(400)
    expect(res.body.rows).toEqual([{ row: 3, error: expect.stringMatching(/source is required/) }])
    expect(await prisma.productLeverValue.count({ where: { productId: otherProduct.id } })).toBe(0)
  })
})

describe('value shapes', () => {
  it('fold size: L × W × H in inches; the volume is computed, never entered', async () => {
    const res = await put(FOLD, { dimensions: { lengthIn: 24, widthIn: 18, heightIn: 10 }, oneHandFold: true, source: ADMIN_SRC })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ number: 2.5, unit: 'cu ft', bool: true, dimensions: { lengthIn: 24, widthIn: 18, heightIn: 10 } })
    expect((await put(FOLD, { number: 3, source: ADMIN_SRC })).status).toBe(400)
    expect((await put(FOLD, { number: 3, dimensions: { lengthIn: 1, widthIn: 1, heightIn: 1 }, source: ADMIN_SRC })).status).toBe(400)
    expect(foldedVolumeCuFt(21, 17, 9)).toBe(1.86)
  })

  it('measurement: the unit must match the lever', async () => {
    expect((await put(WEIGHT, { number: 9, unit: 'kg', source: ADMIN_SRC })).status).toBe(400)
    expect((await put(WEIGHT, { number: 9, unit: 'lb', source: ADMIN_SRC })).status).toBe(200)
  })

  it('category: one of the allowed values (matched case-insensitively, stored canonically)', async () => {
    expect((await put(WHEELS, { text: 'Wooden', source: ADMIN_SRC })).status).toBe(400)
    const res = await put(WHEELS, { text: 'rubber', source: ADMIN_SRC })
    expect(res.status).toBe(200)
    expect(res.body.text).toBe('Rubber')
  })

  it('compatibility list: de-duplicated; boolean: yes/no; fields of another type are refused', async () => {
    expect((await put(COMPAT, { list: ['Seat A', 'seat a', 'Seat B'], source: ADMIN_SRC })).body.list).toEqual(['Seat A', 'Seat B'])
    expect((await put(CANOPY, { bool: false, source: ADMIN_SRC })).body.bool).toBe(false)
    expect((await put(CANOPY, { text: 'yes', source: ADMIN_SRC })).status).toBe(400)
  })

  it('unknown is explicit and cannot carry a value', async () => {
    expect((await put(CANOPY, { unknown: true, bool: true, source: ADMIN_SRC })).status).toBe(400)
    expect((await put(CANOPY, { unknown: true, source: ADMIN_SRC })).body).toMatchObject({ unknown: true, bool: null })
  })

  it('values only for published levers of the product\'s own category', async () => {
    const [cand] = await addCandidates(ctx.category.id, [{ name: 'Unpublished thing', type: 'BOOLEAN', unit: null }])
    expect((await api().put(`/api/admin/products/${product.id}/levers/${cand.id}`).set(bearer(admin.accessToken)).send({ bool: true, source: ADMIN_SRC })).status).toBe(409)
    const elsewhere = await createCategory()
    categoryIds.push(elsewhere.id)
    const foreign = await productIn(elsewhere.id, elsewhere.slug)
    expect((await put(CANOPY, { bool: true, source: ADMIN_SRC }, foreign.id)).status).toBe(400)
  })
})

describe('CSV import of lever values', () => {
  const header = 'product_id,lever,value,unit,unknown,detail,source,source_label,one_hand_fold'
  const good = () => [
    header,
    `${otherProduct.id},Fold size,22 x 18 x 9,in,,folds flat,https://maker.example/manual,Manual p. 4,yes`,
    `${otherProduct.id},weight,17.5,lb,,,entered by admin,,`,
    `${otherProduct.id},Compatibility,Seat A|Seat C,,,,entered by admin,,`,
    `${otherProduct.id},Wheel material,Foam-filled,,,,https://maker.example/spec,,`,
    `${otherProduct.id},Has canopy,,,yes,,entered by admin,,`,
  ].join('\n')

  it('a check (dry run) validates without writing', async () => {
    const res = await csv(good(), true)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ valid: true, rows: 5, imported: 0 })
    expect(await prisma.productLeverValue.count({ where: { productId: otherProduct.id } })).toBe(0)
  })

  it('imports every row with its source and the importing admin', async () => {
    const res = await csv(good())
    expect(res.status).toBe(200)
    expect(res.body.imported).toBe(5)
    const values = await prisma.productLeverValue.findMany({ where: { productId: otherProduct.id } })
    expect(values).toHaveLength(5)
    expect(values.every((v) => v.recordedById === admin.id)).toBe(true)
    const fold = values.find((v) => v.leverId === lever(FOLD).id)
    expect(fold).toMatchObject({ dimLengthIn: 22, valueNumber: foldedVolumeCuFt(22, 18, 9), valueBool: true, sourceUrl: 'https://maker.example/manual', detail: 'folds flat' })
    expect(values.find((v) => v.leverId === lever(CANOPY).id)?.isUnknown).toBe(true)
  })

  it('reports every bad row with its number and writes nothing', async () => {
    const before = await prisma.productLeverValue.findMany({ where: { productId: otherProduct.id }, orderBy: { leverId: 'asc' } })
    const text = [
      header,
      `${otherProduct.id},Weight,12,lb,,,entered by admin,,`, // valid
      `${otherProduct.id},Weight,13,lb,,,entered by admin,,`, // duplicate product+lever
      `${otherProduct.id},Colour,red,,,,entered by admin,,`, // not a published lever
      `nope,Weight,1,lb,,,entered by admin,,`, // unknown product
      `${otherProduct.id},Fold size,22 by 18,in,,,entered by admin,,`, // bad dimensions
      `${otherProduct.id},Wheel material,Wood,,,,entered by admin,,`, // not allowed
      `${otherProduct.id},Has canopy,maybe,,,,entered by admin,,`, // not yes/no
      `${otherProduct.id},Compatibility,Seat A,,,,ftp://x.example,,`, // not http(s)
    ].join('\n')
    const res = await csv(text)
    expect(res.status).toBe(400)
    expect(res.body.rows.map((r: { row: number }) => r.row)).toEqual([3, 4, 5, 6, 7, 8, 9])
    const after = await prisma.productLeverValue.findMany({ where: { productId: otherProduct.id }, orderBy: { leverId: 'asc' } })
    expect(after).toEqual(before)
  })

  it('refuses a file without the required columns, an empty file and a non-CSV body', async () => {
    expect((await csv('product_id,lever,value\nx,y,z')).body.error).toMatch(/Missing column: source/)
    expect((await csv('product_id,lever,value,source\n')).status).toBe(400)
    const json = await api().post(`/api/admin/categories/${ctx.category.id}/lever-values/import`).set(bearer(admin.accessToken)).send({ a: 1 })
    expect(json.status).toBe(415)
  })
})

describe('survey import', () => {
  const upload = (categoryId: string, text: string) =>
    api().post(`/api/admin/categories/${categoryId}/survey?filename=owners.csv`).set(bearer(admin.accessToken)).set('Content-Type', 'text/csv').send(text)

  it('stores rankings and matches them to levers by name on the admin view; unmatched rows are listed', async () => {
    const c = await createCategory()
    categoryIds.push(c.id)
    await addCandidates(c.id, [{ name: 'Weight', type: 'MEASUREMENT', unit: 'lb' }, { name: 'Fold size', type: 'MEASUREMENT', unit: 'in' }])
    const res = await upload(c.id, 'lever,rank,respondents\n weight ,1,40\nFold Size,2,38\nPrice,3,20\n')
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ filename: 'owners.csv', rowCount: 3 })
    const view = await api().get(`/api/admin/categories/${c.id}`).set(bearer(admin.accessToken))
    const byName = Object.fromEntries(view.body.levers.map((l: { name: string; survey: unknown }) => [l.name, l.survey]))
    expect(byName).toEqual({ Weight: { rank: 1, respondents: 40 }, 'Fold size': { rank: 2, respondents: 38 } })
    expect(view.body.survey.unmatched).toEqual([{ lever: 'Price', rank: 3, respondents: 20 }])
  })

  it('is all or nothing: a bad rank fails the file', async () => {
    const c = await createCategory()
    categoryIds.push(c.id)
    const res = await upload(c.id, 'lever,rank,respondents\nWeight,1,40\nFold,zero,3\nWeight,4,1\n')
    expect(res.status).toBe(400)
    expect(res.body.rows.map((r: { row: number }) => r.row)).toEqual([3, 4])
    expect(await prisma.surveyImport.count({ where: { categoryId: c.id } })).toBe(0)
  })
})
