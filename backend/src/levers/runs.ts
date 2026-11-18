// Generation runs (docs/adr-levers.md D3): admin-triggered, limited per day, executed in-process after
// the response. A run's candidates are stored in the same transaction that marks it SUCCEEDED, so a crash
// never leaves half a set; a run left RUNNING is failed as "timeout" after RUN_TIMEOUT_MS.
import Anthropic from '@anthropic-ai/sdk'
import { LeverOrigin, LeverRunMode, LeverRunStatus, LeverStatus, Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'
import { CandidateSetSchema, describeIssues, normalizeName } from './candidates'
import { leverClient, PROMPT_VERSION } from './client'
import { LEVER_GEN_EFFORT, LeverConfig, loadLeverConfig } from './config'
import { dryRunCandidates } from './fixtures'
import { estimateCostUsd } from './pricing'

export const RUN_TIMEOUT_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DAILY_LIMIT_LOCK = 'lever-gen-daily-limit'

export class RunLimitError extends Error {
  constructor(public retryAt: Date | null) {
    super(retryAt ? 'Daily generation limit reached' : 'Live generation is disabled (LEVER_GEN_DAILY_LIMIT=0)')
    this.name = 'RunLimitError'
  }
}

// ── Background execution ────────────────────────────────────────────────────────────────────────────
const inFlight = new Set<Promise<unknown>>()

function inBackground(runId: string, task: () => Promise<unknown>): void {
  const p: Promise<unknown> = Promise.resolve()
    .then(task)
    .catch((err) => logger.error('Lever generation task failed', { runId, errorClass: err instanceof Error ? err.name : typeof err }))
    .finally(() => inFlight.delete(p))
  inFlight.add(p)
}

/** Tests wait for runs started after a response. */
export async function flushLeverRuns(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight])
}

/** On shutdown: give in-flight runs up to `timeoutMs` to finish (a run cut off is failed as a timeout later). */
export async function drainLeverRuns(timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), timeoutMs)))
  const done = await Promise.race([flushLeverRuns().then(() => true as const), timeout])
  clearTimeout(timer)
  return done
}

// ── Start ────────────────────────────────────────────────────────────────────────────────────────────
export async function startRun(categoryId: string, userId: string, notes: string | null): Promise<{ runId: string; mode: LeverRunMode }> {
  const config = loadLeverConfig()
  const mode = config.mode === 'live' ? LeverRunMode.LIVE : LeverRunMode.DRY_RUN
  const run = await prisma.$transaction(async (tx) => {
    const category = await tx.category.findUnique({ where: { id: categoryId }, select: { id: true, name: true, searchTerms: true } })
    if (!category) return null
    if (mode === LeverRunMode.LIVE) {
      // Count and insert under one lock, so two concurrent requests at the limit cannot both pass.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${DAILY_LIMIT_LOCK}))`
      if (config.dailyLimit === 0) throw new RunLimitError(null)
      const recent = await tx.leverCandidateRun.findMany({
        where: { mode: LeverRunMode.LIVE, createdAt: { gte: new Date(Date.now() - DAY_MS) } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      })
      if (recent.length >= config.dailyLimit) {
        throw new RunLimitError(new Date(recent[recent.length - config.dailyLimit].createdAt.getTime() + DAY_MS))
      }
    }
    return tx.leverCandidateRun.create({
      data: {
        categoryId: category.id,
        createdById: userId,
        mode,
        model: mode === LeverRunMode.LIVE ? config.model : 'dry-run',
        input: {
          promptVersion: PROMPT_VERSION,
          categoryName: category.name,
          searchTerms: category.searchTerms,
          notes,
          maxTokens: config.maxTokens,
          effort: LEVER_GEN_EFFORT,
        },
      },
      select: { id: true },
    })
  }, { timeout: 15_000 }) // waiting on the advisory lock must not hit Prisma's 5 s default
  if (!run) throw new CategoryNotFoundError()
  logger.info('Lever generation started', { runId: run.id, categoryId, mode })
  inBackground(run.id, () => executeRun(run.id, config))
  return { runId: run.id, mode }
}

export class CategoryNotFoundError extends Error {
  constructor() { super('Category not found'); this.name = 'CategoryNotFoundError' }
}

// ── Execute ──────────────────────────────────────────────────────────────────────────────────────────
interface Outcome {
  output: unknown
  stopReason: string | null
  servedModel: string | null
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null
}

async function callModel(runId: string, config: LeverConfig): Promise<Outcome | { error: string }> {
  const run = await prisma.leverCandidateRun.findUniqueOrThrow({
    where: { id: runId },
    select: { mode: true, category: { select: { slug: true, name: true, searchTerms: true } }, input: true },
  })
  if (run.mode === LeverRunMode.DRY_RUN) {
    return { output: dryRunCandidates(run.category.slug, run.category.name), stopReason: 'end_turn', servedModel: null, usage: null }
  }
  const input = run.input as Prisma.JsonObject
  const notes = typeof input.notes === 'string' ? input.notes : null
  try {
    return await leverClient().generate({ categoryName: run.category.name, searchTerms: run.category.searchTerms, notes }, config)
  } catch (err) {
    // Typed SDK errors: record the status only, never the message body (it can echo request content).
    if (err instanceof Anthropic.APIError) return { error: `api_error:${err.status ?? 'connection'}` }
    return { error: 'api_error:unknown' }
  }
}

export async function executeRun(runId: string, config: LeverConfig): Promise<void> {
  const outcome = await callModel(runId, config)
  if ('error' in outcome) return fail(runId, outcome.error, null, null)

  // The served model's price, else the requested model's (the response may name a snapshot of it).
  const usageFields = outcome.usage
    ? {
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        cacheReadTokens: outcome.usage.cacheReadTokens,
        costUsd: (outcome.servedModel ? estimateCostUsd(outcome.servedModel, outcome.usage) : null) ?? estimateCostUsd(config.model, outcome.usage),
      }
    : { costUsd: new Prisma.Decimal(0) }
  if (outcome.usage && usageFields.costUsd === null) {
    logger.warn('No price for model; run cost not recorded', { runId, model: outcome.servedModel })
  }

  if (outcome.stopReason === 'refusal') return fail(runId, 'refusal', usageFields, outcome.servedModel)
  if (outcome.stopReason === 'max_tokens') return fail(runId, 'max_tokens', usageFields, outcome.servedModel)

  const parsed = CandidateSetSchema.safeParse(outcome.output)
  if (!parsed.success) {
    logger.warn('Lever generation output failed validation', { runId, issues: describeIssues(parsed.error) })
    return fail(runId, 'validation_failed', usageFields, outcome.servedModel)
  }

  const stored = await prisma.$transaction(async (tx) => {
    // Lock the run row, so a concurrent timeout cannot commit between this check and the update.
    await tx.$queryRaw`SELECT id FROM "lever_candidate_runs" WHERE id = ${runId} FOR UPDATE`
    const run = await tx.leverCandidateRun.findUniqueOrThrow({ where: { id: runId }, select: { categoryId: true, status: true } })
    if (run.status !== LeverRunStatus.RUNNING) {
      // Already failed as a timeout: keep that status, but record what the late (billed) call used.
      await tx.leverCandidateRun.update({ where: { id: runId }, data: { servedModel: outcome.servedModel, ...usageFields } })
      return null
    }
    await tx.$queryRaw`SELECT id FROM "categories" WHERE id = ${run.categoryId} FOR UPDATE`
    const existing = await tx.valueLever.findMany({
      where: { categoryId: run.categoryId, status: { not: LeverStatus.RETIRED } },
      select: { name: true },
    })
    const taken = new Set(existing.map((l) => normalizeName(l.name)))
    const fresh = parsed.data.candidates.filter((c) => !taken.has(normalizeName(c.name)))
    await tx.valueLever.createMany({
      data: fresh.map((c) => ({
        categoryId: run.categoryId,
        name: c.name,
        type: c.type,
        unit: c.unit,
        explanation: c.explanation,
        relatedNeeds: c.relatedNeeds,
        origin: LeverOrigin.GENERATED,
        runId,
      })),
    })
    await tx.leverCandidateRun.update({
      where: { id: runId },
      data: {
        status: LeverRunStatus.SUCCEEDED,
        output: { candidates: parsed.data.candidates, skippedExistingNames: parsed.data.candidates.length - fresh.length },
        servedModel: outcome.servedModel,
        finishedAt: new Date(),
        ...usageFields,
      },
    })
    return fresh.length
  })
  logger.info('Lever generation finished', {
    runId, status: stored === null ? 'already-failed' : 'succeeded', stored,
    model: outcome.servedModel ?? 'dry-run', inputTokens: usageFields.inputTokens, outputTokens: usageFields.outputTokens,
    costUsd: usageFields.costUsd?.toString() ?? null,
  })
}

async function fail(
  runId: string,
  error: string,
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd: Prisma.Decimal | null } | null,
  servedModel: string | null
): Promise<void> {
  const { count } = await prisma.leverCandidateRun.updateMany({
    where: { id: runId, status: LeverRunStatus.RUNNING },
    data: { status: LeverRunStatus.FAILED, error, servedModel, finishedAt: new Date(), ...(usage ?? {}) },
  })
  // Already failed as a timeout: keep that error, but still record the usage of the late call.
  if (count === 0 && usage) await prisma.leverCandidateRun.update({ where: { id: runId }, data: { servedModel, ...usage } })
  logger.warn('Lever generation failed', {
    runId, error, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, costUsd: usage?.costUsd?.toString() ?? null,
  })
}

/** Fail runs still RUNNING after RUN_TIMEOUT_MS (a crash or restart mid-run). Called at startup and on reads. */
export async function expireStaleRuns(now = new Date()): Promise<number> {
  const { count } = await prisma.leverCandidateRun.updateMany({
    where: { status: LeverRunStatus.RUNNING, createdAt: { lt: new Date(now.getTime() - RUN_TIMEOUT_MS) } },
    data: { status: LeverRunStatus.FAILED, error: 'timeout', finishedAt: now },
  })
  if (count > 0) logger.warn('Stale lever generation runs failed', { count })
  return count
}
