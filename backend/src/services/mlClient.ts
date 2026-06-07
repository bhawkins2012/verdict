const ML_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000'

export async function getRecommendations(userFeatures: any): Promise<any[]> {
  const res = await fetch(`${ML_URL}/recommend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userFeatures),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`ML service error: ${res.status}`)
  const data = await res.json()
  return data.recommendations
}

export async function enrichReviewWithNLP(text: string): Promise<{
  sentimentScore?: number
  keyTopics?: string[]
  summaryAuto?: string
}> {
  const res = await fetch(`${ML_URL}/nlp/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) return {}
  return res.json()
}
