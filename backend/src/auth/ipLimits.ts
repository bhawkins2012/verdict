// Per-IP limits on the account-email routes (docs/adr-email-verification.md D4), in addition to the global
// /api limiter. Keyed by req.ip, so TRUST_PROXY decides the client address, as for the global limiter.
// In-memory, so per process (like the global limiter); the limits that must hold across processes are
// database-backed (emailLimits.ts).
import { Response } from 'express'
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit'

const WINDOW_MS = 15 * 60 * 1000

/** One limiter per route group. VERIFY_RATE_LIMIT_MAX (default 10 per 15 min) exists mainly for tests. */
export function ipLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: Number(process.env.VERIFY_RATE_LIMIT_MAX) || 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
  })
}

/** A 429 with Retry-After, for the database-backed limits. */
export function tooManyRequests(res: Response, retryAfterSeconds: number, error: string): void {
  res.set('Retry-After', String(retryAfterSeconds))
  res.status(429).json({ error, retryAfterSeconds })
}
