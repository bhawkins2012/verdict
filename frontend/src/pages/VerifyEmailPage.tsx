import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router-dom'
import { api } from '../lib/api'
import { apiErrorMessage } from '../lib/account'
import { useAuthStore } from '../store/authStore'

/**
 * The page a verification email links to: /verify-email#id=…&t=… (docs/adr-email-verification.md D2).
 * Opening it does nothing; only the button POSTs the token, so mail scanners that prefetch links cannot
 * use it up. The token is in the fragment, which browsers never send to a server. No login needed.
 */
function parseLink(hash: string) {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  return { id: p.get('id') ?? '', token: p.get('t') ?? '' }
}

export function VerifyEmailPage() {
  const location = useLocation()
  const queryClient = useQueryClient()
  const { isAuthenticated } = useAuthStore()
  // Read once: the fragment is cleared from the address bar below, so a shared screenshot or a later
  // reload does not carry the token.
  const [link, setLink] = useState(() => parseLink(location.hash))
  const [seenHash, setSeenHash] = useState(location.hash)
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [location.hash])

  const confirm = useMutation({
    mutationFn: () => api.post('/auth/verify-email', link).then((r) => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  })
  const resend = useMutation({ mutationFn: () => api.post('/auth/verification/resend').then((r) => r.data as { sentTo?: string }) })
  // Another link opened in the same tab (only the fragment changes, so the page stays mounted): start over.
  if (location.hash && location.hash !== seenHash) {
    setSeenHash(location.hash)
    setLink(parseLink(location.hash))
    confirm.reset()
    resend.reset()
  }
  const complete = link.id !== '' && link.token !== ''

  return (
    <div className="animate-fade-in" data-testid="verify-email-page">
      <h2 className="font-display text-3xl text-white mb-2">
        {confirm.isSuccess ? 'Email verified' : 'Confirm your email address'}
      </h2>

      {confirm.isSuccess ? (
        <>
          <p className="text-ink-400 mb-8" role="status">Thanks! Your address is confirmed. Check-ins can now reach you by email if you turn them on.</p>
          <Link to={isAuthenticated ? '/dashboard' : '/login'} className="inline-block px-5 py-3 bg-amber-500 hover:bg-amber-400 text-white font-medium rounded-xl">
            {isAuthenticated ? 'Continue to Verdict' : 'Sign in'}
          </Link>
        </>
      ) : !complete ? (
        <p className="text-ink-400" role="alert">This link is incomplete. Use the button in the most recent email from Verdict.</p>
      ) : (
        <>
          <p className="text-ink-400 mb-8">Press the button to confirm this is your address.</p>
          <button
            type="button"
            className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-white font-medium rounded-xl transition-colors disabled:opacity-50"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate()}
          >
            {confirm.isPending ? 'Confirming…' : 'Confirm'}
          </button>
          {confirm.isError && (
            <div className="mt-6 text-sm" role="alert">
              <p className="text-red-400">{apiErrorMessage(confirm.error, 'This link is invalid or has expired.')}</p>
              {isAuthenticated ? (
                <p className="mt-3 text-ink-300">
                  <button type="button" className="text-amber-400 hover:text-amber-300 underline disabled:opacity-50" disabled={resend.isPending || resend.isSuccess} onClick={() => resend.mutate()}>
                    Send a new link
                  </button>
                  {resend.isSuccess && resend.data.sentTo && <span role="status"> Sent to {resend.data.sentTo}.</span>}
                  {resend.isError && <span className="text-red-400"> {apiErrorMessage(resend.error, 'Could not send a new link.')}</span>}
                </p>
              ) : (
                <p className="mt-3 text-ink-300">
                  <Link to="/login" className="text-amber-400 hover:text-amber-300 underline">Sign in</Link> to request a new link.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
