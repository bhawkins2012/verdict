// Email addresses are trimmed and lower-cased on every write and every lookup (docs/adr-email-verification.md,
// Q6). The database enforces it too: CHECK (email = lower(btrim(email))) and a unique index on lower(email).
import { createHash } from 'crypto'
import { z } from 'zod'

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/** zod field for an email address in a request body: trimmed, lower-cased, then validated. */
export const emailField = z.string().trim().toLowerCase().email('Enter a valid email address').max(254)

/**
 * Key for per-address rate limits. A hash, so limits work for addresses that have no account and the
 * rate-limit table never stores an address in clear.
 */
export function addressKey(email: string): string {
  return createHash('sha256').update(`email-address:v1:${normalizeEmail(email)}`).digest('hex')
}

/** "a***@example.com": enough for the user to recognise their address, not enough to read it off a screen. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***${email.slice(at)}`
}
