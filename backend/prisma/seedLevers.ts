// Categories and value levers seed (docs/adr-levers.md D8). Idempotent: safe to run on a database that
// was seeded before this existed (npm run db:seed:levers), and called at the end of the main seed.
//
// - A dev/test admin (admin@example.com / password123) only when NODE_ENV is development or test;
//   anywhere else `npm run admin:grant -- <email>` is the only way to get an admin.
// - Categories for every existing product category string, linked by categoryId.
// - "strollers" with the five spec levers approved and published, and fictional sample products whose
//   values are all marked as sample data.
// - "car-seats", unpublished, with no levers (ready for a generation run).
import 'dotenv/config'
import { LeverInputFormat, LeverOrigin, LeverStatus, LeverType, PrismaClient, UserRole, ValueSourceType } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { LeverValueInput, toValueData } from '../src/levers/values'

const DEV_ENVS = ['development', 'test']

type LeverSeed = {
  name: string
  type: LeverType
  inputFormat?: LeverInputFormat
  unit: string | null
  explanation: string
  relatedNeeds: string[]
  allowedValues?: string[]
}

export const STROLLER_LEVERS: LeverSeed[] = [
  {
    name: 'Fold size', type: LeverType.MEASUREMENT, inputFormat: LeverInputFormat.DIMENSIONS, unit: 'cu ft',
    explanation: 'Folded size decides whether it fits your trunk, a closet or an overhead bin.',
    relatedNeeds: ['air travel', 'small car', 'storage'],
  },
  {
    name: 'Weight', type: LeverType.MEASUREMENT, unit: 'lb',
    explanation: 'You lift it into the car and up stairs many times a day.',
    relatedNeeds: ['stairs', 'public transport', 'air travel'],
  },
  {
    name: 'Car seat / travel system compatibility', type: LeverType.COMPATIBILITY_LIST, unit: null,
    explanation: 'Lets a sleeping baby move from the car to the stroller without waking.',
    relatedNeeds: ['newborn', 'car travel'],
  },
  {
    name: 'Wheel material', type: LeverType.CATEGORY, unit: null, allowedValues: ['Rubber', 'Foam-filled', 'Plastic'],
    explanation: 'Rubber and foam-filled wheels handle rough ground; plastic is lighter but harsher.',
    relatedNeeds: ['rough terrain', 'city sidewalks'],
  },
  {
    name: 'Seat size and adjustability', type: LeverType.MEASUREMENT, unit: 'lb',
    explanation: 'The seat weight limit sets how long it lasts; recline and seat height decide comfort.',
    relatedNeeds: ['long-term use', 'naps on the go'],
  },
]

const SOURCE = { type: ValueSourceType.ADMIN_ENTERED } as const
const LABEL = 'Sample data'

// Fictional products: no real product shows made-up specs (ADR Q4).
const SAMPLE_STROLLERS: { name: string; brand: string; values: LeverValueInput[] }[] = [
  {
    name: 'Breeze City Compact', brand: 'Sample Brand',
    values: [
      { dimensions: { lengthIn: 21, widthIn: 17, heightIn: 9 }, oneHandFold: true, source: SOURCE, sourceLabel: LABEL },
      { number: 14.5, source: SOURCE, sourceLabel: LABEL },
      { list: ['Sample Infant Seat A', 'Sample Infant Seat B'], detail: 'Adapter needed', source: SOURCE, sourceLabel: LABEL },
      { text: 'Plastic', source: SOURCE, sourceLabel: LABEL },
      { number: 45, detail: '3 recline positions; seat height 20 in', source: SOURCE, sourceLabel: LABEL },
    ],
  },
  {
    name: 'Trailhead All-Terrain', brand: 'Sample Brand',
    values: [
      { dimensions: { lengthIn: 34, widthIn: 25, heightIn: 14 }, oneHandFold: false, source: SOURCE, sourceLabel: LABEL },
      { number: 29, source: SOURCE, sourceLabel: LABEL },
      { list: ['Sample Infant Seat B', 'Sample Infant Seat C'], detail: 'No adapter needed', source: SOURCE, sourceLabel: LABEL },
      { text: 'Rubber', source: SOURCE, sourceLabel: LABEL },
      { number: 65, detail: 'Lie-flat recline; seat height 24 in', source: SOURCE, sourceLabel: LABEL },
    ],
  },
  {
    name: 'Nimbus Travel System', brand: 'Example Co.',
    values: [
      { dimensions: { lengthIn: 30, widthIn: 23, heightIn: 12 }, oneHandFold: true, source: SOURCE, sourceLabel: LABEL },
      { number: 22, source: SOURCE, sourceLabel: LABEL },
      { list: ['Sample Infant Seat A', 'Sample Infant Seat C'], detail: 'Sold with Sample Infant Seat A', source: SOURCE, sourceLabel: LABEL },
      { text: 'Foam-filled', source: SOURCE, sourceLabel: LABEL },
      { number: 50, detail: '4 recline positions; seat height 22 in', source: SOURCE, sourceLabel: LABEL },
    ],
  },
  {
    name: 'Pebble Everyday', brand: 'Example Co.',
    values: [
      { dimensions: { lengthIn: 26, widthIn: 20, heightIn: 11 }, oneHandFold: false, source: SOURCE, sourceLabel: LABEL },
      { number: 18, source: SOURCE, sourceLabel: LABEL },
      { unknown: true, source: SOURCE, sourceLabel: LABEL, detail: 'Compatibility not yet confirmed' },
      { text: 'Foam-filled', source: SOURCE, sourceLabel: LABEL },
      { number: 50, detail: '2 recline positions', source: SOURCE, sourceLabel: LABEL },
    ],
  },
]

export async function seedLevers(prisma: PrismaClient, log: (s: string) => void = console.log): Promise<void> {
  // ── Admin (dev/test only) ────────────────────────────────────────────────────────────────────────
  let adminId: string | null = null
  if (DEV_ENVS.includes(process.env.NODE_ENV ?? '')) {
    const admin = await prisma.user.upsert({
      where: { email: 'admin@example.com' },
      update: { role: UserRole.ADMIN },
      create: {
        email: 'admin@example.com', username: 'verdict_admin', displayName: 'Verdict Admin',
        passwordHash: await bcrypt.hash('password123', 12), emailVerified: true, emailVerifiedAt: new Date(),
        role: UserRole.ADMIN,
      },
    })
    adminId = admin.id
    log('   Admin: admin@example.com (password123), dev/test only')
  } else {
    log(`   No seeded admin (NODE_ENV=${process.env.NODE_ENV ?? 'unset'}); use npm run admin:grant -- <email>`)
  }

  // ── Categories for existing product strings ──────────────────────────────────────────────────────
  const unlinked = await prisma.product.findMany({ where: { categoryId: null }, select: { category: true }, distinct: ['category'] })
  for (const { category } of unlinked) {
    const slug = category.trim().toLowerCase()
    if (!slug) continue
    const c = await prisma.category.upsert({
      where: { slug },
      update: {},
      create: { slug, name: slug.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()), searchTerms: [] },
    })
    await prisma.product.updateMany({ where: { categoryId: null, category }, data: { categoryId: c.id, category: slug } })
  }

  // ── Car seats: unpublished, ready for a generation run ───────────────────────────────────────────
  await prisma.category.upsert({
    where: { slug: 'car-seats' },
    update: {},
    create: { slug: 'car-seats', name: 'Car seats', searchTerms: ['car seat', 'infant car seat', 'convertible car seat', 'booster seat'], createdById: adminId },
  })

  // ── Strollers: five published levers ─────────────────────────────────────────────────────────────
  const strollers = await prisma.category.upsert({
    where: { slug: 'strollers' },
    update: {},
    create: { slug: 'strollers', name: 'Strollers', searchTerms: ['stroller', 'pram', 'pushchair', 'travel system', 'buggy'], createdById: adminId },
  })
  const approved = await prisma.valueLever.count({ where: { categoryId: strollers.id, status: LeverStatus.APPROVED } })
  if (approved === 0) {
    const now = new Date()
    await prisma.$transaction(async (tx) => {
      for (const [i, l] of STROLLER_LEVERS.entries()) {
        await tx.valueLever.create({
          data: {
            categoryId: strollers.id, name: l.name, type: l.type, inputFormat: l.inputFormat ?? LeverInputFormat.SINGLE,
            unit: l.unit, explanation: l.explanation, relatedNeeds: l.relatedNeeds, allowedValues: l.allowedValues ?? [],
            status: LeverStatus.APPROVED, position: i + 1, origin: LeverOrigin.ADMIN, approvedById: adminId, approvedAt: now,
          },
        })
      }
      await tx.category.update({ where: { id: strollers.id }, data: { leversPublishedAt: now, leversPublishedById: adminId } })
    })
    log('   Strollers: five levers published')
  }
  const levers = await prisma.valueLever.findMany({ where: { categoryId: strollers.id, status: LeverStatus.APPROVED }, orderBy: { position: 'asc' } })

  // ── Sample strollers with sample values ──────────────────────────────────────────────────────────
  for (const s of SAMPLE_STROLLERS) {
    const product =
      (await prisma.product.findFirst({ where: { name: s.name, categoryId: strollers.id } })) ??
      (await prisma.product.create({
        data: {
          name: s.name, brand: s.brand, category: strollers.slug, categoryId: strollers.id,
          description: 'Sample product for demo data; not a real stroller.', createdBy: adminId,
        },
      }))
    for (const [i, input] of s.values.entries()) {
      const lever = levers.find((l) => l.position === i + 1)
      if (!lever || lever.name !== STROLLER_LEVERS[i].name) continue // the published set was changed by an admin
      const data = toValueData(lever, input)
      if (!data.ok) throw new Error(`Seed value for ${s.name} / ${lever.name} is invalid: ${data.error}`)
      await prisma.productLeverValue.upsert({
        where: { productId_leverId: { productId: product.id, leverId: lever.id } },
        create: { productId: product.id, leverId: lever.id, ...data.data, isSample: true, recordedById: adminId },
        update: {},
      })
    }
  }
  log(`   Strollers: ${SAMPLE_STROLLERS.length} sample products (values marked "Sample data")`)
  log('   Car seats: unpublished, no levers (run a generation from /admin)')
}

if (require.main === module) {
  const prisma = new PrismaClient()
  console.log('🌱 Seeding categories and value levers...')
  seedLevers(prisma)
    .then(() => console.log('✅ Lever seed complete'))
    .catch((err) => { console.error(err); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
}
