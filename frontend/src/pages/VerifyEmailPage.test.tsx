import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VerifyEmailPage } from './VerifyEmailPage'
import { api, routes } from '../test/apiMock'
import { click, render, Rendered, settle } from '../test/render'
import { useAuthStore } from '../store/authStore'

vi.mock('../lib/api', () => import('../test/apiMock'))

const TOKEN = 'a'.repeat(43)
let view: Rendered | undefined
beforeEach(() => {
  routes.clear()
  vi.clearAllMocks()
  useAuthStore.setState({ isAuthenticated: false })
})
afterEach(() => view?.unmount())

const open = async (hash: string) => {
  view = render(<VerifyEmailPage />, { route: '/verify-email', path: `/verify-email${hash}` })
  await settle()
  return view
}
const button = (v: Rendered, text: RegExp) => [...v.container.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) ?? null

describe('verify email page', () => {
  it('opening the link does nothing; the Confirm button POSTs the id and token from the fragment', async () => {
    routes.set('POST /auth/verify-email', () => ({ verified: true }))
    const v = await open(`#id=tok1&t=${TOKEN}`)
    expect(api.post).not.toHaveBeenCalled() // mail scanners that load the page cannot use the link
    await click(button(v, /^Confirm$/))
    await settle()
    expect(api.post).toHaveBeenCalledWith('/auth/verify-email', { id: 'tok1', token: TOKEN })
    expect(v.container.textContent).toContain('Email verified')
  })

  it('a bad link shows the error; signed-out users are told to sign in, signed-in users can get a new link', async () => {
    routes.set('POST /auth/verify-email', () => Object.assign(new Error('400'), { isAxiosError: true, response: { status: 400, data: { error: 'This link is invalid or has expired.' } } }))
    let v = await open(`#id=tok1&t=${TOKEN}`)
    await click(button(v, /^Confirm$/))
    await settle()
    expect(v.container.textContent).toContain('This link is invalid or has expired.')
    expect(v.container.textContent).toContain('to request a new link')
    expect(button(v, /Send a new link/)).toBeNull()
    v.unmount()

    useAuthStore.setState({ isAuthenticated: true })
    routes.set('POST /auth/verification/resend', () => ({ sentTo: 'a***@example.com' }))
    v = await open(`#id=tok1&t=${TOKEN}`)
    view = v
    await click(button(v, /^Confirm$/))
    await settle()
    await click(button(v, /Send a new link/))
    await settle()
    expect(v.container.textContent).toContain('Sent to a***@example.com')
  })

  it('an incomplete link says so and offers no button', async () => {
    const v = await open('')
    expect(v.container.textContent).toContain('This link is incomplete')
    expect(button(v, /^Confirm$/)).toBeNull()
  })
})
