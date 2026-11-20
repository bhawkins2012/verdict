// One node: its place in the taxonomy, generation runs (stage by stage, with cost), the placement
// suggestions, the navigation explainer, the owner survey, and Phase A history.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { api } from '../../lib/api'
import { apiError, apiRowErrors } from '../../lib/levers'
import { AdminConfig, AdminNodeDetail, AdminRun } from '../../types/levers'
import { ConfigNote } from './AdminNodesPage'
import { RunStatusBadge, usd } from './adminUi'

export function AdminNodePage() {
  const { id = '' } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const key = ['admin', 'node', id]
  const { data } = useQuery<AdminNodeDetail>({
    queryKey: key,
    queryFn: () => api.get(`/admin/nodes/${id}`).then((r) => r.data),
    // Poll while a run is working.
    refetchInterval: (q) => (q.state.data?.runs.some((r) => r.status === 'ACTIVE') ? 2000 : false),
  })
  const { data: config } = useQuery<AdminConfig>({ queryKey: ['admin', 'config'], queryFn: () => api.get('/admin/config').then((r) => r.data) })
  const refresh = () => qc.invalidateQueries({ queryKey: key })
  if (!data) return null

  const latest = data.runs[0] ?? null
  const placement = data.kind === 'DECISION' ? latest?.stages.find((s) => s.stage === 'PLACE' && s.status === 'DONE')?.output as Placement | undefined : undefined
  const explainerDraft = data.kind === 'NAVIGATION' ? data.runs.find((r) => r.kind === 'EXPLAINER' && r.status !== 'FAILED')?.stages[0]?.output as ExplainerDraft | undefined : undefined

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto animate-fade-in">
      <Link to="/admin" className="btn-ghost flex items-center gap-2 mb-4 -ml-2 w-fit"><ArrowLeft size={16} /> Catalog</Link>
      <p className="text-xs text-ink-500">{data.path.map((p) => p.name).join(' › ')}</p>
      <h2 className="font-display text-3xl text-ink-900">{data.name} <span className="text-base text-ink-400">/{data.slug}</span></h2>
      <p className="text-sm text-ink-500 mt-1">
        {data.kind === 'DECISION' ? 'Decision node' : 'Navigation node'}
        {data.safetyCritical && ' · safety-critical (values reviewed one by one)'}
        {data.secondaryParents.length > 0 && ` · also listed in ${data.secondaryParents.map((p) => p.name).join(', ')}`}
        {' · '}
        {data.visible
          ? <>public · <Link className="underline" to={`/categories/${data.slug}`}>open the public page</Link></>
          : 'not public (hidden from browse; search says it is being prepared)'}
      </p>
      {config && <ConfigNote config={config} />}

      <Runs node={data} onChange={() => void refresh()} />
      {placement && <PlacementSuggestions node={data} placement={placement} onChange={() => void refresh()} />}
      {data.kind === 'NAVIGATION' && <Explainer node={data} draft={explainerDraft} onChange={() => void refresh()} />}
      {data.kind === 'DECISION' && <Survey nodeId={id} />}

      {data.legacyRuns.length > 0 && (
        <details className="card p-4 mt-6">
          <summary className="text-sm text-ink-700 cursor-pointer">Phase A lever runs (history, read-only): {data.legacyRuns.length}</summary>
          <ul className="text-xs text-ink-500 mt-2 space-y-1">
            {data.legacyRuns.map((r) => <li key={r.id}>{new Date(r.createdAt).toLocaleString()} · {r.mode.toLowerCase()} · {r.status.toLowerCase()}{r.error ? `: ${r.error}` : ''} · {r.model} · cost {r.costUsd ?? '–'}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}

interface Placement { primaryParentFits: boolean; suggestedPrimaryParent: string | null; secondaryParents: string[]; searchTerms: string[]; rationale: string }
interface ExplainerDraft { explainer: string; children: { slug: string; line: string }[] }

function Runs({ node, onChange }: { node: AdminNodeDetail; onChange: () => void }) {
  const [notes, setNotes] = useState('')
  const start = useMutation({ mutationFn: () => api.post(`/admin/nodes/${node.id}/runs`, { notes: notes || undefined }), onSuccess: onChange })
  const resume = useMutation({ mutationFn: (runId: string) => api.post(`/admin/runs/${runId}/resume`), onSuccess: onChange })
  const cancel = useMutation({ mutationFn: (runId: string) => api.post(`/admin/runs/${runId}/cancel`), onSuccess: onChange })
  const open = node.runs.find((r) => r.status === 'ACTIVE' || r.status === 'STALLED')
  const label = node.kind === 'DECISION' ? 'Run generation' : 'Generate the explainer'
  return (
    <section className="card p-4 mt-6" aria-label="Generation runs">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="font-medium text-ink-800">Generation</h3>
        {node.kind === 'DECISION' && node.runs.length > 0 && <Link to={`/admin/nodes/${node.id}/review`} className="btn-primary text-sm">Open the review screen</Link>}
      </div>
      <p className="text-xs text-ink-500 mt-1">
        {node.kind === 'DECISION'
          ? 'One run places the node, proposes 10–12 levers, finds 15–20 products, verifies brand domains, and extracts every value with its evidence. Products that pass every check are approved automatically; the rest go to "needs attention".'
          : 'Writes a short explainer of how the children differ, for an admin to approve.'}
      </p>
      {!open && (
        <div className="mt-3">
          <label className="block"><span className="label">Notes for the model (optional)</span>
            <textarea className="input" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. focus on families who fly often" /></label>
          <button className="btn-primary mt-2" disabled={start.isPending} onClick={() => start.mutate()}>{label}</button>
          {start.isError && <p role="alert" className="text-sm text-red-700 mt-2">{apiError(start.error)}</p>}
        </div>
      )}
      {(resume.isError || cancel.isError) && <p role="alert" className="text-sm text-red-700 mt-2">{apiError(resume.error ?? cancel.error)}</p>}
      <div className="space-y-4 mt-4">
        {node.runs.map((r) => <RunCard key={r.id} run={r} onResume={() => resume.mutate(r.id)} onCancel={() => cancel.mutate(r.id)} />)}
      </div>
    </section>
  )
}

function RunCard({ run, onResume, onCancel }: { run: AdminRun; onResume: () => void; onCancel: () => void }) {
  const canResume = run.status === 'STALLED' || run.status === 'FAILED' || (run.status === 'READY_FOR_REVIEW' && (run.items.PENDING ?? 0) > 0)
  const canCancel = run.status === 'ACTIVE' || run.status === 'STALLED' || run.status === 'FAILED'
  return (
    <div className="border border-ink-100 rounded-lg p-3" data-testid="run">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <RunStatusBadge status={run.status} />
        <span className="text-ink-600">{new Date(run.createdAt).toLocaleString()} by {run.createdBy ?? '–'}</span>
        <span className="text-ink-500">· {run.mode === 'LIVE' ? `live, ${run.model}` : 'dry run'}</span>
        <span className="text-ink-500">· cost {usd(run.costUsd)} of cap {usd(run.capUsd)}{run.estimateUsd ? ` (estimate ${usd(run.estimateUsd)})` : ''}</span>
        <span className="ml-auto flex gap-1">
          {canResume && <button className="btn-secondary text-xs" onClick={onResume}>Resume</button>}
          {canCancel && <button className="btn-ghost text-xs" onClick={onCancel}>Cancel</button>}
        </span>
      </div>
      {run.error && <p className="text-xs text-red-700 mt-1">Stopped: {run.error}</p>}
      {run.warning && <p className="text-xs text-amber-800 mt-1">{run.warning}</p>}
      <table className="w-full text-xs mt-2">
        <thead className="text-left text-ink-400"><tr><th className="py-1">Stage</th><th>Status</th><th>Calls</th><th>Tokens in / out</th><th>Searches</th><th>Cost</th><th>Detail</th></tr></thead>
        <tbody>
          {run.stages.map((s) => (
            <tr key={s.stage} className="border-t border-ink-100">
              <td className="py-1 font-medium">{s.stage.toLowerCase()}</td>
              <td className={s.status === 'FAILED' ? 'text-red-700' : s.status === 'STALLED' ? 'text-amber-800' : ''}>{s.status.toLowerCase()}{s.error ? `: ${s.error}` : ''}</td>
              <td>{s.calls}</td>
              <td>{s.inputTokens} / {s.outputTokens}</td>
              <td>{s.webSearches || ''}</td>
              <td>{usd(s.costUsd)}</td>
              <td className="text-ink-500">{stageDetail(s.stage, s.output, run.items)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function stageDetail(stage: string, output: unknown, items: AdminRun['items']): string {
  const o = (output ?? {}) as Record<string, unknown>
  switch (stage) {
    case 'LEVERS': return output ? `${o.candidates} candidates (${o.definitionsCreated} new definitions, ${o.definitionsReused} reused)` : ''
    case 'DISCOVER': return output ? `${o.proposed} products (${o.created} new, ${o.linkedExisting} already here)` : ''
    case 'VERIFY': return output ? `${(o.verified as unknown[] | undefined)?.length ?? 0} verified, ${(o.pending as unknown[] | undefined)?.length ?? 0} waiting for an admin, ${(o.refused as unknown[] | undefined)?.length ?? 0} refused` : ''
    case 'EXTRACT': return Object.entries(items).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')
    default: return ''
  }
}

function PlacementSuggestions({ node, placement, onChange }: { node: AdminNodeDetail; placement: Placement; onChange: () => void }) {
  const bySlug = (slug: string) => node.navigationParents.find((p) => p.slug === slug)
  const newParents = placement.secondaryParents.map(bySlug).filter((p): p is NonNullable<typeof p> => !!p && !node.secondaryParents.some((s) => s.id === p.id))
  const newTerms = placement.searchTerms.filter((t) => !node.searchTerms.includes(t))
  const apply = useMutation({
    mutationFn: (body: object) => api.patch(`/admin/nodes/${node.id}`, body),
    onSuccess: onChange,
  })
  return (
    <section className="card p-4 mt-6" aria-label="Placement">
      <h3 className="font-medium text-ink-800">Placement (suggested by the run)</h3>
      <p className="text-sm text-ink-600 mt-1">{placement.primaryParentFits ? 'The primary parent fits.' : `Suggested primary parent: ${placement.suggestedPrimaryParent ?? '(none valid)'}`} {placement.rationale}</p>
      {newParents.length > 0 && (
        <p className="text-sm mt-2">Also list it in: {newParents.map((p) => p.name).join(', ')}{' '}
          <button className="btn-secondary text-xs" onClick={() => apply.mutate({ secondaryParentIds: [...node.secondaryParents.map((s) => s.id), ...newParents.map((p) => p.id)] })}>Apply</button></p>
      )}
      {newTerms.length > 0 && (
        <p className="text-sm mt-2">Search terms to add: {newTerms.join(', ')}{' '}
          <button className="btn-secondary text-xs" onClick={() => apply.mutate({ searchTerms: [...node.searchTerms, ...newTerms] })}>Add</button></p>
      )}
      {newParents.length === 0 && newTerms.length === 0 && <p className="text-xs text-ink-500 mt-2">Nothing to apply.</p>}
      {apply.isError && <p role="alert" className="text-sm text-red-700 mt-2">{apiError(apply.error)}</p>}
    </section>
  )
}

function Explainer({ node, draft, onChange }: { node: AdminNodeDetail; draft: ExplainerDraft | undefined; onChange: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [lines, setLines] = useState<Record<string, string> | null>(null)
  const current = text ?? node.explainer ?? draft?.explainer ?? ''
  const currentLines = lines ?? node.explainerChildLines ?? Object.fromEntries((draft?.children ?? []).map((c) => [c.slug, c.line]))
  const approve = useMutation({
    mutationFn: () => api.post(`/admin/nodes/${node.id}/explainer`, { explainer: current, childLines: currentLines }),
    onSuccess: () => { setText(null); setLines(null); onChange() },
  })
  return (
    <section className="card p-4 mt-6" aria-label="Explainer">
      <h3 className="font-medium text-ink-800">Explainer</h3>
      <p className="text-xs text-ink-500 mt-1">
        {node.explainerApprovedAt ? `Approved ${new Date(node.explainerApprovedAt).toLocaleString()} by ${node.explainerApprovedBy ?? '–'}.` : 'Not approved yet: the node stays hidden until its explainer is approved and a child is published.'}
      </p>
      {(current || draft) ? (
        <form className="mt-2 space-y-2" onSubmit={(e) => { e.preventDefault(); approve.mutate() }}>
          <label className="block"><span className="label">How the children differ (at most 600 characters)</span>
            <textarea className="input" rows={4} maxLength={600} value={current} onChange={(e) => setText(e.target.value)} /></label>
          {node.children.map((c) => (
            <label key={c.id} className="block"><span className="label">{c.name}</span>
              <input className="input" maxLength={160} value={currentLines[c.slug] ?? ''} onChange={(e) => setLines({ ...currentLines, [c.slug]: e.target.value })} /></label>
          ))}
          <button className="btn-primary" disabled={approve.isPending || current.trim().length < 20}>Approve explainer</button>
          {approve.isError && <p role="alert" className="text-sm text-red-700">{apiError(approve.error)}</p>}
        </form>
      ) : <p className="text-sm text-ink-500 mt-2">Run "Generate the explainer" first.</p>}
    </section>
  )
}

function Survey({ nodeId }: { nodeId: string }) {
  const upload = useMutation({
    mutationFn: async (file: File) => api.post(`/admin/nodes/${nodeId}/survey`, await file.text(), { headers: { 'Content-Type': 'text/csv' }, params: { filename: file.name } }),
  })
  const rows = apiRowErrors(upload.error)
  return (
    <section className="card p-4 mt-6" aria-label="Owner survey">
      <h3 className="font-medium text-ink-800 mb-1">Owner survey (optional)</h3>
      <p className="text-xs text-ink-500 mb-2">CSV with columns <code>lever, rank, respondents</code>. Rankings show on the lever cards they match by name.</p>
      <input type="file" accept=".csv,text/csv" aria-label="Survey CSV" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = '' }} />
      {upload.isSuccess && <p className="text-sm text-green-700 mt-2">Imported.</p>}
      {upload.isError && (
        <div role="alert" className="text-sm text-red-700 mt-2">{apiError(upload.error)}
          {rows.length > 0 && <ul className="text-xs mt-1 list-disc ml-5">{rows.slice(0, 20).map((r) => <li key={r.row}>Row {r.row}: {r.error}</li>)}</ul>}
        </div>
      )}
    </section>
  )
}
