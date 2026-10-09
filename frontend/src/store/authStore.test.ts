import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { useAuthStore } from './authStore'

const loginResponse = {
  user: { id: 'u1', email: 'alice@example.com', username: 'alice_reviews' },
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
}

beforeEach(() => {
  localStorage.clear()
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false })
  vi.restoreAllMocks()
})

describe('auth store', () => {
  it('login stores the session and persists it in the shape the API client reads', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ data: loginResponse })

    await useAuthStore.getState().login('alice@example.com', 'password123')

    const s = useAuthStore.getState()
    expect(s).toMatchObject({ isAuthenticated: true, accessToken: 'access-1', refreshToken: 'refresh-1' })
    const stored = JSON.parse(localStorage.getItem('verdict-auth')!)
    expect(stored.state).toMatchObject({ accessToken: 'access-1', isAuthenticated: true })
  })

  it('a request made right after login carries the new access token (end-to-end regression)', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: loginResponse })
    await useAuthStore.getState().login('alice@example.com', 'password123')
    post.mockRestore()

    let header: unknown
    api.defaults.adapter = async (config) => {
      header = config.headers.get('Authorization')
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config }
    }
    await api.get('/reviews/threads')

    expect(header).toBe('Bearer access-1')
  })

  it('a failed login leaves the user logged out', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new Error('Invalid credentials'))

    await expect(useAuthStore.getState().login('alice@example.com', 'wrong')).rejects.toThrow()

    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().accessToken).toBeNull()
  })

  it('logout clears the session even if the server call fails', async () => {
    useAuthStore.setState({ ...loginResponse, isAuthenticated: true })
    vi.spyOn(api, 'post').mockRejectedValue(new Error('network down'))

    await useAuthStore.getState().logout()

    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, accessToken: null, refreshToken: null, user: null })
  })
})
