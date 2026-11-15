import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckinOptInPrompt } from './CheckinOptInPrompt'
import { EmailRemindersCard } from './EmailRemindersCard'
import { api, routes } from '../../test/apiMock'
import { click, newQueryClient, render, Rendered, settle } from '../../test/render'
import type { StageConfig } from '../../lib/stages'

vi.mock('../../lib/api', () => import('../../test/apiMock'))

const config = (cadence: StageConfig['nudgeCadence'], consentCopy: string): StageConfig => ({
  stages: [{ stage: 'INITIAL', label: 'first impression' }, ...cadence.map((c) => ({ stage: c.stage, label: c.label }))],
  nudgeCadence: cadence,
  consentCopy,
})
const CURRENT = config(
  [
    { stage: 'TWO_WEEKS', label: '2 weeks', offset: { days: 14 } },
    { stage: 'THREE_MONTHS', label: '3 months', offset: { months: 3 } },
    { stage: 'ONE_YEAR', label: '1 year', offset: { months: 12 } },
    { stage: 'TWO_YEARS', label: '2 years', offset: { months: 24 } },
  ],
  'Email me check-ins at 2 weeks, 3 months, 1 year, and 2 years.'
)
const settings = (on: boolean, dismissedAt: string | null = null, firstEnabledAt: string | null = on ? '2026-11-01T00:00:00.000Z' : null) => ({
  emailNudgesEnabled: on, emailNudgesConsentAt: null, timezone: 'UTC', nudgeSendHour: 9, emailVerified: false,
  nudgePromptDismissedAt: dismissedAt, emailNudgesFirstEnabledAt: firstEnabledAt,
})

let view: Rendered | undefined
beforeEach(() => {
  routes.clear()
  vi.clearAllMocks()
})
afterEach(() => view?.unmount())

describe('post-first-review opt-in prompt', () => {
  it('is unchecked, shows the consent copy from /api/config verbatim, and sends the browser time zone', async () => {
    routes.set('GET /config', () => CURRENT)
    routes.set('GET /users/me/notification-settings', () => settings(false))
    routes.set('PUT /users/me/notification-settings', () => settings(true))
    view = render(<CheckinOptInPrompt />)
    await settle()

    const box = view.container.querySelector<HTMLInputElement>('[data-testid="checkin-opt-in"] input[type="checkbox"]')
    expect(box?.checked).toBe(false)
    expect(view.container.querySelector('[data-testid="checkin-opt-in"] label')?.textContent).toContain(CURRENT.consentCopy)

    await click(box)
    await settle()
    expect(api.put).toHaveBeenCalledWith('/users/me/notification-settings', {
      emailNudgesEnabled: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  })

  it('cannot drift from the cadence: the label is whatever the API generated for its cadence', async () => {
    const other = config([{ stage: 'ONE_MONTH', label: '1 month', offset: { months: 1 } }], 'Email me check-ins at 1 month.')
    routes.set('GET /config', () => other)
    routes.set('GET /users/me/notification-settings', () => settings(false))
    view = render(<CheckinOptInPrompt />)
    await settle()
    const text = view.container.textContent ?? ''
    expect(text).toContain('Email me check-ins at 1 month.')
    expect(text).not.toContain('2 weeks')
  })

  it('is not shown to users who already opted in', async () => {
    routes.set('GET /config', () => CURRENT)
    routes.set('GET /users/me/notification-settings', () => settings(true))
    view = render(<CheckinOptInPrompt />)
    await settle()
    expect(view.container.querySelector('[data-testid="checkin-opt-in"]')).toBeNull()
  })
})

describe('declining the prompt', () => {
  it('is not shown to users who declined it before', async () => {
    routes.set('GET /config', () => CURRENT)
    routes.set('GET /users/me/notification-settings', () => settings(false, '2026-11-01T00:00:00.000Z'))
    view = render(<CheckinOptInPrompt />)
    await settle()
    expect(view.container.querySelector('[data-testid="checkin-opt-in"]')).toBeNull()
  })

  it('"No thanks" persists the decline, hides the prompt, and does not change email settings', async () => {
    routes.set('GET /config', () => CURRENT)
    routes.set('GET /users/me/notification-settings', () => settings(false))
    routes.set('POST /users/me/nudge-prompt/dismiss', () => settings(false, '2026-11-15T00:00:00.000Z'))
    view = render(<CheckinOptInPrompt />)
    await settle()

    const no = [...view.container.querySelectorAll('button')].find((b) => /No thanks/.test(b.textContent ?? ''))
    await click(no ?? null)
    await settle()
    expect(api.post).toHaveBeenCalledWith('/users/me/nudge-prompt/dismiss')
    expect(api.put).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-testid="checkin-opt-in"]')).toBeNull()
  })
})

describe('review findings', () => {
  it('not shown to a user who opted in before and later opted out (profile or unsubscribe link)', async () => {
    routes.set('GET /config', () => CURRENT)
    routes.set('GET /users/me/notification-settings', () => settings(false, null, '2026-10-01T00:00:00.000Z'))
    view = render(<CheckinOptInPrompt />)
    await settle()
    expect(view.container.querySelector('[data-testid="checkin-opt-in"]')).toBeNull()
  })

  it('the checkbox is disabled while a decline is in flight', async () => {
    routes.set('GET /config', () => CURRENT)
    routes.set('GET /users/me/notification-settings', () => settings(false))
    let finish: (v: unknown) => void = () => undefined
    routes.set('POST /users/me/nudge-prompt/dismiss', () => new Promise((r) => (finish = r)))
    view = render(<CheckinOptInPrompt />)
    await settle()
    const no = [...view.container.querySelectorAll('button')].find((b) => /No thanks/.test(b.textContent ?? ''))
    await click(no ?? null)
    await settle()
    expect(view.container.querySelector<HTMLInputElement>('[data-testid="checkin-opt-in"] input[type="checkbox"]')?.disabled).toBe(true)
    finish(settings(false, '2026-11-15T00:00:00.000Z'))
    await settle()
  })

  it.each([
    ['another user declined (cached before a logout)', settings(false, '2026-11-01T00:00:00.000Z'), settings(false), true],
    ['opted in from another tab (cache says not opted in)', settings(false), settings(true), false],
  ])('decides from a fresh fetch, not the cache: %s', async (_name, cached, server, shown) => {
    routes.set('GET /config', () => CURRENT)
    routes.set('GET /users/me/notification-settings', () => server)
    const client = newQueryClient()
    client.setQueryData(['notification-settings'], cached)
    client.setQueryData(['stage-config'], CURRENT) // so the first render has everything it needs from the cache
    view = render(<CheckinOptInPrompt />, { client })
    await settle()
    expect(view.container.querySelector('[data-testid="checkin-opt-in"]') !== null).toBe(shown)
  })
})

describe('profile email reminders when /api/config fails', () => {
  it('an opted-in user can still turn reminders off', async () => {
    routes.set('GET /config', () => new Error('503'))
    routes.set('GET /users/me/notification-settings', () => settings(true))
    routes.set('PUT /users/me/notification-settings', () => settings(false))
    view = render(<EmailRemindersCard />)
    await settle()

    const box = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(box?.checked).toBe(true)
    expect(box?.disabled).toBe(false)
    await click(box)
    await settle()
    expect(api.put).toHaveBeenCalledWith('/users/me/notification-settings', { emailNudgesEnabled: false })
  })

  it('opting in is disabled without the consent copy', async () => {
    routes.set('GET /config', () => new Error('503'))
    routes.set('GET /users/me/notification-settings', () => settings(false))
    view = render(<EmailRemindersCard />)
    await settle()
    expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true)
    expect(view.container.textContent).toContain("Couldn't load the check-in schedule")
  })
})
