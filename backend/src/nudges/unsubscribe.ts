// Signed unsubscribe links that work without login (docs/adr-nudges.md D5).
// token = base64url(HMAC-SHA256(UNSUBSCRIBE_SECRET, "unsubscribe:v1:" + userId)).
// It binds the user and the purpose, has no expiry (old emails must keep working), and is compared in
// constant time. Rotating UNSUBSCRIBE_SECRET revokes every outstanding link.
import { createHmac, timingSafeEqual } from 'crypto'

const PURPOSE = 'unsubscribe:v1:'

function digest(secret: string, userId: string): Buffer {
  return createHmac('sha256', secret).update(PURPOSE + userId).digest()
}

export function signUnsubscribeToken(secret: string, userId: string): string {
  return digest(secret, userId).toString('base64url')
}

export function verifyUnsubscribeToken(secret: string, userId: unknown, token: unknown): boolean {
  if (typeof userId !== 'string' || typeof token !== 'string' || userId.length === 0 || token.length === 0) return false
  const expected = digest(secret, userId)
  let given: Buffer
  try {
    given = Buffer.from(token, 'base64url')
  } catch {
    return false
  }
  // timingSafeEqual needs equal lengths; a wrong length is simply invalid.
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export function unsubscribeUrl(frontendUrl: string, secret: string, userId: string): string {
  const params = new URLSearchParams({ u: userId, t: signUnsubscribeToken(secret, userId) })
  return `${frontendUrl}/api/nudges/unsubscribe?${params.toString()}`
}
