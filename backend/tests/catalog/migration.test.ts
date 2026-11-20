// The Phase A → taxonomy migration on Phase A data (docs/adr-generation-run.md D3): apply the migrations up
// to Phase A in a scratch schema, write Phase A rows, apply the rest, and check where everything went.
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { TEST_DATABASE_URL } from '../testEnv'
import { uid } from '../generation/helpers'

const BACKEND = path.resolve(__dirname, '../..')
const PHASE_A_LAST = '20261118000000_value_levers'
const schema = `migtest_${uid()}`
const url = (() => { const u = new URL(TEST_DATABASE_URL); u.searchParams.set('schema', schema); return u.toString() })()
let dir = ''
let db: PrismaClient

function deploy(upTo: string | null) {
  fs.rmSync(path.join(dir, 'migrations'), { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'migrations'))
  fs.copyFileSync(path.join(BACKEND, 'prisma/migrations/migration_lock.toml'), path.join(dir, 'migrations/migration_lock.toml'))
  for (const m of fs.readdirSync(path.join(BACKEND, 'prisma/migrations')).filter((n) => /^\d/.test(n)).sort()) {
    if (upTo && m > upTo) break
    fs.cpSync(path.join(BACKEND, 'prisma/migrations', m), path.join(dir, 'migrations', m), { recursive: true })
  }
  execSync(`npx prisma migrate deploy --schema ${path.join(dir, 'schema.prisma')}`, { cwd: BACKEND, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' })
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-mig-'))
  fs.copyFileSync(path.join(BACKEND, 'prisma/schema.prisma'), path.join(dir, 'schema.prisma'))
  deploy(PHASE_A_LAST)
  db = new PrismaClient({ datasources: { db: { url } } })
  const sql = (s: string) => db.$executeRawUnsafe(s)
  await sql(`INSERT INTO users (id, email, username, "passwordHash", "updatedAt") VALUES ('u1', 'a@example.com', 'a', 'x', now())`)
  await sql(`INSERT INTO categories (id, slug, name, "searchTerms", "updatedAt", "leversPublishedAt") VALUES
    ('cat-strollers', 'strollers', 'Strollers', '{}', now(), now()), ('cat-car', 'car-seats', 'Car seats', '{}', now(), null),
    ('cat-kitchen', 'kitchen', 'Kitchen', '{}', now(), null)`)
  await sql(`INSERT INTO value_levers (id, "categoryId", name, type, unit, explanation, "relatedNeeds", "allowedValues", status, position, origin, "approvedAt", "updatedAt") VALUES
    ('vl1', 'cat-strollers', 'Weight', 'MEASUREMENT', 'lb', 'How heavy it is to lift.', '{}', '{}', 'APPROVED', 1, 'ADMIN', now(), now()),
    ('vl2', 'cat-strollers', 'Width', 'MEASUREMENT', 'in', 'Fits doors and trunks.', '{}', '{}', 'APPROVED', 2, 'ADMIN', now(), now()),
    ('vl3', 'cat-strollers', 'Canopy', 'BOOLEAN', null, 'Shade for naps outside.', '{}', '{}', 'APPROVED', 3, 'ADMIN', now(), now()),
    ('vl4', 'cat-strollers', 'Basket', 'BOOLEAN', null, 'Room for shopping bags.', '{}', '{}', 'APPROVED', 4, 'ADMIN', now(), now()),
    ('vl5', 'cat-strollers', 'Brake', 'BOOLEAN', null, 'Stops on slopes safely.', '{}', '{}', 'APPROVED', 5, 'ADMIN', now(), now()),
    ('vl6', 'cat-car', 'Load leg', 'BOOLEAN', null, 'Reduces crash rotation.', '{}', '{}', 'CANDIDATE', null, 'GENERATED', null, now()),
    ('vl7', 'cat-kitchen', 'weight', 'MEASUREMENT', 'lb', 'Same name as a stroller lever.', '{}', '{}', 'CANDIDATE', null, 'ADMIN', null, now())`)
  await sql(`INSERT INTO lever_candidate_runs (id, "categoryId", mode, status, model, input, output) VALUES ('run1', 'cat-car', 'LIVE', 'SUCCEEDED', 'claude-opus-5-5', '{}', '{"candidates":[{"name":"Load leg"}]}')`)
  await sql(`INSERT INTO products (id, name, category, "categoryId", "updatedAt") VALUES
    ('p-sample', 'Breeze City Compact', 'strollers', 'cat-strollers', now()),
    ('p-sample-reviewed', 'Reviewed Sample', 'strollers', 'cat-strollers', now()),
    ('p-real', 'Real Stroller', 'strollers', 'cat-strollers', now()),
    ('p-kettle', 'Kettle', 'kitchen', 'cat-kitchen', now())`)
  await sql(`INSERT INTO review_threads (id, "userId", "productId", "updatedAt") VALUES ('t1', 'u1', 'p-sample-reviewed', now())`)
  await sql(`INSERT INTO product_lever_values (id, "productId", "leverId", "valueNumber", unit, "sourceType", "sourceUrl", "isSample") VALUES
    ('v1', 'p-sample', 'vl1', 20, 'lb', 'ADMIN_ENTERED', null, true),
    ('v2', 'p-sample-reviewed', 'vl1', 21, 'lb', 'ADMIN_ENTERED', null, true),
    ('v3', 'p-real', 'vl1', 22, 'lb', 'URL', 'https://maker.example/real', false),
    ('v4', 'p-kettle', 'vl7', 3, 'lb', 'ADMIN_ENTERED', null, false)`)
  deploy(null)
}, 120_000)

afterAll(async () => {
  await db?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await db?.$disconnect()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Phase A data after the migration', () => {
  it('strollers and car seats become navigation nodes under Baby and Kids, with their ids; nothing stays published', async () => {
    const nodes = await db.taxonomyNode.findMany({ include: { parent: true } })
    const by = (slug: string) => nodes.find((n) => n.slug === slug)
    expect(by('strollers')).toMatchObject({ id: 'cat-strollers', kind: 'NAVIGATION', publishedAt: null, parent: expect.objectContaining({ slug: 'baby-and-kids' }) })
    expect(by('car-seats')).toMatchObject({ id: 'cat-car', kind: 'NAVIGATION', safetyCritical: true })
    expect(by('kitchen')).toMatchObject({ kind: 'DECISION', parentId: null, publishedAt: null })
    expect(nodes.filter((n) => n.kind === 'DECISION' && n.parent?.parentId === by('baby-and-kids')?.id)).toHaveLength(7)
  })

  it('the published stroller levers become shared definitions and REFERENCE candidates on Full-size strollers', async () => {
    const fs1 = await db.taxonomyNode.findUniqueOrThrow({ where: { slug: 'full-size-strollers' }, include: { levers: { include: { definition: true } } } })
    expect(fs1.levers.map((l) => [l.definition.name, l.origin, l.status]).sort()).toEqual([
      ['Basket', 'REFERENCE', 'CANDIDATE'], ['Brake', 'REFERENCE', 'CANDIDATE'], ['Canopy', 'REFERENCE', 'CANDIDATE'],
      ['Weight', 'REFERENCE', 'CANDIDATE'], ['Width', 'REFERENCE', 'CANDIDATE'],
    ])
    // Same name in another category: one shared definition, reused by Kitchen.
    expect(await db.leverDefinition.count({ where: { nameKey: 'weight' } })).toBe(1)
    const kitchen = await db.nodeLever.findMany({ where: { node: { slug: 'kitchen' } }, include: { definition: true } })
    expect(kitchen.map((l) => l.definition.name)).toEqual(['Weight'])
    expect(await db.nodeLever.count({ where: { status: 'APPROVED' } })).toBe(0)
  })

  it('the car-seat test run is kept as history only', async () => {
    expect(await db.leverCandidateRun.findUnique({ where: { id: 'run1' } })).toMatchObject({ categoryId: 'cat-car' })
    expect(await db.nodeLever.count({ where: { node: { slug: 'car-seats' } } })).toBe(0)
    expect(await db.leverDefinition.findUnique({ where: { nameKey: 'load leg' } })).not.toBeNull()
  })

  it('sample products are deleted (unless reviewed); real products are kept, unplaced from navigation nodes', async () => {
    const ids = (await db.product.findMany({ select: { id: true } })).map((p) => p.id).sort()
    expect(ids).toEqual(['p-kettle', 'p-real', 'p-sample-reviewed'])
    expect(await db.product.findUniqueOrThrow({ where: { id: 'p-real' } })).toMatchObject({ nodeId: null, category: 'strollers', catalogStatus: 'APPROVED', listed: false })
    expect(await db.product.findUniqueOrThrow({ where: { id: 'p-kettle' } })).toMatchObject({ nodeId: 'cat-kitchen' })
  })

  it('remaining Phase A values are PROPOSED, origin PHASE_A, and can never be accepted', async () => {
    const v = await db.productLeverValue.findUniqueOrThrow({ where: { id: 'v3' } })
    expect(v).toMatchObject({ status: 'PROPOSED', origin: 'PHASE_A', valueNumber: 22, sourceUrl: 'https://maker.example/real' })
    await expect(db.productLeverValue.update({ where: { id: 'v3' }, data: { status: 'ACCEPTED', acceptMode: 'SINGLE', reviewedAt: new Date(), evidenceQuote: 'x' } })).rejects.toThrow(/phase_a_not_accepted/)
  })
})
