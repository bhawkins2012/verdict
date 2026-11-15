import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VerificationBanner } from './VerificationBanner'
import { api, routes } from '../../test/apiMock'
import { click, render, Rendered, settle } from '../../test/render'

vi.mock('../../lib/api', () => import('../../test/apiMock'))

const me = (verified: boolean) => ({
  id: 'u1', email: 'jane@example.com', username: 'jane', emailVerified: verified, emailVerifiedAt: null,
  emailVerificationSentAt: new Date(Date.now() - 5 * 60_000).toISOString(),
})
let view: Rendered | undefined
beforeEach(() => {
  routes.clear()
  vi.clearAllMocks()
})
afterEach(() => view?.unmount())

describe('verification banner (soft gate)', () => {
  it('is hidden once the address is verified', async () => {
    routes.set('GET /auth/me', () => me(true))
    view = render(<VerificationBanner />)
    await settle()
    expect(view.container.querySelector('[data-testid="verify-banner"]')).toBeNull()
  })

  it('shows the address and when the link was sent; Resend asks for a new link', async () => {
    routes.set('GET /auth/me', () => me(false))
    routes.set('POST /auth/verification/resend', () => ({ sentTo: 'j***@example.com' }))
    view = render(<VerificationBanner />)
    await settle()
    const banner = view.container.querySelector('[data-testid="verify-banner"]')
    expect(banner?.textContent).toContain('jane@example.com')
    expect(banner?.textContent).toContain('5 minutes ago')
    await click([...(banner?.querySelectorAll('button') ?? [])].find((b) => /Resend/.test(b.textContent ?? '')) ?? null)
    await settle()
    expect(api.post).toHaveBeenCalledWith('/auth/verification/resend')
    expect(view.container.textContent).toContain('New link sent to j***@example.com')
  })

  it('a 429 explains when to try again', async () => {
    routes.set('GET /auth/me', () => me(false))
    routes.set('POST /auth/verification/resend', () =>
      Object.assign(new Error('429'), { isAxiosError: true, response: { status: 429, data: { error: 'We recently sent a link to this address.', retryAfterSeconds: 1500 } } })
    )
    view = render(<VerificationBanner />)
    await settle()
    await click([...view.container.querySelectorAll('button')].find((b) => /Resend/.test(b.textContent ?? '')) ?? null)
    await settle()
    expect(view.container.textContent).toContain('We recently sent a link to this address. (try again in 25 minutes)')
  })
})
