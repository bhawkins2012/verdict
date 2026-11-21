// The taxonomy (docs/adr-generation-run.md D1): navigation and decision nodes, primary and secondary
// parents, no cycles, safety inherited from Car seats, and what is visible publicly. The database holds the
// rules too (triggers); the checks here give readable 400s first.
import { NodeKind, Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { AppError } from '../middleware/errorHandler'

type Db = Prisma.TransactionClient

export interface NodeRow {
  id: string; slug: string; name: string; kind: NodeKind; parentId: string | null; position: number
  safetyCritical: boolean; publishedAt: Date | null; explainerApprovedAt: Date | null
}

const NODE_SELECT = {
  id: true, slug: true, name: true, kind: true, parentId: true, position: true, safetyCritical: true, publishedAt: true, explainerApprovedAt: true,
} satisfies Prisma.TaxonomyNodeSelect

/** The whole taxonomy (small: it is product structure), with secondary edges. */
export async function loadTaxonomy(db: Db = prisma) {
  const [nodes, secondary] = await Promise.all([
    db.taxonomyNode.findMany({ select: NODE_SELECT, orderBy: [{ position: 'asc' }, { name: 'asc' }] }),
    db.nodeSecondaryParent.findMany({ select: { nodeId: true, parentId: true } }),
  ])
  return new Taxonomy(nodes, secondary)
}

export class Taxonomy {
  readonly byId: Map<string, NodeRow>
  constructor(readonly nodes: NodeRow[], readonly secondary: { nodeId: string; parentId: string }[]) {
    this.byId = new Map(nodes.map((n) => [n.id, n]))
  }

  bySlug(slug: string): NodeRow | undefined {
    return this.nodes.find((n) => n.slug === slug)
  }

  /** Primary path from the root, ending with the node itself (breadcrumbs). */
  path(id: string): NodeRow[] {
    const out: NodeRow[] = []
    const seen = new Set<string>()
    let cur = this.byId.get(id)
    while (cur && !seen.has(cur.id)) {
      out.unshift(cur)
      seen.add(cur.id)
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined
    }
    return out
  }

  /** Children under a navigation node: primary children and nodes "also listed in" it. */
  children(id: string): { node: NodeRow; viaSecondary: boolean }[] {
    const primary = this.nodes.filter((n) => n.parentId === id).map((node) => ({ node, viaSecondary: false }))
    const extra = this.secondary.filter((e) => e.parentId === id).map((e) => this.byId.get(e.nodeId))
      .filter((n): n is NodeRow => !!n).map((node) => ({ node, viaSecondary: true }))
    return [...primary, ...extra]
  }

  safetyCritical(id: string): boolean {
    return this.path(id).some((n) => n.safetyCritical)
  }

  /** Is `ancestorId` reachable from `id` through primary or secondary edges (or the same node)? */
  hasAncestor(id: string, ancestorId: string): boolean {
    const stack = [id]
    const seen = new Set<string>()
    while (stack.length) {
      const cur = stack.pop() as string
      if (cur === ancestorId) return true
      if (seen.has(cur)) continue
      seen.add(cur)
      const n = this.byId.get(cur)
      if (n?.parentId) stack.push(n.parentId)
      for (const e of this.secondary) if (e.nodeId === cur) stack.push(e.parentId)
    }
    return false
  }

  /** Public visibility (D1): a decision node when published; a navigation node when its explainer is approved and something below it is visible. */
  visible(id: string, seen = new Set<string>()): boolean {
    const n = this.byId.get(id)
    if (!n || seen.has(id)) return false
    seen.add(id)
    if (n.kind === NodeKind.DECISION) return n.publishedAt !== null
    return n.explainerApprovedAt !== null && this.children(id).some((c) => this.visible(c.node.id, new Set(seen)))
  }

  /** One line per node, for the placement prompt: "  slug: Name (KIND)". */
  outline(): string {
    const lines: string[] = []
    const walk = (parentId: string | null, depth: number) => {
      for (const n of this.nodes.filter((x) => x.parentId === parentId)) {
        lines.push(`${'  '.repeat(depth)}${n.slug}: ${n.name} (${n.kind})`)
        walk(n.id, depth + 1)
      }
    }
    walk(null, 0)
    return lines.join('\n')
  }
}

/** Refuse an edge child → parent that would break the rules (the trigger repeats this at the database). */
export function assertEdge(t: Taxonomy, childId: string, parentId: string): void {
  const parent = t.byId.get(parentId)
  const child = t.byId.get(childId)
  if (!parent || !child) throw new AppError(404, 'Node not found')
  if (parent.kind !== NodeKind.NAVIGATION) throw new AppError(400, `"${parent.name}" is a decision node; only navigation nodes have children`)
  if (childId === parentId || t.hasAncestor(parentId, childId)) {
    const path = t.path(parentId).map((n) => n.name).join(' › ')
    throw new AppError(400, `"${child.name}" cannot go under "${parent.name}": it is already above it (${path}), which would make a cycle`)
  }
}

/** Serialize taxonomy edits (the cycle trigger takes the same lock). */
export async function lockTaxonomy(tx: Db): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('taxonomy_edges'))`
}

export async function lockNode(tx: Db, nodeId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "taxonomy_nodes" WHERE id = ${nodeId} FOR UPDATE`
  if (rows.length === 0) throw new AppError(404, 'Node not found')
}

// ── Admin edits ─────────────────────────────────────────────────────────────────────────────────────
export const slugSchema = z.string().trim().toLowerCase().min(2).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'use lower-case letters, digits and single hyphens')

export const createNodeSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: slugSchema.optional(),
  kind: z.nativeEnum(NodeKind),
  parentId: z.string().min(1).max(64).nullable().optional(),
  searchTerms: z.array(z.string().trim().min(2).max(60)).max(20).optional(),
}).strict()

export const editNodeSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  searchTerms: z.array(z.string().trim().min(2).max(60)).max(30).optional(),
  parentId: z.string().min(1).max(64).nullable().optional(),
  secondaryParentIds: z.array(z.string().min(1).max(64)).max(10).optional(),
  safetyCritical: z.boolean().optional(),
}).strict()

export async function editNode(nodeId: string, input: z.infer<typeof editNodeSchema>, userId: string) {
  return prisma.$transaction(async (tx) => {
    await lockTaxonomy(tx)
    const t = await loadTaxonomy(tx)
    const node = t.byId.get(nodeId)
    if (!node) throw new AppError(404, 'Node not found')
    if (input.parentId !== undefined && input.parentId !== null) assertEdge(t, nodeId, input.parentId)
    if (input.secondaryParentIds) {
      for (const p of input.secondaryParentIds) {
        if (p === (input.parentId ?? node.parentId)) throw new AppError(400, 'The primary parent is not also a secondary parent')
        assertEdge(t, nodeId, p)
      }
    }
    await tx.taxonomyNode.update({
      where: { id: nodeId },
      data: { name: input.name, searchTerms: input.searchTerms, parentId: input.parentId, safetyCritical: input.safetyCritical },
    })
    if (input.secondaryParentIds) {
      await tx.nodeSecondaryParent.deleteMany({ where: { nodeId } })
      if (input.secondaryParentIds.length) {
        await tx.nodeSecondaryParent.createMany({ data: input.secondaryParentIds.map((parentId) => ({ nodeId, parentId, createdById: userId })) })
      }
    }
    return tx.taxonomyNode.findUniqueOrThrow({ where: { id: nodeId } })
  })
}
