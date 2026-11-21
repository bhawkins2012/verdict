// The dry-run model (docs/adr-generation-run.md D11): answers each stage from the fixtures, shaped exactly
// like the live model's output, so the same validation and storage paths run. It answers extraction from
// the fixture's spec text (quotes copied from it), plus the deliberate faults the fixtures define.
import { LeverType } from '@prisma/client'
import { normalizeName } from '../../catalog/text'
import { GenerationModel, ModelResult } from '../model'
import { ExtractedValue } from '../schemas'
import { fixtureForSlug, manualUrl, productUrl, specLine } from './site'
import { FixtureLever, NodeFixture } from './types'

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 }
const result = (output: unknown, stopReason = 'end_turn'): ModelResult => ({ output, stopReason, servedModel: null, usage: ZERO })

/** Which fixture lever an extraction lever (by name) is: same definition name, or the shared one it reuses. */
function fixtureLeverFor(f: NodeFixture, leverName: string): FixtureLever | null {
  const key = normalizeName(leverName)
  return f.levers.find((l) => normalizeName(l.definition.name) === key || l.reuseNameKey === key) ?? null
}

function answerFromText(lever: FixtureLever, text: string, items: string[] | undefined): Partial<ExtractedValue> {
  switch (lever.definition.type) {
    case LeverType.MEASUREMENT: {
      const m = /^([\d.,]+)\s*([^\d\s][^\d]*?)?(?:\s+from.*)?$/.exec(text.trim())
      return m ? { statedValue: m[1], statedUnit: (m[2] ?? '').trim() || null } : { statedValue: null }
    }
    case LeverType.CATEGORY:
      return { choice: text.trim() }
    case LeverType.COMPATIBILITY_LIST:
      return { items: items ?? [] }
    case LeverType.BOOLEAN:
      return { bool: /^yes/i.test(text.trim()) }
  }
}

export class DryRunModel implements GenerationModel {
  async place(input: Parameters<GenerationModel['place']>[0]): Promise<ModelResult> {
    const f = fixtureForSlug(input.nodeSlug)
    return result({
      primaryParentFits: true,
      suggestedPrimaryParent: null,
      secondaryParents: [],
      searchTerms: f.searchTerms,
      rationale: `${input.nodeName} fits under ${input.path[input.path.length - 2] ?? 'its parent'} (dry-run placement).`,
    })
  }

  async levers(input: Parameters<GenerationModel['levers']>[0]): Promise<ModelResult> {
    const f = fixtureForSlug(input.nodeSlug)
    const byName = new Map(input.definitions.map((d) => [normalizeName(d.name), d.id]))
    const candidates: { reuseDefinitionId: string | null; definition: FixtureLever['definition'] | null; note: string | null }[] = []
    const used = new Set<string>()
    // Reference levers are kept (and reused) first.
    for (const r of input.reference) {
      candidates.push({ reuseDefinitionId: r.id, definition: null, note: 'Kept from the reference set.' })
      used.add(r.id)
    }
    for (const l of f.levers) {
      if (candidates.length >= 12) break
      const reuse = l.reuseNameKey ? byName.get(l.reuseNameKey) ?? byName.get(normalizeName(l.definition.name)) : byName.get(normalizeName(l.definition.name))
      if (reuse) {
        if (used.has(reuse)) continue
        used.add(reuse)
        candidates.push({ reuseDefinitionId: reuse, definition: null, note: l.note ?? null })
      } else {
        candidates.push({ reuseDefinitionId: null, definition: l.definition, note: l.note ?? null })
      }
    }
    return result({
      candidates,
      referenceNotes: input.reference.map((r) => ({ definitionId: r.id, keep: true, note: 'Still decisive for this node (dry-run note).' })),
    })
  }

  async discover(input: Parameters<GenerationModel['discover']>[0]): Promise<ModelResult> {
    const f = fixtureForSlug(input.nodeSlug)
    return result({
      products: f.products.map((p) => ({ brand: p.brand, model: p.model, manufacturerUrl: productUrl(f, p), rationale: 'Widely sold (dry-run fixture).' })),
    }, 'tool_use')
  }

  async extract(input: Parameters<GenerationModel['extract']>[0]): Promise<ModelResult> {
    const f = fixtureForSlug(input.nodeSlug)
    const p = f.products.find((x) => productUrl(f, x) === input.product.url)
    const page = input.documents.find((d) => d.kind === 'page')
    const manualDoc = p ? input.documents.find((d) => d.url === manualUrl(f, p)) : undefined
    const values: ExtractedValue[] = input.levers.map((l) => {
      const blank: ExtractedValue = {
        lever: l.key, found: false, statedValue: null, statedUnit: null, dimensions: null, items: null, choice: null,
        bool: null, oneHandFold: null, quote: null, source: null, confidence: 'HIGH',
      }
      const fl = p ? fixtureLeverFor(f, l.name) : null
      if (!p || !fl) return blank
      const onPage = p.specs[fl.key]
      const inManual = p.manual?.[fl.key]
      let answer: ExtractedValue = blank
      if (onPage !== undefined && page) {
        answer = { ...blank, found: true, ...answerFromText(fl, onPage, p.items?.[fl.key]), quote: specLine(f, fl.key, onPage), source: page.key }
      } else if (inManual !== undefined && manualDoc) {
        answer = { ...blank, found: true, ...answerFromText(fl, inManual, p.items?.[fl.key]), quote: specLine(f, fl.key, inManual), source: manualDoc.key }
      }
      const override = p.answers?.[fl.key]
      return override ? { ...answer, ...override, lever: l.key, source: override.source === 'page' ? page?.key ?? null : override.source ?? answer.source } : answer
    })
    return result({
      nodeFit: p?.nodeFit ?? { belongs: true, confidence: 'HIGH', reason: `The page describes a ${f.productType.toLowerCase()}.` },
      values,
    })
  }

  async explain(input: Parameters<GenerationModel['explain']>[0]): Promise<ModelResult> {
    const names = input.children.map((c) => c.name)
    return result({
      explainer: `${input.nodeName} come in ${names.length} kinds: ${names.join(', ')}. Each suits a different stage or way of getting around; the pages below compare the products of each kind on the attributes that matter most. (Dry-run text.)`.slice(0, 600),
      children: input.children.map((c) => ({ slug: c.slug, line: `${c.name}: what sets this kind apart (dry-run line).` })),
    })
  }
}
