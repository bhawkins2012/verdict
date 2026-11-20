// Brand domains (docs/adr-generation-run.md section 5 A1): the allow-list. Domains that failed the automatic
// check wait here for one click per brand, ever; confirming one processes the products waiting on it.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { api } from '../../lib/api'
import { apiError } from '../../lib/levers'
import { BrandDomainRow } from '../../types/levers'

export function AdminBrandsPage() {
  const qc = useQueryClient()
  const { data } = useQuery<BrandDomainRow[]>({ queryKey: ['admin', 'brands'], queryFn: () => api.get('/admin/brands').then((r) => r.data) })
  const done = () => { void qc.invalidateQueries({ queryKey: ['admin'] }) }
  const confirm = useMutation({ mutationFn: (id: string) => api.post(`/admin/brands/${id}/confirm`), onSuccess: done })
  const reject = useMutation({ mutationFn: (id: string) => api.post(`/admin/brands/${id}/reject`), onSuccess: done })
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/admin/brands/${id}`), onSuccess: done })
  if (!data) return null
  const pending = data.filter((b) => b.status === 'PENDING_CONFIRMATION')
  const verified = data.filter((b) => b.status === 'VERIFIED')
  const rejected = data.filter((b) => b.status === 'REJECTED')
  const error = confirm.error ?? reject.error ?? remove.error

  return (
    <div className="p-8 max-w-5xl mx-auto animate-fade-in">
      <Link to="/admin" className="btn-ghost flex items-center gap-2 mb-4 -ml-2 w-fit"><ArrowLeft size={16} /> Catalog</Link>
      <h2 className="font-display text-3xl text-ink-900">Brand domains</h2>
      <p className="text-sm text-ink-600 mt-1">
        Values come only from verified brand domains. A domain is verified automatically when it is https, not a retailer or review site,
        contains the brand name, and its home page names the brand; otherwise it waits here. Confirm only the brand's own official site.
      </p>
      {error && <p role="alert" className="text-sm text-red-700 mt-2">{apiError(error)}</p>}

      <section className="mt-6" aria-label="Confirm brand domain">
        <h3 className="font-medium text-ink-800 mb-2">Confirm brand domain ({pending.length})</h3>
        {pending.length === 0 && <p className="text-sm text-ink-500">Nothing waiting.</p>}
        <ul className="space-y-2">
          {pending.map((b) => (
            <li key={b.id} className="card p-3 text-sm" data-testid={`brand-${b.host}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink-900">{b.brand}</span>
                <a className="underline" href={`https://${b.host}/`} target="_blank" rel="noopener noreferrer nofollow">{b.host}</a>
                <span className="ml-auto flex gap-1">
                  <button className="btn-primary text-xs" disabled={confirm.isPending} onClick={() => confirm.mutate(b.id)}>Confirm as {b.brand}'s domain</button>
                  <button className="btn-ghost text-xs" disabled={reject.isPending} onClick={() => reject.mutate(b.id)}>Reject</button>
                </span>
              </div>
              <p className="text-xs text-amber-900 mt-1">Automatic check failed: {b.checkResult?.failed ?? 'unknown reason'}</p>
              {b.checkResult?.siteNames && b.checkResult.siteNames.length > 0 && <p className="text-xs text-ink-500">Site names on its home page: {b.checkResult.siteNames.join(', ')}</p>}
              {b.waitingProducts.length > 0 && <p className="text-xs text-ink-500">Waiting: {b.waitingProducts.join(', ')}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8" aria-label="Verified domains">
        <h3 className="font-medium text-ink-800 mb-2">Verified ({verified.length})</h3>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-ink-400"><tr><th>Brand</th><th>Host</th><th>How</th><th></th></tr></thead>
          <tbody>
            {verified.map((b) => (
              <tr key={b.id} className="border-t border-ink-100">
                <td className="py-1">{b.brand}</td><td>{b.host}</td>
                <td className="text-xs text-ink-500">{b.verifiedVia === 'AUTOMATIC' ? 'automatic' : `confirmed by ${b.verifiedBy ?? 'an admin'}`}{b.verifiedAt ? `, ${new Date(b.verifiedAt).toLocaleDateString()}` : ''}</td>
                <td className="text-right"><button className="btn-ghost text-xs" onClick={() => remove.mutate(b.id)}>Remove<span className="sr-only"> {b.host}</span></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {rejected.length > 0 && <p className="text-xs text-ink-500 mt-4">Rejected: {rejected.map((b) => `${b.host} (${b.brand})`).join(', ')}</p>}
    </div>
  )
}
