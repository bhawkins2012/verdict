import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios'
import { api } from './api'

const KEY = 'verdict-auth'
const persisted = (state: object) => localStorage.setItem(KEY, JSON.stringify({ state, version: 0 }))

type Seen = { url?: string; authorization?: string }
let seen: Seen[]
let respond: (config: InternalAxiosRequestConfig, call: number) => { status: number; data?: unknown }

// Replace the network with an adapter that records requests and answers from `respond`.
beforeEach(() => {
  localStorage.clear()
  seen = []
  respond = () => ({ status: 200, data: {} })
  api.defaults.adapter = async (config) => {
    seen.push({ url: config.url, authorization: config.headers.get('Authorization') as string | undefined })
    const { status, data } = respond(config, seen.length)
    const response = { data, status, statusText: String(status), headers: {}, config }
    if (status >= 400) throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, undefined, response)
    return response
  }
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('request interceptor', () => {
  it("sends the token Zustand's persist middleware stored under { state: {...} }", async () => {
    // Regression: tokens were read from the top level, so no Authorization header was ever sent.
    persisted({ accessToken: 'tok-123', refreshToken: 'ref-123' })

    await api.get('/reviews/threads')

    expect(seen[0].authorization).toBe('Bearer tok-123')
  })

  it('still understands the old flat storage shape', async () => {
    localStorage.setItem(KEY, JSON.stringify({ accessToken: 'flat-tok' }))

    await api.get('/x')

    expect(seen[0].authorization).toBe('Bearer flat-tok')
  })

  it('sends no Authorization header when logged out', async () => {
    await api.get('/x')
    expect(seen[0].authorization).toBeUndefined()
  })
})

describe('401 handling', () => {
  it('refreshes once, retries with the new token, and keeps the { state } wrapper intact', async () => {
    persisted({ accessToken: 'old', refreshToken: 'ref-1', isAuthenticated: true })
    respond = (_c, call) => (call === 1 ? { status: 401 } : { status: 200, data: { ok: true } })
    const refresh = vi.spyOn(axios, 'post').mockResolvedValue({ data: { accessToken: 'new', refreshToken: 'ref-2' } })

    const res = await api.get('/reviews/threads')

    expect(res.data).toEqual({ ok: true })
    expect(refresh).toHaveBeenCalledWith('/api/auth/refresh', { refreshToken: 'ref-1' })
    expect(seen.map(s => s.authorization)).toEqual(['Bearer old', 'Bearer new'])
    const stored = JSON.parse(localStorage.getItem(KEY)!)
    expect(stored.version).toBe(0)
    expect(stored.state).toMatchObject({ accessToken: 'new', refreshToken: 'ref-2', isAuthenticated: true })
  })

  it('clears the session and sends the user to /login when refresh fails', async () => {
    persisted({ accessToken: 'old', refreshToken: 'ref-1' })
    respond = () => ({ status: 401 })
    vi.spyOn(axios, 'post').mockRejectedValue(new Error('refresh rejected'))
    const location = { href: '/dashboard' }
    vi.stubGlobal('location', location)

    await expect(api.get('/reviews/threads')).rejects.toBeTruthy()

    expect(localStorage.getItem(KEY)).toBeNull()
    expect(location.href).toBe('/login')
    vi.unstubAllGlobals()
  })

  it('does not loop: a request that is still 401 after the retry is rejected', async () => {
    persisted({ accessToken: 'old', refreshToken: 'ref-1' })
    respond = () => ({ status: 401 })
    const refresh = vi.spyOn(axios, 'post').mockResolvedValue({ data: { accessToken: 'new', refreshToken: 'ref-2' } })
    vi.stubGlobal('location', { href: '/dashboard' })

    await expect(api.get('/x')).rejects.toBeTruthy()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(seen).toHaveLength(2)
    vi.unstubAllGlobals()
  })
})
