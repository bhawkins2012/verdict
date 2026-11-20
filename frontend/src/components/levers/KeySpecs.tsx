import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { formatLeverValue, formatNumber } from '../../lib/levers'
import { ProductLever } from '../../types/levers'

/** The node's five published levers with this product's values, each with its evidence quote and source. */
export function KeySpecs({ levers, node }: { levers: ProductLever[]; node?: { slug: string; name: string } | null }) {
  if (levers.length === 0) return null
  return (
    <section className="card p-4 md:p-6 mb-6" aria-label="Key specs">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="font-medium text-ink-800">Key specs</h3>
        {node && <Link to={`/categories/${node.slug}`} className="text-xs text-ink-500 hover:text-ink-800">Compare {node.name.toLowerCase()}</Link>}
      </div>
      <dl className="divide-y divide-ink-100">
        {levers.map(({ lever, value, typical }) => (
          <div key={lever.id} className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-1 sm:gap-3">
            <dt className="text-sm text-ink-600">
              <span className="font-medium text-ink-900">{lever.name}</span>
              <span className="block text-xs text-ink-400 leading-snug">{lever.explanation}</span>
            </dt>
            <dd className="sm:col-span-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-ink-900">{formatLeverValue(lever, value)}</span>
                {typical !== null && <span className="text-xs text-ink-400">typical {formatNumber(typical)} {lever.unit}</span>}
                {!value.unknown && value.evidence.adminAttested && (
                  <span className="text-[10px] uppercase tracking-wide bg-ink-100 text-ink-600 px-1.5 py-0.5 rounded" title="Entered by an admin; the manufacturer's site blocked an automatic check of the quote">Admin-attested</span>
                )}
              </div>
              {!value.unknown && value.detail && <p className="text-xs text-ink-500 mt-0.5">{value.detail}</p>}
              {!value.unknown && value.evidence.quote && (
                <p className="text-xs text-ink-500 mt-1">
                  From the manufacturer: “{value.evidence.quote}”
                  {value.evidence.url && (
                    <> <a href={value.evidence.url} target="_blank" rel="noopener noreferrer nofollow" className="underline inline-flex items-center gap-0.5 break-all">
                      {new URL(value.evidence.url).hostname}<ExternalLink size={10} />
                    </a></>
                  )}
                </p>
              )}
              {value.unknown && <p className="text-xs text-ink-400 mt-0.5">Not stated by the manufacturer.</p>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
