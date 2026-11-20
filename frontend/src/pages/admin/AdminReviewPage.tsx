// The review screen (docs/adr-generation-run.md D9, section 5 A1): one page, three steps.
// - Products: approval is automatic; this lists the exceptions (needs attention) and lets the admin approve,
//   reject or unlist before publishing.
// - Levers: the PR #13 drag-and-drop board, each card with its data coverage.
// - Values: the chosen five × approved products, with the evidence beside each value. Keyboard first:
//   arrows move, A accept, R reject, U unknown, E edit, Enter accept and go to the next unreviewed value,
//   N next unreviewed, ? the list. Safety levers are never bulk-accepted.
// Desktop-first (mouse and keyboard); not built for touch.
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import clsx from 'clsx'
import { api } from '../../lib/api'
import { apiError, formatLeverValue } from '../../lib/levers'
import { initialSet, pruneSet } from '../../lib/publishSet'
import { BoardLever, ReviewData, ReviewProduct, ReviewValue, TypedValue } from '../../types/levers'
import { PublishBoard } from '../../components/levers/PublishBoard'
import { LeverForm } from '../../components/levers/LeverForm'
import { CHECK_LABEL, OUTCOME_LABEL, RunStatusBadge, usd } from './adminUi'

type Step = 'products' | 'levers' | 'values'

export function AdminReviewPage() {
  const { id = '' } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const key = ['admin', 'review', id]
  const { data } = useQuery<ReviewData>({
    queryKey: key,
    queryFn: () => api.get(`/admin/nodes/${id}/review`).then((r) => r.data),
    refetchInterval: (q) => (q.state.data?.run?.status === 'ACTIVE' || (q.state.data?.run?.items.PENDING ?? 0) > 0 ? 2000 : false),
  })
  const refresh = () => qc.invalidateQueries({ queryKey: key })
  const [step, setStep] = useState<Step>('products')
  const [edited, setEdited] = useState<string[] | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const publish = useMutation({
    mutationFn: (leverIds: string[]) => api.post(`/admin/nodes/${id}/publish`, { leverIds }),
    onSuccess: async () => { await refresh(); setEdited(null) },
  })

  if (!data) return null
  const live = data.levers.filter((l) => l.status !== 'RETIRED')
  const set = pruneSet(edited ?? initialSet(data.levers), data.levers)
  const chosen = set.map((sid) => live.find((l) => l.id === sid)).filter((l): l is BoardLever => !!l)
  const p = data.progress.products
  const steps: { id: Step; label: string; detail: string }[] = [
    { id: 'products', label: 'Products', detail: `${p.APPROVED} approved · ${p.NEEDS_ATTENTION} need attention` },
    { id: 'levers', label: 'Levers', detail: `${set.length} of 5 chosen · ${live.length} candidates` },
    { id: 'values', label: 'Values', detail: `${data.progress.values.reviewed} of ${data.progress.values.total} reviewed` },
  ]
  const publishStatus = <>
    {publish.isError && <p role="alert" className="text-sm text-red-700 mt-2">{apiError(publish.error)}</p>}
    {publish.isSuccess && <p className="text-sm text-green-700 mt-2">Published: the node, its five levers, the listed products and their values are live.</p>}
  </>

  return (
    <div className="p-8 max-w-[1400px] mx-auto animate-fade-in">
      <Link to={`/admin/nodes/${id}`} className="btn-ghost flex items-center gap-2 mb-3 -ml-2 w-fit"><ArrowLeft size={16} /> {data.node.name}</Link>
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-display text-3xl text-ink-900">Review: {data.node.name}</h2>
        {data.run && <RunStatusBadge status={data.run.status} />}
        {data.run && <span className="text-xs text-ink-500">{data.run.mode === 'LIVE' ? 'live' : 'dry run'} · cost {usd(data.run.costUsd)}</span>}
        {data.node.safetyCritical && <span className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-800">Safety-critical: every value is reviewed one by one</span>}
        {data.node.publishedAt && <Link className="text-xs underline" to={`/categories/${data.node.slug}`}>public page</Link>}
      </div>
      {data.run?.warning && <p className="text-sm text-amber-800 mt-1">{data.run.warning}</p>}
      <p className="sr-only" aria-live="polite">{announce}</p>

      <div className="grid grid-cols-[220px_1fr] gap-6 mt-6">
        <nav aria-label="Review steps">
          <ol className="space-y-1">
            {steps.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  aria-current={step === s.id ? 'step' : undefined}
                  className={clsx('w-full text-left rounded-lg px-3 py-2', step === s.id ? 'bg-ink-900 text-white' : 'hover:bg-ink-100')}
                  onClick={() => setStep(s.id)}
                >
                  <span className="text-sm font-medium">{i + 1}. {s.label}</span>
                  <span className={clsx('block text-xs', step === s.id ? 'text-ink-200' : 'text-ink-500')}>{s.detail}</span>
                </button>
              </li>
            ))}
          </ol>
          <Gate data={data} chosen={chosen} />
        </nav>

        <div className="min-w-0">
          {step === 'products' && <ProductsStep data={data} onChange={() => void refresh()} announce={setAnnounce} />}
          {step === 'levers' && (
            <section aria-label="Levers">
              <p className="text-sm text-ink-600 mb-3">
                Drag five levers into the publish set and put them in order (or use each card's Actions menu). The count on each card is how many
                approved products have a value for it ({'"'}accepted{'"'} once reviewed); publishing needs 80% accepted on each of the five.
              </p>
              <PublishBoard
                levers={live}
                set={set}
                onSetChange={setEdited}
                onPublish={(ids) => publish.mutate(ids)}
                publishing={publish.isPending}
                lockedIds={editingId ? new Set([editingId]) : undefined}
                renderControls={(lever) => (
                  <LeverControls lever={lever} editing={editingId === lever.id} onToggleEdit={() => setEditingId((c) => (c === lever.id ? null : lever.id))}
                    onChanged={() => { setEditingId(null); void refresh() }} />
                )}
                publishStatus={publishStatus}
              />
              <AddLever nodeId={id} onDone={() => void refresh()} />
            </section>
          )}
          {step === 'values' && (
            <ValuesStep data={data} chosen={chosen} onChange={() => void refresh()} announce={setAnnounce}
              onPublish={() => publish.mutate(set)} publishing={publish.isPending} publishStatus={publishStatus} />
          )}
        </div>
      </div>
    </div>
  )
}

/** The publish gate, per chosen lever, always in view. */
function Gate({ data, chosen }: { data: ReviewData; chosen: BoardLever[] }) {
  const products = data.progress.products.APPROVED
  return (
    <div className="card p-3 mt-4 text-xs" aria-label="Publish gate">
      <p className="font-medium text-ink-800 mb-1">Publish gate</p>
      <p className={clsx(products >= data.config.minProducts ? 'text-green-800' : 'text-amber-800')}>{products} approved products (at least {data.config.minProducts})</p>
      {chosen.length < 5 && <p className="text-amber-800">{chosen.length} of 5 levers chosen</p>}
      <ul className="mt-1 space-y-0.5">
        {chosen.map((l) => {
          const ok = products > 0 && l.coverage.accepted * 5 >= products * 4
          return <li key={l.id} className={ok ? 'text-green-800' : 'text-amber-800'}>{l.name}: {l.coverage.accepted} of {products} accepted {ok ? '✓' : `(needs ${Math.ceil(products * 0.8)})`}</li>
        })}
      </ul>
    </div>
  )
}

// ── Products ────────────────────────────────────────────────────────────────────────────────────────
type ProductFilter = 'NEEDS_ATTENTION' | 'APPROVED' | 'REJECTED' | 'ALL'

function ProductsStep({ data, onChange, announce }: { data: ReviewData; onChange: () => void; announce: (s: string) => void }) {
  const [filter, setFilter] = useState<ProductFilter>(data.progress.products.NEEDS_ATTENTION > 0 ? 'NEEDS_ATTENTION' : 'APPROVED')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState(0)
  const rowsRef = useRef<(HTMLTableRowElement | null)[]>([])
  const rows = data.products.filter((p) => filter === 'ALL' || p.status === filter || (filter === 'NEEDS_ATTENTION' && p.status === 'PROPOSED'))
  const decide = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: 'approve' | 'reject' }) => api.post(`/admin/products/${action}`, { productIds: ids }),
    onSuccess: (_r, v) => { announce(`${v.action === 'approve' ? 'Approved' : 'Rejected'} ${v.ids.length} product${v.ids.length === 1 ? '' : 's'}`); setSelected(new Set()); onChange() },
  })
  useEffect(() => { rowsRef.current[focus]?.focus() }, [focus])

  const onKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const row = rows[focus]
    const go = (d: number) => { e.preventDefault(); setFocus((f) => Math.max(0, Math.min(rows.length - 1, f + d))) }
    if (e.key === 'ArrowDown' || e.key === 'j') go(1)
    else if (e.key === 'ArrowUp' || e.key === 'k') go(-1)
    else if (row && e.key === 'a') { e.preventDefault(); decide.mutate({ ids: [row.id], action: 'approve' }) }
    else if (row && e.key === 'r') { e.preventDefault(); decide.mutate({ ids: [row.id], action: 'reject' }) }
    else if (row && e.key === 'x') { e.preventDefault(); toggle(row.id) }
  }
  const toggle = (pid: string) => setSelected((s) => { const n = new Set(s); if (n.has(pid)) n.delete(pid); else n.add(pid); return n })

  return (
    <section aria-label="Products">
      <p className="text-sm text-ink-600 mb-3">
        Products are approved automatically when every check passes (verified brand domain, page fetched, model named, belongs here, not a duplicate).
        The rest are listed here with the check that failed. Approve, reject or leave them; nothing is listed publicly until you publish.
      </p>
      <div className="flex flex-wrap items-center gap-2 mb-3" role="group" aria-label="Show">
        {(['NEEDS_ATTENTION', 'APPROVED', 'REJECTED', 'ALL'] as ProductFilter[]).map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} className={clsx('px-2 py-1 rounded text-xs', filter === f ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700')}
            onClick={() => { setFilter(f); setFocus(0) }}>
            {f === 'NEEDS_ATTENTION' ? `Needs attention (${data.progress.products.NEEDS_ATTENTION + data.progress.products.PROPOSED})` : f === 'ALL' ? `All (${data.products.length})` : `${f.charAt(0)}${f.slice(1).toLowerCase()} (${data.progress.products[f]})`}
          </button>
        ))}
        <span className="ml-auto flex gap-2">
          <button className="btn-secondary text-xs" disabled={selected.size === 0} onClick={() => decide.mutate({ ids: [...selected], action: 'approve' })}>Approve selected ({selected.size})</button>
          <button className="btn-ghost text-xs" disabled={selected.size === 0} onClick={() => decide.mutate({ ids: [...selected], action: 'reject' })}>Reject selected</button>
        </span>
      </div>
      <p className="text-xs text-ink-400 mb-2">Keys: ↑/↓ or J/K move · A approve · R reject · X select</p>
      {decide.isError && <p role="alert" className="text-sm text-red-700 mb-2">{apiError(decide.error)}</p>}
      <table className="w-full text-sm" aria-label="Products">
        <thead className="text-left text-xs text-ink-400">
          <tr><th className="w-6"><span className="sr-only">Select</span></th><th>Product</th><th>Status</th><th>Checks</th><th>Documents</th></tr>
        </thead>
        <tbody onKeyDown={onKey}>
          {rows.map((p, i) => (
            <tr key={p.id} ref={(el) => { rowsRef.current[i] = el }} tabIndex={i === focus ? 0 : -1} onFocus={() => setFocus(i)}
              className={clsx('border-t border-ink-100 align-top outline-none focus:bg-amber-50', i === focus && 'bg-ink-50')} data-testid={`product-${p.name}`}>
              <td className="py-2"><input type="checkbox" aria-label={`Select ${p.brand} ${p.name}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} tabIndex={-1} /></td>
              <td className="py-2">
                <span className="font-medium text-ink-900">{p.brand} {p.name}</span>
                {p.isDryRun && <span className="ml-1 text-[10px] px-1 rounded bg-ink-100 text-ink-600">dry-run</span>}
                {p.url && <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="block text-xs text-ink-500 underline">{new URL(p.url).host}<ExternalLink size={10} className="inline ml-0.5" /></a>}
              </td>
              <td className="py-2"><ProductStatus p={p} /></td>
              <td className="py-2 text-xs"><Checks p={p} /></td>
              <td className="py-2 text-xs text-ink-500">
                {(p.item?.documents ?? []).map((d) => <div key={d.url}>{d.kind}: {OUTCOME_LABEL[d.outcome] ?? d.outcome}{d.chars ? ` (${d.chars.toLocaleString()} chars)` : ''}</div>)}
                {p.item?.status === 'WAITING' && <Link to="/admin/brands" className="underline text-amber-800">waiting: confirm the brand domain</Link>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="py-4 text-ink-500">Nothing here.</td></tr>}
        </tbody>
      </table>
    </section>
  )
}

function ProductStatus({ p }: { p: ReviewProduct }) {
  const text = p.status === 'APPROVED' ? `approved${p.approvedVia === 'AUTO' ? ' automatically' : ` by ${p.reviewedBy ?? 'an admin'}`}` : p.status === 'NEEDS_ATTENTION' ? 'needs attention' : p.status.toLowerCase()
  return <span className={clsx('text-xs', p.status === 'APPROVED' ? 'text-green-800' : p.status === 'REJECTED' ? 'text-ink-400' : 'text-amber-800')}>{text}{p.listed ? ' · listed' : ''}</span>
}

function Checks({ p }: { p: ReviewProduct }) {
  if (p.attentionCheck) return <span className="text-amber-900"><strong>{CHECK_LABEL[p.attentionCheck] ?? p.attentionCheck}:</strong> {p.attentionReason}</span>
  const checks = p.item?.checks
  if (!checks) return <span className="text-ink-400">{p.item ? p.item.status.toLowerCase() : 'not checked'}</span>
  return <span className="text-ink-500">{Object.values(checks).every((c) => c.pass) ? 'all checks passed' : Object.entries(checks).filter(([, c]) => !c.pass).map(([k]) => CHECK_LABEL[k] ?? k).join(', ')}</span>
}

// ── Levers ──────────────────────────────────────────────────────────────────────────────────────────
function LeverControls({ lever, editing, onToggleEdit, onChanged }: { lever: BoardLever; editing: boolean; onToggleEdit: () => void; onChanged: () => void }) {
  const retire = useMutation({ mutationFn: () => api.post(`/admin/levers/${lever.id}/retire`), onSuccess: onChanged })
  return (
    <>
      <div className="flex gap-1 mt-2 pl-8">
        <button type="button" className="btn-ghost text-xs" aria-expanded={editing} onClick={onToggleEdit}>{editing ? 'Close' : 'Edit'}<span className="sr-only"> {lever.name}</span></button>
        {lever.status === 'CANDIDATE' && <button type="button" className="btn-ghost text-xs" onClick={() => retire.mutate()}>Retire<span className="sr-only"> {lever.name}</span></button>}
      </div>
      {retire.isError && <p role="alert" className="text-sm text-red-700">{apiError(retire.error)}</p>}
      {editing && <LeverForm initial={lever} onSave={(body) => api.patch(`/admin/levers/${lever.id}`, body)} onDone={onChanged} />}
    </>
  )
}

function AddLever({ nodeId, onDone }: { nodeId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3">
      <button className="btn-secondary text-sm" onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : 'Add a lever by hand'}</button>
      {open && <div className="card p-3 mt-2"><LeverForm onSave={(b) => api.post(`/admin/nodes/${nodeId}/levers`, b)} onDone={() => { setOpen(false); onDone() }} /></div>}
    </div>
  )
}

// ── Values ──────────────────────────────────────────────────────────────────────────────────────────
type ValueFilter = 'all' | 'unreviewed' | 'unknown' | 'low'
interface Cell { row: number; col: number }

const isLow = (v: ReviewValue | undefined) => !!v && !v.value.unknown && (v.confidence === 'LOW' || v.edited || (v.statedUnit !== null && v.confidence === 'MEDIUM'))

function ValuesStep({ data, chosen, onChange, announce, onPublish, publishing, publishStatus }: {
  data: ReviewData; chosen: BoardLever[]; onChange: () => void; announce: (s: string) => void
  onPublish: () => void; publishing: boolean; publishStatus: React.ReactNode
}) {
  const [filter, setFilter] = useState<ValueFilter>('all')
  const [productFilter, setProductFilter] = useState('')
  const [cell, setCell] = useState<Cell>({ row: 0, col: 0 })
  const [editing, setEditing] = useState(false)
  const [manual, setManual] = useState(false)
  const [help, setHelp] = useState(false)
  const gridRef = useRef<HTMLTableElement>(null)

  const products = data.products.filter((p) => p.status === 'APPROVED' && (!productFilter || p.id === productFilter))
  const byKey = useMemo(() => new Map(data.values.map((v) => [`${v.productId}|${v.definitionId}`, v])), [data.values])
  const valueAt = (r: number, c: number) => { const p = products[r]; const l = chosen[c]; return p && l ? byKey.get(`${p.id}|${l.definitionId}`) : undefined }
  const shown = (v: ReviewValue | undefined) => filter === 'all'
    || (filter === 'unreviewed' && (!v || v.status === 'PROPOSED'))
    || (filter === 'unknown' && (!v || v.value.unknown))
    || (filter === 'low' && isLow(v))
  const visibleRows = products.map((_, r) => r).filter((r) => chosen.some((_, c) => shown(valueAt(r, c))))

  const current = valueAt(cell.row, cell.col)
  const product = products[cell.row]
  const lever = chosen[cell.col]

  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${cell.row}-${cell.col}"]`)?.focus()
  }, [cell])

  /** The next unreviewed cell after this one, in reading order (wrapping). */
  const nextUnreviewed = (from: Cell, skipId?: string): Cell | null => {
    const total = visibleRows.length * chosen.length
    const start = visibleRows.indexOf(from.row) * chosen.length + from.col
    for (let i = 1; i <= total; i++) {
      const k = (start + i) % total
      const r = visibleRows[Math.floor(k / chosen.length)]
      const c = k % chosen.length
      const v = valueAt(r, c)
      if (v && v.status === 'PROPOSED' && v.id !== skipId) return { row: r, col: c }
    }
    return null
  }

  const act = useMutation({
    mutationFn: ({ v, action }: { v: ReviewValue; action: 'accept' | 'reject' | 'unknown'; next?: boolean }) => api.post(`/admin/values/${v.id}/${action}`),
    onSuccess: (_r, { v, action, next }) => {
      announce(`${action === 'accept' ? 'Accepted' : action === 'reject' ? 'Rejected' : 'Marked unknown'}: ${lever?.name} for ${product?.name}`)
      if (next) { const n = nextUnreviewed(cell, v.id); if (n) setCell(n) }
      onChange()
    },
  })
  const bulk = useMutation({
    mutationFn: (definitionId: string) => api.post(`/admin/nodes/${data.node.id}/values/bulk-accept`, { definitionId }).then((r) => r.data as { accepted: number }),
    onSuccess: (r) => { announce(`Accepted ${r.accepted} values`); onChange() },
  })

  const onKey = (e: KeyboardEvent<HTMLTableElement>) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    const move = (dr: number, dc: number) => {
      e.preventDefault()
      const ri = visibleRows.indexOf(cell.row)
      const nr = visibleRows[Math.max(0, Math.min(visibleRows.length - 1, ri + dr))] ?? cell.row
      setCell({ row: nr, col: Math.max(0, Math.min(chosen.length - 1, cell.col + dc)) })
    }
    switch (e.key) {
      case 'ArrowDown': return move(1, 0)
      case 'ArrowUp': return move(-1, 0)
      case 'ArrowRight': return move(0, 1)
      case 'ArrowLeft': return move(0, -1)
      case 'Home': e.preventDefault(); return setCell({ row: cell.row, col: 0 })
      case 'End': e.preventDefault(); return setCell({ row: cell.row, col: chosen.length - 1 })
      case 'a': case 'A': if (current) { e.preventDefault(); act.mutate({ v: current, action: 'accept' }) } return
      case 'Enter': if (current) { e.preventDefault(); act.mutate({ v: current, action: 'accept', next: true }) } return
      case 'r': case 'R': if (current) { e.preventDefault(); act.mutate({ v: current, action: 'reject' }) } return
      case 'u': case 'U': if (current) { e.preventDefault(); act.mutate({ v: current, action: 'unknown' }) } return
      case 'e': case 'E': if (current && current.origin === 'EXTRACTED' && !current.value.unknown) { e.preventDefault(); setEditing(true) } return
      case 'n': case 'N': { e.preventDefault(); const n = nextUnreviewed(cell); if (n) setCell(n); return }
      case '?': e.preventDefault(); return setHelp((h) => !h)
    }
  }

  if (chosen.length === 0) return <p className="text-ink-600">Choose the publish set on the Levers step first: the value grid shows those levers.</p>
  if (products.length === 0) return <p className="text-ink-600">No approved products yet.</p>

  return (
    <section aria-label="Values">
      <div className="flex flex-wrap items-center gap-2 mb-2" role="group" aria-label="Filter values">
        {([['all', 'All'], ['unreviewed', 'Unreviewed'], ['unknown', 'Unknown'], ['low', 'Low confidence']] as [ValueFilter, string][]).map(([f, label]) => (
          <button key={f} type="button" aria-pressed={filter === f} className={clsx('px-2 py-1 rounded text-xs', filter === f ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700')} onClick={() => setFilter(f)}>{label}</button>
        ))}
        <select aria-label="One product" className="input py-1 px-2 text-xs w-56" value={productFilter} onChange={(e) => { setProductFilter(e.target.value); setCell({ row: 0, col: cell.col }) }}>
          <option value="">All products</option>
          {data.products.filter((p) => p.status === 'APPROVED').map((p) => <option key={p.id} value={p.id}>{p.brand} {p.name}</option>)}
        </select>
        <button type="button" className="btn-ghost text-xs ml-auto" aria-expanded={help} onClick={() => setHelp((h) => !h)}>Keyboard shortcuts (?)</button>
      </div>
      {help && (
        <p className="text-xs text-ink-600 bg-ink-50 rounded p-2 mb-2" data-testid="shortcuts">
          Arrows move · Home/End first/last lever · A accept · Enter accept and go to the next unreviewed · R reject · U mark unknown ·
          E correct the value · N next unreviewed · ? show or hide this list
        </p>
      )}

      <div className="grid grid-cols-[1fr_360px] gap-4">
        <div className="overflow-x-auto">
          <table ref={gridRef} role="grid" aria-label="Values: products by lever" className="w-full text-xs border-separate border-spacing-0" onKeyDown={onKey}>
            <thead>
              <tr role="row">
                <th role="columnheader" className="text-left p-2 sticky left-0 bg-white">Product</th>
                {chosen.map((l) => {
                  const ok = l.coverage.products > 0 && l.coverage.accepted * 5 >= l.coverage.products * 4
                  return (
                    <th key={l.id} role="columnheader" className="text-left p-2 align-bottom min-w-[150px]">
                      <span className="block text-ink-900">{l.name}</span>
                      <span className={clsx('block font-normal', ok ? 'text-green-800' : 'text-amber-800')}>{l.coverage.accepted} / {l.coverage.products} accepted{ok ? ' ✓' : ''}</span>
                      {l.safety
                        ? <span className="block font-normal text-red-800" title="Safety lever: review each value one by one">one by one (safety)</span>
                        : <button type="button" className="btn-ghost text-[11px] px-1 -ml-1" disabled={bulk.isPending} onClick={() => bulk.mutate(l.definitionId)}>Accept all high-confidence</button>}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr key={products[r].id} role="row">
                  <th role="rowheader" scope="row" className="text-left p-2 font-medium text-ink-800 sticky left-0 bg-white border-t border-ink-100">{products[r].brand} {products[r].name}</th>
                  {chosen.map((l, c) => {
                    const v = valueAt(r, c)
                    const active = cell.row === r && cell.col === c
                    return (
                      <td key={l.id} role="gridcell" data-cell={`${r}-${c}`} tabIndex={active ? 0 : -1} aria-selected={active}
                        onClick={() => setCell({ row: r, col: c })} onFocus={() => { if (!active) setCell({ row: r, col: c }) }}
                        className={clsx('p-2 border-t border-ink-100 cursor-pointer outline-none', active && 'ring-2 ring-ink-900 ring-inset', !shown(v) && 'opacity-30',
                          v?.status === 'ACCEPTED' && 'bg-green-50', v?.status === 'REJECTED' && 'bg-red-50 line-through')}
                        aria-label={`${products[r].name}, ${l.name}: ${v ? formatLeverValue(l, v.value) : 'no value'}, ${v ? v.status.toLowerCase() : 'missing'}`}>
                        <span className={clsx(v?.value.unknown && 'text-ink-400')}>{v ? formatLeverValue(l, v.value) : '–'}</span>
                        {isLow(v) && <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-amber-500 align-middle" title="Low confidence" />}
                        <span className="block text-[10px] text-ink-400">{v ? (v.status === 'PROPOSED' ? (v.edited ? 'edited · proposed' : 'proposed') : v.status.toLowerCase()) : ''}{v?.origin === 'MANUAL' ? ' · manual' : ''}</span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 flex items-center gap-3">
            <button className="btn-primary" disabled={chosen.length !== 5 || publishing} onClick={onPublish}>Publish these five</button>
            <span className="text-xs text-ink-500">The node, its five levers, the approved products and their accepted values go live together.</span>
          </div>
          {publishStatus}
          {bulk.isError && <p role="alert" className="text-sm text-red-700 mt-2">{apiError(bulk.error)}</p>}
        </div>

        <aside aria-label="Evidence" className="card p-4 self-start sticky top-4">
          {product && lever ? (
            <Evidence key={`${product.id}-${lever.id}`} product={product} lever={lever} value={current} editing={editing} manual={manual}
              onEdit={setEditing} onManual={setManual} acting={act.isPending}
              onAct={(action, next) => current && act.mutate({ v: current, action, next })}
              onChange={() => { setEditing(false); setManual(false); onChange() }} />
          ) : <p className="text-sm text-ink-500">Select a value.</p>}
          {act.isError && <p role="alert" className="text-sm text-red-700 mt-2">{apiError(act.error)}</p>}
        </aside>
      </div>
    </section>
  )
}

function Highlighted({ quote, needle }: { quote: string; needle: string | null }) {
  if (!needle) return <>{quote}</>
  const at = quote.indexOf(needle)
  if (at < 0) return <>{quote}</>
  return <>{quote.slice(0, at)}<mark className="bg-amber-200">{needle}</mark>{quote.slice(at + needle.length)}</>
}

function Evidence({ product, lever, value, editing, manual, onEdit, onManual, onAct, acting, onChange }: {
  product: ReviewProduct; lever: BoardLever; value: ReviewValue | undefined; editing: boolean; manual: boolean
  onEdit: (b: boolean) => void; onManual: (b: boolean) => void; onAct: (a: 'accept' | 'reject' | 'unknown', next?: boolean) => void; acting: boolean; onChange: () => void
}) {
  return (
    <div className="text-sm space-y-2">
      <p className="text-xs text-ink-500">{product.brand} {product.name}</p>
      <h3 className="font-medium text-ink-900">{lever.name}{lever.safety && <span className="ml-2 text-[11px] px-1 rounded bg-red-50 text-red-800">safety</span>}</h3>
      {value ? (
        <>
          <p className="text-lg text-ink-900" data-testid="evidence-value">{formatLeverValue(lever, value.value)}</p>
          {value.statedValue && value.statedUnit && value.statedUnit !== lever.unit && (
            <p className="text-xs text-ink-600">Stated on the page as {value.statedValue} {value.statedUnit}, converted to {lever.unit}.</p>
          )}
          {value.value.unknown && value.unknownReason && <p className="text-xs text-ink-600">Unknown: {value.unknownReason.replace(/_/g, ' ')}</p>}
          {value.quote && (
            <blockquote className="border-l-2 border-ink-300 pl-2 text-ink-700 text-xs" data-testid="evidence-quote">
              “<Highlighted quote={value.quote} needle={value.statedValue} />”
            </blockquote>
          )}
          {value.sourceUrl && <a className="text-xs underline break-all" href={value.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">{value.sourceUrl}</a>}
          <p className="text-xs text-ink-500">
            {value.origin === 'MANUAL' ? 'Entered by an admin' : value.origin === 'PHASE_A' ? 'Phase A value (no evidence)' : 'Extracted'}
            {value.confidence && ` · confidence ${value.confidence.toLowerCase()}`}
            {value.adminAttested && ` · admin-attested (${value.attestedFetchOutcome?.toLowerCase().replace(/_/g, ' ')})`}
            {value.edited && ` · corrected by ${value.editedBy ?? 'an admin'}${value.originalValue ? ` (was ${formatLeverValue(lever, value.originalValue)})` : ''}`}
            {value.reviewedBy && ` · ${value.status.toLowerCase()} by ${value.reviewedBy}${value.acceptMode === 'BULK' ? ' (bulk)' : ''}`}
          </p>
          <div className="flex flex-wrap gap-1 pt-1">
            <button className="btn-primary text-xs" disabled={acting || value.origin === 'PHASE_A'} onClick={() => onAct('accept', true)}>Accept and next <kbd>↵</kbd></button>
            <button className="btn-secondary text-xs" disabled={acting || value.origin === 'PHASE_A'} onClick={() => onAct('accept')}>Accept <kbd>A</kbd></button>
            <button className="btn-ghost text-xs" disabled={acting} onClick={() => onAct('reject')}>Reject <kbd>R</kbd></button>
            <button className="btn-ghost text-xs" disabled={acting} onClick={() => onAct('unknown')}>Mark unknown <kbd>U</kbd></button>
            {value.origin === 'EXTRACTED' && !value.value.unknown && <button className="btn-ghost text-xs" aria-expanded={editing} onClick={() => onEdit(!editing)}>Correct <kbd>E</kbd></button>}
          </div>
          {editing && <EditValue value={value} lever={lever} onDone={onChange} />}
        </>
      ) : <p className="text-ink-500">No value for this lever (the product was not extracted, or the lever was added later).</p>}
      <button className="btn-ghost text-xs" aria-expanded={manual} onClick={() => onManual(!manual)}>{manual ? 'Cancel manual value' : 'Enter a value with its source'}</button>
      {manual && <ManualValue product={product} lever={lever} onDone={onChange} />}
    </div>
  )
}

/** Inputs for a typed value of this lever. */
function ValueInputs({ lever, state, set }: { lever: BoardLever; state: Record<string, string>; set: (k: string, v: string) => void }) {
  const field = (k: string, label: string, props: { inputMode?: 'decimal' } = {}) => (
    <label key={k} className="block"><span className="label">{label}</span><input className="input py-1 text-xs" value={state[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...props} /></label>
  )
  switch (lever.type) {
    case 'MEASUREMENT':
      return lever.inputFormat === 'DIMENSIONS'
        ? <div className="grid grid-cols-3 gap-1">{field('l', 'L (in)', { inputMode: 'decimal' })}{field('w', 'W (in)', { inputMode: 'decimal' })}{field('h', 'H (in)', { inputMode: 'decimal' })}</div>
        : field('number', `Value (${lever.unit})`, { inputMode: 'decimal' })
    case 'CATEGORY':
      return (
        <label className="block"><span className="label">Value</span>
          <select className="input py-1 text-xs" value={state.text ?? ''} onChange={(e) => set('text', e.target.value)}>
            <option value="">Choose…</option>{lever.allowedValues.map((v) => <option key={v}>{v}</option>)}
          </select></label>
      )
    case 'COMPATIBILITY_LIST':
      return field('list', 'Items (separated by |)')
    case 'BOOLEAN':
      return (
        <label className="block"><span className="label">Value</span>
          <select className="input py-1 text-xs" value={state.bool ?? ''} onChange={(e) => set('bool', e.target.value)}>
            <option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option>
          </select></label>
      )
  }
}

function toValueBody(lever: BoardLever, s: Record<string, string>): Partial<TypedValue> & Record<string, unknown> {
  switch (lever.type) {
    case 'MEASUREMENT':
      return lever.inputFormat === 'DIMENSIONS'
        ? { dimensions: { lengthIn: Number(s.l), widthIn: Number(s.w), heightIn: Number(s.h) } }
        : { number: Number(s.number) }
    case 'CATEGORY': return { text: s.text }
    case 'COMPATIBILITY_LIST': return { list: (s.list ?? '').split('|').map((x) => x.trim()).filter(Boolean) }
    case 'BOOLEAN': return { bool: s.bool === 'yes' }
  }
}

function EditValue({ value, lever, onDone }: { value: ReviewValue; lever: BoardLever; onDone: () => void }) {
  const [state, setState] = useState<Record<string, string>>({ number: value.value.number?.toString() ?? '', text: value.value.text ?? '', bool: value.value.bool === null ? '' : value.value.bool ? 'yes' : 'no', list: value.value.list.join(' | ') })
  const save = useMutation({ mutationFn: () => api.patch(`/admin/values/${value.id}`, toValueBody(lever, state)), onSuccess: onDone })
  return (
    <form className="space-y-1 pt-2 border-t border-ink-100" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
      <p className="text-xs text-ink-500">The quote and source stay; the corrected value must be accepted again.</p>
      <ValueInputs lever={lever} state={state} set={(k, v) => setState((s) => ({ ...s, [k]: v }))} />
      <button className="btn-secondary text-xs" disabled={save.isPending}>Save correction</button>
      {save.isError && <p role="alert" className="text-xs text-red-700">{apiError(save.error)}</p>}
    </form>
  )
}

function ManualValue({ product, lever, onDone }: { product: ReviewProduct; lever: BoardLever; onDone: () => void }) {
  const [state, setState] = useState<Record<string, string>>({})
  const [sourceUrl, setSourceUrl] = useState(product.url ?? '')
  const [quote, setQuote] = useState('')
  const save = useMutation({
    mutationFn: () => api.post(`/admin/products/${product.id}/values`, { definitionId: lever.definitionId, value: toValueBody(lever, state), sourceUrl, quote })
      .then((r) => r.data as { adminAttested: boolean; attestedFetchOutcome: string | null }),
  })
  return (
    <form className="space-y-1 pt-2 border-t border-ink-100" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
      <p className="text-xs text-ink-500">The source must be on a verified domain of {product.brand}. The quote is checked against a fresh fetch; if the site blocks the fetch, the value is stored as admin-attested.</p>
      <ValueInputs lever={lever} state={state} set={(k, v) => setState((s) => ({ ...s, [k]: v }))} />
      <label className="block"><span className="label">Source URL</span><input className="input py-1 text-xs" type="url" required value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} /></label>
      <label className="block"><span className="label">Quote from the page (copied exactly)</span><textarea className="input py-1 text-xs" required minLength={3} maxLength={300} rows={2} value={quote} onChange={(e) => setQuote(e.target.value)} /></label>
      <button className="btn-secondary text-xs" disabled={save.isPending}>Save value</button>
      {save.isError && <p role="alert" className="text-xs text-red-700">{apiError(save.error)}</p>}
      {save.isSuccess && (
        <p className="text-xs text-green-800">
          Saved and accepted{save.data.adminAttested ? ` as admin-attested (the site blocked the check: ${save.data.attestedFetchOutcome?.toLowerCase().replace(/_/g, ' ')})` : ': the quote is on the page'}.{' '}
          <button type="button" className="underline" onClick={onDone}>Close</button>
        </p>
      )}
    </form>
  )
}
