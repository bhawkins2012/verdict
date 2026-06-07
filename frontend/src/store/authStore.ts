import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '../lib/api'

interface User {
  id: string
  email: string
  username: string
  displayName?: string
  avatarUrl?: string
  demographics?: any
}

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  isAuthenticated: boolean

  login: (email: string, password: string) => Promise<void>
  register: (data: { email: string; username: string; password: string; displayName?: string }) => Promise<void>
  logout: () => Promise<void>
  setUser: (user: User) => void
  setTokens: (accessToken: string, refreshToken: string) => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,

      login: async (email, password) => {
        const res = await api.post('/auth/login', { email, password })
        set({
          user: res.data.user,
          accessToken: res.data.accessToken,
          refreshToken: res.data.refreshToken,
          isAuthenticated: true,
        })
      },

      register: async (data) => {
        const res = await api.post('/auth/register', data)
        set({
          user: res.data.user,
          accessToken: res.data.accessToken,
          refreshToken: res.data.refreshToken,
          isAuthenticated: true,
        })
      },

      logout: async () => {
        try {
          await api.post('/auth/logout', { refreshToken: get().refreshToken })
        } catch { /* ignore */ }
        set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false })
      },

      setUser: (user) => set({ user }),
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
    }),
    {
      name: 'verdict-auth',
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)
