// Admin home: the taxonomy as a tree, with each node's state and latest run, the generation mode and caps,
// and what needs attention (runs ready for review, brand domains to confirm, unplaced products).
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import clsx from 'clsx'
import { api } from '../../lib/api'
import { apiError } from '../../lib/levers'
import { AdminConfig, AdminSummary, AdminTreeNode, NodeKind } from '../../types/levers'
import { RunStatusBadge } from './adminUi'

export function ConfigNote({ config }: { config: AdminConfig }) {
  return (
    <p className="text-xs text-ink-500 mt-2">
      Generation: <strong>{config.mode === 'live' ? `live (${config.model})` : 'dry run (fixtures, no API calls, no network)'}</strong>
      {' · '}caps ${config.runCapUsd} per run, ${config.dailyCapUsd} per day · publishing needs {config.minProducts} approved products and 80% coverage per lever
    </p>
  )
}

export function AdminNodesPage() {
  const { data: tree } = useQuery<AdminTreeNode[]>({ queryKey: ['admin', 'nodes'], queryFn: () => api.get('/admin/nodes').then((r) => r.data) })
  const { data: config } = useQuery<AdminConfig>({ queryKey: ['admin', 'config'], queryFn: () => api.get('/admin/config').then((r) => r.data) })
  const { data: summary } = useQuery<AdminSummary>({ queryKey: ['admin', 'summary'], queryFn: () => api.get('/admin/summary').then((r) => r.data) })

  const launch: AdminTreeNode[] = []
  const walk = (n: AdminTreeNode) => { if (n.launchOrder && !n.viaSecondary) launch.push(n); n.children.forEach(walk) }
  tree?.forEach(walk)
  launch.sort((a, b) => (a.launchOrder ?? 0) - (b.launchOrder ?? 0))

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto animate-fade-in">
      <h2 className="font-display text-3xl text-ink-900">Catalog</h2>
      {config && <ConfigNote config={config} />}

      {summary && (summary.readyForReview > 0 || summary.brandsToConfirm > 0 || summary.unplacedProducts > 0) && (
        <div className="flex flex-wrap gap-2 mt-4" aria-label="Needs your attention">
          {summary.readyForReview > 0 && <span className="px-2 py-1 rounded bg-green-50 text-green-900 text-sm">{summary.readyForReview} run{summary.readyForReview === 1 ? '' : 's'} ready for review</span>}
          {summary.brandsToConfirm > 0 && <Link to="/admin/brands" className="px-2 py-1 rounded bg-amber-100 text-amber-900 text-sm underline">{summary.brandsToConfirm} brand domain{summary.brandsToConfirm === 1 ? '' : 's'} to confirm</Link>}
          {summary.unplacedProducts > 0 && <span className="px-2 py-1 rounded bg-ink-100 text-ink-700 text-sm">{summary.unplacedProducts} unplaced products</span>}
        </div>
      )}

      {launch.length > 0 && (
        <section className="card p-4 mt-6" aria-label="Launch order">
          <h3 className="font-medium text-ink-800 mb-2">Launch order (travel-system pair first)</h3>
          <ol className="text-sm space-y-1 list-decimal ml-5">
            {launch.map((n) => (
              <li key={n.id}>
                <Link className="underline" to={`/admin/nodes/${n.id}`}>{n.name}</Link>
                <span className="ml-2 text-xs text-ink-500">{n.publishedAt ? 'published' : n.latestRun ? '' : 'not generated yet'}</span>
                {n.latestRun && <span className="ml-2"><RunStatusBadge status={n.latestRun.status} /></span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="mt-6" aria-label="Taxonomy">
        <h3 className="font-medium text-ink-800 mb-2">Taxonomy</h3>
        <ul className="card divide-y divide-ink-100" role="tree" aria-label="Taxonomy">
          {tree?.map((n) => <TreeRow key={n.id} node={n} />)}
        </ul>
      </section>

      {tree && <CreateNode tree={tree} />}
    </div>
  )
}

function TreeRow({ node }: { node: AdminTreeNode }) {
  return (
    <>
      <li role="treeitem" aria-level={node.depth + 1} aria-selected={false} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" style={{ paddingLeft: `${12 + node.depth * 24}px` }}>
        <Link to={`/admin/nodes/${node.id}`} className={clsx('underline', node.kind === 'NAVIGATION' ? 'font-medium text-ink-900' : 'text-ink-800')}>{node.name}</Link>
        <span className="text-xs text-ink-400">{node.kind === 'NAVIGATION' ? 'navigation' : 'decision'}{node.viaSecondary ? ' · also listed here' : ''}</span>
        {node.safetyCritical && <span title="Safety-critical: values are reviewed one by one" className="text-red-700"><ShieldAlert size={14} aria-label="safety-critical" /></span>}
        {node.kind === 'DECISION'
          ? <span className="text-xs text-ink-500">{node.publishedAt ? 'published' : 'unpublished'} · {node.products.approved} approved{node.products.needsAttention ? `, ${node.products.needsAttention} need attention` : ''} · {node.levers.candidates + node.levers.approved} levers</span>
          : <span className="text-xs text-ink-500">{node.visible ? 'visible' : node.explainerApproved ? 'explainer approved' : 'no explainer yet'}</span>}
        {node.latestRun && <RunStatusBadge status={node.latestRun.status} />}
        {node.kind === 'DECISION' && node.latestRun && <Link to={`/admin/nodes/${node.id}/review`} className="text-xs underline text-ink-600">review</Link>}
      </li>
      {!node.viaSecondary && node.children.map((c) => <TreeRow key={`${c.id}-${c.viaSecondary}`} node={c} />)}
    </>
  )
}

function flatten(nodes: AdminTreeNode[], out: AdminTreeNode[] = []): AdminTreeNode[] {
  for (const n of nodes) { if (!n.viaSecondary) { out.push(n); flatten(n.children, out) } }
  return out
}

function CreateNode({ tree }: { tree: AdminTreeNode[] }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<NodeKind>('DECISION')
  const [parentId, setParentId] = useState('')
  const create = useMutation({
    mutationFn: () => api.post('/admin/nodes', { name, kind, parentId: parentId || null }),
    onSuccess: () => { setName(''); void qc.invalidateQueries({ queryKey: ['admin', 'nodes'] }) },
  })
  const parents = flatten(tree).filter((n) => n.kind === 'NAVIGATION')
  return (
    <form className="card p-4 mt-6 grid grid-cols-1 md:grid-cols-4 gap-2 items-end" onSubmit={(e) => { e.preventDefault(); create.mutate() }} aria-label="Add a node">
      <label><span className="label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} /></label>
      <label><span className="label">Kind</span>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as NodeKind)}>
          <option value="DECISION">Decision (levers and products)</option>
          <option value="NAVIGATION">Navigation (children and an explainer)</option>
        </select></label>
      <label><span className="label">Primary parent</span>
        <select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">(none: a root)</option>
          {parents.map((p) => <option key={p.id} value={p.id}>{'— '.repeat(p.depth)}{p.name}</option>)}
        </select></label>
      <div>
        <button className="btn-primary" disabled={create.isPending}>Add node</button>
        {create.isError && <p role="alert" className="text-sm text-red-700 mt-1">{apiError(create.error)}</p>}
      </div>
    </form>
  )
}
