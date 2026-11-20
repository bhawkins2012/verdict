// Catalog seed (docs/adr-generation-run.md D3). Idempotent: safe on a database seeded before this existed
// (npm run db:seed:catalog), and called at the end of the main seed. The launch taxonomy itself comes from
// a migration (it is product structure, not demo data).
//
// - A dev/test admin (admin@example.com / password123) only when NODE_ENV is development or test;
//   anywhere else `npm run admin:grant -- <email>` is the only way to get an admin.
// - A root-level, unpublished decision node for every other product category string (kitchen, …), so those
//   products stay placed; products whose string names a navigation node stay unplaced.
// - The Phase A stroller levers as shared definitions and REFERENCE candidates on Full-size strollers: an
//   input to that node's generation run, never published by the seed. No sample products.
import 'dotenv/config'
import { LeverInputFormat, LeverOrigin, LeverType, NodeKind, PrismaClient, UserRole } from '@prisma/client'
import bcrypt from 'bcryptjs'

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

const nameKey = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')

export async function seedCatalog(prisma: PrismaClient, log: (s: string) => void = console.log): Promise<void> {
  // ── Admin (dev/test only) ────────────────────────────────────────────────────────────────────────
  if (DEV_ENVS.includes(process.env.NODE_ENV ?? '')) {
    await prisma.user.upsert({
      where: { email: 'admin@example.com' },
      update: { role: UserRole.ADMIN },
      create: {
        email: 'admin@example.com', username: 'verdict_admin', displayName: 'Verdict Admin',
        passwordHash: await bcrypt.hash('password123', 12), emailVerified: true, emailVerifiedAt: new Date(),
        role: UserRole.ADMIN,
      },
    })
    log('   Admin: admin@example.com (password123), dev/test only')
  } else {
    log(`   No seeded admin (NODE_ENV=${process.env.NODE_ENV ?? 'unset'}); use npm run admin:grant -- <email>`)
  }

  // ── Nodes for other product category strings ─────────────────────────────────────────────────────
  const unplaced = await prisma.product.findMany({ where: { nodeId: null }, select: { category: true }, distinct: ['category'] })
  for (const { category } of unplaced) {
    const slug = category.trim().toLowerCase()
    if (!slug) continue
    const existing = await prisma.taxonomyNode.findUnique({ where: { slug }, select: { id: true, kind: true } })
    if (existing?.kind === NodeKind.NAVIGATION) continue // products belong to decision nodes: an admin places them
    const node = existing ?? await prisma.taxonomyNode.create({
      data: { slug, name: slug.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()), kind: NodeKind.DECISION, searchTerms: [] },
      select: { id: true, kind: true },
    })
    await prisma.product.updateMany({ where: { nodeId: null, category }, data: { nodeId: node.id, category: slug } })
  }

  // ── The Phase A stroller levers: a reference input to the Full-size strollers run ────────────────
  const fullSize = await prisma.taxonomyNode.findUnique({ where: { slug: 'full-size-strollers' }, select: { id: true } })
  if (fullSize) {
    for (const l of STROLLER_LEVERS) {
      const def = await prisma.leverDefinition.upsert({
        where: { nameKey: nameKey(l.name) },
        update: {},
        create: {
          name: l.name, nameKey: nameKey(l.name), type: l.type, inputFormat: l.inputFormat ?? LeverInputFormat.SINGLE, unit: l.unit,
          explanation: l.explanation, relatedNeeds: l.relatedNeeds, allowedValues: l.allowedValues ?? [], origin: LeverOrigin.ADMIN,
        },
      })
      await prisma.nodeLever.upsert({
        where: { nodeId_definitionId: { nodeId: fullSize.id, definitionId: def.id } },
        update: {},
        create: { nodeId: fullSize.id, definitionId: def.id, origin: LeverOrigin.REFERENCE },
      })
    }
    log('   Full-size strollers: the five Phase A stroller levers as reference candidates (nothing published)')
  }
}

if (require.main === module) {
  const prisma = new PrismaClient()
  console.log('🌱 Seeding the catalog...')
  seedCatalog(prisma)
    .then(() => console.log('✅ Catalog seed complete'))
    .catch((err) => { console.error(err); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
}
