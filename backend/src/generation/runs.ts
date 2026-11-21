// The generation run (docs/adr-generation-run.md D5 and section 5): PLACE → LEVERS → DISCOVER → VERIFY →
// EXTRACT for a decision node, EXPLAIN for a navigation node. Each stage stores its own output, so a stage
// can be resumed without repeating earlier ones. Work runs in-process after the response; a stage claims
// itself with a conditional update, heartbeats, and is marked STALLED by the reconciler if it stops.
import Anthropic from '@anthropic-ai/sdk'
import {
  BrandDomainStatus, CatalogStatus, Confidence, FetchedKind, FetchOutcome, GenerationRunKind, GenerationRunStatus,
  ItemStatus, LeverOrigin, LeverRunMode, LeverStatus, NodeKind, Prisma, RunStage, StageStatus, ValueOrigin, ValueStatus,
} from '@prisma/client'
import crypto from 'crypto'
import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'
import { AppError } from '../middleware/errorHandler'
import { brandKey, containsWords, normalizeName, wordsKey } from '../catalog/text'
import { loadTaxonomy } from '../catalog/taxonomy'
import { EMPTY_VALUE } from '../catalog/values'
import { isVerifiedFor, verifyBrandHost } from './brands'
import { GenerationConfig, loadGenerationConfig } from './config'
import { CapError, estimateNodeUsd, reserveCall, settleCall, worstCaseResumedUsd } from './costs'
import { checkEvidence, EvidenceDocument } from './evidence'
import { Fetcher, fetcherFor } from './fetch/fetcher'
import { httpsHostKey, isDenylisted } from './fetch/hosts'
import { excerpt, looksLikeChallenge, parseHtml } from './fetch/html'
import { extractPdfText } from './fetch/pdf'
import { DryRunModel } from './fixtures/dryRunModel'
import { fixtureTransport } from './fixtures/site'
import { describeModelError, modelErrorText } from './apiError'
import {
  DISCOVERY_MAX_SEARCHES, DiscoverInput, ExplainInput, ExtractDocument, ExtractLever, GenerationModel, LeversInput, liveModel, MAX_PAUSE_RESUMES, ModelResult,
  overrideModel, PartialUsageError, PlaceInput,
} from './model'
import { notifyRunReady } from './notify'
import {
  describeIssues, DiscoverySchema, ExplainerSchema, ExtractedValue, ExtractionSchema, LeverSetSchema, MIN_PRODUCTS, PlacementSchema,
  TARGET_MIN_PRODUCTS,
} from './schemas'

export const STALE_MS = 10 * 60 * 1000
export const PAGE_CHARS = 48_000
export const PDF_CHARS = 80_000
export const MAX_PDFS = 2
export const EXTRACT_CONCURRENCY = 2
export const FETCHED_TEXT_TTL_MS = 24 * 60 * 60 * 1000

const NODE_STAGES: RunStage[] = [RunStage.PLACE, RunStage.LEVERS, RunStage.DISCOVER, RunStage.VERIFY, RunStage.EXTRACT]
const STAGE_ORDER: RunStage[] = [...NODE_STAGES, RunStage.EXPLAIN]

/** A stage failed for a reason the admin can act on (stored as the stage's and the run's error). */
export class StageFailure extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'StageFailure'
  }
}

// ── Background execution ────────────────────────────────────────────────────────────────────────────
const inFlight = new Set<Promise<unknown>>()

function inBackground(runId: string, task: () => Promise<unknown>): void {
  const p: Promise<unknown> = Promise.resolve()
    .then(task)
    .catch((err) => logger.error('Generation task failed', { runId, errorClass: err instanceof Error ? err.name : typeof err, error: err instanceof Error ? err.message.slice(0, 300) : undefined }))
    .finally(() => inFlight.delete(p))
  inFlight.add(p)
}

/** Tests wait for runs started after a response. */
export async function flushGenerationRuns(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight])
}

/** On shutdown: give in-flight work up to `timeoutMs`; a stage cut off is marked STALLED later and resumes. */
export async function drainGenerationRuns(timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), timeoutMs)))
  const done = await Promise.race([flushGenerationRuns().then(() => true as const), timeout])
  clearTimeout(timer)
  return done
}

// ── Context ─────────────────────────────────────────────────────────────────────────────────────────
interface RunContext {
  runId: string
  mode: LeverRunMode
  config: GenerationConfig
  model: GenerationModel
  fetcher: Fetcher
  node: { id: string; slug: string; name: string; searchTerms: string[] }
  notes: string | null
}

function modelFor(mode: LeverRunMode): GenerationModel {
  if (mode === LeverRunMode.LIVE) return liveModel()
  return overrideModel() ?? new DryRunModel()
}

async function contextFor(runId: string): Promise<RunContext> {
  const run = await prisma.generationRun.findUniqueOrThrow({
    where: { id: runId },
    select: { id: true, mode: true, notes: true, node: { select: { id: true, slug: true, name: true, searchTerms: true } } },
  })
  const config = loadGenerationConfig()
  return {
    runId, mode: run.mode, config, model: modelFor(run.mode), notes: run.notes, node: run.node,
    fetcher: fetcherFor(run.mode === LeverRunMode.LIVE ? 'live' : 'dry_run', fixtureTransport),
  }
}

/** One model call: reserved against the caps first (live), settled after, refusals and truncation fail the stage. */
const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 }

async function callModel(ctx: RunContext, stage: RunStage, productId: string | null, promptChars: number, maxSearches: number,
  call: () => Promise<ModelResult>, requests = 1): Promise<ModelResult> {
  const live = ctx.mode === LeverRunMode.LIVE
  // One call may be several API requests (discovery resumes pause_turn), each resending the conversation so
  // far: reserve the worst case of all of them, with the growing input.
  const reserved = live ? worstCaseResumedUsd(ctx.config.model, promptChars, ctx.config.maxTokens, maxSearches, requests) : 0
  const callId = await (live
    ? reserveCall({ runId: ctx.runId, stage, productId, model: ctx.config.model, reservedUsd: reserved, runCapUsd: ctx.config.runCapUsd, dailyCapUsd: ctx.config.dailyCapUsd })
    : prisma.generationCall.create({ data: { runId: ctx.runId, stage, productId, model: 'dry-run', reservedUsd: 0 }, select: { id: true } }).then((c) => c.id))
  let result: ModelResult
  try {
    result = await call()
  } catch (caught) {
    const err = caught instanceof PartialUsageError ? caught.inner : caught
    // The status, the API's error type and message (redacted, capped) and the request id: never request content.
    const described = describeModelError(err)
    const text = modelErrorText(described)
    logger.warn('Generation model call failed', { runId: ctx.runId, stage, productId, code: described.code, ...described.meta })
    // An error status means the API answered and did not bill that request: the call costs what its earlier
    // requests used (0 for a single request). A timeout, a dropped connection or anything else may have been
    // billed, so the cost stays unknown and the reservation keeps counting against the caps.
    const answered = err instanceof Anthropic.APIError && typeof err.status === 'number'
    const usage = answered ? (caught instanceof PartialUsageError ? caught.usage : NO_USAGE) : null
    await settleCall(callId, ctx.config.model, null, live ? usage : null, text)
    throw new StageFailure(described.code, described.detail ?? undefined)
  }
  const failed = result.stopReason === 'refusal' ? 'refusal' : result.stopReason === 'max_tokens' ? 'max_tokens' : null
  await settleCall(callId, live ? ctx.config.model : 'dry-run', result.servedModel, live ? result.usage : null, failed)
  if (failed) throw new StageFailure(failed)
  return result
}

async function heartbeat(runId: string, stage: RunStage): Promise<void> {
  await prisma.generationRunStage.updateMany({ where: { runId, stage, status: StageStatus.RUNNING }, data: { heartbeatAt: new Date() } })
}

// ── Start, resume, cancel ───────────────────────────────────────────────────────────────────────────
export async function startRun(nodeId: string, userId: string, notes: string | null) {
  const config = loadGenerationConfig()
  const node = await prisma.taxonomyNode.findUnique({ where: { id: nodeId }, select: { id: true, kind: true, name: true } })
  if (!node) throw new AppError(404, 'Node not found')
  const kind = node.kind === NodeKind.DECISION ? GenerationRunKind.NODE : GenerationRunKind.EXPLAINER
  if (kind === GenerationRunKind.EXPLAINER) {
    const t = await loadTaxonomy()
    if (t.children(nodeId).length === 0) throw new AppError(400, 'An explainer needs at least one child node')
  }
  const mode = config.mode === 'live' ? LeverRunMode.LIVE : LeverRunMode.DRY_RUN
  const estimate = mode === LeverRunMode.LIVE ? (kind === GenerationRunKind.NODE ? estimateNodeUsd(config.model) : 0.05) : 0
  const stages = kind === GenerationRunKind.NODE ? NODE_STAGES : [RunStage.EXPLAIN]
  let run: { id: string }
  try {
    run = await prisma.generationRun.create({
      data: {
        nodeId, kind, mode, createdById: userId, notes,
        model: mode === LeverRunMode.LIVE ? config.model : 'dry-run',
        capUsd: config.runCapUsd, estimateUsd: estimate,
        stages: { create: stages.map((stage) => ({ stage })) },
      },
      select: { id: true },
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, 'This node already has an open run: resume or cancel it first')
    }
    throw err
  }
  logger.info('Generation run started', { runId: run.id, nodeId, kind, mode, estimateUsd: estimate })
  inBackground(run.id, () => advance(run.id))
  return { runId: run.id, mode, kind, estimateUsd: estimate }
}

/** Resume a stalled or failed run from the stage that stopped (earlier stages are not repeated). */
export async function resumeRun(runId: string) {
  const run = await prisma.generationRun.findUnique({ where: { id: runId }, include: { stages: true } })
  if (!run) throw new AppError(404, 'Run not found')
  const pendingItems = await prisma.extractionItem.count({ where: { runId, status: { in: [ItemStatus.PENDING, ItemStatus.RUNNING] } } })
  const resumable = run.status === GenerationRunStatus.STALLED || run.status === GenerationRunStatus.FAILED
    || (run.status === GenerationRunStatus.READY_FOR_REVIEW && pendingItems > 0)
  if (!resumable) throw new AppError(409, `A ${run.status.toLowerCase().replace(/_/g, ' ')} run cannot be resumed`)
  const stale = new Date(Date.now() - STALE_MS)
  try {
    await prisma.$transaction([
      prisma.generationRunStage.updateMany({
        where: { runId, status: { in: [StageStatus.STALLED, StageStatus.FAILED] } },
        data: { status: StageStatus.PENDING, error: null },
      }),
      // Only items whose worker stopped: a live one is still being processed and must not run twice.
      prisma.extractionItem.updateMany({ where: { runId, status: ItemStatus.RUNNING, heartbeatAt: { lt: stale } }, data: { status: ItemStatus.PENDING } }),
      prisma.generationRun.update({
        where: { id: runId },
        data: { status: run.status === GenerationRunStatus.READY_FOR_REVIEW ? run.status : GenerationRunStatus.ACTIVE, error: null },
      }),
    ])
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new AppError(409, 'Another run on this node is open: finish or cancel it first')
    throw err
  }
  logger.info('Generation run resumed', { runId })
  if (run.status === GenerationRunStatus.READY_FOR_REVIEW) inBackground(runId, () => processPendingItems(runId))
  else inBackground(runId, () => advance(runId))
  return { runId }
}

export async function cancelRun(runId: string) {
  const { count } = await prisma.generationRun.updateMany({
    where: { id: runId, status: { in: [GenerationRunStatus.ACTIVE, GenerationRunStatus.STALLED, GenerationRunStatus.FAILED, GenerationRunStatus.READY_FOR_REVIEW] } },
    data: { status: GenerationRunStatus.CANCELLED, finishedAt: new Date() },
  })
  if (count === 0) throw new AppError(409, 'This run cannot be cancelled')
  await prisma.generationRunStage.updateMany({ where: { runId, status: { in: [StageStatus.PENDING, StageStatus.RUNNING] } }, data: { status: StageStatus.FAILED, error: 'cancelled' } })
  await prisma.extractionItem.updateMany({ where: { runId, status: { in: [ItemStatus.PENDING, ItemStatus.WAITING] } }, data: { status: ItemStatus.FAILED, error: 'cancelled' } })
  logger.info('Generation run cancelled', { runId })
}

async function isOpen(runId: string): Promise<boolean> {
  const r = await prisma.generationRun.findUnique({ where: { id: runId }, select: { status: true } })
  return r?.status === GenerationRunStatus.ACTIVE || r?.status === GenerationRunStatus.READY_FOR_REVIEW
}

/** Cancelled or published: nothing more is written for this run. */
async function isClosed(runId: string): Promise<boolean> {
  const r = await prisma.generationRun.findUnique({ where: { id: runId }, select: { status: true } })
  return !r || r.status === GenerationRunStatus.CANCELLED || r.status === GenerationRunStatus.PUBLISHED
}

// ── The stage loop ──────────────────────────────────────────────────────────────────────────────────
export async function advance(runId: string): Promise<void> {
  for (;;) {
    const run = await prisma.generationRun.findUnique({ where: { id: runId }, include: { stages: true } })
    if (!run || run.status !== GenerationRunStatus.ACTIVE) return
    const ordered = [...run.stages].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage))
    if (ordered.every((s) => s.status === StageStatus.DONE)) return finishRun(runId)
    const next = ordered.find((s) => s.status !== StageStatus.DONE)
    if (!next || next.status !== StageStatus.PENDING) return
    const claimed = await prisma.generationRunStage.updateMany({
      where: { id: next.id, status: StageStatus.PENDING },
      data: { status: StageStatus.RUNNING, attempts: { increment: 1 }, startedAt: new Date(), heartbeatAt: new Date(), error: null },
    })
    if (claimed.count === 0) return // another process has it
    const ctx = await contextFor(runId)
    try {
      const output = await STAGES[next.stage](ctx)
      await prisma.generationRunStage.update({
        where: { id: next.id },
        data: { status: StageStatus.DONE, finishedAt: new Date(), output: output as Prisma.InputJsonValue },
      })
      logger.info('Generation stage done', { runId, stage: next.stage })
    } catch (err) {
      const cap = err instanceof CapError
      const code = cap ? err.cap : err instanceof StageFailure ? err.message : 'internal_error'
      if (!cap && !(err instanceof StageFailure)) {
        logger.error('Generation stage crashed', { runId, stage: next.stage, errorClass: err instanceof Error ? err.name : typeof err, error: err instanceof Error ? err.message.slice(0, 300) : undefined })
      }
      await prisma.generationRunStage.update({
        where: { id: next.id },
        data: { status: cap ? StageStatus.STALLED : StageStatus.FAILED, error: code.slice(0, 500), finishedAt: new Date() },
      })
      await prisma.generationRun.updateMany({
        where: { id: runId, status: GenerationRunStatus.ACTIVE },
        data: { status: cap ? GenerationRunStatus.STALLED : GenerationRunStatus.FAILED, error: `${next.stage}: ${code}`.slice(0, 500) },
      })
      logger.warn('Generation stage stopped', { runId, stage: next.stage, error: code, ...(cap ? { detail: (err as CapError).message } : {}) })
      return
    }
  }
}

async function finishRun(runId: string): Promise<void> {
  const { count } = await prisma.generationRun.updateMany({
    where: { id: runId, status: GenerationRunStatus.ACTIVE },
    data: { status: GenerationRunStatus.READY_FOR_REVIEW, finishedAt: new Date() },
  })
  if (count === 0) return
  // The notice goes once per run: readyAt is set by exactly one caller.
  const first = await prisma.generationRun.updateMany({ where: { id: runId, readyAt: null }, data: { readyAt: new Date() } })
  logger.info('Generation run ready for review', { runId })
  if (first.count === 1) await notifyRunReady(runId)
}

type StageHandler = (ctx: RunContext) => Promise<unknown>

// ── Model inputs (shared with `npm run generation:probe`, so it sends what the stage would) ─────────
export type StageNode = RunContext['node']

export async function placeInputFor(node: StageNode, taxonomy?: Awaited<ReturnType<typeof loadTaxonomy>>): Promise<PlaceInput> {
  const t = taxonomy ?? await loadTaxonomy()
  return { nodeSlug: node.slug, nodeName: node.name, path: t.path(node.id).map((n) => n.name), outline: t.outline() }
}

export async function leversInputFor(node: StageNode, notes: string | null): Promise<LeversInput> {
  const t = await loadTaxonomy()
  const definitions = await prisma.leverDefinition.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, type: true, unit: true, explanation: true } })
  const reference = await prisma.nodeLever.findMany({
    where: { nodeId: node.id, origin: LeverOrigin.REFERENCE, status: { not: LeverStatus.RETIRED } },
    select: { definition: { select: { id: true, name: true, type: true, unit: true, explanation: true } } },
  })
  return {
    nodeSlug: node.slug, nodeName: node.name, path: t.path(node.id).map((n) => n.name), notes,
    definitions, reference: reference.map((r) => r.definition),
  }
}

export async function discoverInputFor(node: StageNode, notes: string | null): Promise<DiscoverInput> {
  const t = await loadTaxonomy()
  return { nodeSlug: node.slug, nodeName: node.name, path: t.path(node.id).map((n) => n.name), searchTerms: node.searchTerms, notes }
}

/** The node's levers as EXTRACT sends them, keyed L1, L2, … in creation order. */
export async function extractionLeversFor(nodeId: string) {
  const nodeLevers = await prisma.nodeLever.findMany({
    where: { nodeId, status: { not: LeverStatus.RETIRED } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { definition: true },
  })
  const keyed = nodeLevers.map((l, i) => ({ key: `L${i + 1}`, lever: l }))
  const leversIn: ExtractLever[] = keyed.map(({ key, lever }) => ({
    key, name: lever.definition.name, type: lever.definition.type, inputFormat: lever.definition.inputFormat, unit: lever.definition.unit,
    allowedValues: lever.definition.allowedValues, explanation: lever.definition.explanation,
  }))
  return { keyed, leversIn }
}

export async function explainInputFor(node: StageNode): Promise<ExplainInput> {
  const t = await loadTaxonomy()
  const children = t.children(node.id).map((c) => ({ slug: c.node.slug, name: c.node.name }))
  return { nodeSlug: node.slug, nodeName: node.name, path: t.path(node.id).map((n) => n.name), children }
}

// ── PLACE ───────────────────────────────────────────────────────────────────────────────────────────
const place: StageHandler = async (ctx) => {
  const t = await loadTaxonomy()
  const input = await placeInputFor(ctx.node, t)
  const outline = input.outline
  const r = await callModel(ctx, RunStage.PLACE, null, outline.length + 2_000, 0, () => ctx.model.place(input, ctx.config))
  const parsed = PlacementSchema.safeParse(r.output)
  if (!parsed.success) throw new StageFailure('validation_failed', describeIssues(parsed.error))
  // Suggestions only (an admin applies them); slugs that are not navigation nodes, or would make a cycle, are dropped.
  const usable = (slug: string) => {
    const n = t.bySlug(slug)
    return !!n && n.kind === NodeKind.NAVIGATION && n.id !== ctx.node.id && !t.hasAncestor(n.id, ctx.node.id)
  }
  const p = parsed.data
  return {
    ...p,
    suggestedPrimaryParent: p.suggestedPrimaryParent && usable(p.suggestedPrimaryParent) ? p.suggestedPrimaryParent : null,
    secondaryParents: p.secondaryParents.filter(usable).filter((s) => t.bySlug(s)?.id !== t.byId.get(ctx.node.id)?.parentId),
    droppedSlugs: [...p.secondaryParents, ...(p.suggestedPrimaryParent ? [p.suggestedPrimaryParent] : [])].filter((s) => !usable(s)),
  }
}

// ── LEVERS ──────────────────────────────────────────────────────────────────────────────────────────
const levers: StageHandler = async (ctx) => {
  const input = await leversInputFor(ctx.node, ctx.notes)
  const definitions = input.definitions
  const r = await callModel(ctx, RunStage.LEVERS, null, JSON.stringify(input).length + 3_000, 0, () => ctx.model.levers(input, ctx.config))
  const parsed = LeverSetSchema.safeParse(r.output)
  if (!parsed.success) throw new StageFailure('validation_failed', describeIssues(parsed.error))
  const known = new Set(definitions.map((d) => d.id))
  const unknownIds = parsed.data.candidates.map((c) => c.reuseDefinitionId).filter((id): id is string => id !== null && !known.has(id))
  if (unknownIds.length) throw new StageFailure('validation_failed', `unknown definition id ${unknownIds[0]}`)

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "taxonomy_nodes" WHERE id = ${ctx.node.id} FOR UPDATE`
    let created = 0, reused = 0, folded = 0, added = 0
    for (const c of parsed.data.candidates) {
      let definitionId = c.reuseDefinitionId
      if (definitionId) reused++
      else if (c.definition) {
        const d = c.definition
        const existing = await tx.leverDefinition.findUnique({ where: { nameKey: normalizeName(d.name) }, select: { id: true } })
        if (existing) { definitionId = existing.id; folded++ } else {
          const def = await tx.leverDefinition.create({
            data: {
              name: d.name, nameKey: normalizeName(d.name), type: d.type, inputFormat: d.inputFormat, unit: d.unit, explanation: d.explanation,
              relatedNeeds: d.relatedNeeds, allowedValues: d.allowedValues, safetyFlag: d.safetyFlag, origin: LeverOrigin.GENERATED,
            },
            select: { id: true },
          })
          definitionId = def.id
          created++
        }
      }
      if (!definitionId) continue
      const onNode = await tx.nodeLever.findUnique({ where: { nodeId_definitionId: { nodeId: ctx.node.id, definitionId } }, select: { id: true, origin: true } })
      if (onNode) {
        if (c.note && onNode.origin !== LeverOrigin.REFERENCE) await tx.nodeLever.update({ where: { id: onNode.id }, data: { note: c.note } })
        continue
      }
      await tx.nodeLever.create({ data: { nodeId: ctx.node.id, definitionId, origin: LeverOrigin.GENERATED, runId: ctx.runId, note: c.note } })
      added++
    }
    for (const n of parsed.data.referenceNotes) {
      await tx.nodeLever.updateMany({
        where: { nodeId: ctx.node.id, definitionId: n.definitionId, origin: LeverOrigin.REFERENCE },
        data: { note: `${n.keep ? 'Keep' : 'Drop'}: ${n.note}`.slice(0, 200) },
      })
    }
    return { candidates: parsed.data.candidates.length, definitionsCreated: created, definitionsReused: reused, foldedIntoExisting: folded, addedToNode: added }
  })
}

// ── DISCOVER ────────────────────────────────────────────────────────────────────────────────────────
const productKey = (brand: string, name: string) => `${brandKey(brand)}|${wordsKey(name)}`

const discover: StageHandler = async (ctx) => {
  const input = await discoverInputFor(ctx.node, ctx.notes)
  const r = await callModel(ctx, RunStage.DISCOVER, null, 4_000, DISCOVERY_MAX_SEARCHES, () => ctx.model.discover(input, ctx.config), MAX_PAUSE_RESUMES + 1)
  if (r.output === null) throw new StageFailure('no_result', 'the model ended without proposing products')
  const parsed = DiscoverySchema.safeParse(r.output)
  if (!parsed.success) throw new StageFailure('validation_failed', describeIssues(parsed.error))

  // De-duplicate within the list (same brand and model, or same URL).
  const seenKeys = new Set<string>()
  const seenUrls = new Set<string>()
  const dropped: string[] = []
  const unusable: string[] = []
  const proposals = parsed.data.products.filter((p) => {
    // Retailers and review sites are never a product's source (D5.3, D6.3).
    const host = httpsHostKey(p.manufacturerUrl)
    if (!host) { unusable.push(p.manufacturerUrl); return false }
    if (isDenylisted(host)) { dropped.push(p.manufacturerUrl); return false }
    const k = productKey(p.brand, p.model)
    if (seenKeys.has(k) || seenUrls.has(p.manufacturerUrl)) return false
    seenKeys.add(k); seenUrls.add(p.manufacturerUrl)
    return true
  })
  if (proposals.length < MIN_PRODUCTS) throw new StageFailure('too_few_products', `${proposals.length} found; at least ${MIN_PRODUCTS} are needed`)
  const warning = proposals.length < TARGET_MIN_PRODUCTS ? `Only ${proposals.length} products found (target ${TARGET_MIN_PRODUCTS}–20)` : null

  const inNode = await prisma.product.findMany({ where: { nodeId: ctx.node.id }, select: { id: true, name: true, brand: true, manufacturerUrl: true, catalogStatus: true } })
  const productIds: string[] = []
  let createdCount = 0, linked = 0, skippedRejected = 0
  for (const p of proposals) {
    const same = inNode.find((x) => x.manufacturerUrl === p.manufacturerUrl || productKey(x.brand ?? '', x.name) === productKey(p.brand, p.model))
    if (same) {
      if (same.catalogStatus === CatalogStatus.REJECTED) { skippedRejected++; continue }
      productIds.push(same.id); linked++
      if (!same.manufacturerUrl) await prisma.product.update({ where: { id: same.id }, data: { manufacturerUrl: p.manufacturerUrl } })
      continue
    }
    const created = await prisma.product.create({
      data: {
        name: p.model, brand: p.brand, category: ctx.node.slug, nodeId: ctx.node.id, websiteUrl: p.manufacturerUrl,
        manufacturerUrl: p.manufacturerUrl, catalogStatus: CatalogStatus.PROPOSED, discoveredByRunId: ctx.runId,
        isDryRun: ctx.mode === LeverRunMode.DRY_RUN,
      },
      select: { id: true },
    })
    productIds.push(created.id); createdCount++
  }
  if (warning) await prisma.generationRun.update({ where: { id: ctx.runId }, data: { warning } })
  return { proposed: proposals.length, created: createdCount, linkedExisting: linked, skippedRejected, droppedRetailers: dropped.length, droppedUnusableUrls: unusable.length, warning, productIds }
}

// ── VERIFY (brand domains) ──────────────────────────────────────────────────────────────────────────
function stageOutputIds(output: Prisma.JsonValue | null | undefined): string[] {
  if (output && typeof output === 'object' && !Array.isArray(output) && Array.isArray(output.productIds)) {
    return output.productIds.filter((x): x is string => typeof x === 'string')
  }
  return []
}

async function setAttention(productId: string, check: string, reason: string): Promise<void> {
  // Never overrides an admin's decision (approved by an admin, or rejected).
  await prisma.product.updateMany({
    where: { id: productId, OR: [{ catalogStatus: { in: [CatalogStatus.PROPOSED, CatalogStatus.NEEDS_ATTENTION] } }, { catalogStatus: CatalogStatus.APPROVED, approvedVia: 'AUTO' }] },
    data: { catalogStatus: CatalogStatus.NEEDS_ATTENTION, approvedVia: null, attentionCheck: check, attentionReason: reason.slice(0, 300) },
  })
}

const verify: StageHandler = async (ctx) => {
  const discoverStage = await prisma.generationRunStage.findUnique({ where: { runId_stage: { runId: ctx.runId, stage: RunStage.DISCOVER } }, select: { output: true } })
  const ids = stageOutputIds(discoverStage?.output)
  const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, brand: true, manufacturerUrl: true, catalogStatus: true } })
  const outcomes = new Map<string, Awaited<ReturnType<typeof verifyBrandHost>>>()
  const summary = { verified: [] as string[], pending: [] as { host: string; failed: string }[], refused: [] as { host: string | null; reason: string }[] }
  for (const p of products) {
    if (!p.manufacturerUrl || !p.brand) continue
    const key = `${brandKey(p.brand)}|${httpsHostKey(p.manufacturerUrl)}`
    if (!outcomes.has(key)) {
      const o = await verifyBrandHost(p.brand, p.manufacturerUrl, ctx.fetcher)
      outcomes.set(key, o)
      if (o.status === 'verified') summary.verified.push(o.host)
      else if (o.status === 'pending') summary.pending.push({ host: o.host, failed: o.failed })
      else summary.refused.push({ host: o.host, reason: o.reason })
      await heartbeat(ctx.runId, RunStage.VERIFY)
    }
  }
  for (const p of products) {
    if (p.catalogStatus === CatalogStatus.REJECTED) continue
    const o = p.manufacturerUrl && p.brand ? outcomes.get(`${brandKey(p.brand)}|${httpsHostKey(p.manufacturerUrl)}`) : undefined
    if (!o || o.status === 'refused') {
      await setAttention(p.id, 'brand_domain', o?.status === 'refused' ? o.reason : 'no manufacturer URL')
      continue
    }
    const status = o.status === 'verified' ? ItemStatus.PENDING : ItemStatus.WAITING
    if (o.status === 'pending') await setAttention(p.id, 'brand_domain', `${o.host} is waiting for an admin to confirm it as ${p.brand}'s domain (${o.failed})`)
    await prisma.extractionItem.upsert({
      where: { runId_productId: { runId: ctx.runId, productId: p.id } },
      create: { runId: ctx.runId, productId: p.id, status },
      update: {},
    })
  }
  return summary
}

// ── EXTRACT ─────────────────────────────────────────────────────────────────────────────────────────
const extract: StageHandler = async (ctx) => {
  const cap = await processItems(ctx, RunStage.EXTRACT)
  if (cap) throw cap
  const counts = await prisma.extractionItem.groupBy({ by: ['status'], where: { runId: ctx.runId }, _count: { _all: true } })
  return Object.fromEntries(counts.map((c) => [c.status, c._count._all]))
}

/** Items left PENDING after the EXTRACT stage (a confirmed brand domain, a resume): processed outside the stage. */
export async function processPendingItems(runId: string): Promise<void> {
  if (!(await isOpen(runId))) return
  const ctx = await contextFor(runId)
  const cap = await processItems(ctx, null)
  if (cap) {
    await prisma.generationRun.updateMany({
      where: { id: runId, status: GenerationRunStatus.READY_FOR_REVIEW },
      data: { error: `EXTRACT: ${cap.cap}` },
    })
  }
}

async function claimItem(runId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "extraction_items" SET "status" = 'RUNNING', "attempts" = "attempts" + 1, "claimedAt" = now(), "heartbeatAt" = now(), "updatedAt" = now()
    WHERE "id" = (SELECT "id" FROM "extraction_items" WHERE "runId" = ${runId} AND "status" = 'PENDING'
                  ORDER BY "createdAt", "id" LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING "id"`
  return rows[0]?.id ?? null
}

/** Work through PENDING items with a few workers. Returns the cap error that stopped them, if any. */
async function processItems(ctx: RunContext, stage: RunStage | null): Promise<CapError | null> {
  let stopped: CapError | null = null
  const worker = async () => {
    while (!stopped && (await isOpen(ctx.runId))) {
      const itemId = await claimItem(ctx.runId)
      if (!itemId) return
      if (stage) await heartbeat(ctx.runId, stage)
      try {
        await processItem(ctx, itemId)
      } catch (err) {
        if (err instanceof CapError) {
          stopped = err
          await prisma.extractionItem.update({ where: { id: itemId }, data: { status: ItemStatus.PENDING } })
          return
        }
        const code = err instanceof StageFailure ? err.message : 'internal_error'
        if (!(err instanceof StageFailure)) logger.error('Extraction item crashed', { runId: ctx.runId, itemId, error: err instanceof Error ? err.message.slice(0, 300) : String(err) })
        await prisma.extractionItem.update({ where: { id: itemId }, data: { status: ItemStatus.FAILED, error: code.slice(0, 500) } })
        const item = await prisma.extractionItem.findUnique({ where: { id: itemId }, select: { productId: true } })
        if (item) await setAttention(item.productId, 'extraction', `extraction failed (${code})`)
      }
    }
  }
  await Promise.all(Array.from({ length: EXTRACT_CONCURRENCY }, worker))
  return stopped
}

interface CheckResult { pass: boolean; reason: string }

async function storeText(ctx: RunContext, url: string, kind: FetchedKind, productId: string, text: string): Promise<void> {
  const now = new Date()
  await prisma.fetchedPage.create({
    data: {
      url, kind, runId: ctx.runId, productId, text, contentHash: crypto.createHash('sha256').update(text).digest('hex'),
      fetchedAt: now, expiresAt: new Date(now.getTime() + FETCHED_TEXT_TTL_MS),
    },
  })
}

/**
 * Store a value unless an admin already decided it (accepted), entered it (manual) or corrected it. Under the
 * node lock that review decisions take too, so a value is never replaced between an admin's read and accept.
 */
async function writeValue(nodeId: string, productId: string, definitionId: string, data: Omit<Prisma.ProductLeverValueUncheckedCreateInput, 'productId' | 'definitionId'>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "taxonomy_nodes" WHERE id = ${nodeId} FOR UPDATE`
    const existing = await tx.productLeverValue.findUnique({
      where: { productId_definitionId: { productId, definitionId } },
      select: { id: true, status: true, origin: true, editedAt: true },
    })
    if (existing && (existing.status === ValueStatus.ACCEPTED || existing.origin === ValueOrigin.MANUAL || existing.editedAt !== null)) return
    if (existing) {
      await tx.productLeverValue.update({ where: { id: existing.id }, data: { ...data, reviewedById: null, reviewedAt: null, acceptMode: null } })
    } else {
      await tx.productLeverValue.create({ data: { ...data, productId, definitionId } })
    }
  })
}

const PDF_LINK = /\.pdf($|\?)/i
const MANUAL_WORDS = /manual|instruction|specification|spec sheet|user guide|owner/i

async function processItem(ctx: RunContext, itemId: string): Promise<void> {
  const item = await prisma.extractionItem.findUniqueOrThrow({
    where: { id: itemId },
    include: { product: { select: { id: true, name: true, brand: true, manufacturerUrl: true, catalogStatus: true, nodeId: true } } },
  })
  const product = item.product
  const done = (data: Prisma.ExtractionItemUpdateInput) => prisma.extractionItem.update({ where: { id: itemId }, data: { status: ItemStatus.DONE, heartbeatAt: new Date(), ...data } })
  if (product.catalogStatus === CatalogStatus.REJECTED) return void (await done({ error: 'product rejected by an admin' }))
  if (!product.manufacturerUrl || !product.brand) return void (await done({ error: 'no manufacturer URL' }))
  const url = product.manufacturerUrl
  const brand = product.brand

  // Check 1: the URL is on a verified domain of its brand (else wait for an admin to confirm the brand).
  if (!(await isVerifiedFor(brand, url))) {
    const host = httpsHostKey(url)
    const row = host ? await prisma.brandDomain.findUnique({ where: { host }, select: { status: true } }) : null
    if (row?.status === BrandDomainStatus.PENDING_CONFIRMATION) {
      await prisma.extractionItem.update({ where: { id: itemId }, data: { status: ItemStatus.WAITING } })
      return
    }
    await setAttention(product.id, 'brand_domain', `${host ?? 'the URL'} is not a verified domain of ${brand}`)
    return void (await done({ fetchOutcome: FetchOutcome.NOT_ALLOWED, checks: { brandDomain: { pass: false, reason: 'not verified' } } }))
  }

  const { keyed, leversIn } = await extractionLeversFor(ctx.node.id)
  const checks: Record<string, CheckResult> = { brandDomain: { pass: true, reason: 'verified domain of the brand' } }
  const documents: { url: string; kind: string; outcome: string; chars?: number; detail?: string }[] = []

  const unknownAll = async (reason: string) => {
    for (const { lever } of keyed) {
      await writeValue(ctx.node.id, product.id, lever.definitionId, {
        ...EMPTY_VALUE, status: ValueStatus.PROPOSED, origin: ValueOrigin.EXTRACTED, unknownReason: reason, sourceUrl: null,
        evidenceQuote: null, statedValue: null, statedUnit: null, confidence: null, runId: ctx.runId, extractedAt: new Date(),
      })
    }
  }

  // Check 2: the page fetches.
  const page = await ctx.fetcher.fetch(url, { kind: 'brand', brandKey: brandKey(brand) }, ['html'])
  await prisma.extractionItem.update({ where: { id: itemId }, data: { heartbeatAt: new Date(), fetchedAt: new Date(), fetchOutcome: page.outcome, httpStatus: page.status } })
  if (page.outcome !== FetchOutcome.OK) {
    documents.push({ url, kind: 'page', outcome: page.outcome, detail: page.detail })
    checks.fetch = { pass: false, reason: `${page.outcome}: ${page.detail}` }
    await unknownAll('page_not_fetched')
    await setAttention(product.id, 'fetch', `the product page could not be fetched (${page.outcome}: ${page.detail})`)
    return void (await done({ checks: checks as unknown as Prisma.InputJsonValue, documents }))
  }
  const html = new TextDecoder().decode(page.body)
  const parsed = parseHtml(html, page.url)
  if (looksLikeChallenge(parsed, html)) {
    await ctx.fetcher.pause(page.host)
    documents.push({ url: page.url, kind: 'page', outcome: FetchOutcome.BLOCKED, detail: 'challenge page' })
    checks.fetch = { pass: false, reason: 'BLOCKED: the site answered with a challenge page; not retried' }
    await unknownAll('page_not_fetched')
    await setAttention(product.id, 'fetch', 'the site answered with a challenge page (blocked, not retried)')
    return void (await done({ fetchOutcome: FetchOutcome.BLOCKED, checks: checks as unknown as Prisma.InputJsonValue, documents }))
  }
  checks.fetch = { pass: true, reason: 'fetched' }
  documents.push({ url: page.url, kind: 'page', outcome: FetchOutcome.OK, chars: parsed.text.length })
  await storeText(ctx, page.url, FetchedKind.PAGE, product.id, parsed.text)

  // Check 3: the page names the model (title, an h1, or the schema.org Product name).
  const names = [parsed.title ?? '', ...parsed.h1s, ...parsed.productNames]
  const named = names.some((n) => containsWords(n, product.name))
  checks.modelNamed = named
    ? { pass: true, reason: `the page names "${product.name}"` }
    : { pass: false, reason: `"${product.name}" is not in the page title, headings or product name (${(parsed.h1s[0] ?? parsed.title ?? 'none').slice(0, 80)})` }

  // Text-based PDF manuals linked from the page (any non-denylisted host) or on the brand's verified host.
  const evidenceDocs: EvidenceDocument[] = [{ key: 'page', url: page.url, text: parsed.text }]
  const modelDocs: ExtractDocument[] = [{ key: 'page', kind: 'page', url: page.url, text: excerpt(parsed.text, PAGE_CHARS) }]
  const linkUrls = new Set(parsed.links.map((l) => l.url))
  const pdfLinks = parsed.links.filter((l) => PDF_LINK.test(new URL(l.url).pathname) && (MANUAL_WORDS.test(l.text) || MANUAL_WORDS.test(l.url)))
    .filter((l, i, all) => all.findIndex((x) => x.url === l.url) === i).slice(0, MAX_PDFS)
  for (const link of pdfLinks) {
    const pdf = await ctx.fetcher.fetch(link.url, { kind: 'linked', brandKey: brandKey(brand), urls: linkUrls }, ['pdf'])
    if (pdf.outcome !== FetchOutcome.OK) { documents.push({ url: link.url, kind: 'pdf', outcome: pdf.outcome, detail: pdf.detail }); continue }
    const text = await extractPdfText(pdf.body)
    if (!text.ok) {
      documents.push({ url: pdf.url, kind: 'pdf', outcome: text.reason === 'scanned' ? FetchOutcome.SCANNED_PDF : FetchOutcome.UNSUPPORTED_TYPE, detail: text.reason })
      continue
    }
    const key = `pdf${evidenceDocs.length}`
    evidenceDocs.push({ key, url: pdf.url, text: text.text })
    modelDocs.push({ key, kind: 'pdf', url: pdf.url, text: excerpt(text.text, PDF_CHARS) })
    documents.push({ url: pdf.url, kind: 'pdf', outcome: FetchOutcome.OK, chars: text.text.length })
    await storeText(ctx, pdf.url, FetchedKind.PDF, product.id, text.text)
  }
  await prisma.extractionItem.update({ where: { id: itemId }, data: { heartbeatAt: new Date() } })

  // Check 5: not a duplicate of a product in another node.
  // Same URL, or the same normalized brand and name (A1), in another node.
  const others = await prisma.product.findMany({
    where: { id: { not: product.id }, nodeId: { not: ctx.node.id }, catalogStatus: { not: CatalogStatus.REJECTED }, OR: [{ manufacturerUrl: url }, { brand: { not: null } }] },
    select: { id: true, name: true, brand: true, manufacturerUrl: true, node: { select: { name: true } } },
  })
  const key = productKey(brand, product.name)
  const dup = others.find((o) => o.manufacturerUrl === url || (o.brand !== null && productKey(o.brand, o.name) === key)) ?? null
  checks.duplicate = dup ? { pass: false, reason: `duplicate of "${dup.name}" in ${dup.node?.name ?? 'another node'}` } : { pass: true, reason: 'no duplicate in other nodes' }

  // The extraction call: every candidate lever from the page and manuals, plus the node-fit classification.
  const t = await loadTaxonomy()
  const input = {
    nodeSlug: ctx.node.slug, nodeName: ctx.node.name, path: t.path(ctx.node.id).map((n) => n.name),
    product: { brand, name: product.name, url }, levers: leversIn, documents: modelDocs,
  }
  const promptChars = modelDocs.reduce((a, d) => a + d.text.length, 0) + JSON.stringify(leversIn).length + 4_000
  const r = await callModel(ctx, RunStage.EXTRACT, product.id, promptChars, 0, () => ctx.model.extract(input, ctx.config))
  const extraction = ExtractionSchema.safeParse(r.output)
  if (!extraction.success) throw new StageFailure('validation_failed', describeIssues(extraction.error))
  // Cancelled (or published) while this item was being fetched or extracted: write nothing. A run marked
  // stalled meanwhile keeps the result: the call was paid for and Resume would not retry a done item.
  if (await isClosed(ctx.runId)) return void (await done({ error: 'cancelled' }))

  // Check 4: node fit, only HIGH auto-approves.
  const fit = extraction.data.nodeFit
  checks.nodeFit = fit.belongs && fit.confidence === Confidence.HIGH
    ? { pass: true, reason: fit.reason }
    : { pass: false, reason: `${fit.belongs ? 'belongs' : 'does not belong'} (${fit.confidence}): ${fit.reason}` }

  // The evidence rules decide every value (D7).
  const tally = { known: 0, unknown: 0 }
  for (const { key, lever } of keyed) {
    const raw: ExtractedValue = extraction.data.values.find((v) => v.lever === key) ?? {
      lever: key, found: false, statedValue: null, statedUnit: null, dimensions: null, items: null, choice: null, bool: null,
      oneHandFold: null, quote: null, source: null, confidence: Confidence.LOW,
    }
    const ev = checkEvidence(lever.definition, raw, evidenceDocs)
    if (ev.ok) tally.known++; else tally.unknown++
    await writeValue(ctx.node.id, product.id, lever.definitionId, {
      ...ev.columns,
      status: ValueStatus.PROPOSED,
      origin: ValueOrigin.EXTRACTED,
      statedValue: ev.statedValue?.slice(0, 100) ?? null,
      statedUnit: ev.statedUnit?.slice(0, 30) ?? null,
      evidenceQuote: ev.quote?.slice(0, 400) ?? null,
      sourceUrl: ev.sourceUrl,
      confidence: ev.ok ? ev.confidence : null,
      unknownReason: ev.ok ? null : ev.reason,
      runId: ctx.runId,
      extractedAt: new Date(),
    })
  }

  // Auto-approval: every check passed (section 5 A1); otherwise needs attention with the first failed check.
  const order = ['brandDomain', 'fetch', 'modelNamed', 'nodeFit', 'duplicate']
  const failed = order.find((k) => checks[k] && !checks[k].pass)
  if (failed) {
    await setAttention(product.id, failed, checks[failed].reason)
  } else {
    await prisma.product.updateMany({
      where: { id: product.id, catalogStatus: { in: [CatalogStatus.PROPOSED, CatalogStatus.NEEDS_ATTENTION] } },
      data: { catalogStatus: CatalogStatus.APPROVED, approvedVia: 'AUTO', attentionCheck: null, attentionReason: null },
    })
  }
  await done({ checks: checks as unknown as Prisma.InputJsonValue, documents, error: null })
  logger.info('Product extracted', { runId: ctx.runId, productId: product.id, known: tally.known, unknown: tally.unknown, approved: !failed, failedCheck: failed ?? null })
}

// ── EXPLAIN (navigation nodes) ──────────────────────────────────────────────────────────────────────
const explain: StageHandler = async (ctx) => {
  const input = await explainInputFor(ctx.node)
  const children = input.children
  const r = await callModel(ctx, RunStage.EXPLAIN, null, 2_000, 0, () => ctx.model.explain(input, ctx.config))
  const parsed = ExplainerSchema.safeParse(r.output)
  if (!parsed.success) throw new StageFailure('validation_failed', describeIssues(parsed.error))
  const slugs = new Set(children.map((c) => c.slug))
  return { explainer: parsed.data.explainer, children: parsed.data.children.filter((c) => slugs.has(c.slug)) }
}

const STAGES: Record<RunStage, StageHandler> = {
  PLACE: place, LEVERS: levers, DISCOVER: discover, VERIFY: verify, EXTRACT: extract, EXPLAIN: explain,
}

// ── Reconciler: stalled work and fetched-text retention ─────────────────────────────────────────────
export async function reconcileGeneration(now = new Date()): Promise<{ stalled: number; requeued: number; purged: number }> {
  const stale = new Date(now.getTime() - STALE_MS)
  const stalledStages = await prisma.generationRunStage.findMany({ where: { status: StageStatus.RUNNING, heartbeatAt: { lt: stale } }, select: { id: true, runId: true, stage: true } })
  for (const s of stalledStages) {
    await prisma.generationRunStage.updateMany({ where: { id: s.id, status: StageStatus.RUNNING }, data: { status: StageStatus.STALLED, error: 'stalled' } })
    await prisma.generationRun.updateMany({ where: { id: s.runId, status: GenerationRunStatus.ACTIVE }, data: { status: GenerationRunStatus.STALLED, error: `${s.stage}: stalled` } })
  }
  const { count: requeued } = await prisma.extractionItem.updateMany({
    where: { status: ItemStatus.RUNNING, heartbeatAt: { lt: stale } },
    data: { status: ItemStatus.PENDING },
  })
  const { count: purged } = await prisma.fetchedPage.deleteMany({ where: { expiresAt: { lte: now } } })
  if (stalledStages.length || requeued || purged) logger.info('Generation reconciled', { stalled: stalledStages.length, requeued, purged })
  return { stalled: stalledStages.length, requeued, purged }
}

let timer: NodeJS.Timeout | null = null
export function startGenerationReconciler(intervalMs = 60_000): void {
  if (timer) return
  const tick = () => void reconcileGeneration().catch((err) => logger.warn('Generation reconcile failed', { error: err instanceof Error ? err.message : String(err) }))
  tick()
  timer = setInterval(tick, intervalMs)
  timer.unref()
}

/** Re-queue items waiting on a brand domain an admin just confirmed, and process them. */
export async function requeueWaitingForHost(host: string): Promise<number> {
  const waiting = await prisma.extractionItem.findMany({
    where: { status: ItemStatus.WAITING },
    select: { id: true, runId: true, product: { select: { manufacturerUrl: true } } },
  })
  const all = waiting.filter((w) => w.product.manufacturerUrl && httpsHostKey(w.product.manufacturerUrl) === host)
  // Items of a run already published or cancelled are closed: their products wait for the node's next run.
  // A stalled or failed run is not closed (Resume continues it): its items go back to pending and run on
  // Resume; only an active or ready run picks them up now.
  const runs = await prisma.generationRun.findMany({ where: { id: { in: [...new Set(all.map((w) => w.runId))] } }, select: { id: true, status: true } })
  const statusOf = new Map(runs.map((r) => [r.id, r.status]))
  const isClosed = (runId: string) => {
    const st = statusOf.get(runId)
    return st === undefined || st === GenerationRunStatus.PUBLISHED || st === GenerationRunStatus.CANCELLED
  }
  const closed = all.filter((w) => isClosed(w.runId))
  if (closed.length) await prisma.extractionItem.updateMany({ where: { id: { in: closed.map((c) => c.id) } }, data: { status: ItemStatus.FAILED, error: 'run closed before the brand domain was confirmed; start a new run' } })
  const matching = all.filter((w) => !isClosed(w.runId))
  if (!matching.length) return 0
  await prisma.extractionItem.updateMany({ where: { id: { in: matching.map((m) => m.id) } }, data: { status: ItemStatus.PENDING } })
  const live: GenerationRunStatus[] = [GenerationRunStatus.ACTIVE, GenerationRunStatus.READY_FOR_REVIEW]
  for (const runId of new Set(matching.map((m) => m.runId))) {
    if (live.includes(statusOf.get(runId) ?? GenerationRunStatus.CANCELLED)) inBackground(runId, () => processPendingItems(runId))
  }
  return matching.length
}

export { STAGE_ORDER }
