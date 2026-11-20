// Node levers and their shared definitions: admin add, edit and retire (docs/adr-generation-run.md D2, D9).
// Writes lock the node row first and read again inside the lock (the Phase A rule).
import { z } from 'zod'
import { LeverInputFormat, LeverOrigin, LeverStatus, LeverType, Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { lockNode } from './taxonomy'
import { normalizeName } from './text'
import { CANONICAL_UNITS } from './units'

type Tx = Prisma.TransactionClient

const oneLine = (min: number, max: number) => z.string().trim().min(min).max(max).refine((s) => !/[\r\n]/.test(s), 'must be one line')

const definitionFields = {
  name: oneLine(2, 60),
  type: z.nativeEnum(LeverType),
  inputFormat: z.nativeEnum(LeverInputFormat),
  unit: z.enum(CANONICAL_UNITS).nullable(),
  explanation: oneLine(10, 200),
  relatedNeeds: z.array(z.string().trim().min(2).max(60)).max(6),
  allowedValues: z.array(z.string().trim().min(1).max(60)).max(12),
  safetyFlag: z.boolean(),
  minValue: z.number().finite().nullable(),
  maxValue: z.number().finite().nullable(),
}

export const createLeverSchema = z.object({
  ...definitionFields,
  inputFormat: definitionFields.inputFormat.optional(),
  unit: definitionFields.unit.optional(),
  relatedNeeds: definitionFields.relatedNeeds.optional(),
  allowedValues: definitionFields.allowedValues.optional(),
  safetyFlag: definitionFields.safetyFlag.optional(),
  minValue: definitionFields.minValue.optional(),
  maxValue: definitionFields.maxValue.optional(),
}).strict()

export const editLeverSchema = z.object(definitionFields).partial().strict()

interface Shape { type: LeverType; inputFormat: LeverInputFormat; unit: string | null; allowedValues: string[] }

/** The shape rules the database also enforces, checked first for a readable 400. */
export function checkShape(l: Shape): void {
  if (l.type === LeverType.MEASUREMENT && !l.unit) throw new AppError(400, 'A measurement needs a unit')
  if (l.type !== LeverType.MEASUREMENT && l.unit) throw new AppError(400, 'Only a measurement has a unit')
  if (l.inputFormat === LeverInputFormat.DIMENSIONS && (l.type !== LeverType.MEASUREMENT || l.unit !== 'cu ft')) {
    throw new AppError(400, 'Dimension input is only for a measurement in cu ft (the volume is computed from L × W × H)')
  }
  if (l.type !== LeverType.CATEGORY && l.allowedValues.length > 0) throw new AppError(400, 'Only a category lever has allowed values')
  const keys = l.allowedValues.map((v) => v.toLowerCase())
  if (new Set(keys).size !== keys.length) throw new AppError(400, 'Allowed values must be unique')
}

async function lockLever(tx: Tx, nodeLeverId: string) {
  const ref = await tx.nodeLever.findUnique({ where: { id: nodeLeverId }, select: { nodeId: true } })
  if (!ref) throw new AppError(404, 'Lever not found')
  await lockNode(tx, ref.nodeId)
  const lever = await tx.nodeLever.findUnique({ where: { id: nodeLeverId }, include: { definition: true } })
  if (!lever) throw new AppError(404, 'Lever not found')
  return lever
}

/** Add a lever to a decision node: reuse the shared definition with that name, or create one. */
export async function createLever(nodeId: string, input: z.infer<typeof createLeverSchema>, userId: string) {
  const shape: Shape = { type: input.type, inputFormat: input.inputFormat ?? LeverInputFormat.SINGLE, unit: input.unit ?? null, allowedValues: input.allowedValues ?? [] }
  checkShape(shape)
  return prisma.$transaction(async (tx) => {
    await lockNode(tx, nodeId)
    const key = normalizeName(input.name)
    let def = await tx.leverDefinition.findUnique({ where: { nameKey: key } })
    if (!def) {
      def = await tx.leverDefinition.create({
        data: {
          name: input.name, nameKey: key, type: shape.type, inputFormat: shape.inputFormat, unit: shape.unit, explanation: input.explanation,
          relatedNeeds: input.relatedNeeds ?? [], allowedValues: shape.allowedValues, safetyFlag: input.safetyFlag ?? false,
          minValue: input.minValue ?? null, maxValue: input.maxValue ?? null, origin: LeverOrigin.ADMIN, createdById: userId,
        },
      })
    }
    const existing = await tx.nodeLever.findUnique({ where: { nodeId_definitionId: { nodeId, definitionId: def.id } } })
    if (existing && existing.status !== LeverStatus.RETIRED) throw new AppError(409, `"${def.name}" is already a lever of this node`)
    if (existing) return tx.nodeLever.update({ where: { id: existing.id }, data: { status: LeverStatus.CANDIDATE, retiredAt: null, retiredById: null } })
    return tx.nodeLever.create({ data: { nodeId, definitionId: def.id, origin: LeverOrigin.ADMIN } })
  })
}

/**
 * Edit the shared definition behind a node lever. It changes the definition for every node using it; the
 * public pages keep the snapshot taken at publish until each node is republished.
 */
export async function editLever(nodeLeverId: string, input: z.infer<typeof editLeverSchema>, userId: string) {
  return prisma.$transaction(async (tx) => {
    const lever = await lockLever(tx, nodeLeverId)
    if (lever.status === LeverStatus.RETIRED) throw new AppError(409, 'A retired lever cannot be edited')
    const cur = lever.definition
    const next: Shape = {
      type: input.type ?? cur.type,
      inputFormat: input.inputFormat ?? cur.inputFormat,
      unit: input.unit !== undefined ? input.unit : cur.unit,
      allowedValues: input.allowedValues ?? cur.allowedValues,
    }
    checkShape(next)
    const valueCount = await tx.productLeverValue.count({ where: { definitionId: cur.id, isUnknown: false } })
    const shapeChanged = next.type !== cur.type || next.unit !== cur.unit || next.inputFormat !== cur.inputFormat
    if (valueCount > 0 && shapeChanged) {
      throw new AppError(409, 'This lever already has product values: its type, unit and input format cannot change (retire it and add a new one)')
    }
    if (valueCount > 0 && input.allowedValues) {
      const kept = new Set(next.allowedValues.map((v) => v.toLowerCase()))
      const used = await tx.productLeverValue.findMany({ where: { definitionId: cur.id, valueText: { not: null } }, select: { valueText: true }, distinct: ['valueText'] })
      const removed = used.map((u) => u.valueText).filter((v): v is string => v !== null && !kept.has(v.toLowerCase()))
      if (removed.length > 0) throw new AppError(409, `Allowed values still used by products: ${removed.join(', ')}`)
    }
    if (input.name !== undefined && normalizeName(input.name) !== cur.nameKey) {
      const clash = await tx.leverDefinition.findUnique({ where: { nameKey: normalizeName(input.name) }, select: { id: true } })
      if (clash) throw new AppError(409, `A lever named "${input.name}" already exists`)
    }
    if (cur.safetyFlag && input.safetyFlag === false) {
      throw new AppError(400, 'A safety flag cannot be removed (it keeps values from being bulk-accepted)')
    }
    await tx.leverDefinition.update({
      where: { id: cur.id },
      data: {
        name: input.name, nameKey: input.name !== undefined ? normalizeName(input.name) : undefined, type: next.type,
        inputFormat: next.inputFormat, unit: next.unit, explanation: input.explanation, relatedNeeds: input.relatedNeeds,
        allowedValues: next.allowedValues, safetyFlag: input.safetyFlag, minValue: input.minValue, maxValue: input.maxValue,
        editedById: userId, editedAt: new Date(),
      },
    })
    return tx.nodeLever.findUniqueOrThrow({ where: { id: nodeLeverId }, include: { definition: true } })
  })
}

/** Discard a candidate. A published lever leaves the set only by publishing a set without it. */
export async function retireLever(nodeLeverId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const lever = await lockLever(tx, nodeLeverId)
    if (lever.status === LeverStatus.APPROVED) throw new AppError(409, 'A published lever cannot be retired on its own: publish a new set of five without it')
    if (lever.status === LeverStatus.RETIRED) throw new AppError(409, 'Already retired')
    return tx.nodeLever.update({ where: { id: nodeLeverId }, data: { status: LeverStatus.RETIRED, retiredById: userId, retiredAt: new Date() } })
  })
}
