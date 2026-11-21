// npm run generation:probe -- <stage> <node-slug> [--shape-only]
//
// Builds the exact request one generation stage would send for a node (model, effort, thinking, max_tokens,
// output schema or tools) and sends it ONCE to the live API, then prints the response or the full error.
// Before sending it prints the request's shape (keys, settings, schemas and tool definitions; the prompt
// text only as character counts) and the local checks against the Claude API docs (requestRules.ts).
// Refuses unless GENERATION_MODE=live. Stores nothing: no run, no call row, no products, and the cost is not
// counted against the generation caps, so it prints it instead.
//
// Stages: place | levers | discover | extract | explain. extract uses the node's current levers and a short
// stand-in document (the real one is a fetched manufacturer page); everything else about it is the stage's
// own request. --shape-only prints the shape and checks without sending (works in dry-run mode too).
import 'dotenv/config' // backend/.env, like the app
import './quietPrisma' // before anything imports lib/prisma
import Anthropic from '@anthropic-ai/sdk'
import { NodeKind } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { GenerationConfig, loadGenerationConfig } from '../generation/config'
import { costUsd } from '../generation/costs'
import { describeModelError, modelErrorText } from '../generation/apiError'
import { buildStageRequest, MAX_PAUSE_RESUMES, ModelStage, parseJsonText, REQUEST_TIMEOUT_MS, StageRequestInput } from '../generation/model'
import { requestIssues, requestShape } from '../generation/requestRules'
import { DiscoverySchema, ExplainerSchema, ExtractionSchema, LeverSetSchema, PlacementSchema, describeIssues } from '../generation/schemas'
import { discoverInputFor, explainInputFor, extractionLeversFor, leversInputFor, placeInputFor, StageNode } from '../generation/runs'

const STAGES: ModelStage[] = ['place', 'levers', 'discover', 'extract', 'explain']
const VALIDATORS = { place: PlacementSchema, levers: LeverSetSchema, discover: DiscoverySchema, extract: ExtractionSchema, explain: ExplainerSchema }
const USAGE = 'Usage: npm run generation:probe -- <place|levers|discover|extract|explain> <node-slug> [--shape-only]'

type Print = (line: string) => void

export async function buildProbeRequest(stage: ModelStage, node: StageNode & { kind: NodeKind }): Promise<StageRequestInput> {
  const decision = stage !== 'explain'
  if (decision && node.kind !== NodeKind.DECISION) throw new Error(`${node.slug} is a navigation node: only explain runs there`)
  if (!decision && node.kind !== NodeKind.NAVIGATION) throw new Error(`${node.slug} is a decision node: explain runs on navigation nodes`)
  switch (stage) {
    case 'place': return { stage, input: await placeInputFor(node) }
    case 'levers': return { stage, input: await leversInputFor(node, null) }
    case 'discover': return { stage, input: await discoverInputFor(node, null) }
    case 'explain': return { stage, input: await explainInputFor(node) }
    case 'extract': {
      const { leversIn } = await extractionLeversFor(node.id)
      if (leversIn.length === 0) throw new Error(`${node.slug} has no levers yet: run LEVERS first`)
      const place = await placeInputFor(node)
      return {
        stage,
        input: {
          nodeSlug: node.slug, nodeName: node.name, path: place.path,
          product: { brand: 'Probe', name: 'Probe Model 1', url: 'https://probe.example/model-1' },
          levers: leversIn,
          documents: [{ key: 'page', kind: 'page', url: 'https://probe.example/model-1', text: 'Probe Model 1. Weight: 9.5 lb. Specifications are listed for testing only.' }],
        },
      }
    }
  }
}

/** Send once; for discovery, follow pause_turn like the stage does. Returns the exit code. */
export async function sendProbe(stage: ModelStage, request: Anthropic.MessageCreateParamsNonStreaming, config: GenerationConfig, print: Print,
  client = new Anthropic({ apiKey: config.apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 })): Promise<number> {
  const messages: Anthropic.MessageParam[] = [...request.messages]
  let total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 }
  for (let resume = 0; ; resume++) {
    let response: Anthropic.Message
    const started = Date.now()
    try {
      response = await client.messages.create({ ...request, messages })
    } catch (err) {
      const d = describeModelError(err)
      print(`\nFAILED after ${((Date.now() - started) / 1000).toFixed(1)} s (request ${resume + 1}): ${modelErrorText(d)}`)
      // The whole error body as the API sent it (it never contains the request).
      if (err instanceof Anthropic.APIError && err.error) print(`Error body: ${JSON.stringify(err.error, null, 2)}`)
      return 1
    }
    const u = response.usage
    total = {
      inputTokens: total.inputTokens + u.input_tokens, outputTokens: total.outputTokens + u.output_tokens,
      cacheReadTokens: total.cacheReadTokens + (u.cache_read_input_tokens ?? 0), webSearches: total.webSearches + (u.server_tool_use?.web_search_requests ?? 0),
    }
    print(`\nResponse ${resume + 1} after ${((Date.now() - started) / 1000).toFixed(1)} s: stop_reason=${response.stop_reason} model=${response.model}`)
    print(`  content blocks: ${response.content.map((b) => b.type).join(', ') || '(none)'}`)
    print(`  usage: ${JSON.stringify(u)}`)
    const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'propose_products')
    if (stage === 'discover' && !call && response.stop_reason === 'pause_turn' && resume < MAX_PAUSE_RESUMES) {
      messages.push({ role: 'assistant', content: response.content })
      continue
    }
    const output = stage === 'discover' ? call?.input ?? null : parseJsonText(response.content)
    const cost = costUsd(response.model, total) ?? costUsd(config.model, total)
    print(`\nCost of this probe: ${cost === null ? 'unknown (no price for the model)' : `$${cost.toFixed(4)}`} (not counted against the generation caps)`)
    if (output === null) {
      print('Output: none (no JSON text / no propose_products call)')
      return 1
    }
    print(`Output:\n${JSON.stringify(output, null, 2)}`)
    const valid = VALIDATORS[stage].safeParse(output)
    print(valid.success ? '\nThe stage\'s own validation (zod) accepts this output.' : `\nThe stage's own validation rejects it: ${describeIssues(valid.error)}`)
    return response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens' ? 1 : 0
  }
}

export async function runProbe(args: string[], env: NodeJS.ProcessEnv, print: Print): Promise<number> {
  const shapeOnly = args.includes('--shape-only')
  const [rawStage, slug] = args.filter((a) => !a.startsWith('--'))
  const stage = rawStage?.toLowerCase() as ModelStage | undefined
  if (!stage || !STAGES.includes(stage) || !slug) { print(USAGE); return 2 }

  let config: GenerationConfig
  try { config = loadGenerationConfig(env) } catch (err) { print(err instanceof Error ? err.message : String(err)); return 2 }
  if (config.mode !== 'live' && !shapeOnly) {
    print('Refusing: GENERATION_MODE is dry_run, so there is no live request to probe. Set GENERATION_MODE=live and ANTHROPIC_API_KEY in backend/.env (or use --shape-only).')
    return 2
  }

  const node = await prisma.taxonomyNode.findUnique({ where: { slug }, select: { id: true, slug: true, name: true, searchTerms: true, kind: true } })
  if (!node) { print(`No node with slug "${slug}"`); return 2 }
  let request: Anthropic.MessageCreateParamsNonStreaming
  try {
    request = buildStageRequest(await buildProbeRequest(stage, node), config)
  } catch (err) { print(err instanceof Error ? err.message : String(err)); return 2 }

  print(`Probe: ${stage.toUpperCase()} for ${node.name} (${node.slug}), mode ${config.mode}`)
  print(`Request shape (prompt text omitted):\n${JSON.stringify(requestShape(request), null, 2)}`)
  const issues = requestIssues(request)
  print(issues.length ? `\nLocal checks against the docs: ${issues.length} problem(s)\n- ${issues.join('\n- ')}` : '\nLocal checks against the docs: none found (the API can still reject a schema as too complex; only sending shows that).')
  if (shapeOnly) return issues.length ? 1 : 0

  print(`\nSending once to the live API (${config.model}, no retries)…`)
  return sendProbe(stage, request, config, print)
}

if (require.main === module) {
  runProbe(process.argv.slice(2), process.env, (l) => console.log(l))
    .then((code) => { process.exitCode = code })
    .catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1 })
    .finally(() => void prisma.$disconnect())
}
