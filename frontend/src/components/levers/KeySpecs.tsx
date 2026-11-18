import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { formatLeverValue, formatNumber } from '../../lib/levers'
import { ProductLever } from '../../types/levers'
import { SampleBadge } from './SampleBadge'

/** The category's five published levers with this product's values and where each value came from. */
export function KeySpecs({ levers, categorySlug }: { levers: ProductLever[]; categorySlug?: string }) {
  if (levers.length === 0) return null
  return (
    <section className="card p-6 mb-6" aria-label="Key specs">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="font-medium text-ink-800">Key specs</h3>
        {categorySlug && <Link to={`/categories/${categorySlug}`} className="text-xs text-ink-500 hover:text-ink-800">Compare in category</Link>}
      </div>
      <dl className="divide-y divide-ink-100">
        {levers.map(({ lever, value, typical }) => (
          <div key={lever.id} className="py-3 grid grid-cols-3 gap-3">
            <dt className="text-sm text-ink-600">
              <span className="font-medium text-ink-900">{lever.name}</span>
              <span className="block text-xs text-ink-400 leading-snug">{lever.explanation}</span>
            </dt>
            <dd className="col-span-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-ink-900">{formatLeverValue(lever, value)}</span>
                {typical !== null && (
                  <span className="text-xs text-ink-400">category typical {formatNumber(typical)} {lever.unit}</span>
                )}
                {value?.isSample && <SampleBadge />}
              </div>
              {value?.detail && <p className="text-xs text-ink-500 mt-0.5">{value.detail}</p>}
              {value && (
                <p className="text-xs text-ink-400 mt-0.5">
                  Source:{' '}
                  {value.source.type === 'URL' && value.source.url ? (
                    <a href={value.source.url} target="_blank" rel="noopener noreferrer nofollow" className="underline inline-flex items-center gap-0.5">
                      {value.source.label || new URL(value.source.url).hostname} <ExternalLink size={10} />
                    </a>
                  ) : (
                    <span>Entered by admin{value.source.label ? ` (${value.source.label})` : ''}</span>
                  )}
                </p>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
