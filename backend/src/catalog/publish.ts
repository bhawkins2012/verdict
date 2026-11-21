// Coverage, the publish gate and the atomic publish (docs/adr-generation-run.md D10). One transaction, with
// the node row locked: the node, its five levers (in order), the listed products and a copy of their
// accepted values go live together, or nothing changes. Public reads use only what this writes.
import { z } from 'zod'
import {
  GenerationRunStatus, ItemStatus, LeverStatus, LeverType, NodeKind, Prisma, StageStatus, ValueOrigin, ValueStatus,
} from '@prisma/client'
import { prisma } from '../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { isDevEnvironment } from '../middleware/devOnly'
import { loadGenerationConfig } from '../generation/config'
import { lockNode } from './taxonomy'
import { IN_CATALOG } from './products'

export const LEVERS_PER_NODE = 5
/** Gate: accepted known values ≥ 80% of the node's published products (accepted × 5 ≥ products × 4). */
export const meetsGate = (accepted: number, products: number) => products > 0 && accepted * 5 >= products * 4

type Db = Prisma.TransactionClient

export interface LeverCoverage { found: number; accepted: number; products: number }

/**
 * Per definition, among the node's approved products: values found (known, not rejected, with evidence)
 * and values accepted (known). An accepted "unknown" does not count (ADR Q9). Phase A values never count.
 */
export async function coverage(db: Db, nodeId: string): Promise<{ products: number; byDefinition: Map<string, LeverCoverage> }> {
  const products = await db.product.findMany({ where: { nodeId, ...IN_CATALOG }, select: { id: true } })
  const ids = products.map((p) => p.id)
  const rows = ids.length
    ? await db.productLeverValue.groupBy({
        by: ['definitionId', 'status'],
        where: { productId: { in: ids }, isUnknown: false, origin: { not: ValueOrigin.PHASE_A }, status: { not: ValueStatus.REJECTED } },
        _count: { _all: true },
      })
    : []
  const byDefinition = new Map<string, LeverCoverage>()
  for (const r of rows) {
    const c = byDefinition.get(r.definitionId) ?? { found: 0, accepted: 0, products: ids.length }
    c.found += r._count._all
    if (r.status === ValueStatus.ACCEPTED) c.accepted += r._count._all
    byDefinition.set(r.definitionId, c)
  }
  return { products: ids.length, byDefinition }
}

export const publishSchema = z.object({ leverIds: z.array(z.string().min(1).max(64)) }).strict()

export class GateError extends AppError {
  constructor(message: string, failing: { lever: string; accepted: number; products: number }[]) {
    super(400, message, { failing })
  }
}

export async function publishNode(nodeId: string, leverIds: string[], userId: string) {
  if (leverIds.length !== LEVERS_PER_NODE || new Set(leverIds).size !== LEVERS_PER_NODE) {
    throw new AppError(400, `Select exactly ${LEVERS_PER_NODE} different levers`)
  }
  const { minProducts } = loadGenerationConfig()
  return prisma.$transaction(async (tx) => {
    await lockNode(tx, nodeId)
    const node = await tx.taxonomyNode.findUniqueOrThrow({ where: { id: nodeId }, select: { id: true, kind: true, name: true } })
    if (node.kind !== NodeKind.DECISION) throw new AppError(400, 'Only a decision node is published with levers')

    // Nothing may still be writing values for this node.
    const busy = await tx.generationRun.findFirst({
      where: {
        nodeId, OR: [
          { status: GenerationRunStatus.ACTIVE },
          { stages: { some: { status: StageStatus.RUNNING } } },
          { items: { some: { status: ItemStatus.RUNNING } } },
          // Pending items of a run still under review are about to be processed; a closed run's are not.
          { status: GenerationRunStatus.READY_FOR_REVIEW, items: { some: { status: ItemStatus.PENDING } } },
        ],
      },
      select: { id: true },
    })
    if (busy) throw new AppError(409, 'A generation run is still writing to this node: wait for it to finish (or cancel it)')

    const chosen = await tx.nodeLever.findMany({ where: { id: { in: leverIds } }, include: { definition: true } })
    if (chosen.length !== LEVERS_PER_NODE || chosen.some((l) => l.nodeId !== nodeId)) throw new AppError(400, 'Every lever must belong to this node')
    if (chosen.some((l) => l.status === LeverStatus.RETIRED)) throw new AppError(400, 'A retired lever cannot be published')
    const badCategory = chosen.find((l) => l.definition.type === LeverType.CATEGORY && l.definition.allowedValues.length < 2)
    if (badCategory) throw new AppError(400, `"${badCategory.definition.name}" needs at least two allowed values before it can be published`)

    const products = await tx.product.findMany({ where: { nodeId, ...IN_CATALOG }, select: { id: true, isDryRun: true } })
    if (products.length < minProducts) {
      throw new AppError(400, `At least ${minProducts} approved products are needed to publish (${products.length} now)`)
    }
    if (products.some((p) => p.isDryRun) && !isDevEnvironment()) {
      throw new AppError(400, 'This node has dry-run products; they can be published only in development or test')
    }

    // The gate: every chosen lever has accepted known values for at least 80% of the products.
    const { byDefinition } = await coverage(tx, nodeId)
    const failing = chosen
      .map((l) => ({ lever: l.definition.name, accepted: byDefinition.get(l.definitionId)?.accepted ?? 0, products: products.length }))
      .filter((c) => !meetsGate(c.accepted, c.products))
    if (failing.length) {
      throw new GateError(
        `Publishing needs accepted values for at least 80% of the ${products.length} products on each lever: ${failing.map((f) => `${f.lever} ${f.accepted} of ${f.products} (${Math.floor((f.accepted / f.products) * 100)}%)`).join('; ')}`,
        failing,
      )
    }

    const now = new Date()
    // Levers: retire the previous five, then approve the new five in order with a snapshot of each definition.
    await tx.nodeLever.updateMany({
      where: { nodeId, status: LeverStatus.APPROVED, id: { notIn: leverIds } },
      data: { status: LeverStatus.RETIRED, position: null, retiredById: userId, retiredAt: now },
    })
    await tx.nodeLever.updateMany({ where: { id: { in: leverIds } }, data: { position: null, status: LeverStatus.CANDIDATE } })
    for (const [i, id] of leverIds.entries()) {
      const l = chosen.find((x) => x.id === id)
      if (!l) continue
      const d = l.definition
      await tx.nodeLever.update({
        where: { id },
        data: {
          status: LeverStatus.APPROVED, position: i + 1,
          approvedById: l.status === LeverStatus.APPROVED && l.approvedById ? l.approvedById : userId,
          approvedAt: l.status === LeverStatus.APPROVED && l.approvedAt ? l.approvedAt : now,
          published: {
            name: d.name, type: d.type, inputFormat: d.inputFormat, unit: d.unit, explanation: d.explanation, allowedValues: d.allowedValues,
          },
        },
      })
    }

    // Products: approved ones are listed, every other product of the node is not.
    const productIds = products.map((p) => p.id)
    await tx.product.updateMany({ where: { nodeId, id: { notIn: productIds } }, data: { listed: false } })
    await tx.product.updateMany({ where: { id: { in: productIds } }, data: { listed: true } })

    // Values: replace the node's public copy with the accepted values of the five levers.
    await tx.publishedLeverValue.deleteMany({ where: { nodeId } })
    const accepted = await tx.productLeverValue.findMany({
      where: { productId: { in: productIds }, definitionId: { in: chosen.map((l) => l.definitionId) }, status: ValueStatus.ACCEPTED, origin: { not: ValueOrigin.PHASE_A } },
    })
    if (accepted.length) {
      await tx.publishedLeverValue.createMany({
        data: accepted.map((v) => ({
          nodeId, productId: v.productId, definitionId: v.definitionId, isUnknown: v.isUnknown, valueNumber: v.valueNumber, unit: v.unit,
          valueText: v.valueText, valueBool: v.valueBool, valueList: v.valueList, dimLengthIn: v.dimLengthIn, dimWidthIn: v.dimWidthIn,
          dimHeightIn: v.dimHeightIn, detail: v.detail, evidenceQuote: v.isUnknown ? null : v.evidenceQuote, sourceUrl: v.isUnknown ? null : v.sourceUrl,
          adminAttested: v.adminAttested, publishedAt: now,
        })),
      })
    }

    await tx.taxonomyNode.update({ where: { id: nodeId }, data: { publishedAt: now, publishedById: userId } })
    await tx.generationRun.updateMany({ where: { nodeId, status: GenerationRunStatus.READY_FOR_REVIEW }, data: { status: GenerationRunStatus.PUBLISHED } })
    return {
      publishedAt: now,
      levers: leverIds,
      products: productIds.length,
      values: accepted.length,
    }
  }, { timeout: 30_000 })
}

/** Take a node off the public site (the same flags, cleared in one transaction). */
export async function unpublishNode(nodeId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    await lockNode(tx, nodeId)
    const now = new Date()
    await tx.nodeLever.updateMany({ where: { nodeId, status: LeverStatus.APPROVED }, data: { status: LeverStatus.CANDIDATE, position: null, retiredById: userId, retiredAt: now } })
    await tx.product.updateMany({ where: { nodeId }, data: { listed: false } })
    await tx.publishedLeverValue.deleteMany({ where: { nodeId } })
    await tx.taxonomyNode.update({ where: { id: nodeId }, data: { publishedAt: null, publishedById: null } })
    return { unpublishedAt: now }
  })
}
