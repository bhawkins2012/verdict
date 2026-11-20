import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { Product } from '../types'
import { DriftBadge } from '../components/ui/DriftBadge'
import { Search, Plus, ArrowRight, Clock } from 'lucide-react'
import { BrowseNode, SearchResult } from '../types/levers'

export function DiscoverPage() {
  const [search, setSearch] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['products', search],
    queryFn: () => api.get('/products', { params: { q: search || undefined } }).then(r => r.data),
    staleTime: 30_000,
  })

  // Browse: the visible taxonomy (published decision nodes and the navigation nodes above them).
  const { data: tree } = useQuery<BrowseNode[]>({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then(r => r.data),
  })
  const decisions: BrowseNode[] = []
  const collect = (n: BrowseNode) => { if (n.kind === 'DECISION') decisions.push(n); n.children.forEach(collect) }
  tree?.forEach(collect)

  // Search matches taxonomy nodes first, including ones still being prepared (product spec, "Search").
  const term = search.trim()
  const { data: hits } = useQuery<SearchResult>({
    queryKey: ['category-search', term],
    queryFn: () => api.get('/categories/search', { params: { q: term } }).then(r => r.data),
    enabled: term.length >= 2,
    staleTime: 30_000,
  })

  const products: Product[] = data?.products || []

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="font-display text-3xl text-ink-900">Discover</h2>
          <p className="text-ink-500 mt-1">Find products to track and review.</p>
        </div>
        <button className="btn-primary flex items-center gap-2">
          <Plus size={15} /> Add product
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          className="input pl-10"
          placeholder="Search categories and products..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Taxonomy nodes matching the search come first */}
      {term.length >= 2 && hits && hits.nodes.length > 0 && (
        <div className="space-y-2 mb-6" aria-label="Matching categories">
          {hits.nodes.map((c) => c.published ? (
            <Link key={c.slug} to={`/categories/${c.slug}`} className="card p-4 block hover:shadow-md transition-shadow">
              <span className="flex items-center gap-3">
                <span className="font-medium text-ink-900">{c.name}</span>
                <span className="text-sm text-ink-500">{c.kind === 'NAVIGATION' ? `Which kind of ${c.name.toLowerCase().replace(/s$/, '')}?` : 'Compare by the five things that matter most'}</span>
                <ArrowRight size={16} className="ml-auto text-ink-400" />
              </span>
              {c.explainer && <span className="block text-sm text-ink-600 mt-1">{c.explainer}</span>}
              {c.children.length > 0 && <span className="block text-xs text-ink-500 mt-1">{c.children.map((ch) => ch.name).join(' · ')}</span>}
            </Link>
          ) : (
            <div key={c.slug} className="card p-4 flex flex-wrap items-center gap-3 bg-ink-50">
              <Clock size={16} className="text-ink-400" />
              <span className="font-medium text-ink-700">{c.name}</span>
              <span className="text-sm text-ink-500">This category is being prepared. Check back soon.</span>
            </div>
          ))}
        </div>
      )}

      {/* Browse: the decision nodes that are live */}
      <div className="flex gap-2 flex-wrap mb-6">
        {decisions.map((c) => (
          <Link
            key={c.slug}
            to={`/categories/${c.slug}`}
            className="stage-badge border cursor-pointer bg-white text-ink-600 border-ink-200 hover:bg-ink-50"
          >
            {c.name} <span className="text-ink-400 ml-0.5">({c.productCount ?? 0})</span>
          </Link>
        ))}
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {[1,2,3,4,5,6].map(i => <div key={i} className="card h-40 animate-pulse bg-ink-100" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {products.map(product => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProductCard({ product }: { product: Product }) {
  return (
    <Link to={`/products/${product.id}`} className="card p-4 hover:shadow-md transition-shadow group">
      <div className="w-full h-28 bg-ink-100 rounded-xl mb-3 overflow-hidden">
        {product.imageUrl ? (
          <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-4xl text-ink-200 font-display">
            {product.name[0]}
          </div>
        )}
      </div>
      <p className="text-xs text-ink-400 capitalize">{product.brand}</p>
      <p className="font-medium text-ink-900 text-sm leading-tight group-hover:text-ink-700 line-clamp-2">{product.name}</p>
      <div className="flex items-center gap-2 mt-2">
        {product.avgRatingLongterm != null && (
          <span className="font-mono text-sm text-ink-700">{product.avgRatingLongterm.toFixed(1)}</span>
        )}
        {product.driftScoreAvg != null && <DriftBadge drift={product.driftScoreAvg} size="sm" />}
        <span className="text-xs text-ink-400 ml-auto">{product.totalReviewCount} reviews</span>
      </div>
    </Link>
  )
}
