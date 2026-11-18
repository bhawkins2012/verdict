import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { apiError } from '../../lib/levers'
import { AdminCategorySummary, AdminConfig } from '../../types/levers'

export function AdminCategoriesPage() {
  const qc = useQueryClient()
  const { data: categories } = useQuery<AdminCategorySummary[]>({ queryKey: ['admin', 'categories'], queryFn: () => api.get('/admin/categories').then((r) => r.data) })
  const { data: config } = useQuery<AdminConfig>({ queryKey: ['admin', 'config'], queryFn: () => api.get('/admin/config').then((r) => r.data) })
  const [name, setName] = useState('')
  const [terms, setTerms] = useState('')
  const create = useMutation({
    mutationFn: () => api.post('/admin/categories', {
      name, searchTerms: terms.split(',').map((t) => t.trim()).filter(Boolean),
    }),
    onSuccess: () => { setName(''); setTerms(''); void qc.invalidateQueries({ queryKey: ['admin', 'categories'] }) },
  })

  return (
    <div className="p-8 max-w-5xl mx-auto animate-fade-in">
      <h2 className="font-display text-3xl text-ink-900">Admin: categories and value levers</h2>
      {config && <ConfigNote config={config} />}

      <table className="w-full text-sm mt-6 card overflow-hidden">
        <thead className="bg-ink-50 text-left text-ink-500">
          <tr><th className="p-3">Category</th><th className="p-3">Levers</th><th className="p-3">Candidates</th><th className="p-3">Products</th><th className="p-3">Status</th></tr>
        </thead>
        <tbody>
          {categories?.map((c) => (
            <tr key={c.id} className="border-t border-ink-100">
              <td className="p-3"><Link className="font-medium text-ink-900 underline" to={`/admin/categories/${c.id}`}>{c.name}</Link> <span className="text-ink-400">/{c.slug}</span></td>
              <td className="p-3">{c.approvedCount} / 5</td>
              <td className="p-3">{c.candidateCount}</td>
              <td className="p-3">{c.productCount}</td>
              <td className="p-3">{c.leversPublishedAt ? <span className="text-green-700">Published</span> : <span className="text-ink-400">Hidden (no published levers)</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="card p-4 mt-6 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate() }}>
        <label className="flex-1 min-w-48"><span className="label">New category name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Car seats" required minLength={2} maxLength={60} /></label>
        <label className="flex-1 min-w-48"><span className="label">Search terms (comma separated)</span>
          <input className="input" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="car seat, infant seat" /></label>
        <button className="btn-primary" disabled={create.isPending}>Create category</button>
        {create.isError && <p role="alert" className="w-full text-sm text-red-700">{apiError(create.error)}</p>}
      </form>
    </div>
  )
}

export function ConfigNote({ config }: { config: AdminConfig }) {
  return (
    <p className="text-sm mt-2 text-ink-500" data-testid="generation-mode">
      Generation: {config.mode === 'live'
        ? <><strong className="text-ink-800">live</strong> ({config.model}), at most {config.dailyLimit} live runs per 24 h, {config.maxTokens} max tokens per run</>
        : <><strong className="text-ink-800">dry run</strong>: fixture candidates, no API call. Set LEVER_GEN_MODE=live and ANTHROPIC_API_KEY to call Claude.</>}
    </p>
  )
}
