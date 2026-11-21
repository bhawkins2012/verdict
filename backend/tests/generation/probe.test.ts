// npm run generation:probe: refuses without live mode, prints the full API error, and prints the output with
// its cost and the stage's own validation verdict. A stub fetch stands in for the API; no network.
import Anthropic from '@anthropic-ai/sdk'
import { buildStageRequest } from '../../src/generation/model'
import { runProbe, sendProbe } from '../../src/scripts/generationProbe'

describe('generation:probe', () => {
  const config = { mode: 'live' as const, model: 'claude-opus-5-5', maxTokens: 16000, runCapUsd: 10, dailyCapUsd: 40, minProducts: 10, apiKey: 'test-key-never-sent' }
  const request = buildStageRequest({ stage: 'place', input: { nodeSlug: 'n', nodeName: 'N', path: ['N'], outline: 'n: N, decision' } }, config)
  const clientAnswering = (status: number, body: unknown) => new Anthropic({
    apiKey: 'test-key-never-sent', maxRetries: 0,
    fetch: (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_011CPROBE' } })) as unknown as typeof fetch,
  })

  it('refuses in dry-run mode and without a stage or node', async () => {
    const lines: string[] = []
    expect(await runProbe(['levers', 'infant-car-seats'], { GENERATION_MODE: 'dry_run' }, (l) => lines.push(l))).toBe(2)
    expect(lines.join('\n')).toMatch(/Refusing: GENERATION_MODE is dry_run/)
    expect(await runProbe(['levers'], { GENERATION_MODE: 'live', ANTHROPIC_API_KEY: 'k' }, (l) => lines.push(l))).toBe(2)
    expect(lines.at(-1)).toMatch(/^Usage: npm run generation:probe/)
  })

  it('prints the full API error', async () => {
    const lines: string[] = []
    const body = { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format.schema: Schema is too complex for compilation.' }, request_id: 'req_011CPROBE' }
    expect(await sendProbe('place', request, config, (l) => lines.push(l), clientAnswering(400, body))).toBe(1)
    const out = lines.join('\n')
    expect(out).toContain('FAILED after')
    expect(out).toContain('api_error:400: invalid_request_error: "output_config.format.schema: Schema is too complex for compilation." (request_id req_011CPROBE)')
    expect(out).toContain('"request_id": "req_011CPROBE"')
  })

  it('prints the output, its cost and whether the stage would accept it', async () => {
    const lines: string[] = []
    const output = { primaryParentFits: true, suggestedPrimaryParent: null, secondaryParents: [], searchTerms: ['infant seat'], rationale: 'Fits under car seats.' }
    const message = {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(output) }], usage: { input_tokens: 1000, output_tokens: 300 },
    }
    expect(await sendProbe('place', request, config, (l) => lines.push(l), clientAnswering(200, message))).toBe(0)
    const out = lines.join('\n')
    expect(out).toMatch(/stop_reason=end_turn/)
    expect(out).toMatch(/Cost of this probe: \$0\.0100/)
    expect(out).toContain('accepts this output')
  })
})
