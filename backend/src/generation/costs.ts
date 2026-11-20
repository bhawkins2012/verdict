// Cost controls (docs/adr-generation-run.md D5.6): every API call is reserved at its worst case before it
// is made, under one advisory lock, and refused if it could take the run or the rolling day over its cap.
// After the call the actual cost replaces the reservation. Dry runs cost nothing and are not capped.
import { CallStatus, Prisma, RunStage } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'

interface Price { input: number; output: number; cacheRead: number }

/** USD per million tokens, from the Claude docs pricing (checked 2026-11-20). */
export const PRICES_PER_MTOK: Readonly<Record<string, Price>> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
}
/** Web search: $10 per 1,000 searches. */
export const WEB_SEARCH_USD = 0.01

const DAY_MS = 24 * 60 * 60 * 1000
const CAP_LOCK = 'generation-cost-caps'

export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; webSearches: number }

export function priceFor(model: string): Price | null {
  return PRICES_PER_MTOK[model] ?? null
}

/** Cost in USD (6 decimals), or null for a model without a price. */
export function costUsd(model: string, usage: Usage): number | null {
  const p = priceFor(model)
  if (!p) return null
  const usd = (usage.inputTokens * p.input + usage.outputTokens * p.output + usage.cacheReadTokens * p.cacheRead) / 1_000_000
    + usage.webSearches * WEB_SEARCH_USD
  return Math.round(usd * 1e6) / 1e6
}

/** Worst case for one call: the prompt (characters ÷ 3, rounded up), plus max_tokens of output, plus searches. */
export function worstCaseUsd(model: string, promptChars: number, maxTokens: number, maxSearches = 0, extraInputTokens = 0): number | null {
  const p = priceFor(model)
  if (!p) return null
  const input = Math.ceil(promptChars / 3) + extraInputTokens
  return Math.round(((input * p.input + maxTokens * p.output) / 1_000_000 + maxSearches * WEB_SEARCH_USD) * 1e6) / 1e6
}

/** Input tokens assumed per web search result in the worst case. */
export const SEARCH_RESULT_TOKENS = 10_000

/**
 * Worst case for a call of several requests where each resends the conversation so far (discovery resumes
 * after pause_turn): request k reads the prompt plus everything earlier requests returned (their search
 * results and up to max_tokens of output each) plus its own search results, and may search again.
 */
export function worstCaseResumedUsd(model: string, promptChars: number, maxTokens: number, maxSearches: number, requests: number): number | null {
  const searchTokens = maxSearches * SEARCH_RESULT_TOKENS
  let total = 0
  for (let k = 1; k <= requests; k++) {
    const one = worstCaseUsd(model, promptChars, maxTokens, maxSearches, k * searchTokens + (k - 1) * maxTokens)
    if (one === null) return null
    total += one
  }
  return Math.round(total * 1e6) / 1e6
}

export class CapError extends Error {
  constructor(readonly cap: 'run_cap' | 'daily_cap' | 'unpriced_model', detail: string) {
    super(detail)
    this.name = 'CapError'
  }
}

/** Spend counted against caps: the actual cost once settled, else the reservation. */
async function spent(tx: Prisma.TransactionClient, where: Prisma.Sql): Promise<number> {
  const rows = await tx.$queryRaw<{ spent: Prisma.Decimal | null }[]>`
    SELECT SUM(COALESCE("costUsd", "reservedUsd")) AS spent FROM "generation_calls" WHERE ${where}`
  return Number(rows[0]?.spent ?? 0)
}

/** Reserve a call. Throws CapError (and reserves nothing) when it could exceed a cap. */
export async function reserveCall(args: {
  runId: string; stage: RunStage; productId?: string | null; model: string; reservedUsd: number | null
  runCapUsd: number; dailyCapUsd: number; now?: Date
}): Promise<string> {
  if (args.reservedUsd === null) throw new CapError('unpriced_model', `No price for model ${args.model}; caps cannot be enforced`)
  const amount = args.reservedUsd
  const now = args.now ?? new Date()
  return prisma.$transaction(async (tx) => {
    // Count and insert under one lock, so two concurrent calls at the limit cannot both pass.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CAP_LOCK}))`
    const runSpent = await spent(tx, Prisma.sql`"runId" = ${args.runId}`)
    const daySpent = await spent(tx, Prisma.sql`"createdAt" >= ${new Date(now.getTime() - DAY_MS)}`)
    if (runSpent + amount > args.runCapUsd) {
      throw new CapError('run_cap', `This call could take the run to $${(runSpent + amount).toFixed(2)}, over its cap of $${args.runCapUsd.toFixed(2)}`)
    }
    if (daySpent + amount > args.dailyCapUsd) {
      throw new CapError('daily_cap', `This call could take the last 24 hours to $${(daySpent + amount).toFixed(2)}, over the daily cap of $${args.dailyCapUsd.toFixed(2)}`)
    }
    const call = await tx.generationCall.create({
      data: { runId: args.runId, stage: args.stage, productId: args.productId ?? null, model: args.model, reservedUsd: amount, createdAt: now },
      select: { id: true },
    })
    return call.id
  }, { timeout: 15_000 })
}

/**
 * Record what a call actually used. Without usage (an API error or a timeout, which may still have been
 * billed, retries included) the cost stays null, so the reservation keeps counting against the caps.
 */
export async function settleCall(callId: string, model: string, servedModel: string | null, usage: Usage | null, error: string | null): Promise<number | null> {
  const cost = usage ? (servedModel ? costUsd(servedModel, usage) : null) ?? costUsd(model, usage) : error ? null : 0
  if (usage && cost === null) logger.warn('No price for model; call cost not recorded', { callId, model: servedModel ?? model })
  await prisma.generationCall.update({
    where: { id: callId },
    data: {
      status: error ? CallStatus.FAILED : CallStatus.DONE,
      servedModel,
      costUsd: cost,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      webSearches: usage?.webSearches ?? null,
      error,
      finishedAt: new Date(),
    },
  })
  return cost
}

/** Total spent by a run (settled costs plus open reservations). */
export async function runSpendUsd(runId: string): Promise<number> {
  return spent(prisma, Prisma.sql`"runId" = ${runId}`)
}

/**
 * Estimate for one decision node at the defaults (ADR D5.6 and section 5 A2): placement, levers, discovery
 * with up to 8 searches, and extraction of `products` products (page plus PDF text).
 */
export function estimateNodeUsd(model: string, products = 18): number | null {
  const parts = [
    costUsd(model, { inputTokens: 2_000, outputTokens: 2_000, cacheReadTokens: 0, webSearches: 0 }),
    costUsd(model, { inputTokens: 5_000, outputTokens: 10_000, cacheReadTokens: 0, webSearches: 0 }),
    costUsd(model, { inputTokens: 60_000, outputTokens: 12_000, cacheReadTokens: 0, webSearches: 8 }),
    costUsd(model, { inputTokens: 35_000 * products, outputTokens: 2_500 * products, cacheReadTokens: 0, webSearches: 0 }),
  ]
  if (parts.some((p) => p === null)) return null
  return Math.round(parts.reduce<number>((a, b) => a + (b ?? 0), 0) * 100) / 100
}
