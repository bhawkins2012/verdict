// Generation configuration (docs/adr-generation-run.md D5.6, Q16). Read on demand so tests can change the
// environment; startup calls loadGenerationConfig() once so a bad configuration fails fast.
import { z } from 'zod'
import { logger } from '../lib/logger'

/** Default model: the one the Claude docs recommend as the starting point (checked 2026-11-20). */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'
/** Highest max_tokens the SDK accepts for a non-streaming request (above about 21333 it requires streaming). */
export const MAX_TOKENS_LIMIT = 21000

export interface GenerationConfig {
  mode: 'dry_run' | 'live'
  model: string
  maxTokens: number
  runCapUsd: number
  dailyCapUsd: number
  minProducts: number
  apiKey: string | undefined
}

const envSchema = z.object({
  GENERATION_MODE: z.enum(['dry_run', 'live']).optional(),
  LEVER_GEN_MODE: z.enum(['dry_run', 'live']).optional(), // old name, still read for one release
  ANTHROPIC_MODEL: z.string().trim().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  GENERATION_MAX_TOKENS: z.coerce.number().int().min(1024).max(MAX_TOKENS_LIMIT, `at most ${MAX_TOKENS_LIMIT} (requests are not streamed)`).optional(),
  LEVER_GEN_MAX_TOKENS: z.coerce.number().int().min(1024).max(MAX_TOKENS_LIMIT, `at most ${MAX_TOKENS_LIMIT} (requests are not streamed)`).optional(),
  GENERATION_RUN_CAP_USD: z.coerce.number().min(0).max(1000).optional().default(10),
  GENERATION_DAILY_CAP_USD: z.coerce.number().min(0).max(10000).optional().default(40),
  GENERATION_MIN_PRODUCTS: z.coerce.number().int().min(1).max(100).optional().default(10),
})

const blankToUndefined = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v !== undefined && v.trim() === '' ? undefined : v]))

let warnedAlias = false

/** Parse and validate. Throws with a readable message (never the key) on a configuration that must not run. */
export function loadGenerationConfig(env: NodeJS.ProcessEnv = process.env): GenerationConfig {
  const parsed = envSchema.safeParse(blankToUndefined(env))
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid generation configuration: ${issues}`)
  }
  const c = parsed.data
  if (!warnedAlias && c.GENERATION_MODE === undefined && c.LEVER_GEN_MODE !== undefined) {
    warnedAlias = true
    logger.warn('LEVER_GEN_MODE is deprecated; use GENERATION_MODE (the old name is read for one release)')
  }
  const mode = c.GENERATION_MODE ?? c.LEVER_GEN_MODE ?? 'dry_run'
  if (mode === 'live' && !c.ANTHROPIC_API_KEY) {
    throw new Error('Invalid generation configuration: GENERATION_MODE=live requires ANTHROPIC_API_KEY')
  }
  return {
    mode,
    model: c.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
    maxTokens: c.GENERATION_MAX_TOKENS ?? c.LEVER_GEN_MAX_TOKENS ?? 16000,
    runCapUsd: c.GENERATION_RUN_CAP_USD,
    dailyCapUsd: c.GENERATION_DAILY_CAP_USD,
    minProducts: c.GENERATION_MIN_PRODUCTS,
    apiKey: c.ANTHROPIC_API_KEY,
  }
}
