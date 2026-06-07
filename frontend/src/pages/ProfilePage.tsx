import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuthStore } from '../store/authStore'
import { CheckCircle2, User } from 'lucide-react'
import clsx from 'clsx'

const AGE_RANGES = [
  { value: 'AGE_18_24', label: '18–24' },
  { value: 'AGE_25_34', label: '25–34' },
  { value: 'AGE_35_44', label: '35–44' },
  { value: 'AGE_45_54', label: '45–54' },
  { value: 'AGE_55_64', label: '55–64' },
  { value: 'AGE_65_PLUS', label: '65+' },
]

const INCOME_BRACKETS = [
  { value: 'UNDER_30K', label: 'Under $30K' },
  { value: 'RANGE_30_50K', label: '$30K–$50K' },
  { value: 'RANGE_50_75K', label: '$50K–$75K' },
  { value: 'RANGE_75_100K', label: '$75K–$100K' },
  { value: 'RANGE_100_150K', label: '$100K–$150K' },
  { value: 'OVER_150K', label: 'Over $150K' },
]

const LIFESTYLE_OPTIONS = [
  'tech-early-adopter', 'home-cooking', 'fitness', 'outdoor',
  'family', 'budget-conscious', 'luxury', 'travel',
  'food-enthusiast', 'gaming', 'sustainability', 'diy',
  'pet-owner', 'remote-work', 'student',
]

export function ProfilePage() {
  const { user, setUser } = useAuthStore()
  const queryClient = useQueryClient()
  const [saved, setSaved] = useState(false)

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get('/auth/me').then(r => r.data),
  })

  const [form, setForm] = useState({
    ageRange: '',
    genderIdentity: '',
    region: '',
    incomeBracket: '',
    lifestyleTags: [] as string[],
    householdSize: '',
    hasChildren: '',
  })

  useEffect(() => {
    if (me?.demographics) {
      const d = me.demographics
      setForm({
        ageRange: d.ageRange || '',
        genderIdentity: d.genderIdentity || '',
        region: d.region || '',
        incomeBracket: d.incomeBracket || '',
        lifestyleTags: d.lifestyleTags || [],
        householdSize: d.householdSize?.toString() || '',
        hasChildren: d.hasChildren === true ? 'true' : d.hasChildren === false ? 'false' : '',
      })
    }
  }, [me])

  const { mutate: save, isPending } = useMutation({
    mutationFn: (data: any) => api.put('/users/me/demographics', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    },
  })

  const handleSave = () => {
    save({
      ageRange: form.ageRange || undefined,
      genderIdentity: form.genderIdentity || undefined,
      region: form.region || undefined,
      incomeBracket: form.incomeBracket || undefined,
      lifestyleTags: form.lifestyleTags,
      householdSize: form.householdSize ? parseInt(form.householdSize) : undefined,
      hasChildren: form.hasChildren === 'true' ? true : form.hasChildren === 'false' ? false : undefined,
    })
  }

  const toggleTag = (tag: string) => {
    setForm(prev => ({
      ...prev,
      lifestyleTags: prev.lifestyleTags.includes(tag)
        ? prev.lifestyleTags.filter(t => t !== tag)
        : [...prev.lifestyleTags, tag],
    }))
  }

  return (
    <div className="p-8 max-w-2xl mx-auto animate-fade-in">
      <div className="flex items-center gap-4 mb-8">
        <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center">
          <span className="text-2xl font-display text-amber-700">
            {(user?.displayName || user?.username || '?')[0].toUpperCase()}
          </span>
        </div>
        <div>
          <h2 className="font-display text-2xl text-ink-900">{user?.displayName || user?.username}</h2>
          <p className="text-ink-500 text-sm">{user?.email}</p>
        </div>
      </div>

      <div className="card p-6 mb-4">
        <h3 className="font-medium text-ink-800 mb-1">Your Profile</h3>
        <p className="text-sm text-ink-500 mb-6">
          This helps us match you with reviewers who have similar backgrounds and find you relevant recommendations.
          All information is optional.
        </p>

        <div className="space-y-6">
          {/* Age */}
          <div>
            <label className="label">Age Range</label>
            <div className="flex flex-wrap gap-2">
              {AGE_RANGES.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setForm(p => ({ ...p, ageRange: p.ageRange === value ? '' : value }))}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-sm border transition-all',
                    form.ageRange === value
                      ? 'bg-ink-900 text-white border-ink-900'
                      : 'bg-white text-ink-600 border-ink-200 hover:bg-ink-50'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Gender */}
          <div>
            <label className="label">Gender Identity</label>
            <input
              className="input"
              placeholder="e.g. Woman, Man, Non-binary, Prefer not to say..."
              value={form.genderIdentity}
              onChange={e => setForm(p => ({ ...p, genderIdentity: e.target.value }))}
            />
          </div>

          {/* Region */}
          <div>
            <label className="label">Region</label>
            <input
              className="input"
              placeholder="e.g. US-CA, GB, AU-NSW..."
              value={form.region}
              onChange={e => setForm(p => ({ ...p, region: e.target.value }))}
            />
            <p className="text-xs text-ink-400 mt-1">Country or country + region code</p>
          </div>

          {/* Income */}
          <div>
            <label className="label">Income Bracket</label>
            <div className="flex flex-wrap gap-2">
              {INCOME_BRACKETS.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setForm(p => ({ ...p, incomeBracket: p.incomeBracket === value ? '' : value }))}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-sm border transition-all',
                    form.incomeBracket === value
                      ? 'bg-ink-900 text-white border-ink-900'
                      : 'bg-white text-ink-600 border-ink-200 hover:bg-ink-50'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Household */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Household Size</label>
              <input
                className="input"
                type="number"
                min="1"
                max="20"
                placeholder="e.g. 2"
                value={form.householdSize}
                onChange={e => setForm(p => ({ ...p, householdSize: e.target.value }))}
              />
            </div>
            <div>
              <label className="label">Children at Home</label>
              <div className="flex gap-2">
                {[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }].map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => setForm(p => ({ ...p, hasChildren: p.hasChildren === value ? '' : value }))}
                    className={clsx(
                      'flex-1 py-2.5 rounded-xl text-sm font-medium border transition-all',
                      form.hasChildren === value
                        ? 'bg-ink-900 text-white border-ink-900'
                        : 'bg-white text-ink-600 border-ink-200 hover:bg-ink-50'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Lifestyle tags */}
          <div>
            <label className="label">Lifestyle Tags</label>
            <div className="flex flex-wrap gap-2">
              {LIFESTYLE_OPTIONS.map(tag => (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={clsx(
                    'px-3 py-1.5 rounded-full text-sm border transition-all',
                    form.lifestyleTags.includes(tag)
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-white text-ink-600 border-ink-200 hover:bg-ink-50'
                  )}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={isPending}
        className="btn-primary w-full py-3 flex items-center justify-center gap-2"
      >
        {saved
          ? <><CheckCircle2 size={16} /> Saved!</>
          : isPending ? 'Saving...' : 'Save profile'
        }
      </button>
    </div>
  )
}
