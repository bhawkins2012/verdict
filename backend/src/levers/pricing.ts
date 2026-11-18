// USD per million tokens, from the Claude docs pricing (checked 2026-11-18). Used only to log and store an
// estimated cost per generation run; a model not listed here gets a null cost and a warning.
import { Prisma } from '@prisma/client'

interface Price { input: number; output: number; cacheRead: number }

export const PRICES_PER_MTOK: Readonly<Record<string, Price>> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
}

export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number }

/** Estimated cost in USD (6 decimal places), or null for a model without a price. */
export function estimateCostUsd(model: string, usage: Usage): Prisma.Decimal | null {
  const price = PRICES_PER_MTOK[model]
  if (!price) return null
  const usd = (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * price.cacheRead) / 1_000_000
  return new Prisma.Decimal(usd.toFixed(6))
}
