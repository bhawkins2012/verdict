import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowDown, ArrowLeft, ArrowUp, X } from 'lucide-react'
import { api } from '../../lib/api'
import { apiError, apiRowErrors } from '../../lib/levers'
import { AdminCategoryDetail, AdminConfig, AdminLever, AdminRun, LeverInputFormat, LeverType } from '../../types/levers'
import { ConfigNote } from './AdminCategoriesPage'

const TYPE_LABEL: Record<LeverType, string> = {
  MEASUREMENT: 'Measurement', CATEGORY: 'Category', COMPATIBILITY_LIST: 'Compatibility list', BOOLEAN: 'Yes / no',
}

export function AdminCategoryPage() {
  const { id = '' } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const key = ['admin', 'category', id]
  const { data } = useQuery<AdminCategoryDetail>({ queryKey: key, queryFn: () => api.get(`/admin/categories/${id}`).then((r) => r.data) })
  const { data: config } = useQuery<AdminConfig>({ queryKey: ['admin', 'config'], queryFn: () => api.get('/admin/config').then((r) => r.data) })
  const refresh = () => qc.invalidateQueries({ queryKey: key })

  // The publish set: the published levers in order, until the admin changes the selection.
  const [edited, setEdited] = useState<string[] | null>(null)
  const publish = useMutation({
    mutationFn: (leverIds: string[]) => api.post(`/admin/categories/${id}/publish`, { leverIds }),
    onSuccess: () => { setEdited(null); void refresh() },
  })

  if (!data) return null
  const selected = edited ?? data.levers.filter((l) => l.status === 'APPROVED').sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((l) => l.id)
  const setSelected = (f: (s: string[]) => string[]) => setEdited(f(selected))
  const live = data.levers.filter((l) => l.status !== 'RETIRED')
  const retired = data.levers.filter((l) => l.status === 'RETIRED')
  const byId = new Map(data.levers.map((l) => [l.id, l]))

  const toggle = (leverId: string) =>
    setSelected((s) => (s.includes(leverId) ? s.filter((x) => x !== leverId) : s.length >= 5 ? s : [...s, leverId]))
  const move = (i: number, d: -1 | 1) =>
    setSelected((s) => { const n = [...s]; const j = i + d; if (j < 0 || j >= n.length) return s; [n[i], n[j]] = [n[j], n[i]]; return n })

  return (
    <div className="p-8 max-w-6xl mx-auto animate-fade-in">
      <Link to="/admin" className="btn-ghost flex items-center gap-2 mb-4 -ml-2 w-fit"><ArrowLeft size={16} /> All categories</Link>
      <h2 className="font-display text-3xl text-ink-900">{data.name} <span className="text-base text-ink-400">/{data.slug}</span></h2>
      <p className="text-sm text-ink-500 mt-1">
        {data.leversPublishedAt
          ? <>Published {new Date(data.leversPublishedAt).toLocaleString()} by {data.leversPublishedBy ?? 'seed'} · <Link className="underline" to={`/categories/${data.slug}`}>public page</Link></>
          : 'Not published: hidden from browse; search says it is being prepared.'}
      </p>
      {config && <ConfigNote config={config} />}

      <Generate categoryId={id} runs={data.runs} onDone={() => void refresh()} />
      <Survey categoryId={id} survey={data.survey} onDone={() => void refresh()} />

      {/* Candidates and approved levers */}
      <section className="mt-8">
        <h3 className="font-medium text-ink-800 mb-2">Levers ({live.length})</h3>
        <p className="text-xs text-ink-500 mb-3">Tick five, put them in order, then publish. Publishing approves exactly these five and retires the previous set. Nothing here is public until it is published.</p>
        <div className="space-y-2">
          {live.map((l) => (
            <LeverRow key={l.id} lever={l} selected={selected.includes(l.id)} canSelect={selected.length < 5} onToggle={() => toggle(l.id)} onChanged={() => void refresh()} />
          ))}
          {live.length === 0 && <p className="text-sm text-ink-500">No levers yet. Run a generation or add one.</p>}
        </div>
        <AddLever categoryId={id} onDone={() => void refresh()} />
      </section>

      {/* Publish */}
      <section className="card p-4 mt-6" aria-label="Publish set">
        <h3 className="font-medium text-ink-800 mb-2">Publish set ({selected.length} / 5)</h3>
        <ol className="space-y-1">
          {selected.map((sid, i) => (
            <li key={sid} className="flex items-center gap-2 text-sm">
              <span className="w-5 text-ink-400">{i + 1}.</span>
              <span className="flex-1">{byId.get(sid)?.name}</span>
              <button aria-label="Move up" className="btn-ghost p-1" onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
              <button aria-label="Move down" className="btn-ghost p-1" onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
              <button aria-label="Remove" className="btn-ghost p-1" onClick={() => toggle(sid)}><X size={14} /></button>
            </li>
          ))}
        </ol>
        <button className="btn-primary mt-3" disabled={selected.length !== 5 || publish.isPending} onClick={() => publish.mutate(selected)}>
          Approve and publish these five
        </button>
        {publish.isError && <p role="alert" className="text-sm text-red-700 mt-2">{apiError(publish.error)}</p>}
        {publish.isSuccess && <p className="text-sm text-green-700 mt-2">Published.</p>}
      </section>

      <ValueImport categoryId={id} products={data.products} published={!!data.leversPublishedAt} />

      {retired.length > 0 && (
        <details className="mt-6">
          <summary className="text-sm text-ink-500 cursor-pointer">Retired levers ({retired.length})</summary>
          <ul className="text-sm text-ink-500 mt-2 space-y-1">{retired.map((l) => <li key={l.id}>{l.name} · {TYPE_LABEL[l.type]}</li>)}</ul>
        </details>
      )}
    </div>
  )
}

// ── Generation ───────────────────────────────────────────────────────────────────────────────────────
function Generate({ categoryId, runs, onDone }: { categoryId: string; runs: AdminRun[]; onDone: () => void }) {
  const [notes, setNotes] = useState('')
  const [pendingRun, setPendingRun] = useState<string | null>(null)
  const start = useMutation({
    mutationFn: () => api.post(`/admin/categories/${categoryId}/runs`, { notes: notes || undefined }).then((r) => r.data as { runId: string }),
    onSuccess: (r) => setPendingRun(r.runId),
  })
  // Poll every 2 s while a run is RUNNING; when it finishes, stop and refresh the category once.
  useQuery<AdminRun>({
    queryKey: ['admin', 'run', pendingRun],
    queryFn: async () => {
      try {
        const run: AdminRun = (await api.get(`/admin/runs/${pendingRun}`)).data
        if (run.status !== 'RUNNING') { setPendingRun(null); onDone() }
        return run
      } catch (err) {
        setPendingRun(null) // stop polling; the runs table shows the run's state after a refresh
        onDone()
        throw err
      }
    },
    enabled: !!pendingRun,
    refetchInterval: 2000,
    retry: false,
  })

  return (
    <section className="card p-4 mt-6" aria-label="Generate candidates">
      <h3 className="font-medium text-ink-800 mb-2">Generate candidate levers</h3>
      <label className="block"><span className="label">Notes for the model (optional)</span>
        <textarea className="input" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. focus on families who fly often" /></label>
      <button className="btn-primary mt-2" disabled={start.isPending || !!pendingRun} onClick={() => start.mutate()}>
        {pendingRun ? 'Generating…' : 'Run generation'}
      </button>
      {start.isError && <p role="alert" className="text-sm text-red-700 mt-2">{apiError(start.error)}</p>}
      {runs.length > 0 && (
        <table className="w-full text-xs mt-4">
          <thead className="text-left text-ink-400"><tr><th>Started</th><th>By</th><th>Mode</th><th>Status</th><th>Model</th><th>Tokens in / out</th><th>Cost (USD)</th><th>Stored</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-ink-100">
                <td className="py-1">{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.createdBy}</td>
                <td>{r.mode === 'LIVE' ? 'live' : 'dry run'}</td>
                <td className={r.status === 'FAILED' ? 'text-red-700' : ''}>{r.status.toLowerCase()}{r.error ? `: ${r.error}` : ''}</td>
                <td>{r.servedModel ?? r.model}</td>
                <td>{r.inputTokens ?? '–'} / {r.outputTokens ?? '–'}</td>
                <td>{r.costUsd ?? '–'}</td>
                <td>{r.candidatesStored}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

// ── Survey ───────────────────────────────────────────────────────────────────────────────────────────
function Survey({ categoryId, survey, onDone }: { categoryId: string; survey: AdminCategoryDetail['survey']; onDone: () => void }) {
  const upload = useMutation({
    mutationFn: async (file: File) => api.post(`/admin/categories/${categoryId}/survey`, await file.text(), {
      headers: { 'Content-Type': 'text/csv' }, params: { filename: file.name },
    }),
    onSuccess: onDone,
  })
  const rows = apiRowErrors(upload.error)
  return (
    <section className="card p-4 mt-6" aria-label="Owner survey">
      <h3 className="font-medium text-ink-800 mb-1">Owner survey</h3>
      <p className="text-xs text-ink-500 mb-2">CSV with columns <code>lever, rank, respondents</code>. Rankings show next to the levers they match by name.</p>
      <input type="file" accept=".csv,text/csv" aria-label="Survey CSV" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = '' }} />
      {upload.isError && <ErrorRows message={apiError(upload.error)} rows={rows} />}
      {survey && (
        <div className="text-xs text-ink-500 mt-2">
          Latest: {survey.filename}, {survey.rowCount} rows, {new Date(survey.uploadedAt).toLocaleString()} by {survey.uploadedBy}.
          {survey.unmatched.length > 0 && (
            <p className="mt-1">In the survey, not among the levers: {survey.unmatched.map((u) => `${u.lever} (#${u.rank}, ${u.respondents})`).join('; ')}</p>
          )}
        </div>
      )}
    </section>
  )
}

function ErrorRows({ message, rows }: { message: string; rows: { row: number; error: string }[] }) {
  return (
    <div role="alert" className="text-sm text-red-700 mt-2">
      {message}
      {rows.length > 0 && <ul className="text-xs mt-1 list-disc ml-5">{rows.slice(0, 20).map((r) => <li key={r.row}>Row {r.row}: {r.error}</li>)}</ul>}
    </div>
  )
}

// ── Lever row with inline edit ───────────────────────────────────────────────────────────────────────
function LeverRow({ lever, selected, canSelect, onToggle, onChanged }: {
  lever: AdminLever; selected: boolean; canSelect: boolean; onToggle: () => void; onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const retire = useMutation({ mutationFn: () => api.post(`/admin/levers/${lever.id}/retire`), onSuccess: onChanged })
  return (
    <div className="card p-3" data-testid={`lever-${lever.name}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" aria-label={`Select ${lever.name}`} className="mt-1" checked={selected} disabled={!selected && !canSelect} onChange={onToggle} />
        <div className="flex-1">
          <p className="text-sm">
            <span className="font-medium text-ink-900">{lever.name}</span>
            <span className="text-ink-400"> · {TYPE_LABEL[lever.type]}{lever.unit ? ` (${lever.unit})` : ''}{lever.inputFormat === 'DIMENSIONS' ? ', from L × W × H' : ''}</span>
            {lever.status === 'APPROVED' && <span className="ml-2 text-xs text-green-700">Published #{lever.position}</span>}
            {lever.survey && <span className="ml-2 text-xs bg-blue-50 text-blue-800 px-1.5 py-0.5 rounded">Survey #{lever.survey.rank} · {lever.survey.respondents} owners</span>}
          </p>
          <p className="text-xs text-ink-600">{lever.explanation}</p>
          <p className="text-[11px] text-ink-400">
            {lever.origin === 'GENERATED' ? 'Generated' : 'Added by admin'}
            {lever.relatedNeeds.length > 0 && ` · needs: ${lever.relatedNeeds.join(', ')}`}
            {lever.allowedValues.length > 0 && ` · values: ${lever.allowedValues.join(', ')}`}
            {lever.approvedAt && ` · approved by ${lever.approvedBy ?? 'seed'} ${new Date(lever.approvedAt).toLocaleDateString()}`}
            {lever.editedAt && ` · edited by ${lever.editedBy} ${new Date(lever.editedAt).toLocaleDateString()}`}
            {lever.valueCount > 0 && ` · ${lever.valueCount} product values`}
          </p>
        </div>
        <button className="btn-ghost text-xs" onClick={() => setEditing((e) => !e)}>{editing ? 'Close' : 'Edit'}</button>
        {lever.status === 'CANDIDATE' && <button className="btn-ghost text-xs" onClick={() => retire.mutate()}>Retire</button>}
      </div>
      {retire.isError && <p role="alert" className="text-sm text-red-700">{apiError(retire.error)}</p>}
      {editing && <LeverForm initial={lever} onSave={(body) => api.patch(`/admin/levers/${lever.id}`, body)} onDone={() => { setEditing(false); onChanged() }} />}
    </div>
  )
}

interface LeverBody {
  name: string; type: LeverType; inputFormat: LeverInputFormat; unit: string | null; explanation: string
  relatedNeeds: string[]; allowedValues: string[]
}

const splitList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

function LeverForm({ initial, onSave, onDone }: { initial?: Partial<AdminLever>; onSave: (b: LeverBody) => Promise<unknown>; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<LeverType>(initial?.type ?? 'MEASUREMENT')
  const [inputFormat, setInputFormat] = useState<LeverInputFormat>(initial?.inputFormat ?? 'SINGLE')
  const [unit, setUnit] = useState(initial?.unit ?? '')
  const [explanation, setExplanation] = useState(initial?.explanation ?? '')
  const [needs, setNeeds] = useState((initial?.relatedNeeds ?? []).join(', '))
  const [values, setValues] = useState((initial?.allowedValues ?? []).join(', '))
  const save = useMutation({
    mutationFn: () => onSave({
      name, type, inputFormat: type === 'MEASUREMENT' ? inputFormat : 'SINGLE',
      unit: type === 'MEASUREMENT' ? (inputFormat === 'DIMENSIONS' ? 'cu ft' : unit.trim() || null) : null,
      explanation, relatedNeeds: splitList(needs), allowedValues: type === 'CATEGORY' ? splitList(values) : [],
    }),
    onSuccess: onDone,
  })
  return (
    <form className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-ink-100" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
      <label><span className="label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} /></label>
      <label><span className="label">Type</span>
        <select className="input" value={type} onChange={(e) => setType(e.target.value as LeverType)}>
          {(Object.keys(TYPE_LABEL) as LeverType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select></label>
      {type === 'MEASUREMENT' && (
        <>
          <label><span className="label">Input</span>
            <select className="input" value={inputFormat} onChange={(e) => setInputFormat(e.target.value as LeverInputFormat)}>
              <option value="SINGLE">One number</option>
              <option value="DIMENSIONS">Folded L × W × H in inches (volume in cu ft is computed)</option>
            </select></label>
          <label><span className="label">Unit</span>
            <input className="input" value={inputFormat === 'DIMENSIONS' ? 'cu ft' : unit} disabled={inputFormat === 'DIMENSIONS'} onChange={(e) => setUnit(e.target.value)} required maxLength={20} /></label>
        </>
      )}
      <label className="col-span-2"><span className="label">One-line explanation</span><input className="input" value={explanation} onChange={(e) => setExplanation(e.target.value)} required minLength={10} maxLength={200} /></label>
      <label><span className="label">Related needs (comma separated)</span><input className="input" value={needs} onChange={(e) => setNeeds(e.target.value)} /></label>
      {type === 'CATEGORY' && <label><span className="label">Allowed values (comma separated)</span><input className="input" value={values} onChange={(e) => setValues(e.target.value)} /></label>}
      <div className="col-span-2 flex items-center gap-2">
        <button className="btn-primary" disabled={save.isPending}>Save</button>
        {save.isError && <span role="alert" className="text-sm text-red-700">{apiError(save.error)}</span>}
      </div>
    </form>
  )
}

function AddLever({ categoryId, onDone }: { categoryId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3">
      <button className="btn-secondary text-sm" onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : 'Add a lever by hand'}</button>
      {open && <div className="card p-3 mt-2"><LeverForm onSave={(b) => api.post(`/admin/categories/${categoryId}/levers`, b)} onDone={() => { setOpen(false); onDone() }} /></div>}
    </div>
  )
}

// ── Lever values ─────────────────────────────────────────────────────────────────────────────────────
function ValueImport({ categoryId, products, published }: { categoryId: string; products: AdminCategoryDetail['products']; published: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const run = useMutation({
    mutationFn: async ({ dryRun }: { dryRun: boolean }) => {
      if (!file) throw new Error('Choose a file')
      return api.post(`/admin/categories/${categoryId}/lever-values/import`, await file.text(), {
        headers: { 'Content-Type': 'text/csv' }, params: { dryRun: dryRun ? 'true' : undefined },
      }).then((r) => r.data as { rows: number; imported: number })
    },
  })
  return (
    <section className="card p-4 mt-6" aria-label="Lever values">
      <h3 className="font-medium text-ink-800 mb-2">Product lever values</h3>
      {!published && <p className="text-xs text-ink-500 mb-2">Publish five levers first; values can only be set for published levers.</p>}
      <ul className="text-sm space-y-1 mb-4">
        {products.map((p) => (
          <li key={p.id}><Link className="underline" to={`/admin/products/${p.id}`}>{p.name}</Link> <span className="text-ink-400">{p.brand} · {p.valueCount} values</span></li>
        ))}
        {products.length === 0 && <li className="text-ink-500">No products in this category.</li>}
      </ul>
      <p className="text-xs text-ink-500 mb-1">
        CSV import (all or nothing): <code>product_id, lever, value, unit, unknown, detail, source, source_label, one_hand_fold</code>.
        <code> source</code> is required: a URL or <code>entered by admin</code>. Lists use <code>|</code>; folded size is <code>L x W x H</code> in inches.
      </p>
      <input type="file" accept=".csv,text/csv" aria-label="Lever values CSV" onChange={(e) => { setFile(e.target.files?.[0] ?? null); run.reset() }} />
      <div className="flex gap-2 mt-2">
        <button className="btn-secondary text-sm" disabled={!file || run.isPending} onClick={() => run.mutate({ dryRun: true })}>Check file</button>
        <button className="btn-primary text-sm" disabled={!file || run.isPending} onClick={() => run.mutate({ dryRun: false })}>Import</button>
      </div>
      {run.isError && <ErrorRows message={apiError(run.error)} rows={apiRowErrors(run.error)} />}
      {run.isSuccess && <p className="text-sm text-green-700 mt-2">{run.data.imported > 0 ? `Imported ${run.data.imported} values.` : `All ${run.data.rows} rows are valid. Nothing imported yet.`}</p>}
    </section>
  )
}
