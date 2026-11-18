// Categories and levers: admin edits, the atomic publish of five, and the one public read path
// (docs/adr-levers.md D4). Every write that checks names or the approved set locks the category row first.
import { z } from 'zod'
import { LeverInputFormat, LeverOrigin, LeverStatus, LeverType, Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { normalizeName } from './candidates'

export const LEVERS_PER_CATEGORY = 5

type Tx = Prisma.TransactionClient

// ── Categories ───────────────────────────────────────────────────────────────────────────────────────
export function normalizeSlug(s: string): string {
  return s.trim().toLowerCase()
}

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(50)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'use lower-case letters, digits and single hyphens')

export const createCategorySchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    slug: slugSchema.optional(),
    searchTerms: z.array(z.string().trim().min(2).max(60)).max(20).optional(),
  })
  .strict()

export function slugFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

async function lockCategory(tx: Tx, categoryId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "categories" WHERE id = ${categoryId} FOR UPDATE`
  if (rows.length === 0) throw new AppError(404, 'Category not found')
}

async function assertNameFree(tx: Tx, categoryId: string, name: string, exceptId?: string): Promise<void> {
  const others = await tx.valueLever.findMany({
    where: { categoryId, status: { not: LeverStatus.RETIRED }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { name: true },
  })
  if (others.some((o) => normalizeName(o.name) === normalizeName(name))) {
    throw new AppError(409, `A lever named "${name}" already exists in this category`)
  }
}

// ── Lever fields ─────────────────────────────────────────────────────────────────────────────────────
const leverFields = {
  name: z.string().trim().min(2).max(60).refine((s) => !/[\r\n]/.test(s), 'must be one line'),
  type: z.nativeEnum(LeverType),
  inputFormat: z.nativeEnum(LeverInputFormat),
  unit: z.string().trim().min(1).max(20).nullable(),
  explanation: z.string().trim().min(10).max(200).refine((s) => !/[\r\n]/.test(s), 'must be one line'),
  relatedNeeds: z.array(z.string().trim().min(2).max(60)).max(6),
  allowedValues: z.array(z.string().trim().min(1).max(60)).max(20),
}

export const createLeverSchema = z
  .object({
    ...leverFields,
    inputFormat: leverFields.inputFormat.optional(),
    unit: leverFields.unit.optional(),
    relatedNeeds: leverFields.relatedNeeds.optional(),
    allowedValues: leverFields.allowedValues.optional(),
  })
  .strict()

export const editLeverSchema = z.object(leverFields).partial().strict()

interface LeverShape {
  type: LeverType
  inputFormat: LeverInputFormat
  unit: string | null
  allowedValues: string[]
}

/** The shape rules the database also enforces, checked first for a readable 400. */
function checkShape(l: LeverShape): void {
  if (l.type === LeverType.MEASUREMENT && !l.unit) throw new AppError(400, 'A measurement needs a unit')
  if (l.type !== LeverType.MEASUREMENT && l.unit) throw new AppError(400, 'Only a measurement has a unit')
  if (l.inputFormat === LeverInputFormat.DIMENSIONS && (l.type !== LeverType.MEASUREMENT || l.unit !== 'cu ft')) {
    throw new AppError(400, 'Dimension input is only for a measurement in cu ft (the volume is computed from L × W × H)')
  }
  if (l.type !== LeverType.CATEGORY && l.allowedValues.length > 0) throw new AppError(400, 'Only a category lever has allowed values')
  const keys = l.allowedValues.map((v) => v.toLowerCase())
  if (new Set(keys).size !== keys.length) throw new AppError(400, 'Allowed values must be unique')
}

export async function createLever(categoryId: string, input: z.infer<typeof createLeverSchema>, userId: string) {
  const shape: LeverShape = {
    type: input.type,
    inputFormat: input.inputFormat ?? LeverInputFormat.SINGLE,
    unit: input.type === LeverType.MEASUREMENT ? input.unit ?? null : input.unit ?? null,
    allowedValues: input.allowedValues ?? [],
  }
  checkShape(shape)
  return prisma.$transaction(async (tx) => {
    await lockCategory(tx, categoryId)
    await assertNameFree(tx, categoryId, input.name)
    return tx.valueLever.create({
      data: {
        categoryId,
        name: input.name,
        type: shape.type,
        inputFormat: shape.inputFormat,
        unit: shape.unit,
        explanation: input.explanation,
        relatedNeeds: input.relatedNeeds ?? [],
        allowedValues: shape.allowedValues,
        origin: LeverOrigin.ADMIN,
        editedById: userId,
        editedAt: new Date(),
      },
    })
  })
}

export async function editLever(leverId: string, input: z.infer<typeof editLeverSchema>, userId: string) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.valueLever.findUnique({ where: { id: leverId } })
    if (!current) throw new AppError(404, 'Lever not found')
    await lockCategory(tx, current.categoryId)
    if (current.status === LeverStatus.RETIRED) throw new AppError(409, 'A retired lever cannot be edited')

    const next: LeverShape = {
      type: input.type ?? current.type,
      inputFormat: input.inputFormat ?? current.inputFormat,
      unit: input.unit !== undefined ? input.unit : current.unit,
      allowedValues: input.allowedValues ?? current.allowedValues,
    }
    // Changing type to/from a measurement must also change the unit; do it in the same request.
    checkShape(next)

    const valueCount = await tx.productLeverValue.count({ where: { leverId } })
    const shapeChanged = next.type !== current.type || next.unit !== current.unit || next.inputFormat !== current.inputFormat
    if (valueCount > 0 && shapeChanged) {
      throw new AppError(409, 'This lever already has product values: its type, unit and input format cannot change (retire it and add a new one)')
    }
    if (valueCount > 0 && input.allowedValues) {
      const kept = new Set(next.allowedValues.map((v) => v.toLowerCase()))
      const used = await tx.productLeverValue.findMany({ where: { leverId, valueText: { not: null } }, select: { valueText: true }, distinct: ['valueText'] })
      const removed = used.map((u) => u.valueText).filter((v): v is string => v !== null && !kept.has(v.toLowerCase()))
      if (removed.length > 0) throw new AppError(409, `Allowed values still used by products: ${removed.join(', ')}`)
    }
    if (current.status === LeverStatus.APPROVED && next.type === LeverType.CATEGORY && next.allowedValues.length < 2) {
      throw new AppError(400, 'A published category lever needs at least two allowed values')
    }
    if (input.name !== undefined) await assertNameFree(tx, current.categoryId, input.name, leverId)

    return tx.valueLever.update({
      where: { id: leverId },
      data: {
        name: input.name,
        type: next.type,
        inputFormat: next.inputFormat,
        unit: next.unit,
        explanation: input.explanation,
        relatedNeeds: input.relatedNeeds,
        allowedValues: next.allowedValues,
        editedById: userId,
        editedAt: new Date(),
      },
    })
  })
}

/** Discard a candidate. An approved lever leaves the set only by publishing a set without it. */
export async function retireLever(leverId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.valueLever.findUnique({ where: { id: leverId }, select: { categoryId: true, status: true } })
    if (!current) throw new AppError(404, 'Lever not found')
    await lockCategory(tx, current.categoryId)
    if (current.status === LeverStatus.APPROVED) {
      throw new AppError(409, 'A published lever cannot be retired on its own: publish a new set of five without it')
    }
    if (current.status === LeverStatus.RETIRED) throw new AppError(409, 'Already retired')
    return tx.valueLever.update({ where: { id: leverId }, data: { status: LeverStatus.RETIRED, retiredById: userId, retiredAt: new Date() } })
  })
}

// ── Publish ──────────────────────────────────────────────────────────────────────────────────────────
export const publishSchema = z.object({ leverIds: z.array(z.string().min(1).max(64)) }).strict()

/**
 * Approve exactly five levers in the given order and publish them, retiring the previous set, in one
 * transaction. Approved always means published; the database trigger re-checks the count at commit.
 */
export async function publishLeverSet(categoryId: string, leverIds: string[], userId: string) {
  if (leverIds.length !== LEVERS_PER_CATEGORY || new Set(leverIds).size !== LEVERS_PER_CATEGORY) {
    throw new AppError(400, `Select exactly ${LEVERS_PER_CATEGORY} different levers`)
  }
  return prisma.$transaction(async (tx) => {
    await lockCategory(tx, categoryId)
    const chosen = await tx.valueLever.findMany({ where: { id: { in: leverIds } } })
    if (chosen.length !== LEVERS_PER_CATEGORY || chosen.some((l) => l.categoryId !== categoryId)) {
      throw new AppError(400, 'Every lever must belong to this category')
    }
    if (chosen.some((l) => l.status === LeverStatus.RETIRED)) throw new AppError(400, 'A retired lever cannot be published')
    const badCategory = chosen.find((l) => l.type === LeverType.CATEGORY && l.allowedValues.length < 2)
    if (badCategory) throw new AppError(400, `"${badCategory.name}" needs at least two allowed values before it can be published`)

    const now = new Date()
    // Clear positions first: the (categoryId, position) unique index must not see two levers at one slot.
    await tx.valueLever.updateMany({
      where: { categoryId, status: LeverStatus.APPROVED, id: { notIn: leverIds } },
      data: { status: LeverStatus.RETIRED, position: null, retiredById: userId, retiredAt: now },
    })
    await tx.valueLever.updateMany({ where: { id: { in: leverIds } }, data: { position: null, status: LeverStatus.CANDIDATE } })
    for (const [i, id] of leverIds.entries()) {
      const lever = chosen.find((l) => l.id === id)
      await tx.valueLever.update({
        where: { id },
        data: {
          status: LeverStatus.APPROVED,
          position: i + 1,
          approvedById: lever?.status === LeverStatus.APPROVED ? lever.approvedById : userId,
          approvedAt: lever?.status === LeverStatus.APPROVED ? lever.approvedAt : now,
        },
      })
    }
    await tx.category.update({ where: { id: categoryId }, data: { leversPublishedAt: now, leversPublishedById: userId } })
    return tx.valueLever.findMany({ where: { categoryId, status: LeverStatus.APPROVED }, orderBy: { position: 'asc' } })
  })
}

// ── Public read path ─────────────────────────────────────────────────────────────────────────────────
export const PUBLIC_LEVER_SELECT = {
  id: true, name: true, type: true, inputFormat: true, unit: true, explanation: true, allowedValues: true, position: true,
} satisfies Prisma.ValueLeverSelect

export type PublicLever = Prisma.ValueLeverGetPayload<{ select: typeof PUBLIC_LEVER_SELECT }>

/**
 * The only way public routes read levers: approved levers of a published category, in order. Candidates
 * and retired levers never pass this filter.
 */
export async function publicLevers(categoryId: string): Promise<PublicLever[]> {
  return prisma.valueLever.findMany({
    where: { categoryId, status: LeverStatus.APPROVED, category: { leversPublishedAt: { not: null } } },
    orderBy: { position: 'asc' },
    select: PUBLIC_LEVER_SELECT,
  })
}
