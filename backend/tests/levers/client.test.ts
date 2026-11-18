// The real Anthropic client class, with a stub fetch: checks the request it sends and how it reads the
// response. No network call is made.
import { AnthropicLeverClient, parseJsonText } from '../../src/levers/client'
import { loadLeverConfig } from '../../src/levers/config'
import { validCandidates } from './helpers'

function stubFetch(body: object, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fn, calls }
}

const message = (text: string, extra: object = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
  stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 3400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...extra,
})

const config = loadLeverConfig({ LEVER_GEN_MODE: 'live', ANTHROPIC_API_KEY: 'test-key', LEVER_GEN_MAX_TOKENS: '12000' })
const request = { categoryName: 'Strollers', searchTerms: ['pram'], notes: 'families who fly' }

describe('AnthropicLeverClient (stub fetch)', () => {
  it('sends the configured model, token cap, adaptive thinking, high effort and the JSON schema; no fallbacks', async () => {
    const { fn, calls } = stubFetch(message(JSON.stringify(validCandidates())))
    await new AnthropicLeverClient(fn).generate(request, config)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 12000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object', required: ['candidates'] } } },
    })
    expect(body.fallbacks).toBeUndefined()
    expect(body.messages[0].content).toContain('Category: Strollers')
    expect(body.messages[0].content).toContain('families who fly')
    const headers = new Headers(calls[0].init?.headers)
    // SDK 1.x sends the key as a bearer token and pins the API version.
    expect(headers.get('authorization')).toBe('Bearer test-key')
    expect(headers.get('anthropic-version')).toBe('2026-10-21')
    expect(headers.get('anthropic-beta')).toBeNull()
  })

  it('returns the parsed JSON, stop reason, served model and usage', async () => {
    const { fn } = stubFetch(message(JSON.stringify(validCandidates()), { model: 'claude-opus-5-5' }))
    const result = await new AnthropicLeverClient(fn).generate(request, config)
    expect(result).toEqual({
      output: validCandidates(),
      stopReason: 'end_turn',
      servedModel: 'claude-opus-5-5',
      usage: { inputTokens: 1200, outputTokens: 3400, cacheReadTokens: 0 },
    })
  })

  it('returns null output for a refusal without text, keeping the stop reason', async () => {
    const { fn } = stubFetch({ ...message(''), content: [], stop_reason: 'refusal' })
    const result = await new AnthropicLeverClient(fn).generate(request, config)
    expect(result.output).toBeNull()
    expect(result.stopReason).toBe('refusal')
  })

  it('throws the SDK error class on an API error', async () => {
    const { fn } = stubFetch({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529)
    await expect(new AnthropicLeverClient(fn).generate(request, config)).rejects.toMatchObject({ status: 529 })
  })
})

describe('parseJsonText', () => {
  it('parses the first text block and returns null for non-JSON or no text', () => {
    expect(parseJsonText([{ type: 'text', text: '{"a":1}', citations: null }])).toEqual({ a: 1 })
    expect(parseJsonText([{ type: 'text', text: 'not json', citations: null }])).toBeNull()
    expect(parseJsonText([])).toBeNull()
  })
})
