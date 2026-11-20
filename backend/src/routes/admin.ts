// Admin routes: taxonomy, generation runs, the review screen, brand domains and publishing
// (docs/adr-generation-run.md D13). Every route: authenticate + requireAdmin (role read from the database).
import express, { Router, Request, Response } from 'express'
import { z } from 'zod'
import {
  BrandDomainStatus, BrandVerifiedVia, CatalogStatus, GenerationRunKind, GenerationRunStatus, ItemStatus, LeverStatus, NodeKind, Prisma,
} from '@prisma/client'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'
import { requireAdmin } from '../middleware/requireAdmin'
import { AppError } from '../middleware/errorHandler'
import { loadGenerationConfig } from '../generation/config'
import { cancelRun, reconcileGeneration, requeueWaitingForHost, resumeRun, startRun, STAGE_ORDER } from '../generation/runs'
import { runSpendUsd } from '../generation/costs'
import { httpsHostKey } from '../generation/fetch/hosts'
import { createLever, createLeverSchema, editLever, editLeverSchema, retireLever } from '../catalog/levers'
import { coverage, LEVERS_PER_NODE, publishNode, publishSchema, unpublishNode } from '../catalog/publish'
import {
  acceptValue, approveProducts, bulkAccept, bulkAcceptSchema, decisionSchema, editValue, enterManualValue, markUnknown, placeProduct, placeProductSchema,
  productDecisionSchema, rejectProducts, rejectValue,
} from '../catalog/review'
import { importSurvey } from '../catalog/survey'
import { createNodeSchema, editNode, editNodeSchema, loadTaxonomy, lockTaxonomy } from '../catalog/taxonomy'
import { normalizeName, slugFromName } from '../catalog/text'
import { presentTyped, valueColumnsOf } from '../catalog/values'

export const adminRouter = Router()
adminRouter.use(authenticate, requireAdmin)

const csvBody = express.text({ type: ['text/csv', 'text/plain', 'application/csv'], limit: '1mb' })

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) {
    const i = r.error.issues[0]
    throw new AppError(400, `${i.path.join('.') || 'body'}: ${i.message}`)
  }
  return r.data
}

const userId = (req: Request): string => {
  if (!req.userId) throw new AppError(401, 'Authentication required')
  return req.userId
}

/** Launch order (spec: the travel-system pair first). A hint for the admin screen only. */
export const LAUNCH_ORDER = ['infant-car-seats', 'full-size-strollers', 'convertible-car-seats', 'travel-strollers', 'booster-seats', 'jogging-strollers', 'double-strollers']

// ── Config and summary ──────────────────────────────────────────────────────────────────────────────
adminRouter.get('/config', (_req: Request, res: Response) => {
  const c = loadGenerationConfig()
  res.json({
    mode: c.mode, model: c.mode === 'live' ? c.model : 'dry-run', runCapUsd: c.runCapUsd, dailyCapUsd: c.dailyCapUsd,
    minProducts: c.minProducts, maxTokens: c.maxTokens, leversPerNode: LEVERS_PER_NODE,
  })
})

/** The in-app notice: runs ready for review, brand domains to confirm, unplaced products. */
adminRouter.get('/summary', async (_req: Request, res: Response) => {
  const [ready, brands, unplaced] = await Promise.all([
    prisma.generationRun.count({ where: { status: GenerationRunStatus.READY_FOR_REVIEW } }),
    prisma.brandDomain.count({ where: { status: BrandDomainStatus.PENDING_CONFIRMATION } }),
    prisma.product.count({ where: { nodeId: null } }),
  ])
  res.json({ readyForReview: ready, brandsToConfirm: brands, unplacedProducts: unplaced })
})

// ── Taxonomy ────────────────────────────────────────────────────────────────────────────────────────
adminRouter.get('/nodes', async (_req: Request, res: Response) => {
  await reconcileGeneration()
  const t = await loadTaxonomy()
  const [runs, productCounts, leverCounts] = await Promise.all([
    prisma.generationRun.findMany({ orderBy: { createdAt: 'desc' }, select: { id: true, nodeId: true, status: true, kind: true, createdAt: true } }),
    prisma.product.groupBy({ by: ['nodeId', 'catalogStatus'], where: { NOT: { catalogStatus: CatalogStatus.APPROVED, approvedVia: null } }, _count: { _all: true } }),
    prisma.nodeLever.groupBy({ by: ['nodeId', 'status'], _count: { _all: true } }),
  ])
  const count = (rows: { nodeId: string | null; _count: { _all: number } }[], id: string, pick: (r: never) => boolean) =>
    rows.filter((r) => r.nodeId === id && pick(r as never)).reduce((a, r) => a + r._count._all, 0)
  const present = (id: string, depth: number): unknown => {
    const n = t.byId.get(id)
    if (!n) return null
    const latest = runs.find((r) => r.nodeId === id) ?? null
    return {
      id: n.id, slug: n.slug, name: n.name, kind: n.kind, depth, publishedAt: n.publishedAt, visible: t.visible(n.id),
      explainerApproved: n.explainerApprovedAt !== null, safetyCritical: t.safetyCritical(n.id),
      launchOrder: LAUNCH_ORDER.includes(n.slug) ? LAUNCH_ORDER.indexOf(n.slug) + 1 : null,
      latestRun: latest && { id: latest.id, status: latest.status, kind: latest.kind, createdAt: latest.createdAt },
      products: {
        approved: count(productCounts, id, (r: { catalogStatus: CatalogStatus }) => r.catalogStatus === CatalogStatus.APPROVED),
        needsAttention: count(productCounts, id, (r: { catalogStatus: CatalogStatus }) => r.catalogStatus === CatalogStatus.NEEDS_ATTENTION),
      },
      levers: {
        candidates: count(leverCounts, id, (r: { status: LeverStatus }) => r.status === LeverStatus.CANDIDATE),
        approved: count(leverCounts, id, (r: { status: LeverStatus }) => r.status === LeverStatus.APPROVED),
      },
      children: depth > 6 ? [] : t.children(id).map((c) => ({ ...(present(c.node.id, depth + 1) as object), viaSecondary: c.viaSecondary })),
    }
  }
  res.json(t.nodes.filter((n) => n.parentId === null).map((n) => present(n.id, 0)))
})

adminRouter.post('/nodes', async (req: Request, res: Response) => {
  const body = parse(createNodeSchema, req.body)
  const slug = body.slug ?? slugFromName(body.name)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 2) throw new AppError(400, 'slug: could not derive a valid slug from the name; give one')
  const node = await prisma.$transaction(async (tx) => {
    await lockTaxonomy(tx)
    if (await tx.taxonomyNode.findUnique({ where: { slug }, select: { id: true } })) throw new AppError(409, `A node with slug "${slug}" already exists`)
    if (body.parentId) {
      const t = await loadTaxonomy(tx)
      const parent = t.byId.get(body.parentId)
      if (!parent) throw new AppError(404, 'Parent not found')
      if (parent.kind !== NodeKind.NAVIGATION) throw new AppError(400, `"${parent.name}" is a decision node; only navigation nodes have children`)
    }
    return tx.taxonomyNode.create({
      data: { slug, name: body.name, kind: body.kind, parentId: body.parentId ?? null, searchTerms: body.searchTerms ?? [], createdById: userId(req) },
    })
  })
  res.status(201).json(node)
})

adminRouter.patch('/nodes/:id', async (req: Request, res: Response) => {
  res.json(await editNode(req.params.id, parse(editNodeSchema, req.body), userId(req)))
})

const RUN_SELECT = {
  id: true, kind: true, mode: true, status: true, model: true, capUsd: true, estimateUsd: true, warning: true, error: true, notes: true,
  createdAt: true, finishedAt: true, readyAt: true, createdBy: { select: { username: true } },
  stages: { select: { stage: true, status: true, attempts: true, startedAt: true, heartbeatAt: true, finishedAt: true, error: true, output: true } },
  calls: { select: { stage: true, costUsd: true, reservedUsd: true, inputTokens: true, outputTokens: true, webSearches: true, status: true } },
} satisfies Prisma.GenerationRunSelect

type RunRow = Prisma.GenerationRunGetPayload<{ select: typeof RUN_SELECT }>

async function presentRun(r: RunRow) {
  const items = await prisma.extractionItem.groupBy({ by: ['status'], where: { runId: r.id }, _count: { _all: true } })
  const spent = await runSpendUsd(r.id)
  const byStage = (stage: string) => r.calls.filter((c) => c.stage === stage)
  return {
    id: r.id, kind: r.kind, mode: r.mode, status: r.status, model: r.model, capUsd: Number(r.capUsd), estimateUsd: r.estimateUsd === null ? null : Number(r.estimateUsd),
    costUsd: spent, warning: r.warning, error: r.error, notes: r.notes, createdAt: r.createdAt, finishedAt: r.finishedAt, readyAt: r.readyAt,
    createdBy: r.createdBy?.username ?? null,
    stages: [...r.stages].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)).map((s) => ({
      ...s,
      calls: byStage(s.stage).length,
      costUsd: byStage(s.stage).reduce((a, c) => a + Number(c.costUsd ?? c.reservedUsd), 0),
      inputTokens: byStage(s.stage).reduce((a, c) => a + (c.inputTokens ?? 0), 0),
      outputTokens: byStage(s.stage).reduce((a, c) => a + (c.outputTokens ?? 0), 0),
      webSearches: byStage(s.stage).reduce((a, c) => a + (c.webSearches ?? 0), 0),
    })),
    items: Object.fromEntries(items.map((i) => [i.status, i._count._all])),
  }
}

adminRouter.get('/nodes/:id', async (req: Request, res: Response) => {
  await reconcileGeneration()
  const t = await loadTaxonomy()
  const n = t.byId.get(req.params.id)
  if (!n) throw new AppError(404, 'Node not found')
  const node = await prisma.taxonomyNode.findUniqueOrThrow({
    where: { id: n.id },
    include: {
      publishedBy: { select: { username: true } }, explainerApprovedBy: { select: { username: true } },
      secondaryParents: { select: { parent: { select: { id: true, slug: true, name: true } } } },
      runs: { orderBy: { createdAt: 'desc' }, take: 10, select: RUN_SELECT },
      legacyRuns: { orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, mode: true, status: true, model: true, error: true, costUsd: true, createdAt: true, output: true } },
    },
  })
  res.json({
    id: node.id, slug: node.slug, name: node.name, kind: node.kind, searchTerms: node.searchTerms, safetyCritical: t.safetyCritical(n.id),
    ownSafetyCritical: node.safetyCritical, path: t.path(n.id).map((x) => ({ id: x.id, slug: x.slug, name: x.name })),
    parentId: node.parentId, secondaryParents: node.secondaryParents.map((s) => s.parent),
    children: t.children(n.id).map((c) => ({ id: c.node.id, slug: c.node.slug, name: c.node.name, kind: c.node.kind, viaSecondary: c.viaSecondary })),
    publishedAt: node.publishedAt, publishedBy: node.publishedBy?.username ?? null, visible: t.visible(n.id),
    explainer: node.explainer, explainerChildLines: node.explainerChildLines, explainerApprovedAt: node.explainerApprovedAt,
    explainerApprovedBy: node.explainerApprovedBy?.username ?? null,
    navigationParents: t.nodes.filter((x) => x.kind === NodeKind.NAVIGATION && x.id !== n.id).map((x) => ({ id: x.id, slug: x.slug, name: x.name })),
    runs: await Promise.all(node.runs.map(presentRun)),
    legacyRuns: node.legacyRuns.map((r) => ({ ...r, costUsd: r.costUsd === null ? null : r.costUsd.toString() })),
  })
})

const explainerSchema = z.object({
  explainer: z.string().trim().min(20).max(600),
  childLines: z.record(z.string().min(1).max(60), z.string().trim().min(1).max(160)),
}).strict()

/** Approve the explainer of a navigation node (edited or as generated). */
adminRouter.post('/nodes/:id/explainer', async (req: Request, res: Response) => {
  const body = parse(explainerSchema, req.body)
  const node = await prisma.taxonomyNode.findUnique({ where: { id: req.params.id }, select: { kind: true } })
  if (!node) throw new AppError(404, 'Node not found')
  if (node.kind !== NodeKind.NAVIGATION) throw new AppError(400, 'Only navigation nodes have an explainer')
  const updated = await prisma.taxonomyNode.update({
    where: { id: req.params.id },
    data: { explainer: body.explainer, explainerChildLines: body.childLines, explainerApprovedAt: new Date(), explainerApprovedById: userId(req) },
  })
  await prisma.generationRun.updateMany({ where: { nodeId: req.params.id, kind: GenerationRunKind.EXPLAINER, status: GenerationRunStatus.READY_FOR_REVIEW }, data: { status: GenerationRunStatus.PUBLISHED } })
  res.json({ explainer: updated.explainer, explainerApprovedAt: updated.explainerApprovedAt })
})

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────────
const runSchema = z.object({ notes: z.string().trim().max(1000).optional() }).strict()

adminRouter.post('/nodes/:id/runs', async (req: Request, res: Response) => {
  const body = parse(runSchema, req.body ?? {})
  res.status(202).json(await startRun(req.params.id, userId(req), body.notes || null))
})

adminRouter.get('/runs/:id', async (req: Request, res: Response) => {
  await reconcileGeneration()
  const run = await prisma.generationRun.findUnique({ where: { id: req.params.id }, select: { ...RUN_SELECT, nodeId: true } })
  if (!run) throw new AppError(404, 'Run not found')
  res.json({ ...(await presentRun(run)), nodeId: run.nodeId })
})

adminRouter.post('/runs/:id/resume', async (req: Request, res: Response) => {
  res.status(202).json(await resumeRun(req.params.id))
})

adminRouter.post('/runs/:id/cancel', async (req: Request, res: Response) => {
  await cancelRun(req.params.id)
  res.json({ cancelled: true })
})

// ── Review screen data ──────────────────────────────────────────────────────────────────────────────
adminRouter.get('/nodes/:id/review', async (req: Request, res: Response) => {
  await reconcileGeneration()
  const t = await loadTaxonomy()
  const n = t.byId.get(req.params.id)
  if (!n) throw new AppError(404, 'Node not found')
  if (n.kind !== NodeKind.DECISION) throw new AppError(400, 'Only decision nodes have a review screen')
  const config = loadGenerationConfig()
  const [run, products, levers, cov, survey] = await Promise.all([
    prisma.generationRun.findFirst({ where: { nodeId: n.id, kind: GenerationRunKind.NODE }, orderBy: { createdAt: 'desc' }, select: RUN_SELECT }),
    prisma.product.findMany({
      where: { nodeId: n.id },
      orderBy: [{ catalogStatus: 'asc' }, { brand: 'asc' }, { name: 'asc' }],
      include: {
        extractionItems: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, fetchOutcome: true, httpStatus: true, checks: true, documents: true, error: true } },
        reviewedBy: { select: { username: true } },
      },
    }),
    prisma.nodeLever.findMany({
      where: { nodeId: n.id },
      orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
      include: {
        definition: { include: { nodeLevers: { where: { status: { not: LeverStatus.RETIRED } }, select: { node: { select: { id: true, name: true } } } } } },
        approvedBy: { select: { username: true } },
      },
    }),
    coverage(prisma, n.id),
    prisma.surveyImport.findFirst({ where: { nodeId: n.id }, orderBy: { uploadedAt: 'desc' }, include: { rankings: true } }),
  ])
  const live = levers.filter((l) => l.status !== LeverStatus.RETIRED)
  const values = await prisma.productLeverValue.findMany({
    where: { productId: { in: products.map((p) => p.id) }, definitionId: { in: live.map((l) => l.definitionId) } },
    include: { reviewedBy: { select: { username: true } }, editedBy: { select: { username: true } } },
  })
  const safetyNode = t.safetyCritical(n.id)
  const rankingFor = (name: string) => survey?.rankings.find((r) => normalizeName(r.leverName) === normalizeName(name)) ?? null
  // A product added by a user (or seeded before generation runs) is approved for its own page but not in the
  // catalog: shown as proposed here.
  const statusOf = (p: { catalogStatus: CatalogStatus; approvedVia: string | null }) =>
    p.catalogStatus === CatalogStatus.APPROVED && p.approvedVia === null ? CatalogStatus.PROPOSED : p.catalogStatus
  const approvedIds = new Set(products.filter((p) => statusOf(p) === CatalogStatus.APPROVED).map((p) => p.id))
  const reviewable = values.filter((v) => approvedIds.has(v.productId))

  res.json({
    node: { id: n.id, slug: n.slug, name: n.name, publishedAt: n.publishedAt, safetyCritical: safetyNode, path: t.path(n.id).map((x) => x.name) },
    config: { minProducts: config.minProducts, mode: config.mode },
    run: run ? await presentRun(run) : null,
    products: products.map((p) => ({
      id: p.id, name: p.name, brand: p.brand, url: p.manufacturerUrl ?? p.websiteUrl, status: statusOf(p), approvedVia: p.approvedVia,
      attentionCheck: p.attentionCheck ?? (statusOf(p) !== p.catalogStatus ? 'not_in_catalog' : null),
      attentionReason: p.attentionReason ?? (statusOf(p) !== p.catalogStatus ? 'Added by a user or before generation runs, not reviewed into the catalog; approve it to include it in this node\'s list' : null), listed: p.listed, isDryRun: p.isDryRun,
      reviewedBy: p.reviewedBy?.username ?? null, item: p.extractionItems[0] ?? null,
    })),
    levers: levers.map((l) => ({
      id: l.id, definitionId: l.definitionId, name: l.definition.name, type: l.definition.type, inputFormat: l.definition.inputFormat,
      unit: l.definition.unit, explanation: l.definition.explanation, relatedNeeds: l.definition.relatedNeeds, allowedValues: l.definition.allowedValues,
      status: l.status, position: l.position, origin: l.origin, note: l.note, safety: l.safety || l.definition.safetyFlag || safetyNode,
      approvedBy: l.approvedBy?.username ?? null, approvedAt: l.approvedAt,
      sharedWith: l.definition.nodeLevers.map((x) => x.node).filter((x) => x.id !== n.id).map((x) => x.name),
      coverage: { found: cov.byDefinition.get(l.definitionId)?.found ?? 0, accepted: cov.byDefinition.get(l.definitionId)?.accepted ?? 0, products: cov.products },
      survey: rankingFor(l.definition.name) && { rank: rankingFor(l.definition.name)?.rank, respondents: rankingFor(l.definition.name)?.respondentCount },
    })),
    values: values.map((v) => ({
      id: v.id, productId: v.productId, definitionId: v.definitionId, status: v.status, origin: v.origin, value: presentTyped(valueColumnsOf(v)),
      statedValue: v.statedValue, statedUnit: v.statedUnit, quote: v.evidenceQuote, sourceUrl: v.sourceUrl, confidence: v.confidence,
      unknownReason: v.unknownReason, adminAttested: v.adminAttested, attestedFetchOutcome: v.attestedFetchOutcome,
      edited: v.editedAt !== null, originalValue: v.originalValue, acceptMode: v.acceptMode,
      reviewedBy: v.reviewedBy?.username ?? null, reviewedAt: v.reviewedAt, editedBy: v.editedBy?.username ?? null, updatedAt: v.updatedAt,
    })),
    progress: {
      products: Object.fromEntries(Object.values(CatalogStatus).map((s) => [s, products.filter((p) => statusOf(p) === s).length])),
      values: { reviewed: reviewable.filter((v) => v.status !== 'PROPOSED').length, total: reviewable.length },
    },
  })
})

// ── Levers ──────────────────────────────────────────────────────────────────────────────────────────
adminRouter.post('/nodes/:id/levers', async (req: Request, res: Response) => {
  res.status(201).json(await createLever(req.params.id, parse(createLeverSchema, req.body), userId(req)))
})
adminRouter.patch('/levers/:id', async (req: Request, res: Response) => {
  res.json(await editLever(req.params.id, parse(editLeverSchema, req.body), userId(req)))
})
adminRouter.post('/levers/:id/retire', async (req: Request, res: Response) => {
  res.json(await retireLever(req.params.id, userId(req)))
})

// ── Products ────────────────────────────────────────────────────────────────────────────────────────
adminRouter.post('/products/approve', async (req: Request, res: Response) => {
  res.json(await approveProducts(parse(productDecisionSchema, req.body).productIds, userId(req)))
})
adminRouter.post('/products/reject', async (req: Request, res: Response) => {
  res.json(await rejectProducts(parse(productDecisionSchema, req.body).productIds, userId(req)))
})
adminRouter.get('/products/unplaced', async (_req: Request, res: Response) => {
  res.json(await prisma.product.findMany({ where: { nodeId: null }, orderBy: { name: 'asc' }, select: { id: true, name: true, brand: true, category: true } }))
})
adminRouter.patch('/products/:id', async (req: Request, res: Response) => {
  res.json(await placeProduct(req.params.id, parse(placeProductSchema, req.body)))
})
adminRouter.post('/products/:id/values', async (req: Request, res: Response) => {
  const v = await enterManualValue(req.params.id, req.body, userId(req))
  res.status(201).json({ id: v.id, status: v.status, adminAttested: v.adminAttested, attestedFetchOutcome: v.attestedFetchOutcome })
})

// ── Values ──────────────────────────────────────────────────────────────────────────────────────────
adminRouter.post('/values/:id/accept', async (req: Request, res: Response) => {
  const v = await acceptValue(req.params.id, userId(req), parse(decisionSchema, req.body ?? {}).seen)
  res.json({ id: v.id, status: v.status })
})
adminRouter.post('/values/:id/reject', async (req: Request, res: Response) => {
  const v = await rejectValue(req.params.id, userId(req), parse(decisionSchema, req.body ?? {}).seen)
  res.json({ id: v.id, status: v.status })
})
adminRouter.post('/values/:id/unknown', async (req: Request, res: Response) => {
  const v = await markUnknown(req.params.id, userId(req), parse(decisionSchema, req.body ?? {}).seen)
  res.json({ id: v.id, status: v.status })
})
adminRouter.patch('/values/:id', async (req: Request, res: Response) => {
  // The body is the corrected value, plus `seen` (the value's updatedAt as the screen showed it).
  const { seen, ...value } = parse(decisionSchema.passthrough(), req.body ?? {})
  const v = await editValue(req.params.id, value, userId(req), seen)
  res.json({ id: v.id, status: v.status })
})
adminRouter.post('/nodes/:id/values/bulk-accept', async (req: Request, res: Response) => {
  res.json(await bulkAccept(req.params.id, parse(bulkAcceptSchema, req.body).definitionId, userId(req)))
})

// ── Brand domains (the allow-list) ──────────────────────────────────────────────────────────────────
const brandStatusSchema = z.nativeEnum(BrandDomainStatus).optional()

adminRouter.get('/brands', async (req: Request, res: Response) => {
  const status = parse(brandStatusSchema, req.query.status)
  const rows = await prisma.brandDomain.findMany({
    where: status ? { status } : {}, orderBy: [{ status: 'asc' }, { brand: 'asc' }],
    include: { verifiedBy: { select: { username: true } } },
  })
  const waiting = await prisma.extractionItem.findMany({ where: { status: ItemStatus.WAITING }, select: { product: { select: { manufacturerUrl: true, name: true } } } })
  res.json(rows.map((b) => ({
    id: b.id, brand: b.brand, host: b.host, status: b.status, verifiedVia: b.verifiedVia, verifiedAt: b.verifiedAt,
    verifiedBy: b.verifiedBy?.username ?? null, checkResult: b.checkResult,
    waitingProducts: waiting.filter((w) => w.product.manufacturerUrl && httpsHostKey(w.product.manufacturerUrl) === b.host).map((w) => w.product.name),
  })))
})

/** One click per brand, ever: the host joins the allow-list and its waiting products are processed. */
adminRouter.post('/brands/:id/confirm', async (req: Request, res: Response) => {
  const { count } = await prisma.brandDomain.updateMany({
    where: { id: req.params.id, status: { not: BrandDomainStatus.VERIFIED } },
    data: { status: BrandDomainStatus.VERIFIED, verifiedVia: BrandVerifiedVia.ADMIN, verifiedById: userId(req), verifiedAt: new Date() },
  })
  if (count === 0) throw new AppError(409, 'Already verified (or not found)')
  const b = await prisma.brandDomain.findUniqueOrThrow({ where: { id: req.params.id } })
  // Products waiting on this domain go back to PROPOSED; their extraction re-runs every check.
  const blocked = await prisma.product.findMany({ where: { attentionCheck: 'brand_domain', catalogStatus: CatalogStatus.NEEDS_ATTENTION }, select: { id: true, manufacturerUrl: true } })
  await prisma.product.updateMany({
    where: { id: { in: blocked.filter((p) => p.manufacturerUrl && httpsHostKey(p.manufacturerUrl) === b.host).map((p) => p.id) } },
    data: { catalogStatus: CatalogStatus.PROPOSED, attentionCheck: null, attentionReason: null },
  })
  const requeued = await requeueWaitingForHost(b.host)
  res.json({ id: b.id, host: b.host, status: b.status, requeued })
})

adminRouter.post('/brands/:id/reject', async (req: Request, res: Response) => {
  if (!(await prisma.brandDomain.findUnique({ where: { id: req.params.id }, select: { id: true } }))) throw new AppError(404, 'Not found')
  const b = await prisma.brandDomain.update({ where: { id: req.params.id }, data: { status: BrandDomainStatus.REJECTED, verifiedVia: null, verifiedAt: null, verifiedById: userId(req) } })
  const waiting = await prisma.extractionItem.findMany({ where: { status: ItemStatus.WAITING }, select: { id: true, productId: true, product: { select: { manufacturerUrl: true } } } })
  const affected = waiting.filter((w) => w.product.manufacturerUrl && httpsHostKey(w.product.manufacturerUrl) === b.host)
  await prisma.extractionItem.updateMany({ where: { id: { in: affected.map((a) => a.id) } }, data: { status: ItemStatus.FAILED, error: 'brand domain rejected' } })
  await prisma.product.updateMany({ where: { id: { in: affected.map((a) => a.productId) } }, data: { attentionReason: `an admin rejected ${b.host} as the brand's domain` } })
  res.json({ id: b.id, status: b.status })
})

/** Remove a host from the allow-list: future fetches stop; values already extracted stay for review. */
adminRouter.delete('/brands/:id', async (req: Request, res: Response) => {
  await prisma.brandDomain.delete({ where: { id: req.params.id } }).catch(() => { throw new AppError(404, 'Not found') })
  res.status(204).end()
})

// ── Publish ─────────────────────────────────────────────────────────────────────────────────────────
adminRouter.post('/nodes/:id/publish', async (req: Request, res: Response) => {
  res.json(await publishNode(req.params.id, parse(publishSchema, req.body).leverIds, userId(req)))
})
adminRouter.post('/nodes/:id/unpublish', async (req: Request, res: Response) => {
  res.json(await unpublishNode(req.params.id, userId(req)))
})

// ── Survey ──────────────────────────────────────────────────────────────────────────────────────────
const filenameSchema = z.string().trim().min(1).max(200).optional()

adminRouter.post('/nodes/:id/survey', csvBody, async (req: Request, res: Response) => {
  if (typeof req.body !== 'string') throw new AppError(415, 'Send the CSV file as text/csv')
  const filename = parse(filenameSchema, req.query.filename) ?? 'survey.csv'
  res.status(201).json(await importSurvey(req.params.id, filename, req.body, userId(req)))
})

