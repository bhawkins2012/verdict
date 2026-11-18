// The shape of a generation run's output (docs/adr-levers.md D3).
//
// Two schemas: ApiCandidateSetSchema (client.ts, zod/v4 as the SDK helper requires) is the structural
// shape sent to the API as the structured-output format. CandidateSetSchema (here) is the strict product
// rule set that every result must pass before anything is stored, whatever the API guaranteed.
import { z } from 'zod'
import { LeverType } from '@prisma/client'

export const MIN_CANDIDATES = 10
export const MAX_CANDIDATES = 12

export const leverTypes = [LeverType.MEASUREMENT, LeverType.CATEGORY, LeverType.COMPATIBILITY_LIST, LeverType.BOOLEAN] as const

const oneLine = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(min).max(max).refine((s) => !/[\r\n]/.test(s), 'must be one line'))

export const CandidateSchema = z
  .object({
    name: oneLine(2, 60),
    type: z.enum(leverTypes),
    unit: z.string().trim().max(20).nullable(),
    explanation: oneLine(10, 200),
    relatedNeeds: z.array(oneLine(2, 60)).min(1).max(6),
  })
  .strict()
  .superRefine((c, ctx) => {
    const hasUnit = c.unit !== null && c.unit !== ''
    if (c.type === LeverType.MEASUREMENT && !hasUnit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unit'], message: 'a measurement needs a unit' })
    }
    if (c.type !== LeverType.MEASUREMENT && hasUnit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unit'], message: 'only a measurement has a unit' })
    }
  })
  .transform((c) => ({ ...c, unit: c.type === LeverType.MEASUREMENT ? c.unit : null }))

export const CandidateSetSchema = z
  .object({ candidates: z.array(CandidateSchema).min(MIN_CANDIDATES).max(MAX_CANDIDATES) })
  .strict()
  .superRefine((set, ctx) => {
    const seen = new Set<string>()
    set.candidates.forEach((c, i) => {
      const key = normalizeName(c.name)
      if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidates', i, 'name'], message: 'duplicate name' })
      seen.add(key)
    })
  })

export type Candidate = z.output<typeof CandidateSchema>

/** Case- and whitespace-insensitive name key: levers, survey rows and CSV rows are matched by it. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Short, log-safe description of why output failed validation (no model text beyond paths). */
export function describeIssues(error: z.ZodError): string {
  return error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}
