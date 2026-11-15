import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppLayout } from './AppLayout'
import { routes } from '../../test/apiMock'
import { click, newQueryClient, render, Rendered, settle } from '../../test/render'

vi.mock('../../lib/api', () => import('../../test/apiMock'))

let view: Rendered | undefined
afterEach(() => view?.unmount())

describe('sign out', () => {
  it("clears every cached response, so the next user on this browser never sees this user's data", async () => {
    routes.clear()
    routes.set('GET /nudges', () => [])
    routes.set('POST /auth/logout', () => ({ success: true }))
    const client = newQueryClient()
    client.setQueryData(['notification-settings'], { emailNudgesEnabled: false, nudgePromptDismissedAt: '2026-11-01T00:00:00.000Z' })
    view = render(<AppLayout />, { client })
    await settle()

    const signOut = [...view.container.querySelectorAll('button')].find((b) => /Sign out/.test(b.textContent ?? ''))
    await click(signOut ?? null)
    await settle()
    expect(client.getQueryData(['notification-settings'])).toBeUndefined()
  })
})
