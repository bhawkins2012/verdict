import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { api } from '../../lib/api'
import { apiError, formatLeverValue } from '../../lib/levers'
import { AdminProductLevers, LeverValue, PublicLever } from '../../types/levers'
import { SampleBadge } from '../../components/levers/SampleBadge'

export function AdminProductLeversPage() {
  const { id = '' } = useParams<{ id: string }>()
  const { data } = useQuery<AdminProductLevers>({ queryKey: ['admin', 'product-levers', id], queryFn: () => api.get(`/admin/products/${id}/levers`).then((r) => r.data) })
  if (!data) return null
  const cat = data.product.category
  return (
    <div className="p-8 max-w-4xl mx-auto animate-fade-in">
      {cat && <Link to={`/admin/categories/${cat.id}`} className="btn-ghost flex items-center gap-2 mb-4 -ml-2 w-fit"><ArrowLeft size={16} /> {cat.name}</Link>}
      <h2 className="font-display text-3xl text-ink-900">{data.product.name}</h2>
      <p className="text-sm text-ink-500 mb-6">{data.product.brand} · lever values. Every value needs a source: a URL, or "entered by admin".</p>
      {data.levers.length === 0 && <p className="text-ink-500">This product's category has no published levers.</p>}
      <div className="space-y-4">
        {data.levers.map((l) => <ValueForm key={l.id} productId={id} lever={l} current={l.value} />)}
      </div>
    </div>
  )
}

type SourceChoice = '' | 'URL' | 'ADMIN_ENTERED'

function ValueForm({ productId, lever, current }: { productId: string; lever: PublicLever; current: LeverValue | null }) {
  const qc = useQueryClient()
  const [unknown, setUnknown] = useState(false)
  const [number, setNumber] = useState('')
  const [dims, setDims] = useState({ l: '', w: '', h: '' })
  const [oneHand, setOneHand] = useState<'' | 'yes' | 'no'>('')
  const [text, setText] = useState('')
  const [list, setList] = useState('')
  const [bool, setBool] = useState<'' | 'yes' | 'no'>('')
  const [detail, setDetail] = useState('')
  const [source, setSource] = useState<SourceChoice>('') // no default: the admin must choose
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')

  const save = useMutation({
    mutationFn: () => {
      // The source has no default: refuse to send until the admin picks one.
      if (source === '') return Promise.reject(new Error('Choose a source: a URL or "Entered by admin".'))
      const body: Record<string, unknown> = {
        source: source === 'URL' ? { type: 'URL', url } : { type: 'ADMIN_ENTERED' },
        detail: detail || undefined,
        sourceLabel: label || undefined,
      }
      if (unknown) body.unknown = true
      else if (lever.type === 'MEASUREMENT' && lever.inputFormat === 'DIMENSIONS') {
        body.dimensions = { lengthIn: Number(dims.l), widthIn: Number(dims.w), heightIn: Number(dims.h) }
        body.oneHandFold = oneHand === '' ? null : oneHand === 'yes'
      } else if (lever.type === 'MEASUREMENT') body.number = Number(number)
      else if (lever.type === 'CATEGORY') body.text = text
      else if (lever.type === 'COMPATIBILITY_LIST') body.list = list.split('\n').map((s) => s.trim()).filter(Boolean)
      else body.bool = bool === 'yes'
      return api.put(`/admin/products/${productId}/levers/${lever.id}`, body)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'product-levers', productId] }),
  })

  return (
    <form className="card p-4" aria-label={lever.name} onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
      <div className="flex items-baseline gap-2">
        <h3 className="font-medium text-ink-900">{lever.position}. {lever.name}</h3>
        <span className="text-xs text-ink-400">{lever.unit}</span>
      </div>
      <p className="text-xs text-ink-500 mb-2">
        Current: {formatLeverValue(lever, current)}
        {current && <> · {current.source.type === 'URL' ? current.source.url : 'entered by admin'}{current.recordedBy ? ` · ${current.recordedBy}` : ''} · {new Date(current.recordedAt).toLocaleDateString()}</>}
        {current?.isSample && <> <SampleBadge /></>}
      </p>

      <label className="flex items-center gap-2 text-sm mb-2"><input type="checkbox" checked={unknown} onChange={(e) => setUnknown(e.target.checked)} /> Unknown</label>
      {!unknown && (
        <div className="mb-2">
          {lever.type === 'MEASUREMENT' && lever.inputFormat === 'DIMENSIONS' && (
            <div className="flex flex-wrap items-end gap-2">
              {(['l', 'w', 'h'] as const).map((k) => (
                <label key={k}><span className="label">{k === 'l' ? 'Length' : k === 'w' ? 'Width' : 'Height'} (in)</span>
                  <input className="input w-24" inputMode="decimal" required value={dims[k]} onChange={(e) => setDims({ ...dims, [k]: e.target.value })} /></label>
              ))}
              <label><span className="label">One-hand fold</span>
                <select className="input" value={oneHand} onChange={(e) => setOneHand(e.target.value as '' | 'yes' | 'no')}><option value="">Not known</option><option value="yes">Yes</option><option value="no">No</option></select></label>
              <p className="text-xs text-ink-400 w-full">The folded volume (cu ft) is computed from these.</p>
            </div>
          )}
          {lever.type === 'MEASUREMENT' && lever.inputFormat === 'SINGLE' && (
            <label><span className="label">Value ({lever.unit})</span><input className="input w-40" inputMode="decimal" required value={number} onChange={(e) => setNumber(e.target.value)} /></label>
          )}
          {lever.type === 'CATEGORY' && (
            <label><span className="label">Value</span>
              <select className="input w-60" required value={text} onChange={(e) => setText(e.target.value)}>
                <option value="">Choose…</option>
                {lever.allowedValues.map((v) => <option key={v} value={v}>{v}</option>)}
              </select></label>
          )}
          {lever.type === 'COMPATIBILITY_LIST' && (
            <label><span className="label">Compatible items (one per line)</span><textarea className="input" rows={3} required value={list} onChange={(e) => setList(e.target.value)} /></label>
          )}
          {lever.type === 'BOOLEAN' && (
            <label><span className="label">Value</span>
              <select className="input w-40" required value={bool} onChange={(e) => setBool(e.target.value as '' | 'yes' | 'no')}><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option></select></label>
          )}
        </div>
      )}
      <label className="block mb-2"><span className="label">Detail (optional)</span><input className="input" maxLength={300} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>

      <fieldset className="mb-2">
        <legend className="label">Source (required)</legend>
        <label className="mr-4 text-sm"><input type="radio" name={`src-${lever.id}`} required checked={source === 'URL'} onChange={() => setSource('URL')} /> URL</label>
        <label className="text-sm"><input type="radio" name={`src-${lever.id}`} checked={source === 'ADMIN_ENTERED'} onChange={() => setSource('ADMIN_ENTERED')} /> Entered by admin</label>
        {source === 'URL' && <input className="input mt-1" type="url" required placeholder="https://manufacturer.example/spec" value={url} onChange={(e) => setUrl(e.target.value)} />}
        <input className="input mt-1" placeholder="Source label, e.g. Manufacturer spec page (optional)" maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} />
      </fieldset>

      <button className="btn-primary" disabled={save.isPending}>Save value</button>
      {save.isError && <p role="alert" className="text-sm text-red-700 mt-1">{save.error instanceof Error && !('response' in save.error) ? save.error.message : apiError(save.error)}</p>}
      {save.isSuccess && <p className="text-sm text-green-700 mt-1">Saved.</p>}
    </form>
  )
}
