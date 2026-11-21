// The request each stage sends, checked against the Claude API docs (src/generation/requestRules.ts lists the
// pages): a snapshot of its keys, settings and schema (never the prompt text), the documented rules, and that
// the client sends exactly what buildStageRequest builds. No database and no network.
import { AnthropicGenerationModel, buildStageRequest, ModelStage, StageRequestInput } from '../../src/generation/model'
import { checkSchema, requestIssues, requestShape } from '../../src/generation/requestRules'

const config = { mode: 'live' as const, model: 'claude-opus-5-5', maxTokens: 16000, runCapUsd: 10, dailyCapUsd: 40, minProducts: 10, apiKey: 'test-key-never-sent' }
const node = { nodeSlug: 'infant-car-seats', nodeName: 'Infant car seats', path: ['Baby and Kids', 'Car seats', 'Infant car seats'] }
const def = { id: 'def1', name: 'Weight', type: 'MEASUREMENT', unit: 'lb', explanation: 'Carry weight.' }

const INPUTS: Record<ModelStage, StageRequestInput> = {
  place: { stage: 'place', input: { ...node, outline: 'baby-and-kids: Baby and Kids, navigation' } },
  levers: { stage: 'levers', input: { ...node, notes: null, definitions: [def], reference: [def] } },
  discover: { stage: 'discover', input: { ...node, searchTerms: ['infant seat'], notes: null } },
  extract: {
    stage: 'extract',
    input: {
      ...node, product: { brand: 'Acme', name: 'Glide', url: 'https://acme.example/glide' },
      levers: [{ key: 'L1', name: 'Weight', type: 'MEASUREMENT', inputFormat: 'SINGLE', unit: 'lb', allowedValues: [], explanation: 'x' }],
      documents: [{ key: 'page', kind: 'page', url: 'https://acme.example/glide', text: 'Weight: 9 lb' }],
    },
  },
  explain: { stage: 'explain', input: { ...node, children: [{ slug: 'a', name: 'A' }] } },
}
const STAGES = Object.keys(INPUTS) as ModelStage[]

/** The shape without anything that changes with prompt wording. */
function snapshotShape(stage: ModelStage) {
  const shape = requestShape(buildStageRequest(INPUTS[stage], config))
  const { system_chars: _s, messages, tools, ...rest } = shape as Record<string, unknown>
  void _s
  return {
    ...rest,
    messages: (messages as { role: string }[]).map((m) => m.role),
    tools: (tools as Record<string, unknown>[] | undefined)?.map(({ description_chars: _d, ...t }) => (void _d, t)),
  }
}

describe('stage requests', () => {
  it.each(STAGES)('%s: matches the documented shape (snapshot of keys, settings and schema)', (stage) => {
    expect(snapshotShape(stage)).toMatchSnapshot()
  })

  it.each(STAGES)('%s: breaks none of the documented rules', (stage) => {
    expect(requestIssues(buildStageRequest(INPUTS[stage], config))).toEqual([])
  })

  it('every stage uses adaptive thinking, an explicit effort and the configured model and max_tokens; none sends sampling settings', () => {
    for (const stage of STAGES) {
      const r = buildStageRequest(INPUTS[stage], config) as unknown as Record<string, unknown>
      expect(r).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, thinking: { type: 'adaptive' } })
      expect((r.output_config as { effort: string }).effort).toMatch(/^(medium|high)$/)
      for (const k of ['temperature', 'top_p', 'top_k', 'stream']) expect(r).not.toHaveProperty(k)
    }
  })

  it.each(STAGES)('%s: the client sends exactly the built request', async (stage) => {
    const bodies: unknown[] = []
    const reply = stage === 'discover'
      ? { type: 'tool_use', id: 'toolu_1', name: 'propose_products', input: { products: [] } }
      : { type: 'text', text: '{}' }
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [reply], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const model = new AnthropicGenerationModel(fetchImpl)
    const { input } = INPUTS[stage]
    await (model[stage] as (i: unknown, c: typeof config) => Promise<unknown>).call(model, input, config)
    expect(bodies).toEqual([JSON.parse(JSON.stringify(buildStageRequest(INPUTS[stage], config)))])
  })
})

describe('the documented-rules checker', () => {
  const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties, ...extra })

  it('flags unsupported keywords, array bounds, open objects, anyOf next to type, and complex enums', () => {
    const issues = checkSchema(obj({
      a: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      b: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
      c: { type: 'string', maxLength: 10, pattern: '^x$' },
      d: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      e: { type: 'string', anyOf: [{ type: 'string' }] },
      f: { enum: [{ x: 1 }] },
      g: { type: 'string', format: 'url' },
    })).issues.join('\n')
    for (const s of ['"oneOf"', 'minItems must be 0 or 1', '"maxItems"', '"maxLength"', '$.d: objects need additionalProperties', 'anyOf next to', 'complex type in enum', 'format "url"']) {
      expect(issues).toContain(s)
    }
    expect(issues).not.toContain('pattern') // simple patterns are supported
  })

  it('counts union-typed and optional parameters across the request against the documented limits', () => {
    const many = obj(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, { type: ['string', 'null'] }])))
    expect(checkSchema(many).unionParams).toBe(17)
    const req = { ...buildStageRequest(INPUTS.place, config), output_config: { effort: 'high' as const, format: { type: 'json_schema' as const, schema: many } } }
    expect(requestIssues(req)).toEqual(['17 parameters with union types across strict schemas (limit 16)'])
    const optional = { ...many, required: [] }
    expect(checkSchema(optional).optionalParams).toBe(17)
  })

  it('flags request settings claude-opus-5-5 rejects', () => {
    const base = buildStageRequest(INPUTS.discover, config)
    const bad = { ...base, temperature: 0, max_tokens: 64000, thinking: { type: 'enabled', budget_tokens: 2048 }, tool_choice: { type: 'any' } } as unknown as typeof base
    const issues = requestIssues(bad).join('\n')
    for (const s of ['temperature', 'needs streaming', 'thinking.type "enabled"', 'budget_tokens', 'tool_choice "any"']) expect(issues).toContain(s)
  })
})
