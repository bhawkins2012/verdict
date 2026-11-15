import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { api } from '../../lib/api'
import { useStageConfig } from '../../lib/stages'

interface NotificationSettings {
  emailNudgesEnabled: boolean
  emailNudgesConsentAt: string | null
  timezone: string
  nudgeSendHour: number
  emailVerified: boolean
  nudgePromptDismissedAt: string | null
  emailNudgesFirstEnabledAt: string | null
}

type SettingsUpdate = Partial<Pick<NotificationSettings, 'emailNudgesEnabled' | 'timezone' | 'nudgeSendHour'>>

const browserTimeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`

/** Email check-in preferences (docs/adr-nudges.md D5). Off until the user turns it on. */
export function EmailRemindersCard() {
  const queryClient = useQueryClient()
  const { data: stageConfig, isError: configError } = useStageConfig()
  const { data: settings } = useQuery<NotificationSettings>({
    queryKey: ['notification-settings'],
    queryFn: () => api.get('/users/me/notification-settings').then((r) => r.data),
  })
  const update = useMutation({
    mutationFn: (body: SettingsUpdate) => api.put('/users/me/notification-settings', body).then((r) => r.data as NotificationSettings),
    onSuccess: (data) => queryClient.setQueryData(['notification-settings'], data),
    // Back to the server's value once the request settles (rolls back a rejected change).
    onSettled: () => setPendingEnabled(null),
  })
  // Optimistic value for the checkbox, set synchronously in the click handler so the control never
  // snaps back while the request is in flight.
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null)

  if (!settings) return null
  const tz = browserTimeZone()
  const enabled = pendingEnabled ?? settings.emailNudgesEnabled

  const toggle = (on: boolean) => {
    setPendingEnabled(on)
    // Turning reminders on adopts the browser's time zone, unless the user already picked one.
    update.mutate(on && tz && settings.timezone === 'UTC' ? { emailNudgesEnabled: true, timezone: tz } : { emailNudgesEnabled: on })
  }

  return (
    <div className="card p-6 mb-4">
      <h3 className="font-medium text-ink-800 mb-1">Email reminders</h3>
      <label className="flex items-start gap-3 mt-3 cursor-pointer">
        <input
          type="checkbox"
          className="mt-1"
          checked={enabled}
          // Opting in needs the consent copy (from GET /api/config); opting out never does.
          disabled={update.isPending || (!enabled && !stageConfig)}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>
          <span className="text-sm text-ink-800">
            {stageConfig ? stageConfig.consentCopy : enabled ? 'Email reminders are on.' : 'Email reminders are off.'}
          </span>
          {!stageConfig && (
            <span className="block text-xs text-amber-700" role="status">
              {configError ? "Couldn't load the check-in schedule, so reminders can't be turned on right now." : 'Loading the check-in schedule…'}
            </span>
          )}
          <span className="block text-xs text-ink-500">
            When it&apos;s time for your next review of a product you track, we&apos;ll email you (at most one email a day).
            Every email has an unsubscribe link. Check-ins always appear here in Verdict either way.
          </span>
        </span>
      </label>

      {enabled && (
        <div className="grid sm:grid-cols-2 gap-4 mt-5">
          <div>
            <label className="label" htmlFor="nudge-hour">Send at</label>
            <select
              id="nudge-hour"
              className="input"
              value={settings.nudgeSendHour}
              disabled={update.isPending}
              onChange={(e) => update.mutate({ nudgeSendHour: Number(e.target.value) })}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{hourLabel(h)}</option>
              ))}
            </select>
          </div>
          <div>
            <span className="label">Time zone</span>
            <p className="text-sm text-ink-700 py-2">{settings.timezone}</p>
            {tz && tz !== settings.timezone && (
              <button type="button" className="text-xs text-ink-500 hover:text-ink-800 hover:underline" disabled={update.isPending} onClick={() => update.mutate({ timezone: tz })}>
                Use this device&apos;s time zone ({tz})
              </button>
            )}
          </div>
          {!settings.emailVerified && (
            <p className="sm:col-span-2 text-xs text-amber-700">
              Your email address isn&apos;t verified yet. Until it is, check-ins may only appear here in Verdict.
            </p>
          )}
        </div>
      )}

      {update.isError && (
        <p role="alert" className="text-xs text-red-600 mt-3">
          {(axios.isAxiosError<{ error?: string }>(update.error) && update.error.response?.data?.error) || 'Could not save. Please try again.'}
        </p>
      )}
    </div>
  )
}
