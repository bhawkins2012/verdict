import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { MailWarning } from 'lucide-react'
import { api } from '../../lib/api'
import { apiErrorMessage, useMe } from '../../lib/account'

/**
 * Soft gate (docs/adr-email-verification.md D8): everything works before verification; this banner asks
 * the user to confirm their address and offers a new link. It shows the full address (it is the user's
 * own, and seeing it is how they spot a typo) with a way to change it.
 */
export function VerificationBanner() {
  const queryClient = useQueryClient()
  const { data: me } = useMe()
  const resend = useMutation({
    mutationFn: () => api.post('/auth/verification/resend').then((r) => r.data as { sentTo?: string; alreadyVerified?: boolean }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  })

  if (!me || me.emailVerified) return null

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-8 py-3 text-sm text-amber-900 flex flex-wrap items-center gap-x-4 gap-y-2" role="region" aria-label="Email verification" data-testid="verify-banner">
      <MailWarning size={16} className="shrink-0" aria-hidden />
      <span>
        Please confirm <strong>{me.email}</strong> to get check-ins by email.
        {me.emailVerificationSentAt && (
          <> We sent a link {formatDistanceToNow(new Date(me.emailVerificationSentAt), { addSuffix: true })}.</>
        )}
      </span>
      <button type="button" className="font-medium underline hover:text-amber-700 disabled:opacity-50" disabled={resend.isPending} onClick={() => resend.mutate()}>
        {resend.isPending ? 'Sending…' : 'Resend email'}
      </button>
      <Link to="/profile#email" className="underline hover:text-amber-700">Change address</Link>
      {resend.isSuccess && resend.data.sentTo && <span role="status">New link sent to {resend.data.sentTo}.</span>}
      {resend.isError && <span role="alert" className="text-red-700">{apiErrorMessage(resend.error, 'Could not send a new link. Please try again.')}</span>}
    </div>
  )
}
