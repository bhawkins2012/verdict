import { randomUUID } from 'crypto'
import { LeverOrigin, LeverStatus, LeverType, LeverInputFormat, UserRole } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { GenerationResult, LeverGenClient, setLeverClientForTests } from '../../src/levers/client'
import { registerUser } from '../helpers'

export async function registerAdmin() {
  const user = await registerUser()
  await prisma.user.update({ where: { id: user.id }, data: { role: UserRole.ADMIN } })
  return user
}

export async function createCategory(opts: { published?: boolean } = {}) {
  const slug = `test-cat-${randomUUID().slice(0, 8)}`
  return prisma.category.create({
    data: { slug, name: `Test ${slug}`, searchTerms: [`term ${slug}`], leversPublishedAt: opts.published ? new Date() : null },
  })
}

export const FIVE: { name: string; type: LeverType; unit: string | null; inputFormat?: LeverInputFormat; allowedValues?: string[] }[] = [
  { name: 'Fold size', type: LeverType.MEASUREMENT, unit: 'cu ft', inputFormat: LeverInputFormat.DIMENSIONS },
  { name: 'Weight', type: LeverType.MEASUREMENT, unit: 'lb' },
  { name: 'Compatibility', type: LeverType.COMPATIBILITY_LIST, unit: null },
  { name: 'Wheel material', type: LeverType.CATEGORY, unit: null, allowedValues: ['Rubber', 'Foam-filled', 'Plastic'] },
  { name: 'Has canopy', type: LeverType.BOOLEAN, unit: null },
]

/** Candidates in a category (not approved). */
export async function addCandidates(categoryId: string, specs = FIVE, prefix = '') {
  const out = []
  for (const s of specs) {
    out.push(await prisma.valueLever.create({
      data: {
        categoryId, name: `${prefix}${s.name}`, type: s.type, unit: s.unit, inputFormat: s.inputFormat ?? LeverInputFormat.SINGLE,
        explanation: `Why ${s.name} matters to a buyer.`, relatedNeeds: ['testing'], allowedValues: s.allowedValues ?? [],
        origin: LeverOrigin.ADMIN,
      },
    }))
  }
  return out
}

/** A category with five approved, published levers (directly in the database, like the seed). */
export async function publishedCategory() {
  const category = await createCategory()
  const now = new Date()
  const levers = await prisma.$transaction(async (tx) => {
    const created = []
    for (const [i, s] of FIVE.entries()) {
      created.push(await tx.valueLever.create({
        data: {
          categoryId: category.id, name: s.name, type: s.type, unit: s.unit, inputFormat: s.inputFormat ?? LeverInputFormat.SINGLE,
          explanation: `Why ${s.name} matters to a buyer.`, relatedNeeds: ['testing'], allowedValues: s.allowedValues ?? [],
          origin: LeverOrigin.ADMIN, status: LeverStatus.APPROVED, position: i + 1, approvedAt: now,
        },
      }))
    }
    await tx.category.update({ where: { id: category.id }, data: { leversPublishedAt: now } })
    return created
  })
  return { category, levers }
}

export async function productIn(categoryId: string, slug: string, name = `Product ${randomUUID().slice(0, 6)}`) {
  return prisma.product.create({ data: { name, category: slug, categoryId } })
}

export async function deleteCategories(ids: string[]) {
  await prisma.product.deleteMany({ where: { categoryId: { in: ids } } })
  await prisma.category.deleteMany({ where: { id: { in: ids } } })
}

/** A valid candidate set as the model would return it. */
export function validCandidates(n = 10) {
  return {
    candidates: Array.from({ length: n }, (_, i) => ({
      name: `Candidate ${i + 1}`,
      type: i % 2 === 0 ? 'MEASUREMENT' : 'BOOLEAN',
      unit: i % 2 === 0 ? 'lb' : null,
      explanation: `Candidate ${i + 1} decides fit for some buyers.`,
      relatedNeeds: ['air travel'],
    })),
  }
}

export interface FakeClient extends LeverGenClient { calls: number }

/** Install a fake Anthropic client returning `result` (or throwing `error`). */
export function fakeClient(result: Partial<GenerationResult> | (() => never)): FakeClient {
  const client: FakeClient = {
    calls: 0,
    async generate() {
      client.calls++
      if (typeof result === 'function') return result()
      return {
        output: result.output ?? null,
        stopReason: result.stopReason ?? 'end_turn',
        servedModel: result.servedModel ?? 'claude-opus-5-5',
        usage: result.usage ?? { inputTokens: 1500, outputTokens: 4000, cacheReadTokens: 0 },
      }
    },
  }
  setLeverClientForTests(client)
  return client
}

const LEVER_ENV = ['LEVER_GEN_MODE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'LEVER_GEN_DAILY_LIMIT', 'LEVER_GEN_MAX_TOKENS'] as const

/** Live mode with a fake key (the client is always faked in tests). */
export function liveMode(extra: Partial<Record<(typeof LEVER_ENV)[number], string>> = {}) {
  process.env.LEVER_GEN_MODE = 'live'
  process.env.ANTHROPIC_API_KEY = 'test-key-never-sent'
  for (const [k, v] of Object.entries(extra)) process.env[k] = v
}

/** Back to the defaults: mode unset (so the default applies) and an empty key that dotenv cannot fill. */
export function resetLeverEnv() {
  for (const k of LEVER_ENV) delete process.env[k]
  process.env.ANTHROPIC_API_KEY = ''
  setLeverClientForTests(null)
}
