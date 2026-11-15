import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/** GET /api/auth/me (the fields the account UI uses). */
export interface Me {
  id: string
  email: string
  username: string
  displayName?: string | null
  emailVerified: boolean
  emailVerifiedAt: string | null
  /** When the newest verification link for the current address was issued. */
  emailVerificationSentAt: string | null
  demographics?: Record<string, unknown> | null
}

export function useMe(enabled = true) {
  return useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/auth/me').then((r) => r.data),
    enabled,
  })
}

/** The API's error message, or a fallback. For 429s, mentions when to retry. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (!axios.isAxiosError<{ error?: string; retryAfterSeconds?: number }>(err)) return fallback
  const data = err.response?.data
  const message = data?.error ?? fallback
  if (err.response?.status === 429 && data?.retryAfterSeconds) {
    const minutes = Math.ceil(data.retryAfterSeconds / 60)
    return `${message} (try again in ${minutes} minute${minutes === 1 ? '' : 's'})`
  }
  return message
}
