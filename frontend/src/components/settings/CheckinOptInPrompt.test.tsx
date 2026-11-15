import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckinOptInPrompt } from './CheckinOptInPrompt'
import { EmailRemindersCard } from './EmailRemindersCard'
import { api, routes } from '../../test/apiMock'
import { click, render, Rendered, settle } from '../../test/render'
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
const settings = (on: boolean) => ({ emailNudgesEnabled: on, emailNudgesConsentAt: null, timezone: 'UTC', nudgeSendHour: 9, emailVerified: false })

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
