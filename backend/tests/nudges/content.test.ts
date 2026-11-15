import { renderNudgeEmail } from '../../src/nudges/email'
import { signUnsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from '../../src/nudges/unsubscribe'

const SECRET = 'test-unsubscribe-secret-0123456789-abcdefghij'

describe('unsubscribe tokens', () => {
  const token = signUnsubscribeToken(SECRET, 'user-1')

  it('verify for the user they were made for', () => {
    expect(verifyUnsubscribeToken(SECRET, 'user-1', token)).toBe(true)
  })

  it.each([
    ['another user', 'user-2', token, SECRET],
    ['a tampered token', 'user-1', token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA'), SECRET],
    ['a truncated token', 'user-1', token.slice(0, 10), SECRET],
    ['an empty token', 'user-1', '', SECRET],
    ['a missing token', 'user-1', undefined, SECRET],
    ['a non-string user', ['user-1'], token, SECRET],
    ['a different secret (rotated)', 'user-1', token, SECRET + 'x'],
  ])('reject %s', (_name, user, tok, secret) => {
    expect(verifyUnsubscribeToken(secret, user, tok)).toBe(false)
  })

  it('bind the purpose: an HMAC of the bare user id is not accepted', () => {
    const { createHmac } = jest.requireActual<typeof import('crypto')>('crypto')
    const bare = createHmac('sha256', SECRET).update('user-1').digest('base64url')
    expect(verifyUnsubscribeToken(SECRET, 'user-1', bare)).toBe(false)
  })

  it('build a URL carrying the user and token', () => {
    const url = new URL(unsubscribeUrl('http://app.test', SECRET, 'user-1'))
    expect(url.pathname).toBe('/api/nudges/unsubscribe')
    expect(verifyUnsubscribeToken(SECRET, url.searchParams.get('u'), url.searchParams.get('t'))).toBe(true)
  })
})

describe('nudge email', () => {
  const email = renderNudgeEmail(
    {
      nudgeId: 'n1', stage: 'TWO_WEEKS', productId: 'p1', productName: 'Kettle <script>alert(1)</script>\r\nBcc: x@evil.test',
      userId: 'u1', to: 'u@example.com', displayName: 'Ann & "Bo"', fromPurchase: true,
    },
    { frontendUrl: 'http://app.test', fromEmail: 'Verdict <r@verdict.test>', unsubscribeSecret: SECRET, postalAddress: '1 Test St' }
  )

  it('deep-links to the review form for the stage and nudge', () => {
    expect(email.text).toContain('http://app.test/products/p1/review?stage=TWO_WEEKS&nudgeId=n1')
  })

  it('has the unsubscribe link, one-click headers, and the postal address in the footer', () => {
    const unsub = unsubscribeUrl('http://app.test', SECRET, 'u1')
    expect(email.text).toContain(unsub)
    expect(email.headers['List-Unsubscribe']).toBe(`<${unsub}>`)
    expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(email.text).toContain('1 Test St')
    expect(email.html).toContain('1 Test St')
  })

  it('escapes user-supplied values in HTML and keeps newlines out of the subject', () => {
    expect(email.html).not.toContain('<script>')
    expect(email.html).toContain('&lt;script&gt;')
    expect(email.html).toContain('Ann &amp; &quot;Bo&quot;')
    expect(email.subject).not.toMatch(/[\r\n]/)
  })

  it('has no images or tracking pixels, and a stable idempotency key per nudge', () => {
    expect(email.html).not.toMatch(/<img/i)
    expect(email.idempotencyKey).toBe('nudge/n1')
  })
})
