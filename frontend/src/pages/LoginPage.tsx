import axios from 'axios'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { login } = useAuthStore()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password)
      navigate('/dashboard')
    } catch (err) {
      setError((axios.isAxiosError<{ error?: string }>(err) && err.response?.data?.error) || 'Invalid credentials')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="animate-fade-in">
      <h2 className="font-display text-3xl text-white mb-2">Welcome back.</h2>
      <p className="text-ink-400 mb-8">Sign in to see how your opinions have evolved.</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label text-ink-400">Email</label>
          <input className="input bg-ink-900 border-ink-700 text-white placeholder-ink-600 focus:ring-amber-500" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required />
        </div>
        <div>
          <label className="label text-ink-400">Password</label>
          <input className="input bg-ink-900 border-ink-700 text-white placeholder-ink-600 focus:ring-amber-500" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button type="submit" disabled={loading} className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-white font-medium rounded-xl transition-colors disabled:opacity-50">
          {loading ? 'Signing in...' : 'Sign in'}
        </button>

        <p className="text-center text-ink-500 text-sm">
          No account?{' '}
          <Link to="/register" className="text-amber-400 hover:text-amber-300">Create one</Link>
        </p>

        <p className="text-center text-ink-600 text-xs mt-4">
          Demo: alice@example.com / password123
        </p>
      </form>
    </div>
  )
}
