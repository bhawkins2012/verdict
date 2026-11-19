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

describe('phone menu', () => {
  it('the Menu button opens the sidebar panel; choosing a link closes it', async () => {
    routes.clear()
    routes.set('GET /nudges', () => [])
    view = render(<AppLayout />, { route: '*' }) // stays mounted when a nav link changes the URL
    await settle()
    const button = view.container.querySelector<HTMLButtonElement>('button[aria-controls="app-sidebar"]')
    const aside = view.container.querySelector('#app-sidebar')
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    expect(aside?.className).toContain('invisible') // closed: hidden on phones and out of the tab order
    await click(button)
    expect(button?.getAttribute('aria-expanded')).toBe('true')
    expect(aside?.className).toContain('visible')
    expect(aside?.className).not.toMatch(/(^| )invisible/)
    await click(aside?.querySelector('a[href="/discover"]') ?? null)
    expect(button?.getAttribute('aria-expanded')).toBe('false')
  })
})
