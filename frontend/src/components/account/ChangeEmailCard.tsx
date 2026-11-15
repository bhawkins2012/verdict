import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2 } from 'lucide-react'
import { api } from '../../lib/api'
import { apiErrorMessage, useMe } from '../../lib/account'
import { useAuthStore } from '../../store/authStore'

/** Change the account's email address (docs/adr-email-verification.md D7). Needs the current password. */
export function ChangeEmailCard() {
  const queryClient = useQueryClient()
  const { user, setUser } = useAuthStore()
  const { data: me } = useMe()
  const [email, setEmail] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const change = useMutation({
    mutationFn: () => api.put('/users/me/email', { email, currentPassword }).then((r) => r.data as { email: string; changed: boolean }),
    onSuccess: (data) => {
      setCurrentPassword('')
      if (data.changed) setEmail('')
      if (data.changed && user) setUser({ ...user, email: data.email })
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
  })

  if (!me) return null

  return (
    <div className="card p-6 mb-4" id="email">
      <h3 className="font-medium text-ink-800 mb-1">Email address</h3>
      <p className="text-sm text-ink-600 flex items-center gap-2">
        {me.email}
        {me.emailVerified ? (
          <span className="inline-flex items-center gap-1 text-sage-600 text-xs"><CheckCircle2 size={12} /> Verified</span>
        ) : (
          <span className="text-amber-700 text-xs">Not verified yet</span>
        )}
      </p>

      <form
        className="grid sm:grid-cols-2 gap-4 mt-4"
        onSubmit={(e) => {
          e.preventDefault()
          change.mutate()
        }}
      >
        <div>
          <label className="label" htmlFor="new-email">New email address</label>
          <input id="new-email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </div>
        <div>
          <label className="label" htmlFor="current-password">Current password</label>
          <input id="current-password" className="input" type="password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
        </div>
        <div className="sm:col-span-2 flex items-center gap-3">
          <button type="submit" className="btn-primary" disabled={change.isPending}>
            {change.isPending ? 'Saving…' : 'Change email'}
          </button>
          {change.isSuccess && (
            <p className="text-sm text-ink-600" role="status">
              {change.data.changed
                ? `Done. We sent a confirmation link to ${change.data.email} and a notice to your previous address.`
                : 'That is already your address.'}
            </p>
          )}
          {change.isError && <p className="text-sm text-red-600" role="alert">{apiErrorMessage(change.error, 'Could not change your email. Please try again.')}</p>}
        </div>
      </form>
      <p className="text-xs text-ink-500 mt-3">The new address needs to be confirmed before check-in emails go to it.</p>
    </div>
  )
}
