import { useState } from 'react'
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Product, ReviewStage, STAGE_LABELS } from '../types'
import { ArrowLeft, Plus, X, ArrowRight } from 'lucide-react'
import clsx from 'clsx'

const SCORE_DIMENSIONS = [
  { key: 'scoreOverall', label: 'Overall', required: true, description: 'Your overall rating' },
  { key: 'scoreValue', label: 'Value', required: false, description: 'Worth the price?' },
  { key: 'scoreQuality', label: 'Quality', required: false, description: 'Build quality & materials' },
  { key: 'scoreLongevity', label: 'Longevity', required: false, description: 'How well has it held up?' },
  { key: 'scoreExpectations', label: 'Expectations', required: false, description: 'Did it meet your expectations?' },
]

interface ReviewPayload {
  productId?: string
  stage: ReviewStage
  scoreOverall?: number
  bodyText?: string
  pros: string[]
  cons: string[]
  wouldStillBuy?: boolean
  wouldRecommend?: boolean
  [score: string]: unknown
}

export function WriteReviewPage() {
  const { id: productId } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const stage = (searchParams.get('stage') || 'INITIAL') as ReviewStage

  const [scores, setScores] = useState<Record<string, number>>({ scoreOverall: 0 })
  const [bodyText, setBodyText] = useState('')
  const [pros, setPros] = useState<string[]>([''])
  const [cons, setCons] = useState<string[]>([''])
  const [wouldStillBuy, setWouldStillBuy] = useState<boolean | null>(null)
  const [wouldRecommend, setWouldRecommend] = useState<boolean | null>(null)
  const [step, setStep] = useState<'scores' | 'details'>('scores')

  const { data: product } = useQuery<Product>({
    queryKey: ['product', productId],
    queryFn: () => api.get(`/products/${productId}`).then(r => r.data),
  })

  const { mutate: submit, isPending } = useMutation({
    mutationFn: (data: ReviewPayload) => api.post('/reviews', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['threads'] })
      queryClient.invalidateQueries({ queryKey: ['thread', productId] })
      queryClient.invalidateQueries({ queryKey: ['nudges'] })
      navigate(`/products/${productId}/thread`)
    },
  })

  const handleSubmit = () => {
    submit({
      productId,
      stage,
      ...scores,
      bodyText: bodyText || undefined,
      pros: pros.filter(Boolean),
      cons: cons.filter(Boolean),
      wouldStillBuy: wouldStillBuy ?? undefined,
      wouldRecommend: wouldRecommend ?? undefined,
    })
  }

  const canProceed = scores.scoreOverall >= 1

  return (
    <div className="p-8 max-w-2xl mx-auto animate-fade-in">
      {/* Back */}
      <Link to={`/products/${productId}/thread`} className="btn-ghost flex items-center gap-2 mb-6 -ml-2 w-fit">
        <ArrowLeft size={16} /> Back
      </Link>

      {/* Header */}
      <div className="mb-8">
        <span className="stage-badge bg-amber-100 text-amber-700 border border-amber-200 mb-3 inline-flex">
          {STAGE_LABELS[stage]}
        </span>
        <h2 className="font-display text-3xl text-ink-900">
          {stage === 'INITIAL' ? 'First impression?' : 'How has it held up?'}
        </h2>
        {product && (
          <p className="text-ink-500 mt-1">{product.brand} · {product.name}</p>
        )}
      </div>

      {/* Step indicators */}
      <div className="flex gap-2 mb-8">
        {['scores', 'details'].map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={clsx(
              'w-7 h-7 rounded-full text-xs font-medium flex items-center justify-center transition-all',
              step === s
                ? 'bg-ink-900 text-white'
                : i < ['scores', 'details'].indexOf(step)
                  ? 'bg-sage-500 text-white'
                  : 'bg-ink-200 text-ink-500'
            )}>
              {i + 1}
            </div>
            <span className="text-sm text-ink-500 capitalize">{s}</span>
            {i < 1 && <div className="w-8 h-px bg-ink-200" />}
          </div>
        ))}
      </div>

      {/* Step 1: Scores */}
      {step === 'scores' && (
        <div className="space-y-6 animate-fade-in">
          {SCORE_DIMENSIONS.map(dim => (
            <div key={dim.key}>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <label className="label">{dim.label} {dim.required && <span className="text-amber-500">*</span>}</label>
                  <p className="text-xs text-ink-400">{dim.description}</p>
                </div>
                <span className={clsx(
                  'font-display text-2xl w-10 text-right',
                  scores[dim.key] ? 'text-ink-900' : 'text-ink-300'
                )}>
                  {scores[dim.key] || '–'}
                </span>
              </div>
              <ScoreSlider
                value={scores[dim.key] || 0}
                onChange={v => setScores(prev => ({ ...prev, [dim.key]: v }))}
              />
            </div>
          ))}

          <button
            onClick={() => setStep('details')}
            disabled={!canProceed}
            className="btn-primary w-full flex items-center justify-center gap-2 py-3 mt-4"
          >
            Continue <ArrowRight size={16} />
          </button>
        </div>
      )}

      {/* Step 2: Details */}
      {step === 'details' && (
        <div className="space-y-6 animate-fade-in">
          {/* Review text */}
          <div>
            <label className="label">Your review</label>
            <textarea
              className="input resize-none h-32"
              placeholder={stage === 'INITIAL'
                ? "What's your first impression? How does it feel out of the box?"
                : "How has it held up? Has your opinion changed? What surprised you?"
              }
              value={bodyText}
              onChange={e => setBodyText(e.target.value)}
            />
            <p className="text-xs text-ink-400 mt-1">{bodyText.length}/5000</p>
          </div>

          {/* Pros */}
          <div>
            <label className="label">Pros</label>
            <div className="space-y-2">
              {pros.map((pro, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    className="input flex-1"
                    placeholder="e.g. Great battery life"
                    value={pro}
                    onChange={e => {
                      const updated = [...pros]
                      updated[i] = e.target.value
                      setPros(updated)
                    }}
                  />
                  {pros.length > 1 && (
                    <button onClick={() => setPros(pros.filter((_, j) => j !== i))} className="btn-ghost p-2">
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
              {pros.length < 5 && (
                <button onClick={() => setPros([...pros, ''])} className="btn-ghost text-sm flex items-center gap-1">
                  <Plus size={13} /> Add pro
                </button>
              )}
            </div>
          </div>

          {/* Cons */}
          <div>
            <label className="label">Cons</label>
            <div className="space-y-2">
              {cons.map((con, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    className="input flex-1"
                    placeholder="e.g. Loud fan"
                    value={con}
                    onChange={e => {
                      const updated = [...cons]
                      updated[i] = e.target.value
                      setCons(updated)
                    }}
                  />
                  {cons.length > 1 && (
                    <button onClick={() => setCons(cons.filter((_, j) => j !== i))} className="btn-ghost p-2">
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
              {cons.length < 5 && (
                <button onClick={() => setCons([...cons, ''])} className="btn-ghost text-sm flex items-center gap-1">
                  <Plus size={13} /> Add con
                </button>
              )}
            </div>
          </div>

          {/* Would you recommend / buy */}
          {stage !== 'INITIAL' && (
            <div className="grid grid-cols-2 gap-4">
              <BooleanToggle
                label="Would you still buy it?"
                value={wouldStillBuy}
                onChange={setWouldStillBuy}
              />
              <BooleanToggle
                label="Would you recommend it?"
                value={wouldRecommend}
                onChange={setWouldRecommend}
              />
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button onClick={() => setStep('scores')} className="btn-secondary">
              Back
            </button>
            <button
              onClick={handleSubmit}
              disabled={isPending}
              className="btn-primary flex-1 flex items-center justify-center gap-2 py-3"
            >
              {isPending ? 'Submitting...' : 'Submit review'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ScoreSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
        <button
          key={n}
          onClick={() => onChange(n)}
          className={clsx(
            'flex-1 h-10 rounded-lg text-sm font-medium transition-all border',
            value === n
              ? 'bg-ink-900 text-white border-ink-900 scale-105'
              : value >= n
                ? 'bg-ink-200 text-ink-700 border-ink-300 hover:bg-ink-300'
                : 'bg-white text-ink-300 border-ink-200 hover:bg-ink-100'
          )}
        >
          {n}
        </button>
      ))}
    </div>
  )
}

function BooleanToggle({ label, value, onChange }: {
  label: string
  value: boolean | null
  onChange: (v: boolean | null) => void
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex gap-2">
        {([true, false] as const).map(v => (
          <button
            key={String(v)}
            onClick={() => onChange(value === v ? null : v)}
            className={clsx(
              'flex-1 py-2 rounded-xl text-sm font-medium border transition-all',
              value === v
                ? v
                  ? 'bg-sage-600 text-white border-sage-600'
                  : 'bg-red-500 text-white border-red-500'
                : 'bg-white text-ink-600 border-ink-200 hover:bg-ink-50'
            )}
          >
            {v ? 'Yes' : 'No'}
          </button>
        ))}
      </div>
    </div>
  )
}
