import axios from 'axios'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'

export function RegisterPage() {
  const [form, setForm] = useState({ email: '', username: '', password: '', displayName: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { register } = useAuthStore()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await register(form)
      navigate('/profile') // Send to profile to fill demographics
    } catch (err) {
      setError((axios.isAxiosError<{ error?: string }>(err) && err.response?.data?.error) || 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm(prev => ({ ...prev, [key]: e.target.value }))
  })

  return (
    <div className="animate-fade-in">
      <h2 className="font-display text-3xl text-white mb-2">Start tracking.</h2>
      <p className="text-ink-400 mb-8">Create your account to begin longitudinal reviews.</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        {[
          { key: 'displayName', label: 'Display Name', type: 'text', placeholder: 'Jane Smith', required: false },
          { key: 'email', label: 'Email', type: 'email', placeholder: 'you@example.com', required: true },
          { key: 'username', label: 'Username', type: 'text', placeholder: 'jane_reviews', required: true },
          { key: 'password', label: 'Password', type: 'password', placeholder: '8+ characters', required: true },
        ].map(({ key, label, type, placeholder, required }) => (
          <div key={key}>
            <label className="label text-ink-400">{label}</label>
            <input
              className="input bg-ink-900 border-ink-700 text-white placeholder-ink-600 focus:ring-amber-500"
              type={type}
              placeholder={placeholder}
              required={required}
              {...field(key as keyof typeof form)}
            />
          </div>
        ))}

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button type="submit" disabled={loading} className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-white font-medium rounded-xl transition-colors disabled:opacity-50">
          {loading ? 'Creating account...' : 'Create account'}
        </button>

        <p className="text-center text-ink-500 text-sm">
          Already have an account?{' '}
          <Link to="/login" className="text-amber-400 hover:text-amber-300">Sign in</Link>
        </p>
      </form>
    </div>
  )
}
