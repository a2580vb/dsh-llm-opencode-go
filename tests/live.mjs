/**
 * Live end-to-end check against OpenCode Go.
 *
 * Not part of `npm test`: it spends real quota and needs a real credential.
 * Run it deliberately:
 *
 *   OC_KEY=oc_sk_... node tests/live.mjs
 *
 * It drives the real adapter through the real transport for every protocol in
 * the catalog, including a full tool-calling round trip and a protocol-fallback
 * request, and prints the request/response facts it observed.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'

import { PROTOCOLS, resolveConfig } from '../lib/config.js'
import { OpenCodeGoAdapter } from '../lib/index.js'
import { ModelCache } from '../lib/model/cache.js'

const API_KEY = process.env.OC_KEY
if (API_KEY === undefined || API_KEY === '') {
  console.error('OC_KEY is not set; refusing to run the live check')
  process.exit(1)
}

const CACHE_PATH = process.env.OC_CACHE ?? join(homedir(), '.dsh', 'cache', 'opencode-go-models.json')

const results = []

function report(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** The deployment facts a live adapter gets, so a test can withhold them. */
const SEAM = { readImageRequest: async () => undefined }
const NO_SEAM = undefined

/**
 * One adapter over the live service.
 *
 * `attachments` defaults to a minimal seam, because the route's declared
 * modalities follow the request path: without one, a vision model correctly
 * reports text-only and the metadata checks below would be measuring the
 * absence of a service rather than the catalogue. Pass `attachments: () =>
 * NO_SEAM` for the deployment that has none.
 */
function buildAdapter(overrides = {}) {
  const { attachments = () => SEAM, ...configOverrides } = overrides
  const config = resolveConfig({
    baseURL: process.env.OC_BASE ?? 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OC_KEY',
    modelsCachePath: CACHE_PATH,
    ...configOverrides,
  })
  const cache = new ModelCache(config, {
    authHeaders: async () => ({ authorization: `Bearer ${API_KEY}` }),
    logger: console,
  })
  const adapter = new OpenCodeGoAdapter({
    options: () => config,
    resolveApiKey: async () => API_KEY,
    cache,
    attachments,
    discover: (provider) => adapter.listModels(provider),
    logger: { info() {}, warn: console.warn, debug() {}, error: console.error },
  })
  return { adapter, config }
}

/** Stream one call, assembling chunks and timing the first token. */
async function run(adapter, options) {
  const started = Date.now()
  let firstTokenAt
  const chunks = []
  for await (const chunk of adapter.stream(options)) {
    if (firstTokenAt === undefined && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')) {
      firstTokenAt = Date.now() - started
    }
    chunks.push(chunk)
  }
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return {
    chunks,
    blocks: assembler.blocks(),
    finish: assembler.finish,
    usage: assembler.usage,
    elapsedMs: Date.now() - started,
    firstTokenMs: firstTokenAt,
    replayState: chunks.find((chunk) => chunk.type === 'finish')?.replayState,
  }
}

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
}

const userTurn = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

// ---------------------------------------------------------------------------
// 1. Discovery
// ---------------------------------------------------------------------------
{
  const { adapter, config } = buildAdapter()
  const models = await adapter.listModels(config.provider)
  report('GET /models discovery', models.length > 20, `${models.length} models, cache at ${CACHE_PATH}`)
  const luna = await adapter.resolveModel(config.provider, 'gpt-5.6-luna', undefined)
  report(
    'gpt-5.6-luna resolves as Responses-only with a context window',
    luna.context?.contextWindow > 0,
    `contextWindow=${luna.context?.contextWindow} efforts=${luna.reasoning?.efforts.map((effort) => effort.id).join('/')}`,
  )

  // The catalogue's figures, not one assumed window shared by every model.
  const unique = new Set(models.map((model) => model.contextWindow))
  const missing = models.filter((model) => !Number.isInteger(model.contextWindow) || !Number.isInteger(model.maxTokens))
  report(
    'every advertised model carries its own measured context window and output cap',
    missing.length === 0 && unique.size > 3,
    `${models.length} models, ${unique.size} distinct windows,`
    + ` e.g. deepseek-v4.1-flash=${models.find((m) => m.id === 'deepseek-v4.1-flash')?.contextWindow}`
    + ` gpt-5.6-luna=${luna.context?.contextWindow}`
    + ` hy3=${models.find((m) => m.id === 'hy3')?.contextWindow}`,
  )
  // The declared modalities follow the request path: this builder mounts a
  // minimal attachment seam, so a vision model declares image input.
  const vision = models.find((model) => model.id === 'deepseek-v4-flash-vision-exp')
  const textOnly = models.find((model) => model.id === 'glm-5.3')
  report(
    'a vision model declares image input while a text-only model does not',
    vision?.inputModalities?.includes('image') === true && textOnly?.inputModalities?.includes('image') === false,
    `vision=${vision?.inputModalities?.join('+')} text=${textOnly?.inputModalities?.join('+')}`,
  )
  // The same catalog without the attachment seam: the declaration follows the
  // request path, so the vision model reports text-only and says why.
  const withoutSeam = buildAdapter({ attachments: () => NO_SEAM })
  const gated = await withoutSeam.adapter.resolveModel(config.provider, 'deepseek-v4-flash-vision-exp', undefined)
  report(
    'without an attachment seam, the same model reports text-only with a note',
    gated.inputModalities.includes('image') === false && String(gated.description ?? '').length > 0,
    `modalities=${gated.inputModalities.join('+')} note=${JSON.stringify(String(gated.description ?? '').slice(0, 80))}`,
  )
}

// ---------------------------------------------------------------------------
// 2. Every protocol, in a real round trip
// ---------------------------------------------------------------------------
const PROTOCOL_CASES = [
  { model: 'glm-5.3', protocol: PROTOCOLS.CHAT, label: 'glm-5.3 (chat-completions)' },
  { model: 'deepseek-v4-flash', protocol: PROTOCOLS.CHAT, label: 'deepseek-v4-flash (chat-completions)' },
  { model: 'gpt-5.6-luna', protocol: PROTOCOLS.RESPONSES, label: 'gpt-5.6-luna (responses)' },
  { model: 'minimax-m2.7', protocol: PROTOCOLS.ANTHROPIC, label: 'minimax-m2.7 (anthropic)' },
  { model: 'qwen3.8-max', protocol: PROTOCOLS.ANTHROPIC, label: 'qwen3.8-max (anthropic)' },
]

for (const testCase of PROTOCOL_CASES) {
  const { adapter, config } = buildAdapter({
    protocolOverrides: { [testCase.model]: testCase.protocol },
    reasoningEfforts: ['low'],
    modelsCachePath: CACHE_PATH,
  })
  try {
    const out = await run(adapter, {
      provider: config.provider,
      model: testCase.model,
      messages: [userTurn('Reply with exactly the two letters OK and nothing else.')],
      reasoningEffort: 'low',
      maxTokens: 2048,
      sessionId: 'live-check-session',
    })
    const text = out.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
    report(
      testCase.label,
      out.finish.kind === 'stop' && /OK/i.test(text),
      `finish=${out.finish.kind} text=${JSON.stringify(text.slice(0, 40))} in=${out.usage?.inputTokens} out=${out.usage?.outputTokens} first=${out.firstTokenMs}ms total=${out.elapsedMs}ms`,
    )
  } catch (error) {
    report(testCase.label, false, `${error.code ?? 'ERROR'}: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// 3. Tool calling round trip: call, result, follow-up
// ---------------------------------------------------------------------------
for (const testCase of [
  { model: 'deepseek-v4-flash', protocol: PROTOCOLS.CHAT },
  { model: 'gpt-5.6-luna', protocol: PROTOCOLS.RESPONSES },
  { model: 'qwen3.8-max', protocol: PROTOCOLS.ANTHROPIC },
]) {
  const label = `tool round trip: ${testCase.model} (${testCase.protocol})`
  const { adapter, config } = buildAdapter({
    protocolOverrides: { [testCase.model]: testCase.protocol },
    modelsCachePath: CACHE_PATH,
  })
  try {
    const first = await run(adapter, {
      provider: config.provider,
      model: testCase.model,
      messages: [userTurn('What is the weather in Paris? Call the get_weather tool.')],
      tools: [WEATHER_TOOL],
      maxTokens: 2048,
      sessionId: 'live-tool-session',
    })
    const call = first.blocks.find((block) => block.type === 'tool-call')
    if (call === undefined) {
      report(label, false, `no tool call; finish=${first.finish.kind} text=${JSON.stringify(first.blocks.map((b) => b.type))}`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(call.arguments)
    } catch (error) {
      report(label, false, `tool arguments are not JSON: ${call.arguments}`)
      continue
    }
    if (parsed?.city === undefined) {
      report(label, false, `tool arguments carry no city: ${call.arguments}`)
      continue
    }

    const second = await run(adapter, {
      provider: config.provider,
      model: testCase.model,
      messages: [
        userTurn('What is the weather in Paris? Call the get_weather tool.'),
        {
          role: 'assistant',
          content: [
            ...(first.blocks.filter((block) => block.type === 'reasoning')),
            { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments },
          ],
          source: {
            kind: 'model',
            provider: config.provider,
            model: testCase.model,
            replayState: first.replayState,
          },
        },
        { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: '18C and sunny in Paris.' }] },
      ],
      tools: [WEATHER_TOOL],
      maxTokens: 2048,
      sessionId: 'live-tool-session',
    })
    const answer = second.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
    report(
      label,
      second.finish.kind === 'stop' && /18|sunny|paris/i.test(answer),
      `call=${call.name}(${call.arguments}) → finish=${second.finish.kind} answer=${JSON.stringify(answer.slice(0, 80))}`,
    )
  } catch (error) {
    report(label, false, `${error.code ?? 'ERROR'}: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// 4. Protocol fallback: a Responses-only model asked to start at chat
// ---------------------------------------------------------------------------
{
  const { adapter, config } = buildAdapter({
    // Deliberately wrong: gpt-5.6-luna refuses chat-completions. The adapter
    // must discover that for itself and reach the model over Responses.
    protocolOverrides: { 'gpt-5.6-luna': PROTOCOLS.CHAT },
    modelsCachePath: CACHE_PATH,
  })
  try {
    const out = await run(adapter, {
      provider: config.provider,
      model: 'gpt-5.6-luna',
      messages: [userTurn('Reply with exactly the two letters OK.')],
      maxTokens: 2048,
      sessionId: 'live-fallback-session',
    })
    const text = out.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
    report('protocol fallback recovers from ModelProtocolUnsupported', /OK/i.test(text), `text=${JSON.stringify(text.slice(0, 40))}`)
  } catch (error) {
    report('protocol fallback recovers from ModelProtocolUnsupported', false, `${error.code ?? 'ERROR'}: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// 5. A per-conversation session header keeps the cache warm
// ---------------------------------------------------------------------------
{
  const { adapter, config } = buildAdapter({ modelsCachePath: CACHE_PATH })
  try {
    const base = [userTurn('Remember the number 4173. Reply with exactly: noted')]
    const first = await run(adapter, {
      provider: config.provider,
      model: 'glm-5.3',
      messages: base,
      maxTokens: 2048,
      sessionId: 'cache-affinity-session',
    })
    const second = await run(adapter, {
      provider: config.provider,
      model: 'glm-5.3',
      messages: [...base, { role: 'assistant', content: first.blocks, source: { kind: 'model', provider: config.provider, model: 'glm-5.3', replayState: first.replayState } }, userTurn('What number? Reply with digits only.')],
      maxTokens: 2048,
      sessionId: 'cache-affinity-session',
    })
    const answer = second.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
    report(
      'a second turn on one session id is served and reports cache reuse',
      second.finish.kind === 'stop',
      `recall=${JSON.stringify(answer.slice(0, 40))} cacheRead=${second.usage?.cacheReadTokens ?? 0} input=${second.usage?.inputTokens}`,
    )
  } catch (error) {
    report('a second turn on one session id is served and reports cache reuse', false, `${error.code ?? 'ERROR'}: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// 6. The second call is served from the cache, without touching /models
// ---------------------------------------------------------------------------
{
  const config = resolveConfig({
    baseURL: process.env.OC_BASE ?? 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OC_KEY',
    modelsCachePath: CACHE_PATH,
  })
  let modelRequests = 0
  const countingFetch = (url, init) => {
    if (String(url).endsWith('/models')) modelRequests += 1
    return globalThis.fetch(url, init)
  }
  const cache = new ModelCache(config, {
    authHeaders: async () => ({ authorization: `Bearer ${API_KEY}` }),
    logger: { info() {}, warn: console.warn },
  })
  const adapter = new OpenCodeGoAdapter({
    options: () => config,
    resolveApiKey: async () => API_KEY,
    cache,
    attachments: () => undefined,
    discover: (provider) => adapter.listModels(provider),
    logger: { info() {}, warn: console.warn, debug() {}, error: console.error },
    fetch: countingFetch,
  })
  try {
    await adapter.listModels(config.provider)
    await adapter.listModels(config.provider)
    report(
      'a warm catalog needs no second /models request',
      modelRequests === 0,
      `${modelRequests} /models requests (the file cache served both)`,
    )
  } catch (error) {
    report('a warm catalog needs no second /models request', false, `${error.code ?? 'ERROR'}: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// 7. A history with an unanswerable tool call is still accepted
// ---------------------------------------------------------------------------
// The harness can record a tool call it never dispatched, which leaves a call in
// the history with no result behind it. The Responses API answers that history
// with `400 No tool output found for tool call <id>`, naming the call that was
// left standing, so this is the shape that has to come out of the converter
// without it.
{
  const { adapter, config } = buildAdapter({
    protocolOverrides: { 'deepseek-v4.1-flash': PROTOCOLS.RESPONSES },
    modelsCachePath: CACHE_PATH,
  })
  try {
    const out = await run(adapter, {
      provider: config.provider,
      model: 'deepseek-v4.1-flash',
      messages: [
        userTurn('Search for today’s headlines and confirm the scope with me.'),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'On it — searching and confirming the scope.' },
            { type: 'tool-call', id: 'call_live_answered', name: 'web_search', arguments: '{"queries":["today headlines"]}' },
            { type: 'tool-call', id: 'call_live_undispatched', name: 'ask_user_question', arguments: '{"questions":[{"id":"scope","question":"Which news?"}]}' },
          ],
          source: { kind: 'model', provider: config.provider, model: 'deepseek-v4.1-flash' },
        },
        { role: 'tool', toolCallId: 'call_live_answered', content: [{ type: 'text', text: 'Search unavailable: no API key.' }] },
        userTurn('Technology and finance, last 24 hours. Answer in one line.'),
      ],
      maxTokens: 2048,
      sessionId: 'live-dangling-session',
    })
    const text = out.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
    report(
      'a history with an undispatched tool call is accepted',
      out.finish.kind === 'stop' && text.trim() !== '',
      `finish=${out.finish.kind} text=${JSON.stringify(text.slice(0, 80))}`,
    )
  } catch (error) {
    report(
      'a history with an undispatched tool call is accepted',
      false,
      `${error.code ?? 'ERROR'}: ${error.message}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 8. Every advertised effort is one the service actually accepts
// ---------------------------------------------------------------------------
{
  const { adapter, config } = buildAdapter({
    protocolOverrides: { 'gpt-5.6-luna': PROTOCOLS.RESPONSES },
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    modelsCachePath: CACHE_PATH,
  })
  const info = await adapter.resolveModel(config.provider, 'gpt-5.6-luna', undefined)
  const offered = info.reasoning?.efforts.map((effort) => String(effort.id)) ?? []
  const rejected = []
  for (const effort of offered) {
    try {
      await run(adapter, {
        provider: config.provider,
        model: 'gpt-5.6-luna',
        messages: [userTurn('Reply with exactly the two letters OK.')],
        reasoningEffort: effort,
        maxTokens: 2048,
        sessionId: 'live-effort-session',
      })
    } catch (error) {
      rejected.push(`${effort}=${error.code}`)
    }
  }
  report(
    'every advertised reasoning effort is accepted by the service',
    rejected.length === 0,
    `offered=[${offered.join(',')}] rejected=[${rejected.join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// 9. The model cache file was written, when the path is writable
// ---------------------------------------------------------------------------
{
  try {
    const raw = JSON.parse(await readFile(CACHE_PATH, 'utf8'))
    report('the discovered catalog was cached on disk', Array.isArray(raw.ids) && raw.ids.length > 20, `${raw.ids.length} ids, version ${raw.version}`)
  } catch (error) {
    report('the discovered catalog was cached on disk', false, error.message)
  }
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} live checks passed`)
if (failed.length > 0) process.exitCode = 1
