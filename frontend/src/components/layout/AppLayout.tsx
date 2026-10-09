import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Compass, Bell, LogOut, TrendingUp } from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { useQuery } from '@tanstack/react-query'
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

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-ink-200 flex flex-col shrink-0">
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

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
