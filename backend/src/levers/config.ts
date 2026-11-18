// Lever generation configuration (docs/adr-levers.md D3). Read on demand so tests can change the
// environment; startup calls loadLeverConfig() once so a bad configuration fails fast.
import { z } from 'zod'

/** Default model: the one the Claude docs recommend as the starting point (checked 2026-11-18). */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'
/** Effort for generation runs (ADR Q8: high). */
export const LEVER_GEN_EFFORT = 'high' as const
/** Highest max_tokens the SDK accepts for a non-streaming request (above about 21333 it requires streaming). */
export const MAX_TOKENS_LIMIT = 21000

export interface LeverConfig {
  mode: 'dry_run' | 'live'
  model: string
  maxTokens: number
  dailyLimit: number
  apiKey: string | undefined
}

const envSchema = z.object({
  LEVER_GEN_MODE: z.enum(['dry_run', 'live']).optional().default('dry_run'),
  ANTHROPIC_MODEL: z.string().trim().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  // At most 21000: the SDK refuses non-streaming requests whose max_tokens could take longer than 10 minutes.
  LEVER_GEN_MAX_TOKENS: z.coerce.number().int().min(1024).max(MAX_TOKENS_LIMIT, `at most ${MAX_TOKENS_LIMIT} (the request is not streamed)`).optional().default(16000),
  LEVER_GEN_DAILY_LIMIT: z.coerce.number().int().min(0).max(1000).optional().default(10),
})

const blankToUndefined = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v !== undefined && v.trim() === '' ? undefined : v]))

/** Parse and validate. Throws with a readable message (never the key) on a configuration that must not run. */
export function loadLeverConfig(env: NodeJS.ProcessEnv = process.env): LeverConfig {
  const parsed = envSchema.safeParse(blankToUndefined(env))
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid lever generation configuration: ${issues}`)
  }
  const c = parsed.data
  if (c.LEVER_GEN_MODE === 'live' && !c.ANTHROPIC_API_KEY) {
    throw new Error('Invalid lever generation configuration: LEVER_GEN_MODE=live requires ANTHROPIC_API_KEY')
  }
  return {
    mode: c.LEVER_GEN_MODE,
    model: c.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
    maxTokens: c.LEVER_GEN_MAX_TOKENS,
    dailyLimit: c.LEVER_GEN_DAILY_LIMIT,
    apiKey: c.ANTHROPIC_API_KEY,
  }
}
