// Email verification tokens (docs/adr-email-verification.md D1).
//
// The link carries a selector (the row id, not secret) and a verifier (32 random bytes, base64url). Only
// sha256(verifier) is stored. Checking looks the row up by selector and compares hashes in constant time.
// Tokens expire after 24 h, work once, and issuing a new one supersedes every older open token for the
// user. A token verifies only the address it was issued for.
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'

type Tx = Prisma.TransactionClient

/** The user's address changed after the caller read it; no token was issued. */
export class AddressChangedError extends Error {
  constructor() {
    super('The email address changed; no link was issued')
    this.name = 'AddressChangedError'
  }
}

/**
 * Lock the user row and return its current email. Every transaction that touches a user's tokens takes
 * this lock first (issue, consume, email change), so they serialize per user in one order: no deadlock
 * between "verify" and "change email", and no token issued for an address that just changed.
 */
async function lockUserEmail(tx: Tx, userId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ email: string }[]>`SELECT "email" FROM "users" WHERE "id" = ${userId} FOR UPDATE`
  return rows[0]?.email ?? null
}

export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/** base64url of 32 bytes is 43 characters. */
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/

function hashVerifier(verifier: string): Buffer {
  return createHash('sha256').update(verifier).digest()
}

export interface IssuedToken {
  id: string
  verifier: string
  createdAt: Date
  expiresAt: Date
}

/**
 * Issue a token for `email` and supersede the user's older open tokens. Call inside a transaction.
 * Throws AddressChangedError if `email` is no longer the user's address.
 */
export async function issueVerificationToken(tx: Tx, userId: string, email: string, now: Date): Promise<IssuedToken> {
  if ((await lockUserEmail(tx, userId)) !== email) throw new AddressChangedError()
  await tx.emailVerificationToken.updateMany({
    where: { userId, usedAt: null, supersededAt: null },
    data: { supersededAt: now },
  })
  const verifier = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS)
  const row = await tx.emailVerificationToken.create({
    data: { userId, email, tokenHash: hashVerifier(verifier).toString('hex'), createdAt: now, expiresAt },
    select: { id: true },
  })
  return { id: row.id, verifier, createdAt: now, expiresAt }
}

/** Supersede every open token for the user (email change). */
export async function supersedeTokens(tx: Tx, userId: string, now: Date): Promise<void> {
  await tx.emailVerificationToken.updateMany({ where: { userId, usedAt: null, supersededAt: null }, data: { supersededAt: now } })
}

export type InvalidReason = 'malformed' | 'unknown' | 'mismatch' | 'used' | 'superseded' | 'expired' | 'email-changed'
export type VerifyResult = { ok: true; userId: string } | { ok: false; reason: InvalidReason }

/**
 * Check and consume a token. Every failure is reported to the caller the same way (the API answers one
 * generic message); `reason` is for logs only.
 */
export async function consumeVerificationToken(db: PrismaClient, id: unknown, verifier: unknown, now: Date): Promise<VerifyResult> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64 || typeof verifier !== 'string' || !VERIFIER_PATTERN.test(verifier)) {
    return { ok: false, reason: 'malformed' }
  }
  return db.$transaction(async (tx) => {
    const row = await tx.emailVerificationToken.findUnique({ where: { id } })
    if (!row) return { ok: false, reason: 'unknown' } as const
    const currentEmail = await lockUserEmail(tx, row.userId) // user row first, like issue and email change

    const expected = Buffer.from(row.tokenHash, 'hex')
    const given = hashVerifier(verifier)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'mismatch' } as const
    if (row.usedAt) return { ok: false, reason: 'used' } as const
    if (row.supersededAt) return { ok: false, reason: 'superseded' } as const
    if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' } as const
    if (row.email !== currentEmail) return { ok: false, reason: 'email-changed' } as const

    // Consume atomically: of two concurrent confirmations exactly one gets count 1. An email change that
    // commits first supersedes the token, so this fails too.
    const claimed = await tx.emailVerificationToken.updateMany({
      where: { id, usedAt: null, supersededAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    })
    if (claimed.count === 0) return { ok: false, reason: 'used' } as const

    await tx.user.update({ where: { id: row.userId }, data: { emailVerified: true, emailVerifiedAt: now } })
    await supersedeTokens(tx, row.userId, now)
    return { ok: true, userId: row.userId } as const
  })
}

/** The path and fragment of a verification link (the token is in the fragment: never sent to servers). */
export function verificationLink(frontendUrl: string, token: Pick<IssuedToken, 'id' | 'verifier'>): string {
  const fragment = new URLSearchParams({ id: token.id, t: token.verifier })
  return `${frontendUrl}/verify-email#${fragment.toString()}`
}
