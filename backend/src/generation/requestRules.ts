// Local checks of a generation request against the Claude API docs, and a printable summary of its shape
// (keys and schema, never the prompt text). Used by `npm run generation:probe` before it sends anything and by
// the request-shape tests. Sources, checked 2026-11-21:
// - JSON Schema limitations and schema complexity limits:
//   https://platform.claude.com/docs/en/build-with-claude/structured-outputs (#json-schema-limitations,
//   #schema-complexity-limits). The same rules apply to `strict: true` tool schemas
//   (https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use).
// - Thinking and effort: https://platform.claude.com/docs/en/build-with-claude/effort and
//   https://platform.claude.com/docs/en/api/errors (#common-validation-errors: disabled thinking and forced
//   tool_choice are 400s on claude-opus-5-5).
// - Web search versions and domain lists: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
// - Non-streaming max_tokens: the TypeScript SDK refuses non-streaming requests above 21,333 tokens.
// Passing these checks does not guarantee the API accepts a schema: it also has internal grammar-size limits
// ("Schema is too complex for compilation") that only a live request (the probe) can show.
import type Anthropic from '@anthropic-ai/sdk'

export const LIMITS = { strictTools: 20, optionalParams: 24, unionParams: 16, maxTokens: 128_000, nonStreamingMaxTokens: 21_333 } as const
const UNSUPPORTED_KEYWORDS = [
  'oneOf', 'not', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains', 'minProperties', 'maxProperties', 'patternProperties',
  'propertyNames', 'dependentRequired', 'dependentSchemas', 'if', 'then', 'else', 'prefixItems', 'unevaluatedProperties', 'unevaluatedItems',
]
const FORMATS = ['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const WEB_SEARCH_TYPES = ['web_search_20250305', 'web_search_20260209', 'web_search_20260318']

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface SchemaStats { unionParams: number; optionalParams: number; issues: string[] }

/** Walk one schema (an output format or a strict tool's input schema) and collect the documented violations. */
export function checkSchema(schema: unknown, at = '$'): SchemaStats {
  const stats: SchemaStats = { unionParams: 0, optionalParams: 0, issues: [] }
  const visit = (node: unknown, path: string) => {
    if (!isObj(node)) return
    for (const k of UNSUPPORTED_KEYWORDS) if (k in node) stats.issues.push(`${path}: "${k}" is not supported`)
    if ('minItems' in node && node.minItems !== 0 && node.minItems !== 1) stats.issues.push(`${path}: minItems must be 0 or 1`)
    if (typeof node.$ref === 'string' && !node.$ref.startsWith('#')) stats.issues.push(`${path}: external $ref`)
    if (typeof node.format === 'string' && !FORMATS.includes(node.format)) stats.issues.push(`${path}: format "${node.format}" is not supported`)
    if ('anyOf' in node && ('type' in node || 'properties' in node)) stats.issues.push(`${path}: anyOf next to type/properties`)
    if (Array.isArray(node.enum) && node.enum.some((v) => v !== null && typeof v === 'object')) stats.issues.push(`${path}: complex type in enum`)
    const types = Array.isArray(node.type) ? node.type : [node.type]
    if (types.includes('object') || 'properties' in node) {
      if (node.additionalProperties !== false) stats.issues.push(`${path}: objects need additionalProperties: false`)
      const props = isObj(node.properties) ? node.properties : {}
      const required = Array.isArray(node.required) ? node.required : []
      for (const r of required) if (!(String(r) in props)) stats.issues.push(`${path}: required "${String(r)}" is not a property`)
      for (const [name, prop] of Object.entries(props)) {
        if (!required.includes(name)) stats.optionalParams++
        if (isObj(prop) && (Array.isArray(prop.type) || 'anyOf' in prop)) stats.unionParams++
        visit(prop, `${path}.${name}`)
      }
    }
    if ('items' in node) visit(node.items, `${path}[]`)
    for (const k of ['anyOf', 'allOf'] as const) if (Array.isArray(node[k])) (node[k] as unknown[]).forEach((s, i) => visit(s, `${path}.${k}[${i}]`))
    for (const k of ['$defs', 'definitions'] as const) if (isObj(node[k])) for (const [n, s] of Object.entries(node[k] as Json)) visit(s, `${path}.${k}.${n}`)
  }
  visit(schema, at)
  return stats
}

/** Every documented rule this request breaks (empty when it matches the docs). */
export function requestIssues(req: Anthropic.MessageCreateParamsNonStreaming): string[] {
  const issues: string[] = []
  const body = req as unknown as Json
  for (const k of ['temperature', 'top_p', 'top_k']) if (k in body) issues.push(`${k} is not accepted on current models`)
  if (req.max_tokens > LIMITS.maxTokens) issues.push(`max_tokens ${req.max_tokens} is over the model's ${LIMITS.maxTokens}`)
  if (req.max_tokens > LIMITS.nonStreamingMaxTokens) issues.push(`max_tokens ${req.max_tokens} needs streaming (SDK limit ${LIMITS.nonStreamingMaxTokens})`)
  const thinking = body.thinking as Json | undefined
  if (thinking && thinking.type !== 'adaptive') issues.push(`thinking.type "${String(thinking.type)}" is a 400 on claude-opus-5-5 (adaptive only)`)
  if (thinking && 'budget_tokens' in thinking) issues.push('thinking.budget_tokens is a 400 on claude-opus-5-5')
  const oc = (body.output_config ?? {}) as Json
  if (oc.effort !== undefined && !EFFORTS.includes(String(oc.effort))) issues.push(`output_config.effort "${String(oc.effort)}" is not a level`)
  const tc = body.tool_choice as Json | undefined
  if (tc && (tc.type === 'any' || tc.type === 'tool')) issues.push(`tool_choice "${String(tc.type)}" is a 400 on claude-opus-5-5`)

  const schemas: { at: string; schema: unknown }[] = []
  const format = oc.format as Json | undefined
  if (format) {
    if (format.type !== 'json_schema') issues.push(`output_config.format.type "${String(format.type)}"`)
    schemas.push({ at: 'output_config.format.schema', schema: format.schema })
  }
  const tools = (Array.isArray(body.tools) ? body.tools : []) as Json[]
  let strictTools = 0
  for (const t of tools) {
    if (typeof t.type === 'string' && t.type.startsWith('web_search')) {
      if (!WEB_SEARCH_TYPES.includes(t.type)) issues.push(`unknown web search version ${t.type}`)
      if (t.allowed_domains && t.blocked_domains) issues.push('web search: allowed_domains and blocked_domains together are a 400')
      for (const d of [...((t.blocked_domains ?? []) as string[]), ...((t.allowed_domains ?? []) as string[])]) {
        if (/^[a-z]+:\/\//i.test(d) || !d.includes('.')) issues.push(`web search domain "${d}" must be a bare domain`)
      }
      if (format) issues.push('web search results carry citations, which output_config.format rejects')
    }
    if (t.strict === true) {
      strictTools++
      schemas.push({ at: `tools.${String(t.name)}.input_schema`, schema: t.input_schema })
    }
  }
  if (strictTools > LIMITS.strictTools) issues.push(`${strictTools} strict tools (limit ${LIMITS.strictTools})`)
  let union = 0, optional = 0
  for (const s of schemas) {
    const st = checkSchema(s.schema, s.at)
    issues.push(...st.issues)
    union += st.unionParams
    optional += st.optionalParams
  }
  if (union > LIMITS.unionParams) issues.push(`${union} parameters with union types across strict schemas (limit ${LIMITS.unionParams})`)
  if (optional > LIMITS.optionalParams) issues.push(`${optional} optional parameters across strict schemas (limit ${LIMITS.optionalParams})`)
  return issues
}

/** The request without its prompt text: keys, settings, schemas and tool definitions; text as character counts. */
export function requestShape(req: Anthropic.MessageCreateParamsNonStreaming): Json {
  const body = req as unknown as Json
  const text = (v: unknown) => (typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length)
  const oc = (body.output_config ?? undefined) as Json | undefined
  const format = oc?.format as Json | undefined
  const tools = (Array.isArray(body.tools) ? body.tools : undefined) as Json[] | undefined
  const schemas = [format?.schema, ...(tools ?? []).filter((t) => t.strict === true).map((t) => t.input_schema)].filter(Boolean)
  const stats = schemas.map((s) => checkSchema(s))
  return {
    keys: Object.keys(body).sort(),
    model: body.model,
    max_tokens: body.max_tokens,
    thinking: body.thinking,
    output_config: oc ? { ...oc, ...(format ? { format: { type: format.type, schema: format.schema } } : {}) } : undefined,
    tools: tools?.map((t) => (t.type && t.type !== 'custom'
      ? { ...t, ...(Array.isArray(t.blocked_domains) ? { blocked_domains: `${t.blocked_domains.length} domains` } : {}) }
      : { name: t.name, strict: t.strict, description_chars: text(t.description), input_schema: t.input_schema })),
    tool_choice: body.tool_choice,
    system_chars: text(body.system),
    messages: (body.messages as Json[]).map((m) => ({ role: m.role, content_chars: text(m.content) })),
    schema_complexity: {
      union_params: stats.reduce((a, s) => a + s.unionParams, 0),
      optional_params: stats.reduce((a, s) => a + s.optionalParams, 0),
      strict_tools: (tools ?? []).filter((t) => t.strict === true).length,
      limits: { union_params: LIMITS.unionParams, optional_params: LIMITS.optionalParams, strict_tools: LIMITS.strictTools },
    },
  }
}
