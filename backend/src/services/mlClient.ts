import { z } from 'zod'

const ML_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000'

const recommendationSchema = z.object({
  productId: z.string(),
  score: z.number(),
  reason: z.string(),
  confidence: z.number().optional(),
  demographicMatch: z.number().optional(),
})

const recommendResponseSchema = z.object({
  recommendations: z.array(recommendationSchema),
})

// Only these fields may flow from the ML service into a Review row.
const nlpEnrichmentSchema = z.object({
  sentimentScore: z.number().min(-1).max(1).optional(),
  keyTopics: z.array(z.string().max(100)).max(20).optional(),
  summaryAuto: z.string().max(2000).nullish().transform((v) => v ?? undefined),
})

export type MLRecommendation = z.infer<typeof recommendationSchema>
export type NLPEnrichment = z.infer<typeof nlpEnrichmentSchema>

export async function getRecommendations(userFeatures: Record<string, unknown>): Promise<MLRecommendation[]> {
  const res = await fetch(`${ML_URL}/recommend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userFeatures),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`ML service error: ${res.status}`)
  return recommendResponseSchema.parse(await res.json()).recommendations
}

export async function enrichReviewWithNLP(text: string): Promise<NLPEnrichment> {
  const res = await fetch(`${ML_URL}/nlp/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) return {}
  const parsed = nlpEnrichmentSchema.safeParse(await res.json())
  return parsed.success ? parsed.data : {}
}
