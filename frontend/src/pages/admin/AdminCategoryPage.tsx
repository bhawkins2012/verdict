import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { api } from '../../lib/api'
import { apiError, apiRowErrors } from '../../lib/levers'
import { AdminCategoryDetail, AdminConfig, AdminLever, AdminRun } from '../../types/levers'
import { LeverForm, TYPE_LABEL } from '../../components/levers/LeverForm'
import { PublishBoard } from '../../components/levers/PublishBoard'
import { initialSet } from '../../lib/publishSet'
import { ConfigNote } from './AdminCategoriesPage'


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
    // Refetch first, then drop the local selection: clearing it before the new data arrives would rebuild
    // the set from stale data (nothing approved yet) and flash every card back to Candidates.
    onSuccess: async () => { await refresh(); setEdited(null) },
  })

  if (!data) return null
  const selected = edited ?? initialSet(data.levers)
  const live = data.levers.filter((l) => l.status !== 'RETIRED')
  const retired = data.levers.filter((l) => l.status === 'RETIRED')

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto animate-fade-in">
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

      {/* Approval board: candidates and the five-slot publish set */}
      <section className="mt-8" aria-label="Levers">
        <h3 className="font-medium text-ink-800 mb-1">Levers ({live.length})</h3>
        <p className="text-xs text-ink-500 mb-3">
          Drag five levers into the publish set and put them in order (or use each card's Actions menu), then publish.
          Publishing approves exactly these five and retires the previous set. Nothing here is public until it is published.
        </p>
        <PublishBoard
          levers={live}
          set={selected}
          onSetChange={setEdited}
          onPublish={(ids) => publish.mutate(ids)}
          publishing={publish.isPending}
          renderControls={(lever) => <LeverControls lever={lever} onChanged={() => void refresh()} />}
          publishStatus={<>
            {publish.isError && <p role="alert" className="text-sm text-red-700 mt-2">{apiError(publish.error)}</p>}
            {publish.isSuccess && <p className="text-sm text-green-700 mt-2">Published.</p>}
          </>}
        />
        <AddLever categoryId={id} onDone={() => void refresh()} />
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

// ── Edit and Retire on each board card ───────────────────────────────────────────────────────────────
function LeverControls({ lever, onChanged }: { lever: AdminLever; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const retire = useMutation({ mutationFn: () => api.post(`/admin/levers/${lever.id}/retire`), onSuccess: onChanged })
  return (
    <>
      <div className="flex gap-1 mt-2 pl-8">
        <button type="button" className="btn-ghost text-xs" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>
          {editing ? 'Close' : 'Edit'}<span className="sr-only"> {lever.name}</span>
        </button>
        {lever.status === 'CANDIDATE' && (
          <button type="button" className="btn-ghost text-xs" onClick={() => retire.mutate()}>Retire<span className="sr-only"> {lever.name}</span></button>
        )}
      </div>
      {retire.isError && <p role="alert" className="text-sm text-red-700">{apiError(retire.error)}</p>}
      {editing && <LeverForm initial={lever} onSave={(body) => api.patch(`/admin/levers/${lever.id}`, body)} onDone={() => { setEditing(false); onChanged() }} />}
    </>
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
