import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { LayoutDashboard, Compass, Bell, LogOut, TrendingUp, Shield, Menu, X } from 'lucide-react'
import { VerificationBanner } from '../account/VerificationBanner'
import { useAuthStore } from '../../store/authStore'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import clsx from 'clsx'

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/discover', icon: Compass, label: 'Discover' },
  { to: '/recommendations', icon: TrendingUp, label: 'For You' },
]

export function AppLayout() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()

  const { data: nudges } = useQuery({
    queryKey: ['nudges'],
    queryFn: () => api.get('/nudges').then(r => r.data),
    refetchInterval: 60_000,
  })

  const pendingNudgeCount = nudges?.length || 0

  const queryClient = useQueryClient()

  // Phones: the sidebar is a slide-out panel behind a Menu button (md and up: always visible, unchanged).
  const [menuOpen, setMenuOpen] = useState(false)
  const asideRef = useRef<HTMLElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLElement>(null)
  const wasOpen = useRef(false)
  useEffect(() => {
    const content = contentRef.current
    if (menuOpen) {
      // Focus moves into the panel, the page behind it is inert, and Escape closes it from anywhere.
      asideRef.current?.querySelector<HTMLElement>('a, button')?.focus()
      content?.setAttribute('inert', '')
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
      // Widening past md shows the sidebar anyway; close the phone panel so nothing stays inert.
      const wide = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 768px)') : null
      const onWide = () => { if (wide?.matches) setMenuOpen(false) }
      document.addEventListener('keydown', onKey)
      wide?.addEventListener('change', onWide)
      wasOpen.current = true
      return () => {
        document.removeEventListener('keydown', onKey)
        wide?.removeEventListener('change', onWide)
        content?.removeAttribute('inert')
      }
    }
    // Just closed: return focus to the Menu button (focus was inside the panel, which is now invisible).
    if (wasOpen.current) {
      wasOpen.current = false
      menuButtonRef.current?.focus()
    }
  }, [menuOpen])

  const handleLogout = async () => {
    await logout()
    // Drop every cached response, so the next user on this browser never sees this user's data.
    queryClient.clear()
    navigate('/login')
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Backdrop for the phone menu */}
      {menuOpen && <div className="fixed inset-0 z-30 bg-ink-900/30 md:hidden" aria-hidden="true" onClick={() => setMenuOpen(false)} />}

      {/* Sidebar: always shown from md up; on phones a panel that is invisible (and out of the tab order) when closed */}
      <aside
        ref={asideRef}
        id="app-sidebar"
        aria-label="Main menu"
        onClick={(e) => { if ((e.target as HTMLElement).closest('a')) setMenuOpen(false) }}
        className={clsx(
          'w-60 bg-white border-r border-ink-200 flex flex-col shrink-0',
          'fixed inset-y-0 left-0 z-40 transition-transform md:static md:translate-x-0 md:visible',
          menuOpen ? 'translate-x-0 visible' : '-translate-x-full invisible',
        )}
      >
        {/* Logo */}
        <div className="px-6 py-5 border-b border-ink-100">
          <h1 className="font-display text-2xl text-ink-900">Verdict</h1>
          <p className="text-xs text-ink-400 mt-0.5">Reviews that evolve</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-0.5">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
                isActive
                  ? 'bg-ink-900 text-white'
                  : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
              )}
            >
              <Icon size={17} />
              {label}
            </NavLink>
          ))}

          {/* Nudges with badge */}
          <NavLink
            to="/dashboard?tab=nudges"
            className={({ isActive }) => clsx(
              'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
              isActive
                ? 'bg-ink-900 text-white'
                : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
            )}
          >
            <Bell size={17} />
            <span className="flex-1">Check-ins</span>
            {pendingNudgeCount > 0 && (
              <span className="bg-amber-500 text-white text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center">
                {pendingNudgeCount}
              </span>
            )}
          </NavLink>

          {/* Admins only; the API checks the role on every admin request. */}
          {user?.role === 'ADMIN' && (
            <NavLink
              to="/admin"
              className={({ isActive }) => clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
                isActive ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
              )}
            >
              <Shield size={17} />
              Admin
            </NavLink>
          )}
        </nav>

        {/* User footer */}
        <div className="p-3 border-t border-ink-100 space-y-0.5">
          <NavLink
            to="/profile"
            className={({ isActive }) => clsx(
              'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors w-full',
              isActive ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100'
            )}
          >
            <div className="w-6 h-6 bg-amber-100 rounded-full flex items-center justify-center">
              <span className="text-xs font-bold text-amber-700">
                {(user?.displayName || user?.username || '?')[0].toUpperCase()}
              </span>
            </div>
            <span className="flex-1 truncate">{user?.displayName || user?.username}</span>
          </NavLink>
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-ink-500 hover:bg-red-50 hover:text-red-600 transition-colors w-full"
          >
            <LogOut size={17} />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Phone top bar */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-ink-200 bg-white">
          <button
            ref={menuButtonRef}
            type="button"
            className="btn-ghost p-1"
            aria-controls="app-sidebar"
            aria-expanded={menuOpen}
            aria-label="Menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <span className="font-display text-xl text-ink-900">Verdict</span>
        </div>

        {/* Main content */}
        <main ref={contentRef} className="flex-1 overflow-y-auto">
          <VerificationBanner />
          <Outlet />
        </main>
      </div>
    </div>
  )
}
