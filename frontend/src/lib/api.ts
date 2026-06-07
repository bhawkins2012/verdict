import axios from 'axios'

export const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
})

// Inject auth token on every request
api.interceptors.request.use((config) => {
  // Import here to avoid circular dependency
  const { accessToken } = JSON.parse(localStorage.getItem('verdict-auth') || '{}')
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`
  }
  return config
})

// Handle 401 — try refresh token
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config
    if (err.response?.status === 401 && !original._retry) {
      original._retry = true
      try {
        const stored = JSON.parse(localStorage.getItem('verdict-auth') || '{}')
        if (!stored.refreshToken) throw new Error('No refresh token')

        const res = await axios.post('/api/auth/refresh', { refreshToken: stored.refreshToken })
        const { accessToken, refreshToken } = res.data

        // Update store
        const updated = { ...stored, accessToken, refreshToken }
        localStorage.setItem('verdict-auth', JSON.stringify(updated))

        original.headers.Authorization = `Bearer ${accessToken}`
        return api(original)
      } catch {
        localStorage.removeItem('verdict-auth')
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  }
)
