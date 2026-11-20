import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ChevronRight, Info, SlidersHorizontal } from 'lucide-react'
import { api } from '../lib/api'
import { apiError, filterParams, formatLeverValue, formatNumber, isActive } from '../lib/levers'
import { DryRunBadge } from '../components/levers/DryRunBadge'
import { Crumb, DecisionPageData, LeverFilter, NavigationPageData, NodePageData, PublicLever, FilterOptions } from '../types/levers'

/** Filter state as typed: min and max stay text, so "1." and "1.5" can be entered. */
type RawFilter = Omit<LeverFilter, 'min' | 'max'> & { min?: string; max?: string }

function numberOrUndefined(s: string | undefined): number | undefined {
  if (s === undefined || s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

function toApiFilters(raw: Record<string, RawFilter>): Record<string, LeverFilter> {
  const out: Record<string, LeverFilter> = {}
  for (const [id, f] of Object.entries(raw)) {
    const parsed: LeverFilter = { ...f, min: numberOrUndefined(f.min), max: numberOrUndefined(f.max) }
    if (isActive(parsed)) out[id] = parsed
  }
  return out
}

/** The value, `ms` after it last changed (typing in a min/max box sends one request, not one per key). */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

/** A taxonomy node: a navigation node (how its children differ) or a decision node (five lever filters). */
export function CategoryPage() {
  const { slug } = useParams<{ slug: string }>()
  const [filters, setFilters] = useState<Record<string, RawFilter>>({})

  const active = useDebounced(toApiFilters(filters), 300)
  const { data, error, isFetching } = useQuery<NodePageData>({
    queryKey: ['category', slug, active],
    queryFn: () => api.get(`/categories/${slug}?${filterParams(active).toString()}`).then((r) => r.data),
    placeholderData: keepPreviousData,
    retry: false,
  })

  if (error && !data) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto">
        <Link to="/discover" className="btn-ghost flex items-center gap-2 mb-6 -ml-2 w-fit"><ArrowLeft size={16} /> Discover</Link>
        <p className="text-ink-600">{apiError(error, 'This category is not available.')}</p>
      </div>
    )
  }
  if (!data || data.slug !== slug) return null
  return data.kind === 'NAVIGATION'
    ? <NavigationPage data={data} />
    : <DecisionPage data={data} filters={filters} setFilters={setFilters} isFetching={isFetching} />
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-xs text-ink-500 mb-3">
      <ol className="flex flex-wrap items-center gap-1">
        <li><Link to="/discover" className="hover:text-ink-800">Discover</Link></li>
        {crumbs.map((c, i) => (
          <li key={c.slug} className="flex items-center gap-1">
            <ChevronRight size={12} aria-hidden="true" />
            {i === crumbs.length - 1 || !c.visible
              ? <span aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.name}</span>
              : <Link to={`/categories/${c.slug}`} className="hover:text-ink-800">{c.name}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  )
}

function NavigationPage({ data }: { data: NavigationPageData }) {
  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto animate-fade-in">
      <Breadcrumbs crumbs={data.breadcrumbs} />
      <h2 className="font-display text-3xl text-ink-900">{data.name}</h2>
      {data.explainer && <p className="text-ink-600 mt-2 max-w-3xl">{data.explainer}</p>}
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6" aria-label={`Kinds of ${data.name.toLowerCase()}`}>
        {data.children.map((c) => (
          <li key={c.slug}>
            <Link to={`/categories/${c.slug}`} className="card p-4 block hover:shadow-md transition-shadow h-full">
              <span className="font-medium text-ink-900">{c.name}</span>
              {c.line && <span className="block text-sm text-ink-600 mt-1">{c.line}</span>}
              <span className="block text-xs text-ink-400 mt-2">
                {c.kind === 'DECISION' ? `${c.productCount ?? 0} products compared` : 'More kinds inside'}{c.alsoListed ? ' · also listed here' : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DecisionPage({ data, filters, setFilters, isFetching }: {
  data: DecisionPageData; filters: Record<string, RawFilter>; setFilters: (f: Record<string, RawFilter>) => void; isFetching: boolean
}) {
  const [showFilters, setShowFilters] = useState(false)
  const setFilter = (id: string, f: RawFilter) => setFilters({ ...filters, [id]: f })
  const activeCount = Object.keys(toApiFilters(filters)).length

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto animate-fade-in">
      <Breadcrumbs crumbs={data.breadcrumbs} />
      <h2 className="font-display text-3xl text-ink-900">{data.name}</h2>
      <p className="text-ink-500 mt-1 mb-4">The five things that most decide which one is right for you.</p>

      {/* Phones: the filters collapse behind one button. */}
      <button type="button" className="btn-secondary w-full flex items-center justify-center gap-2 mb-3 md:hidden" aria-expanded={showFilters} aria-controls="lever-filters"
        onClick={() => setShowFilters((o) => !o)}>
        <SlidersHorizontal size={15} /> Filters{activeCount > 0 ? ` (${activeCount})` : ''}
      </button>
      <section id="lever-filters" aria-label="Filters" className={clsx('grid grid-cols-1 md:grid-cols-5 gap-3 mb-4', !showFilters && 'hidden md:grid')}>
        {data.levers.map((lever) => (
          <div key={lever.id} className="card p-3">
            <p className="text-sm font-medium text-ink-900">{lever.name}</p>
            <p className="text-xs text-ink-500 mt-0.5 mb-2 leading-snug">{lever.explanation}</p>
            <LeverFilterControl lever={lever} options={lever.options} value={filters[lever.id] ?? {}} onChange={(f) => setFilter(lever.id, f)} />
          </div>
        ))}
      </section>

      <div className="flex flex-wrap items-center gap-3 mb-4 text-sm text-ink-500">
        <span data-testid="result-count">{data.products.length} of {data.total} products</span>
        {activeCount > 0 && <button className="btn-ghost text-sm" onClick={() => setFilters({})}>Clear filters</button>}
        {isFetching && <span className="text-xs">Updating…</span>}
        <span className="sm:ml-auto flex items-center gap-1 text-xs"><Info size={12} /> Sorted by name. Best Fit ranking is coming.</span>
      </div>
      {activeCount > 0 && <p className="text-xs text-ink-400 mb-3">Products with an unknown value for a filtered lever are not shown.</p>}

      <div className="space-y-3">
        {data.products.map((p) => (
          <Link key={p.id} to={`/products/${p.id}`} className="card p-4 block hover:shadow-md transition-shadow">
            <div className="flex flex-wrap items-baseline gap-2">
              <p className="font-medium text-ink-900">{p.name}</p>
              <p className="text-xs text-ink-400">{p.brand}</p>
              {p.isDryRun && <DryRunBadge />}
              {p.alsoListed && <span className="text-[11px] text-ink-400">also listed here</span>}
            </div>
            <dl className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-2">
              {data.levers.map((l) => (
                <div key={l.id}>
                  <dt className="text-[11px] uppercase tracking-wide text-ink-400">{l.name}</dt>
                  <dd className="text-sm text-ink-700">{formatLeverValue(l, p.values[l.id])}</dd>
                </div>
              ))}
            </dl>
          </Link>
        ))}
        {data.products.length === 0 && <p className="text-ink-500">No products match these filters.</p>}
      </div>
    </div>
  )
}

function LeverFilterControl({ lever, options, value, onChange }: {
  lever: PublicLever; options: FilterOptions; value: RawFilter; onChange: (f: RawFilter) => void
}) {
  switch (lever.type) {
    case 'MEASUREMENT': {
      const range = options && 'min' in options ? options : null
      const unitLabel = lever.inputFormat === 'DIMENSIONS' ? `${lever.unit}, folded volume` : lever.unit
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <input aria-label={`${lever.name} minimum`} className="input py-1 px-2 text-xs" inputMode="decimal"
              placeholder={range ? `min ${formatNumber(range.min)}` : 'min'} value={value.min ?? ''}
              onChange={(e) => onChange({ ...value, min: e.target.value })} />
            <input aria-label={`${lever.name} maximum`} className="input py-1 px-2 text-xs" inputMode="decimal"
              placeholder={range ? `max ${formatNumber(range.max)}` : 'max'} value={value.max ?? ''}
              onChange={(e) => onChange({ ...value, max: e.target.value })} />
          </div>
          <p className="text-[11px] text-ink-400">{unitLabel}</p>
          {lever.inputFormat === 'DIMENSIONS' && (
            <label className="flex items-center gap-1 text-xs text-ink-600">
              <input type="checkbox" checked={value.is === 'yes'} onChange={(e) => onChange({ ...value, is: e.target.checked ? 'yes' : undefined })} />
              One-hand fold
            </label>
          )}
        </div>
      )
    }
    case 'CATEGORY':
      return (
        <div className="space-y-0.5">
          {lever.allowedValues.map((v) => {
            const checked = value.in?.includes(v) ?? false
            return (
              <label key={v} className="flex items-center gap-1 text-xs text-ink-700">
                <input type="checkbox" checked={checked}
                  onChange={(e) => onChange({ ...value, in: e.target.checked ? [...(value.in ?? []), v] : (value.in ?? []).filter((x) => x !== v) })} />
                {v}
              </label>
            )
          })}
        </div>
      )
    case 'COMPATIBILITY_LIST': {
      const values = options && 'values' in options ? options.values : []
      return (
        <select aria-label={lever.name} className="input py-1 px-2 text-xs" value={value.has ?? ''}
          onChange={(e) => onChange({ has: e.target.value || undefined })}>
          <option value="">Any</option>
          {values.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      )
    }
    case 'BOOLEAN':
      return (
        <select aria-label={lever.name} className="input py-1 px-2 text-xs" value={value.is ?? ''}
          onChange={(e) => onChange({ is: e.target.value === 'yes' || e.target.value === 'no' ? e.target.value : undefined })}>
          <option value="">Any</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      )
  }
}
