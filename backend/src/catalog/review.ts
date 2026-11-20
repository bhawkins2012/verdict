// Value review and product exceptions (docs/adr-generation-run.md D9, section 5 A1, A4). Value review is
// the one human step: accept, reject, mark unknown or correct one value at a time; bulk accept only for
// non-safety levers' high-confidence extracted values. Every decision records who and when, and locks the
// node first so a re-extraction cannot overwrite a value mid-review.
import { z } from 'zod'
import {
  AcceptMode, CatalogStatus, Confidence, FetchOutcome, LeverStatus, NodeKind, Prisma, ValueOrigin, ValueStatus,
} from '@prisma/client'
import { prisma } from '../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { lockNode, loadTaxonomy } from './taxonomy'
import { brandKey, quoteAppearsIn } from './text'
import { EMPTY_VALUE, presentTyped, toValueData, valueColumnsOf, valueInputSchema } from './values'
import { isVerifiedFor } from '../generation/brands'
import { loadGenerationConfig } from '../generation/config'
import { fetcherFor } from '../generation/fetch/fetcher'
import { parseHtml } from '../generation/fetch/html'
import { extractPdfText } from '../generation/fetch/pdf'
import { fixtureTransport } from '../generation/fixtures/site'
import { MAX_QUOTE_CHARS } from '../generation/evidence'

type Tx = Prisma.TransactionClient

/** Lock the value's node, then read the value again inside the lock. */
async function lockValue(tx: Tx, valueId: string) {
  const ref = await tx.productLeverValue.findUnique({ where: { id: valueId }, select: { product: { select: { nodeId: true } } } })
  if (!ref) throw new AppError(404, 'Value not found')
  if (ref.product.nodeId) await lockNode(tx, ref.product.nodeId)
  const v = await tx.productLeverValue.findUnique({ where: { id: valueId }, include: { definition: true, product: { select: { nodeId: true } } } })
  if (!v) throw new AppError(404, 'Value not found')
  return v
}

/** Is this value on a safety-flagged lever (the definition, the node lever, or a safety-critical node)? */
export async function isSafetyValue(tx: Tx, definitionId: string, nodeId: string | null): Promise<boolean> {
  const def = await tx.leverDefinition.findUnique({ where: { id: definitionId }, select: { safetyFlag: true } })
  if (def?.safetyFlag) return true
  if (!nodeId) return false
  const nl = await tx.nodeLever.findUnique({ where: { nodeId_definitionId: { nodeId, definitionId } }, select: { safety: true } })
  if (nl?.safety) return true
  return (await loadTaxonomy(tx)).safetyCritical(nodeId)
}

export async function acceptValue(valueId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const v = await lockValue(tx, valueId)
    if (v.origin === ValueOrigin.PHASE_A) throw new AppError(400, 'This Phase A value has no evidence quote and cannot be accepted; extract it again or enter a value with its source')
    if (!v.isUnknown && (!v.evidenceQuote || !v.sourceUrl)) throw new AppError(400, 'A value needs its evidence quote and source before it can be accepted')
    return tx.productLeverValue.update({
      where: { id: valueId },
      data: { status: ValueStatus.ACCEPTED, acceptMode: AcceptMode.SINGLE, reviewedById: userId, reviewedAt: new Date() },
    })
  })
}

export async function rejectValue(valueId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    await lockValue(tx, valueId)
    return tx.productLeverValue.update({
      where: { id: valueId },
      data: { status: ValueStatus.REJECTED, acceptMode: null, reviewedById: userId, reviewedAt: new Date() },
    })
  })
}

/** Record an explicit unknown (accepted, so the product shows "Unknown"; it does not count toward coverage). */
export async function markUnknown(valueId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const v = await lockValue(tx, valueId)
    const now = new Date()
    return tx.productLeverValue.update({
      where: { id: valueId },
      data: {
        ...EMPTY_VALUE, status: ValueStatus.ACCEPTED, acceptMode: AcceptMode.SINGLE, reviewedById: userId, reviewedAt: now,
        unknownReason: 'marked_unknown_by_admin', confidence: null, adminAttested: false, attestedFetchOutcome: null,
        origin: v.origin === ValueOrigin.PHASE_A ? ValueOrigin.MANUAL : v.origin,
        originalValue: v.originalValue ?? (presentTyped(valueColumnsOf(v)) as Prisma.InputJsonValue),
      },
    })
  })
}

/** Correct an extracted value (for example a misread unit). The quote and source stay; it must be accepted again. */
export async function editValue(valueId: string, rawInput: unknown, userId: string) {
  const parsed = valueInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message)
  return prisma.$transaction(async (tx) => {
    const v = await lockValue(tx, valueId)
    if (v.origin !== ValueOrigin.EXTRACTED) throw new AppError(400, 'Only extracted values are corrected here; enter a manual value instead')
    if (!v.evidenceQuote || !v.sourceUrl) throw new AppError(400, 'This value has no evidence to correct; enter a manual value instead')
    const shaped = toValueData(v.definition, parsed.data)
    if (!shaped.ok) throw new AppError(400, shaped.error)
    if (shaped.data.isUnknown) throw new AppError(400, 'Use "Mark unknown" for an unknown value')
    return tx.productLeverValue.update({
      where: { id: valueId },
      data: {
        ...shaped.data, status: ValueStatus.PROPOSED, acceptMode: null, reviewedById: null, reviewedAt: null,
        editedById: userId, editedAt: new Date(), confidence: Confidence.LOW, unknownReason: null,
        originalValue: v.originalValue ?? (presentTyped(valueColumnsOf(v)) as Prisma.InputJsonValue),
      },
    })
  })
}

export const bulkAcceptSchema = z.object({ definitionId: z.string().min(1).max(64) }).strict()

/**
 * Accept every high-confidence extracted proposal in one lever's column, for approved products. Refused for
 * safety-flagged levers (all car-seat levers): those are reviewed one by one. The database refuses it too.
 */
export async function bulkAccept(nodeId: string, definitionId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    await lockNode(tx, nodeId)
    if (await isSafetyValue(tx, definitionId, nodeId)) throw new AppError(400, 'Safety lever: review each value one by one (bulk accept is not available)')
    const { count } = await tx.productLeverValue.updateMany({
      where: {
        definitionId, status: ValueStatus.PROPOSED, origin: ValueOrigin.EXTRACTED, confidence: Confidence.HIGH, isUnknown: false,
        editedAt: null, evidenceQuote: { not: null }, sourceUrl: { not: null },
        product: { nodeId, catalogStatus: CatalogStatus.APPROVED },
      },
      data: { status: ValueStatus.ACCEPTED, acceptMode: AcceptMode.BULK, reviewedById: userId, reviewedAt: new Date() },
    })
    return { accepted: count }
  })
}

// ── Manual values (section 5 A4) ────────────────────────────────────────────────────────────────────
export const manualValueSchema = z.object({
  definitionId: z.string().min(1).max(64),
  value: valueInputSchema,
  sourceUrl: z.string().trim().max(2000).url().refine((u) => u.startsWith('https://'), 'the source must be an https URL'),
  quote: z.string().trim().min(3).max(MAX_QUOTE_CHARS),
}).strict()

/** Outcomes that mean "the site would not let us check", which makes the value admin-attested. */
const BLOCKED_OUTCOMES: readonly FetchOutcome[] = [FetchOutcome.BLOCKED, FetchOutcome.ROBOTS_DISALLOWED]

/**
 * An admin enters a value with its source URL and a pasted quote. The URL must be on a verified domain of
 * the product's brand. If it can be fetched, the quote must be in the fresh text; if the site blocks the
 * fetch, the value is stored as admin-attested with the outcome. Either way it is accepted one by one.
 */
export async function enterManualValue(productId: string, rawInput: unknown, userId: string) {
  const parsed = manualValueSchema.safeParse(rawInput)
  if (!parsed.success) {
    const i = parsed.error.issues[0]
    throw new AppError(400, `${i.path.join('.') || 'body'}: ${i.message}`)
  }
  const input = parsed.data
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, brand: true, nodeId: true } })
  if (!product) throw new AppError(404, 'Product not found')
  if (!product.brand) throw new AppError(400, 'The product has no brand, so no verified domain')
  const def = await prisma.leverDefinition.findUnique({ where: { id: input.definitionId } })
  if (!def) throw new AppError(404, 'Lever not found')
  if (!product.nodeId) throw new AppError(400, 'Place the product in a decision node first')
  const onNode = await prisma.nodeLever.findUnique({ where: { nodeId_definitionId: { nodeId: product.nodeId, definitionId: def.id } }, select: { status: true } })
  if (!onNode || onNode.status === LeverStatus.RETIRED) throw new AppError(400, 'That lever is not a lever of this product\'s node')
  const shaped = toValueData(def, input.value)
  if (!shaped.ok) throw new AppError(400, shaped.error)
  if (shaped.data.isUnknown) throw new AppError(400, 'Use "Mark unknown" for an unknown value')
  if (!(await isVerifiedFor(product.brand, input.sourceUrl))) {
    throw new AppError(400, `The source must be on a verified domain of ${product.brand} (confirm the brand's domain first)`)
  }

  // A fresh fetch of the source, under the same rules as extraction.
  const config = loadGenerationConfig()
  const fetcher = fetcherFor(config.mode, fixtureTransport)
  const res = await fetcher.fetch(input.sourceUrl, { kind: 'brand', brandKey: brandKey(product.brand) }, ['html', 'pdf'])
  let attested: FetchOutcome | null = null
  if (res.outcome === FetchOutcome.OK) {
    const text = res.kind === 'pdf'
      ? await extractPdfText(res.body).then((r) => (r.ok ? r.text : null))
      : parseHtml(new TextDecoder().decode(res.body), res.url).text
    if (text === null) throw new AppError(400, 'The source PDF has no readable text, so the quote cannot be checked')
    if (!quoteAppearsIn(text, input.quote)) throw new AppError(400, 'The quote is not on the source page (checked against a fresh fetch, ignoring spacing)')
  } else if (BLOCKED_OUTCOMES.includes(res.outcome)) {
    attested = res.outcome
  } else {
    throw new AppError(400, `The source could not be fetched to check the quote (${res.outcome}: ${res.detail})`)
  }

  return prisma.$transaction(async (tx) => {
    await lockNode(tx, product.nodeId as string)
    const now = new Date()
    const data = {
      ...shaped.data, status: ValueStatus.ACCEPTED, origin: ValueOrigin.MANUAL, acceptMode: AcceptMode.SINGLE,
      reviewedById: userId, reviewedAt: now, evidenceQuote: input.quote, sourceUrl: input.sourceUrl, confidence: Confidence.HIGH,
      unknownReason: null, statedValue: null, statedUnit: null, adminAttested: attested !== null, attestedFetchOutcome: attested,
      editedById: userId, editedAt: now, runId: null, extractedAt: null,
    }
    return tx.productLeverValue.upsert({
      where: { productId_definitionId: { productId, definitionId: def.id } },
      create: { ...data, productId, definitionId: def.id },
      update: data,
    })
  })
}

// ── Products: exceptions only (approval is automatic) ───────────────────────────────────────────────
export const productDecisionSchema = z.object({ productIds: z.array(z.string().min(1).max(64)).min(1).max(100) }).strict()

/** Approve needs-attention products by hand (or put a rejected one back). */
export async function approveProducts(productIds: string[], userId: string) {
  const { count } = await prisma.product.updateMany({
    where: { id: { in: productIds }, nodeId: { not: null }, catalogStatus: { in: [CatalogStatus.NEEDS_ATTENTION, CatalogStatus.PROPOSED, CatalogStatus.REJECTED] } },
    data: { catalogStatus: CatalogStatus.APPROVED, approvedVia: 'ADMIN', attentionCheck: null, attentionReason: null, reviewedById: userId, reviewedAt: new Date() },
  })
  return { approved: count }
}

/** Remove products from the node before publish (also unlists at the next publish). */
export async function rejectProducts(productIds: string[], userId: string) {
  const { count } = await prisma.product.updateMany({
    where: { id: { in: productIds }, discoveredByRunId: { not: null } },
    data: { catalogStatus: CatalogStatus.REJECTED, approvedVia: null, attentionCheck: null, attentionReason: null, reviewedById: userId, reviewedAt: new Date() },
  })
  return { rejected: count }
}

export const placeProductSchema = z.object({
  nodeId: z.string().min(1).max(64).optional(),
  alsoListedIn: z.array(z.string().min(1).max(64)).max(5).optional(),
}).strict()

/** Place a product in a decision node, and set its "also listed in" decision nodes. */
export async function placeProduct(productId: string, input: z.infer<typeof placeProductSchema>) {
  const t = await loadTaxonomy()
  const ids = [...(input.nodeId ? [input.nodeId] : []), ...(input.alsoListedIn ?? [])]
  for (const id of ids) {
    const n = t.byId.get(id)
    if (!n) throw new AppError(404, 'Node not found')
    if (n.kind !== NodeKind.DECISION) throw new AppError(400, `"${n.name}" is a navigation node; products belong to decision nodes`)
  }
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: productId }, select: { nodeId: true } })
    if (!product) throw new AppError(404, 'Product not found')
    const nodeId = input.nodeId ?? product.nodeId
    if (input.nodeId) {
      const slug = t.byId.get(input.nodeId)?.slug
      await tx.product.update({ where: { id: productId }, data: { nodeId: input.nodeId, category: slug, listed: false } })
    }
    if (input.alsoListedIn) {
      if (nodeId && input.alsoListedIn.includes(nodeId)) throw new AppError(400, 'A product is not "also listed in" its own node')
      await tx.productAlsoListedIn.deleteMany({ where: { productId } })
      if (input.alsoListedIn.length) await tx.productAlsoListedIn.createMany({ data: input.alsoListedIn.map((n) => ({ productId, nodeId: n })) })
    }
    return tx.product.findUniqueOrThrow({ where: { id: productId }, include: { alsoListedIn: true } })
  })
}
