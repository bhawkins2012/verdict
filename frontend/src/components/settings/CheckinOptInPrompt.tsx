import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useStageConfig } from '../../lib/stages'

interface NotificationSettings {
  emailNudgesEnabled: boolean
  timezone: string
  nudgePromptDismissedAt: string | null
}

const browserTimeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

/**
 * Shown after a user's first (INITIAL) review of each product until they opt in or decline ("No
 * thanks", persisted server-side as nudgePromptDismissedAt; never shown again). Unchecked by default.
 * The profile's Email reminders card stays the way to change the choice later. The label is the consent copy from GET /api/config, generated from
 * the nudge cadence on the server, so it cannot drift from what we actually send.
 */
export function CheckinOptInPrompt() {
  const queryClient = useQueryClient()
  const { data: config } = useStageConfig()
  const { data: settings } = useQuery<NotificationSettings>({
    queryKey: ['notification-settings'],
    queryFn: () => api.get('/users/me/notification-settings').then((r) => r.data),
  })
  // Decided once, when the prompt first renders: users who already opted in or declined never see it.
  const [eligible, setEligible] = useState<boolean | null>(null)
  const [checked, setChecked] = useState(false)
  const update = useMutation({
    mutationFn: (enabled: boolean) => {
      const tz = browserTimeZone()
      return api
        .put('/users/me/notification-settings', enabled && tz ? { emailNudgesEnabled: true, timezone: tz } : { emailNudgesEnabled: enabled })
        .then((r) => r.data)
    },
    onSuccess: (data) => queryClient.setQueryData(['notification-settings'], data),
    onError: () => setChecked((c) => !c), // roll back the optimistic checkbox
  })
  const dismiss = useMutation({
    mutationFn: () => api.post('/users/me/nudge-prompt/dismiss').then((r) => r.data),
    onSuccess: (data) => {
      queryClient.setQueryData(['notification-settings'], data)
      setEligible(false)
    },
  })

  if (!config || !settings) return null
  if (eligible === null) {
    setEligible(!settings.emailNudgesEnabled && !settings.nudgePromptDismissedAt)
    return null
  }
  if (!eligible) return null

  return (
    <div className="card p-5 mb-6 border-amber-200 bg-amber-50/40" data-testid="checkin-opt-in">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          className="mt-1"
          checked={checked}
          disabled={update.isPending}
          onChange={(e) => {
            setChecked(e.target.checked)
            update.mutate(e.target.checked)
          }}
        />
        <span>
          <span className="text-sm font-medium text-ink-800">{config.consentCopy}</span>
          <span className="block text-xs text-ink-500 mt-0.5">
            Optional. At most one email a day, each with an unsubscribe link. Check-ins also appear here in Verdict.
          </span>
        </span>
      </label>
      {!checked && !update.isSuccess && (
        <button
          type="button"
          className="text-xs text-ink-500 hover:text-ink-800 hover:underline mt-2 ml-7"
          disabled={dismiss.isPending || update.isPending}
          onClick={() => dismiss.mutate()}
        >
          No thanks, don&apos;t ask again
        </button>
      )}
      {dismiss.isError && <p className="text-xs text-red-600 mt-2" role="alert">Could not save. Please try again.</p>}
      {checked && update.isSuccess && (
        <p className="text-xs text-ink-600 mt-2" role="status">Done. You can change this any time in your profile.</p>
      )}
      {update.isError && <p className="text-xs text-red-600 mt-2" role="alert">Could not save. Please try again.</p>}
    </div>
  )
}
