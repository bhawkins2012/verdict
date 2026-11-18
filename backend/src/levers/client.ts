// The one place that talks to the Anthropic API (docs/adr-levers.md D3). Tests inject a fake through
// setLeverClientForTests; nothing else in the code base constructs an Anthropic client.
import Anthropic from '@anthropic-ai/sdk'
import { leverTypes } from './candidates'
import { LEVER_GEN_EFFORT, LeverConfig } from './config'

/**
 * Structural JSON schema for the API's structured output (output_config.format), so the API constrains
 * decoding to this shape. The strict product rules (counts, lengths, unit iff measurement, unique names)
 * are in candidates.ts and are checked on every result before anything is stored.
 */
export const CANDIDATE_SET_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'unit', 'explanation', 'relatedNeeds'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: [...leverTypes] },
          unit: { type: ['string', 'null'] },
          explanation: { type: 'string' },
          relatedNeeds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const

/** The JSON text of the first text block, parsed; null if there is none or it is not JSON. */
export function parseJsonText(content: readonly Anthropic.ContentBlock[]): unknown {
  const text = content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text
  if (text === undefined) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const PROMPT_VERSION = 'levers-v1'

export const SYSTEM_PROMPT = `You propose "value levers" for a product category on Verdict, a product-review site that helps people choose.

A value lever is an attribute that most decides whether a product in the category is right for a particular person. Good levers:
- can be checked from a spec sheet, manual or product listing (measurable or verifiable), not opinions about quality;
- differ meaningfully between products in the category;
- connect to concrete user needs or circumstances (for example air travel, a small car, rough terrain);
- are general attributes, never brand or model names.

Each lever has one type:
- MEASUREMENT: a number with a unit (give the unit, for example "lb" or "in");
- CATEGORY: one value from a short fixed list (unit null);
- COMPATIBILITY_LIST: a list of other products it works with (unit null);
- BOOLEAN: yes or no (unit null).

Return 10 to 12 candidates, most decisive first. For each: a short name (at most 60 characters), its type, its unit (null unless MEASUREMENT), a one-line explanation of why it matters to a buyer (at most 200 characters, plain text), and 1 to 6 short user needs it interacts with.`

export interface GenerationRequest {
  categoryName: string
  searchTerms: string[]
  notes: string | null
}

export interface GenerationResult {
  /** The parsed structured output, or null when the API returned none. Validated by the caller. */
  output: unknown
  stopReason: string | null
  servedModel: string
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
}

export interface LeverGenClient {
  generate(request: GenerationRequest, config: LeverConfig): Promise<GenerationResult>
}

export function userMessage(request: GenerationRequest): string {
  const lines = [`Category: ${request.categoryName}`]
  if (request.searchTerms.length) lines.push(`Also searched as: ${request.searchTerms.join(', ')}`)
  if (request.notes) lines.push(`Notes from the Verdict editor:\n${request.notes}`)
  return lines.join('\n')
}

export class AnthropicLeverClient implements LeverGenClient {
  /** `fetchImpl` lets tests check the exact request without a network call. */
  constructor(private readonly fetchImpl?: typeof fetch) {}

  async generate(request: GenerationRequest, config: LeverConfig): Promise<GenerationResult> {
    const client = new Anthropic({ apiKey: config.apiKey, ...(this.fetchImpl ? { fetch: this.fetchImpl, maxRetries: 0 } : {}) })
    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: LEVER_GEN_EFFORT, format: { type: 'json_schema', schema: CANDIDATE_SET_JSON_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage(request) }],
    })
    return {
      output: parseJsonText(response.content),
      stopReason: response.stop_reason,
      servedModel: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    }
  }
}

let override: LeverGenClient | null = null

export function setLeverClientForTests(client: LeverGenClient | null): void {
  override = client
}

export function leverClient(): LeverGenClient {
  if (override) return override
  // Tests inject a fake; this makes it impossible for a test to reach the real API by accident.
  if (process.env.NODE_ENV === 'test') throw new Error('Tests must inject a lever generation client (setLeverClientForTests)')
  return new AnthropicLeverClient()
}
