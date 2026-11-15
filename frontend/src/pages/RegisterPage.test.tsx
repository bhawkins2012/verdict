import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { RegisterPage } from './RegisterPage'
import { api, routes } from '../test/apiMock'
import { render, Rendered, settle } from '../test/render'
import { useAuthStore } from '../store/authStore'

vi.mock('../lib/api', () => import('../test/apiMock'))

let view: Rendered | undefined
beforeEach(() => {
  routes.clear()
  vi.clearAllMocks()
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false })
})
afterEach(() => view?.unmount())

async function submit(email: string) {
  view?.unmount()
  view = render(<RegisterPage />, { path: '/register', route: '/register' })
  const inputs = view.container.querySelectorAll<HTMLInputElement>('form input')
  const values = ['Jane', email, 'jane_reviews', 'password123']
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    inputs.forEach((input, i) => {
      setValue?.call(input, values[i])
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  })
  await act(async () => {
    view?.container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
  return view.container.querySelector('[data-testid="check-email"]')?.textContent ?? null
}

describe('register', () => {
  it('shows the same "Check your email, then sign in" screen for a new and an already-registered address, and never signs in', async () => {
    // The API answers both with the same 202 body.
    routes.set('POST /auth/register', () => ({ message: 'Check your email, then sign in.' }))
    const fresh = await submit('new@example.com')
    const known = await submit('alice@example.com')

    expect(fresh).toContain('Check your email, then sign in.')
    expect(known?.replace('alice@example.com', 'X')).toBe(fresh?.replace('new@example.com', 'X'))
    expect(api.post.mock.calls.map((c) => c[0])).toEqual(['/auth/register', '/auth/register']) // no /auth/login
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })
})
