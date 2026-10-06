import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { Product } from '../types'
import { DriftBadge } from '../components/ui/DriftBadge'
import { Search, Plus } from 'lucide-react'
import clsx from 'clsx'

export function DiscoverPage() {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['products', search, category],
    queryFn: () => api.get('/products', { params: { q: search || undefined, category: category || undefined } }).then(r => r.data),
    staleTime: 30_000,
  })

  const { data: categories } = useQuery<{ name: string; count: number }[]>({
    queryKey: ['categories'],
    queryFn: () => api.get('/products/categories/list').then(r => r.data),
  })

  const products: Product[] = data?.products || []

  return (
    <div className="p-8 max-w-5xl mx-auto animate-fade-in">
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
          placeholder="Search products..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Category filters */}
      <div className="flex gap-2 flex-wrap mb-6">
        <button
          onClick={() => setCategory('')}
          className={clsx('stage-badge border cursor-pointer', !category ? 'bg-ink-900 text-white border-ink-900' : 'bg-white text-ink-600 border-ink-200 hover:bg-ink-50')}
        >
          All
        </button>
        {categories?.map((c) => (
          <button
            key={c.name}
            onClick={() => setCategory(c.name === category ? '' : c.name)}
            className={clsx('stage-badge border cursor-pointer capitalize', c.name === category ? 'bg-ink-900 text-white border-ink-900' : 'bg-white text-ink-600 border-ink-200 hover:bg-ink-50')}
          >
            {c.name} <span className="text-ink-400 ml-0.5">({c.count})</span>
          </button>
        ))}
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-3 gap-4">
          {[1,2,3,4,5,6].map(i => <div key={i} className="card h-40 animate-pulse bg-ink-100" />)}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
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
