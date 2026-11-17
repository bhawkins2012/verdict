// Nudge configuration from environment variables (docs/adr-nudges.md D9). Read on demand so tests can
// change the environment; startup calls loadNudgeConfig() once so a bad configuration fails fast.
import { z } from 'zod'
import { logger } from '../lib/logger'
import { resolveFrontendUrl } from '../lib/frontendUrl'

export type ProviderName = 'console' | 'resend'

export interface NudgeConfig {
  provider: ProviderName
  resendApiKey: string | undefined
  fromEmail: string
  unsubscribeSecret: string
  dailyCap: number
  maxAttempts: number
  requireVerifiedEmail: boolean
  postalAddress: string
  enabled: boolean
  frontendUrl: string
}

const DEV_UNSUBSCRIBE_SECRET = 'dev-only-unsubscribe-secret-change-me-0123456789'
const POSTAL_PLACEHOLDER = '[Postal address not configured: set NUDGE_POSTAL_ADDRESS]'

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback
      const s = v.trim().toLowerCase()
      if (['true', '1', 'yes'].includes(s)) return true
      if (['false', '0', 'no'].includes(s)) return false
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected true or false, got "${v}"` })
      return z.NEVER
    })

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  NUDGE_EMAIL_PROVIDER: z.enum(['console', 'resend']).optional().default('console'),
  RESEND_API_KEY: z.string().trim().min(1).optional(),
  NUDGE_FROM_EMAIL: z.string().trim().min(3).optional(),
  UNSUBSCRIBE_SECRET: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  JWT_REFRESH_SECRET: z.string().optional(),
  NUDGE_DAILY_CAP: z.coerce.number().int().min(1).optional().default(1),
  NUDGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).optional().default(5),
  NUDGE_REQUIRE_VERIFIED_EMAIL: bool(true),
  NUDGE_POSTAL_ADDRESS: z.string().trim().min(1).optional(),
  NUDGES_ENABLED: bool(true),
  FRONTEND_URL: z.string().trim().url().optional(),
})

let warnedDevSecret = false

/** Parse and validate. Throws with a readable message on a configuration that must not run. */
export function loadNudgeConfig(env: NodeJS.ProcessEnv = process.env): NudgeConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid nudge configuration: ${issues}`)
  }
  const e = parsed.data
  const production = e.NODE_ENV === 'production'

  let unsubscribeSecret = e.UNSUBSCRIBE_SECRET?.trim() ?? ''
  if (unsubscribeSecret.length < 32) {
    if (production) throw new Error('UNSUBSCRIBE_SECRET must be set (at least 32 characters) in production')
    if (!warnedDevSecret && e.NODE_ENV !== 'test') {
      logger.warn('UNSUBSCRIBE_SECRET is not set; using a fixed development value. Never do this in production.')
      warnedDevSecret = true
    }
    unsubscribeSecret = DEV_UNSUBSCRIBE_SECRET
  }
  if (unsubscribeSecret === e.JWT_SECRET || unsubscribeSecret === e.JWT_REFRESH_SECRET) {
    throw new Error('UNSUBSCRIBE_SECRET must be different from the JWT secrets')
  }

  if (e.NUDGE_EMAIL_PROVIDER === 'resend') {
    const missing = [
      !e.RESEND_API_KEY && 'RESEND_API_KEY',
      !e.NUDGE_FROM_EMAIL && 'NUDGE_FROM_EMAIL',
      !e.NUDGE_POSTAL_ADDRESS && 'NUDGE_POSTAL_ADDRESS',
    ].filter(Boolean)
    if (missing.length > 0) {
      throw new Error(`NUDGE_EMAIL_PROVIDER=resend requires ${missing.join(', ')}`)
    }
  }

  return {
    provider: e.NUDGE_EMAIL_PROVIDER,
    resendApiKey: e.RESEND_API_KEY,
    fromEmail: e.NUDGE_FROM_EMAIL ?? 'Verdict <reminders@verdict.invalid>',
    unsubscribeSecret,
    dailyCap: e.NUDGE_DAILY_CAP,
    maxAttempts: e.NUDGE_MAX_ATTEMPTS,
    requireVerifiedEmail: e.NUDGE_REQUIRE_VERIFIED_EMAIL,
    postalAddress: e.NUDGE_POSTAL_ADDRESS ?? POSTAL_PLACEHOLDER,
    enabled: e.NUDGES_ENABLED,
    // Codespaces-aware (lib/frontendUrl.ts): the same value app.ts uses for CORS.
    frontendUrl: resolveFrontendUrl(env).url,
  }
}
