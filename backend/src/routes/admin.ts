// Admin routes for categories, lever generation, approval and lever values (docs/adr-levers.md).
// Every route: authenticate + requireAdmin (role read from the database per request).
import express, { Router, Request, Response } from 'express'
import { z } from 'zod'
import { LeverStatus, Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'
import { requireAdmin } from '../middleware/requireAdmin'
import { AppError } from '../middleware/errorHandler'
import { normalizeName } from '../levers/candidates'
import { loadLeverConfig } from '../levers/config'
import {
  createCategorySchema, createLever, createLeverSchema, editLever, editLeverSchema, publishLeverSet, publishSchema,
  retireLever, slugFromName,
} from '../levers/levers'
import { importLeverValues, importSurvey, setLeverValue } from '../levers/imports'
import { CategoryNotFoundError, expireStaleRuns, RunLimitError, startRun } from '../levers/runs'
import { leverValueInputSchema, presentValue } from '../levers/values'

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

const RUN_SELECT = {
  id: true, mode: true, status: true, model: true, servedModel: true, error: true, inputTokens: true, outputTokens: true,
  cacheReadTokens: true, costUsd: true, createdAt: true, finishedAt: true, input: true,
  createdBy: { select: { username: true } },
  _count: { select: { levers: true } },
} satisfies Prisma.LeverCandidateRunSelect

type RunRow = Prisma.LeverCandidateRunGetPayload<{ select: typeof RUN_SELECT }>
const presentRun = (r: RunRow) => ({
  id: r.id, mode: r.mode, status: r.status, model: r.model, servedModel: r.servedModel, error: r.error,
  inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens,
  costUsd: r.costUsd === null ? null : r.costUsd.toString(), createdAt: r.createdAt, finishedAt: r.finishedAt,
  createdBy: r.createdBy?.username ?? null, candidatesStored: r._count.levers, input: r.input,
})

// ── Config (what the admin screen needs to know) ─────────────────────────────────────────────────────
adminRouter.get('/config', (_req: Request, res: Response) => {
  const c = loadLeverConfig()
  res.json({ mode: c.mode, model: c.mode === 'live' ? c.model : 'dry-run', dailyLimit: c.dailyLimit, maxTokens: c.maxTokens })
})

// ── Categories ───────────────────────────────────────────────────────────────────────────────────────
adminRouter.get('/categories', async (_req: Request, res: Response) => {
  const categories = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true, slug: true, name: true, searchTerms: true, leversPublishedAt: true,
      _count: { select: { products: true } },
      levers: { where: { status: { not: LeverStatus.RETIRED } }, select: { status: true } },
    },
  })
  res.json(categories.map((c) => ({
    id: c.id, slug: c.slug, name: c.name, searchTerms: c.searchTerms, leversPublishedAt: c.leversPublishedAt,
    productCount: c._count.products,
    approvedCount: c.levers.filter((l) => l.status === LeverStatus.APPROVED).length,
    candidateCount: c.levers.filter((l) => l.status === LeverStatus.CANDIDATE).length,
  })))
})

adminRouter.post('/categories', async (req: Request, res: Response) => {
  const body = parse(createCategorySchema, req.body)
  const slug = body.slug ?? slugFromName(body.name)
  if (slug.length < 2) throw new AppError(400, 'slug: could not derive a slug from the name; give one')
  const exists = await prisma.category.findUnique({ where: { slug }, select: { id: true } })
  if (exists) throw new AppError(409, `A category with slug "${slug}" already exists`)
  const category = await prisma.category.create({
    data: { slug, name: body.name, searchTerms: body.searchTerms ?? [], createdById: userId(req) },
  })
  res.status(201).json(category)
})

adminRouter.get('/categories/:id', async (req: Request, res: Response) => {
  await expireStaleRuns()
  const category = await prisma.category.findUnique({
    where: { id: req.params.id },
    include: {
      leversPublishedBy: { select: { username: true } },
      levers: {
        orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
        include: {
          approvedBy: { select: { username: true } },
          editedBy: { select: { username: true } },
          _count: { select: { values: true } },
        },
      },
      runs: { orderBy: { createdAt: 'desc' }, take: 10, select: RUN_SELECT },
      surveyImports: { orderBy: { uploadedAt: 'desc' }, take: 1, include: { rankings: { orderBy: { rank: 'asc' } }, uploadedBy: { select: { username: true } } } },
      products: { orderBy: { name: 'asc' }, select: { id: true, name: true, brand: true, _count: { select: { leverValues: true } } } },
    },
  })
  if (!category) throw new AppError(404, 'Category not found')

  // Survey rows matched to non-retired levers by normalized name; unmatched rows listed separately.
  const survey = category.surveyImports[0] ?? null
  const live = category.levers.filter((l) => l.status !== LeverStatus.RETIRED)
  const leverKeys = new Set(live.map((l) => normalizeName(l.name)))
  const rankingFor = (name: string) => survey?.rankings.find((r) => normalizeName(r.leverName) === normalizeName(name)) ?? null

  res.json({
    id: category.id, slug: category.slug, name: category.name, searchTerms: category.searchTerms,
    leversPublishedAt: category.leversPublishedAt, leversPublishedBy: category.leversPublishedBy?.username ?? null,
    levers: category.levers.map((l) => ({
      id: l.id, name: l.name, type: l.type, inputFormat: l.inputFormat, unit: l.unit, explanation: l.explanation,
      relatedNeeds: l.relatedNeeds, allowedValues: l.allowedValues, status: l.status, position: l.position,
      origin: l.origin, runId: l.runId, approvedBy: l.approvedBy?.username ?? null, approvedAt: l.approvedAt,
      editedBy: l.editedBy?.username ?? null, editedAt: l.editedAt, valueCount: l._count.values,
      survey: rankingFor(l.name) ? { rank: rankingFor(l.name)?.rank, respondents: rankingFor(l.name)?.respondentCount } : null,
    })),
    runs: category.runs.map(presentRun),
    survey: survey && {
      id: survey.id, filename: survey.filename, uploadedAt: survey.uploadedAt, uploadedBy: survey.uploadedBy?.username ?? null,
      rowCount: survey.rowCount,
      unmatched: survey.rankings.filter((r) => !leverKeys.has(normalizeName(r.leverName)))
        .map((r) => ({ lever: r.leverName, rank: r.rank, respondents: r.respondentCount })),
    },
    products: category.products.map((p) => ({ id: p.id, name: p.name, brand: p.brand, valueCount: p._count.leverValues })),
  })
})

// ── Generation runs ──────────────────────────────────────────────────────────────────────────────────
const runSchema = z.object({ notes: z.string().trim().max(1000).optional() }).strict()

adminRouter.post('/categories/:id/runs', async (req: Request, res: Response) => {
  const body = parse(runSchema, req.body ?? {})
  try {
    const run = await startRun(req.params.id, userId(req), body.notes || null)
    res.status(202).json(run)
  } catch (err) {
    if (err instanceof CategoryNotFoundError) throw new AppError(404, 'Category not found')
    if (err instanceof RunLimitError) {
      throw new AppError(429, err.retryAt ? `Daily generation limit reached; next run allowed at ${err.retryAt.toISOString()}` : err.message, {
        retryAt: err.retryAt?.toISOString() ?? null,
      })
    }
    throw err
  }
})

adminRouter.get('/runs/:id', async (req: Request, res: Response) => {
  await expireStaleRuns()
  const run = await prisma.leverCandidateRun.findUnique({ where: { id: req.params.id }, select: { ...RUN_SELECT, categoryId: true } })
  if (!run) throw new AppError(404, 'Run not found')
  res.json({ ...presentRun(run), categoryId: run.categoryId })
})

// ── Levers ───────────────────────────────────────────────────────────────────────────────────────────
adminRouter.post('/categories/:id/levers', async (req: Request, res: Response) => {
  const body = parse(createLeverSchema, req.body)
  res.status(201).json(await createLever(req.params.id, body, userId(req)))
})

adminRouter.patch('/levers/:id', async (req: Request, res: Response) => {
  const body = parse(editLeverSchema, req.body)
  res.json(await editLever(req.params.id, body, userId(req)))
})

adminRouter.post('/levers/:id/retire', async (req: Request, res: Response) => {
  res.json(await retireLever(req.params.id, userId(req)))
})

adminRouter.post('/categories/:id/publish', async (req: Request, res: Response) => {
  const body = parse(publishSchema, req.body)
  res.json({ levers: await publishLeverSet(req.params.id, body.leverIds, userId(req)) })
})

// ── Survey ───────────────────────────────────────────────────────────────────────────────────────────
const filenameSchema = z.string().trim().min(1).max(200).optional()

adminRouter.post('/categories/:id/survey', csvBody, async (req: Request, res: Response) => {
  if (typeof req.body !== 'string') throw new AppError(415, 'Send the CSV file as text/csv')
  const filename = parse(filenameSchema, req.query.filename) ?? 'survey.csv'
  res.status(201).json(await importSurvey(req.params.id, filename, req.body, userId(req)))
})

// ── Lever values ─────────────────────────────────────────────────────────────────────────────────────
adminRouter.get('/products/:id/levers', async (req: Request, res: Response) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, brand: true, categoryId: true, categoryRef: { select: { id: true, name: true, slug: true } } },
  })
  if (!product) throw new AppError(404, 'Product not found')
  const levers = product.categoryId
    ? await prisma.valueLever.findMany({
        where: { categoryId: product.categoryId, status: LeverStatus.APPROVED },
        orderBy: { position: 'asc' },
        include: { values: { where: { productId: product.id }, include: { recordedBy: { select: { username: true } } } } },
      })
    : []
  res.json({
    product: { id: product.id, name: product.name, brand: product.brand, category: product.categoryRef },
    levers: levers.map((l) => ({
      id: l.id, name: l.name, type: l.type, inputFormat: l.inputFormat, unit: l.unit, allowedValues: l.allowedValues,
      explanation: l.explanation, position: l.position,
      value: l.values[0] ? { ...presentValue(l.values[0]), recordedBy: l.values[0].recordedBy?.username ?? null } : null,
    })),
  })
})

adminRouter.put('/products/:productId/levers/:leverId', async (req: Request, res: Response) => {
  const body = parse(leverValueInputSchema, req.body)
  const v = await setLeverValue(req.params.productId, req.params.leverId, body, userId(req))
  res.json(presentValue(v))
})

adminRouter.post('/categories/:id/lever-values/import', csvBody, async (req: Request, res: Response) => {
  if (typeof req.body !== 'string') throw new AppError(415, 'Send the CSV file as text/csv')
  const dryRun = req.query.dryRun === 'true'
  res.json(await importLeverValues(req.params.id, req.body, userId(req), dryRun))
})
