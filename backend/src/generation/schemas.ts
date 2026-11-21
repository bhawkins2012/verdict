// What each stage's model call must return (docs/adr-generation-run.md D5). Two layers, as in Phase A:
// a structural JSON schema sent to the API (structured outputs / a strict tool), and the strict zod rules
// here that every result must pass before anything is stored, whatever the API guaranteed.
import { z } from 'zod'
import { LeverInputFormat, LeverType } from '@prisma/client'
import { CANONICAL_UNITS } from '../catalog/units'
import { normalizeName } from '../catalog/text'

export const MIN_CANDIDATES = 10
export const MAX_CANDIDATES = 12
export const MIN_PRODUCTS = 10 // below this DISCOVER fails (section 5 A3)
export const TARGET_MIN_PRODUCTS = 15
export const MAX_PRODUCTS = 20

const leverTypes = [LeverType.MEASUREMENT, LeverType.CATEGORY, LeverType.COMPATIBILITY_LIST, LeverType.BOOLEAN] as const
const confidences = ['HIGH', 'MEDIUM', 'LOW'] as const

const oneLine = (min: number, max: number) =>
  z.string().transform((s) => s.trim()).pipe(z.string().min(min).max(max).refine((s) => !/[\r\n]/.test(s), 'must be one line'))

export function describeIssues(error: z.ZodError): string {
  return error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

// ── PLACE ───────────────────────────────────────────────────────────────────────────────────────────
export const PlacementSchema = z.object({
  primaryParentFits: z.boolean(),
  suggestedPrimaryParent: z.string().trim().max(60).nullable(),
  secondaryParents: z.array(z.string().trim().min(1).max(60)).max(5),
  searchTerms: z.array(oneLine(2, 60)).max(10),
  rationale: oneLine(5, 300),
}).strict()
export type Placement = z.output<typeof PlacementSchema>

export const PLACEMENT_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['primaryParentFits', 'suggestedPrimaryParent', 'secondaryParents', 'searchTerms', 'rationale'],
  properties: {
    primaryParentFits: { type: 'boolean' },
    suggestedPrimaryParent: { type: ['string', 'null'] },
    secondaryParents: { type: 'array', items: { type: 'string' } },
    searchTerms: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
} as const

// ── LEVERS ──────────────────────────────────────────────────────────────────────────────────────────
const NewDefinitionSchema = z.object({
  name: oneLine(2, 60),
  type: z.enum(leverTypes),
  inputFormat: z.enum([LeverInputFormat.SINGLE, LeverInputFormat.DIMENSIONS]),
  unit: z.enum(CANONICAL_UNITS).nullable(),
  explanation: oneLine(10, 200),
  relatedNeeds: z.array(oneLine(2, 60)).min(1).max(6),
  allowedValues: z.array(oneLine(1, 60)).max(12),
  safetyFlag: z.boolean(),
}).superRefine((c, ctx) => {
  if (c.type === LeverType.MEASUREMENT && !c.unit) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unit'], message: 'a measurement needs a unit' })
  if (c.type !== LeverType.MEASUREMENT && c.unit) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unit'], message: 'only a measurement has a unit' })
  if (c.inputFormat === LeverInputFormat.DIMENSIONS && (c.type !== LeverType.MEASUREMENT || c.unit !== 'cu ft')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inputFormat'], message: 'dimensions are a measurement in cu ft' })
  }
  if (c.type === LeverType.CATEGORY && c.allowedValues.length < 2) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedValues'], message: 'a category needs at least two allowed values' })
  if (c.type !== LeverType.CATEGORY && c.allowedValues.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedValues'], message: 'only a category has allowed values' })
})

const CandidateSchema = z.object({
  reuseDefinitionId: z.string().trim().min(1).max(64).nullable(),
  definition: NewDefinitionSchema.nullable(),
  note: oneLine(1, 200).nullable(),
}).strict().superRefine((c, ctx) => {
  if ((c.reuseDefinitionId === null) === (c.definition === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'give either reuseDefinitionId or a new definition' })
  }
})

export const LeverSetSchema = z.object({
  candidates: z.array(CandidateSchema).min(MIN_CANDIDATES).max(MAX_CANDIDATES),
  referenceNotes: z.array(z.object({ definitionId: z.string().min(1).max(64), keep: z.boolean(), note: oneLine(1, 200) }).strict()).max(12),
}).strict().superRefine((set, ctx) => {
  const names = new Set<string>()
  const ids = new Set<string>()
  set.candidates.forEach((c, i) => {
    if (c.definition) {
      const key = normalizeName(c.definition.name)
      if (names.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidates', i], message: 'duplicate name' })
      names.add(key)
    }
    if (c.reuseDefinitionId) {
      if (ids.has(c.reuseDefinitionId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidates', i], message: 'duplicate reuse' })
      ids.add(c.reuseDefinitionId)
    }
  })
})
export type LeverSet = z.output<typeof LeverSetSchema>

const DEFINITION_JSON = {
  type: ['object', 'null'], additionalProperties: false,
  required: ['name', 'type', 'inputFormat', 'unit', 'explanation', 'relatedNeeds', 'allowedValues', 'safetyFlag'],
  properties: {
    name: { type: 'string' },
    type: { type: 'string', enum: [...leverTypes] },
    inputFormat: { type: 'string', enum: ['SINGLE', 'DIMENSIONS'] },
    unit: { type: ['string', 'null'], enum: [...CANONICAL_UNITS, null] },
    explanation: { type: 'string' },
    relatedNeeds: { type: 'array', items: { type: 'string' } },
    allowedValues: { type: 'array', items: { type: 'string' } },
    safetyFlag: { type: 'boolean' },
  },
} as const

export const LEVER_SET_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['candidates', 'referenceNotes'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['reuseDefinitionId', 'definition', 'note'],
        properties: { reuseDefinitionId: { type: ['string', 'null'] }, definition: DEFINITION_JSON, note: { type: ['string', 'null'] } },
      },
    },
    referenceNotes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['definitionId', 'keep', 'note'],
        properties: { definitionId: { type: 'string' }, keep: { type: 'boolean' }, note: { type: 'string' } },
      },
    },
  },
} as const

// ── DISCOVER (returned through the strict `propose_products` tool) ─────────────────────────────────
export const ProductProposalSchema = z.object({
  brand: oneLine(1, 80),
  model: oneLine(1, 120),
  manufacturerUrl: z.string().trim().max(2000).url().refine((u) => u.startsWith('https://'), 'must be https'),
  rationale: oneLine(1, 200),
}).strict()

export const DiscoverySchema = z.object({
  products: z.array(ProductProposalSchema).max(MAX_PRODUCTS),
}).strict()
export type Discovery = z.output<typeof DiscoverySchema>

export const PROPOSE_PRODUCTS_TOOL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['products'],
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['brand', 'model', 'manufacturerUrl', 'rationale'],
        properties: { brand: { type: 'string' }, model: { type: 'string' }, manufacturerUrl: { type: 'string' }, rationale: { type: 'string' } },
      },
    },
  },
} as const

// ── EXTRACT ─────────────────────────────────────────────────────────────────────────────────────────
export const ExtractedValueSchema = z.object({
  lever: z.string().trim().min(1).max(10),
  found: z.boolean(),
  statedValue: z.string().trim().max(100).nullable(),
  statedUnit: z.string().trim().max(30).nullable(),
  dimensions: z.object({ length: z.string().trim().max(20), width: z.string().trim().max(20), height: z.string().trim().max(20) }).strict().nullable(),
  items: z.array(z.string().trim().min(1).max(120)).max(60).nullable(),
  choice: z.string().trim().max(60).nullable(),
  bool: z.boolean().nullable(),
  oneHandFold: z.boolean().nullable(),
  quote: z.string().max(400).nullable(),
  source: z.string().trim().max(10).nullable(),
  confidence: z.enum(confidences),
}).strict()
export type ExtractedValue = z.output<typeof ExtractedValueSchema>

export const ExtractionSchema = z.object({
  nodeFit: z.object({ belongs: z.boolean(), confidence: z.enum(confidences), reason: oneLine(1, 300) }).strict(),
  values: z.array(ExtractedValueSchema).max(20),
}).strict()
export type Extraction = z.output<typeof ExtractionSchema>

export const EXTRACTION_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['nodeFit', 'values'],
  properties: {
    nodeFit: {
      type: 'object', additionalProperties: false, required: ['belongs', 'confidence', 'reason'],
      properties: { belongs: { type: 'boolean' }, confidence: { type: 'string', enum: [...confidences] }, reason: { type: 'string' } },
    },
    values: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['lever', 'found', 'statedValue', 'statedUnit', 'dimensions', 'items', 'choice', 'bool', 'oneHandFold', 'quote', 'source', 'confidence'],
        properties: {
          lever: { type: 'string' },
          found: { type: 'boolean' },
          statedValue: { type: ['string', 'null'] },
          statedUnit: { type: ['string', 'null'] },
          dimensions: {
            type: ['object', 'null'], additionalProperties: false, required: ['length', 'width', 'height'],
            properties: { length: { type: 'string' }, width: { type: 'string' }, height: { type: 'string' } },
          },
          items: { type: ['array', 'null'], items: { type: 'string' } },
          choice: { type: ['string', 'null'] },
          bool: { type: ['boolean', 'null'] },
          oneHandFold: { type: ['boolean', 'null'] },
          quote: { type: ['string', 'null'] },
          source: { type: ['string', 'null'] },
          confidence: { type: 'string', enum: [...confidences] },
        },
      },
    },
  },
} as const

// ── EXPLAIN ─────────────────────────────────────────────────────────────────────────────────────────
export const ExplainerSchema = z.object({
  explainer: z.string().transform((s) => s.trim()).pipe(z.string().min(20).max(600)),
  children: z.array(z.object({ slug: z.string().trim().min(1).max(60), line: oneLine(5, 160) }).strict()).min(1).max(20),
}).strict()
export type Explainer = z.output<typeof ExplainerSchema>

export const EXPLAINER_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['explainer', 'children'],
  properties: {
    explainer: { type: 'string' },
    children: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['slug', 'line'], properties: { slug: { type: 'string' }, line: { type: 'string' } } },
    },
  },
} as const
