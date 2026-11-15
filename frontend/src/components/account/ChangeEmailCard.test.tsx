import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { ChangeEmailCard } from './ChangeEmailCard'
import { api, routes } from '../../test/apiMock'
import { render, Rendered, settle } from '../../test/render'

vi.mock('../../lib/api', () => import('../../test/apiMock'))

let view: Rendered | undefined
beforeEach(() => {
  routes.clear()
  vi.clearAllMocks()
  routes.set('GET /auth/me', () => ({ id: 'u1', email: 'old@example.com', username: 'jane', emailVerified: true, emailVerifiedAt: null, emailVerificationSentAt: null }))
})
afterEach(() => view?.unmount())

async function fillAndSubmit(v: Rendered, email: string, password: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    for (const [id, value] of [['new-email', email], ['current-password', password]]) {
      const input = v.container.querySelector<HTMLInputElement>(`#${id}`)
      if (!input) throw new Error(`no #${id}`)
      setValue?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await act(async () => {
    v.container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
}

describe('change email', () => {
  it('sends the new address with the current password and says where the link went', async () => {
    routes.set('PUT /users/me/email', () => ({ email: 'new@example.com', emailVerified: false, changed: true }))
    view = render(<ChangeEmailCard />)
    await settle()
    expect(view.container.textContent).toContain('old@example.com')
    await fillAndSubmit(view, 'new@example.com', 'password123')
    expect(api.put).toHaveBeenCalledWith('/users/me/email', { email: 'new@example.com', currentPassword: 'password123' })
    expect(view.container.textContent).toContain('We sent a confirmation link to new@example.com and a notice to your previous address')
  })

  it('shows the API error (wrong password, address in use)', async () => {
    routes.set('PUT /users/me/email', () =>
      Object.assign(new Error('403'), { isAxiosError: true, response: { status: 403, data: { error: 'Current password is incorrect' } } })
    )
    view = render(<ChangeEmailCard />)
    await settle()
    await fillAndSubmit(view, 'new@example.com', 'nope')
    expect(view.container.textContent).toContain('Current password is incorrect')
  })
})
