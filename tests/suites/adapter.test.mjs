/**
 * The adapter end to end, against a fake transport.
 *
 * These cases drive the real `OpenCodeGoAdapter`: real configuration, real
 * catalog, real request building, real header assembly, and the real protocol
 * fallback. Only `fetch` is replaced, so what is asserted here is the HTTP
 * request the plugin would actually send and the chunks it would actually
 * produce.
 */

import { BlockAssembler } from '@deepseek-ai/dsh-llm'

import { PROTOCOLS, resolveConfig } from '../../lib/config.js'
import { OpenCodeGoAdapter, signaturesFromHistory } from '../../lib/index.js'
import { ModelCache } from '../../lib/model/cache.js'
import { equal, is, ok } from '../helpers.mjs'

/** A `fetch` that replays scripted responses and records every request. */
function fakeFetch(script) {
  const requests = []
  const implementation = async (url, init) => {
    requests.push({ url: String(url), init })
    const next = script.shift()
    if (next === undefined) throw new Error(`unexpected request to ${url}`)
    const status = next.status ?? 200
    const headers = new Headers(next.headers ?? { 'content-type': 'text/event-stream' })
    return new Response(next.body === undefined ? '' : next.body, { status, headers })
  }
  implementation.requests = requests
  return implementation
}

/** A response body of SSE frames built from JSON payloads. */
function sse(frames) {
  return frames
    .map((frame) => (frame.event === undefined ? `data: ${JSON.stringify(frame.data)}` : `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}`))
    .join('\n\n') + '\n\n'
}

/**
 * A `fetch` that answers `GET /models` from one script and everything else from
 * another.
 *
 * Discovery and generation share one seam — the plugin reads both through the
 * same implementation — so a case has to say which answer belongs to which
 * request. The completion script keeps the plain `requests` array, because
 * those are the requests most cases assert on.
 */
function routedFetch(modelsScript, chatScript) {
  const discovery = fakeFetch(modelsScript)
  const chat = fakeFetch(chatScript)
  const implementation = async (url, init) => {
    const target = String(url).endsWith('/models') ? discovery : chat
    return target(url, init)
  }
  implementation.requests = chat.requests
  implementation.modelsRequests = discovery.requests
  return implementation
}

/** A `GET /models` reply, in the shape the relay documents. */
function modelsReply(ids) {
  return JSON.stringify({
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'opencode' })),
  })
}

/** Not-an-error response the relay sends for an unsupported protocol. */
function protocolUnsupported(model) {
  return {
    status: 400,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'error', error: { type: 'ModelProtocolUnsupported', message: 'Model does not support this protocol.' } , model }),
  }
}

/**
 * The relay's training-consent refusal, as the current service answers it.
 *
 * The gate is an account-level policy check, so it is answered as a data-policy
 * failure rather than as a request the model could not read. The URL in the
 * message is the one the service itself points at.
 */
function trainingConsentRefusal() {
  return {
    status: 403,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'error',
      error: {
        type: 'DataPolicyError',
        message: 'This model collects data used to improve its quality and requires explicit opt in:'
          + ' https://opencode.ai/workspace/ws_test/go',
      },
    }),
  }
}

/**
 * The same refusal as deployments that surface it from the upstream service
 * answer: `400`, an `Account.TrainingNotAllowed` code, and the sentence form.
 */
function trainingConsentRefusalAsUpstreamError() {
  return {
    status: 400,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: {
        code: 'Account.TrainingNotAllowed',
        message: 'Upstream request failed: This Go model trains on request data. Allow paid endpoints'
          + " that train on request data in your workspace's Privacy settings to use it.",
      },
    }),
  }
}

/** A logger that keeps its lines, so a case can assert what a deployment sees. */
function recordingLogger() {
  const lines = []
  return {
    lines,
    info: (...args) => lines.push(args.map((arg) => String(arg)).join(' ')),
    warn: (...args) => lines.push(args.map((arg) => String(arg)).join(' ')),
    debug() {},
    error: (...args) => lines.push(args.map((arg) => String(arg)).join(' ')),
  }
}

/**
 * A per-adapter cache path, so one case's discovery never reaches another.
 *
 * The run's process id is part of the name: a leftover file from an earlier
 * run would otherwise be a warm cache, and a case that measures what discovery
 * fetched would silently measure nothing.
 */
let cacheCounter = 0
const cacheFile = () => {
  cacheCounter += 1
  return `L:\\e2\\dsh-plugin\\opencodego-transfrom\\.test-cache\\${process.pid}-${cacheCounter}.json`
}

/**
 * Build an adapter over scripted responses.
 *
 * `script` answers everything the adapter generates; discovery gets its own
 * script, which by default lists nothing, so the catalog a case starts from is
 * exactly the measured fallback. A case that wants models to come from
 * discovery passes `discovery: [{ body: modelsReply([...]) }, ...]`.
 */
function adapterWith(script, overrides = {}) {
  const config = resolveConfig({
    baseURL: 'https://relay.test/v1',
    apiKeyEnv: 'TEST_KEY',
    modelsCachePath: overrides.cachePath ?? cacheFile(),
    ...overrides.config,
  })
  process.env.TEST_KEY = 'sk-test-value'
  const fetch = routedFetch(overrides.discovery ?? [{ body: modelsReply([]) }], script)
  const logger = overrides.logger ?? silentLogger()
  const cache = new ModelCache(config, {
    authHeaders: async () => ({ authorization: 'Bearer sk-test-value' }),
    logger,
    // Discovery reads through the same scripted implementation as generation,
    // so a case can answer `GET /models` and a completion from one script.
    fetch,
  })
  const adapter = new OpenCodeGoAdapter({
    options: () => config,
    resolveApiKey: async () => 'sk-test-value',
    cache,
    attachments: () => overrides.attachments,
    discover: (provider) => adapter.listModels(provider),
    logger,
    fetch,
  })
  return { adapter, config, fetch }
}

function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} }
}

/** Collect one stream and assemble it. */
async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return { chunks, blocks: assembler.blocks(), finish: assembler.finish, usage: assembler.usage }
}

/** One user text message, as the harness sends it. */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

const CHAT_BODY = sse([
  { data: { id: 'r1', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] } },
  { data: { id: 'r1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
  { data: { id: 'r1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } },
  { data: '[DONE]' },
])

export default {
  name: 'adapter',
  cases: [
    {
      name: 'the request carries the session header, the client header, and both identities',
      async run() {
        const { adapter, fetch } = adapterWith([{ body: CHAT_BODY }])
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
          sessionId: 'session-abc',
        })
        const headers = new Headers(fetch.requests[0].init.headers)
        // The whole point of the plugin: one stable id per conversation.
        is(headers.get('x-opencode-session'), 'session-abc')
        is(headers.get('x-opencode-client'), 'dsh-opencode-go')
        const agent = headers.get('user-agent')
        ok(agent.startsWith('dsh-opencode-go/'), `the plugin leads the User-Agent: ${agent}`)
        is(fetch.requests[0].url, 'https://relay.test/v1/chat/completions')
      },
    },
    {
      name: 'two turns of one conversation share one session id; another conversation differs',
      async run() {
        const { adapter, fetch } = adapterWith([{ body: CHAT_BODY }, { body: CHAT_BODY }, { body: CHAT_BODY }])
        for (const sessionId of ['conv-1', 'conv-1', 'conv-2']) {
          await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')], sessionId })
        }
        const seen = fetch.requests.map((request) => new Headers(request.init.headers).get('x-opencode-session'))
        equal(seen, ['conv-1', 'conv-1', 'conv-2'])
      },
    },
    {
      name: 'sessionHeader=off sends no session header at all',
      async run() {
        const { adapter, fetch } = adapterWith([{ body: CHAT_BODY }], { config: { sessionHeader: 'off' } })
        await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')], sessionId: 's' })
        is(new Headers(fetch.requests[0].init.headers).get('x-opencode-session'), null)
      },
    },
    {
      name: 'sessionHeader=uuid is stable per conversation and opaque',
      async run() {
        const { adapter, fetch } = adapterWith([{ body: CHAT_BODY }, { body: CHAT_BODY }], { config: { sessionHeader: 'uuid' } })
        await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')], sessionId: 'conv-1' })
        await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')], sessionId: 'conv-1' })
        const first = new Headers(fetch.requests[0].init.headers).get('x-opencode-session')
        const second = new Headers(fetch.requests[1].init.headers).get('x-opencode-session')
        is(first, second)
        ok(first !== 'conv-1', 'the harness session id is not sent')
      },
    },
    {
      name: 'an auxiliary call with no session id still carries a stable header',
      async run() {
        const { adapter, fetch } = adapterWith([{ body: CHAT_BODY }, { body: CHAT_BODY }])
        await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] })
        await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] })
        const first = new Headers(fetch.requests[0].init.headers).get('x-opencode-session')
        const second = new Headers(fetch.requests[1].init.headers).get('x-opencode-session')
        ok(first !== null && first !== '', 'a header was sent')
        is(first, second)
      },
    },
    {
      name: 'the auth header matches the protocol the model uses',
      async run() {
        const { adapter, fetch } = adapterWith([
          { body: CHAT_BODY },
          {
            body: sse([
              { event: 'message_start', data: { type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } } },
              { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
              { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
              { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
              { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
              { event: 'message_stop', data: { type: 'message_stop' } },
            ]),
          },
        ])
        await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] })
        const chatHeaders = new Headers(fetch.requests[0].init.headers)
        is(chatHeaders.get('authorization'), 'Bearer sk-test-value')
        is(chatHeaders.get('x-api-key'), null)

        await collect(adapter, { provider: 'opencode-go', model: 'minimax-m2.7', messages: [userMessage('hi')] })
        const messagesHeaders = new Headers(fetch.requests[1].init.headers)
        is(messagesHeaders.get('x-api-key'), 'sk-test-value')
        is(messagesHeaders.get('authorization'), null)
        is(messagesHeaders.get('anthropic-version'), '2023-06-01')
        is(fetch.requests[1].url, 'https://relay.test/v1/messages')
      },
    },
    {
      name: 'a protocol refusal falls through to the next protocol the model serves',
      async run() {
        const { adapter, fetch } = adapterWith([protocolUnsupported('deepseek-v4-flash'), { body: CHAT_BODY }])
        const { blocks, finish } = await collect(adapter, {
          provider: 'opencode-go',
          model: 'deepseek-v4-flash',
          messages: [userMessage('hi')],
        })
        is(fetch.requests.length, 2)
        is(fetch.requests[0].url, 'https://relay.test/v1/responses')
        is(fetch.requests[1].url, 'https://relay.test/v1/chat/completions')
        equal(blocks, [{ type: 'text', text: 'hi' }])
        equal(finish, { kind: 'stop' })
      },
    },
    {
      name: 'a failure that is not a protocol refusal is terminal',
      async run() {
        const { adapter, fetch } = adapterWith([
          { status: 401, headers: { 'content-type': 'application/json' }, body: '{"error":{"message":"bad key"}}' },
        ])
        let error
        try {
          await collect(adapter, { provider: 'opencode-go', model: 'deepseek-v4-flash', messages: [userMessage('hi')] })
        } catch (thrown) {
          error = thrown
        }
        is(error?.code, 'AUTH')
        is(fetch.requests.length, 1, 'no other protocol was tried')
      },
    },
    {
      name: 'a rate limit is classified as retryable and keeps its retry-after',
      async run() {
        const { adapter } = adapterWith([
          {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '3' },
            body: '{"error":{"message":"slow down"}}',
          },
        ])
        let error
        try {
          await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] })
        } catch (thrown) {
          error = thrown
        }
        is(error?.code, 'RATE_LIMIT')
        is(error?.failure?.providerRetryAfterMs, 3000)
      },
    },
    {
      name: 'a context-window refusal is classified from the provider detail',
      async run() {
        const { adapter } = adapterWith([
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
            body: '{"error":{"message":"This model\'s maximum context length is 128000 tokens"}}',
          },
        ])
        let error
        try {
          await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] })
        } catch (thrown) {
          error = thrown
        }
        is(error?.code, 'CONTEXT_WINDOW_EXCEEDED')
      },
    },
    {
      name: 'a training-consent refusal is named as such, explained, and never retried elsewhere',
      async run() {
        // deepseek-v4-flash serves all three protocols, so mistaking this refusal
        // for a protocol one would spend three requests on one account policy.
        const { adapter, fetch } = adapterWith([trainingConsentRefusal()])
        let error
        try {
          await collect(adapter, {
            provider: 'opencode-go',
            model: 'deepseek-v4-flash',
            messages: [userMessage('hi')],
          })
        } catch (thrown) {
          error = thrown
        }
        is(error?.code, 'TRAINING_CONSENT_REQUIRED')
        is(error?.failure?.status, 403)
        is(fetch.requests.length, 1, 'no other protocol was tried')
        const message = String(error?.message)
        ok(message.includes('Allow models that train on request data'), 'the missing setting is named')
        ok(message.includes('https://opencode.ai/workspace'), 'the console is named')
        ok(message.includes('cannot grant that consent'), 'it says the plugin cannot grant it')
      },
    },
    {
      name: 'the 400 spelling with an Account.TrainingNotAllowed code is the same failure',
      async run() {
        const { adapter } = adapterWith([trainingConsentRefusalAsUpstreamError()])
        let error
        try {
          await collect(adapter, {
            provider: 'opencode-go',
            model: 'muse-spark-1.3-contributor',
            messages: [userMessage('hi')],
          })
        } catch (thrown) {
          error = thrown
        }
        is(error?.code, 'TRAINING_CONSENT_REQUIRED')
        is(error?.failure?.status, 400)
        // The provider's own words survive, so the remedy is added to them rather
        // than replacing what the service said.
        ok(String(error?.message).includes('trains on request data'), 'the provider detail is kept')
      },
    },
    {
      name: 'a gated model states the setting it needs, in the listing and in its metadata',
      async run() {
        const { adapter } = adapterWith([])
        const models = await adapter.listModels('opencode-go')
        const gated = models.find((model) => model.id === 'muse-spark-1.3-contributor')
        ok(gated !== undefined, 'the gated model is listed, because enabling the setting makes it usable')
        ok(
          String(gated.description).includes('Allow models that train on request data'),
          `the listing names the setting: ${gated.description}`,
        )
        const info = await adapter.resolveModel('opencode-go', 'muse-spark-1.3-contributor', undefined)
        ok(
          String(info.description).includes('trains on request data'),
          `the resolved metadata names the constraint: ${info.description}`,
        )
        // An ordinary model carries no such note, so the note still means something.
        const plain = models.find((model) => model.id === 'glm-5.3')
        is(plain.description, undefined)
      },
    },
    {
      name: 'hideTrainingModels drops the gated models from the listing but not from the route',
      async run() {
        const { adapter } = adapterWith([], { config: { hideTrainingModels: true } })
        const models = await adapter.listModels('opencode-go')
        ok(
          !models.some((model) => model.id === 'muse-spark-1.3-contributor'),
          'the gated model is not offered',
        )
        ok(models.some((model) => model.id === 'glm-5.3'), 'the rest of the catalog is offered')
        // Hiding is a listing decision: a session already on the model, or a
        // deployment that enabled the setting after this listing, still resolves.
        const info = await adapter.resolveModel('opencode-go', 'muse-spark-1.3-contributor', undefined)
        is(info.id, 'muse-spark-1.3-contributor')
      },
    },
    {
      name: 'refreshing the catalog reports what the service added and dropped',
      async run() {
        const { adapter, fetch } = adapterWith([], {
          discovery: [
            { body: modelsReply(['alpha-model', 'doomed-model']) },
            { body: modelsReply(['alpha-model', 'beta-model']) },
          ],
        })
        const before = await adapter.listModels('opencode-go')
        ok(before.some((model) => model.id === 'doomed-model'), 'the first answer is the catalog')

        const result = await adapter.refreshCatalog()
        is(fetch.modelsRequests.length, 2, 'the forced read is a real request, not a cache hit')
        is(fetch.modelsRequests[1].url, 'https://relay.test/v1/models')
        is(result.ok, true)
        equal(result.added, ['beta-model'])
        equal(result.removed, ['doomed-model'])
        is(result.discovered, 2)
        ok(result.fetchedAt > 0, 'the answer is dated')
        // The refresh answers with the new catalog, so the page renders one
        // round trip and never shows a list that disagrees with its own diff.
        ok(result.catalog.models.some((model) => model.id === 'beta-model'))
        ok(!result.catalog.models.some((model) => model.id === 'doomed-model'))
      },
    },
    {
      name: 'a model the service drops but the built-in catalog knows stays offered',
      async run() {
        const { adapter } = adapterWith([], {
          discovery: [
            { body: modelsReply(['glm-5.3', 'alpha-model']) },
            { body: modelsReply(['alpha-model']) },
          ],
        })
        await adapter.listModels('opencode-go')
        const result = await adapter.refreshCatalog()
        is(result.ok, true)
        // The diff is measured over the catalog, not over the raw answer: the
        // listing did not change for this model, so neither does the report.
        equal(result.removed, [])
        ok(result.catalog.models.some((model) => model.id === 'glm-5.3'), 'still offered')
      },
    },
    {
      name: 'a refresh that fails keeps the catalog it had',
      async run() {
        const { adapter } = adapterWith([], {
          discovery: [
            { body: modelsReply(['alpha-model']) },
            { status: 502, body: 'upstream is unwell' },
          ],
        })
        const before = await adapter.listModels('opencode-go')
        const result = await adapter.refreshCatalog()
        is(result.ok, false)
        is(result.reason, 'discovery-failed')
        ok(String(result.message).includes('502'), result.message)
        // A page asking for fresher facts must not be how a working deployment
        // loses its models.
        const after = await adapter.listModels('opencode-go')
        equal(after.map((model) => model.id), before.map((model) => model.id))
        ok(result.catalog.models.some((model) => model.id === 'alpha-model'))
      },
    },
    {
      name: 'a catalog built from configuration has nothing to fetch',
      async run() {
        const { adapter, fetch } = adapterWith([], {
          config: { modelSource: 'config', models: [{ id: 'only-model' }] },
        })
        const result = await adapter.refreshCatalog()
        is(result.ok, false)
        is(result.reason, 'not-discovering')
        is(fetch.modelsRequests.length, 0, 'nothing was requested')
        equal(result.catalog.models.map((model) => model.id), ['only-model'])
      },
    },
    {
      name: 'the discovery cache serves memory until a read is forced',
      async run() {
        const { adapter, fetch } = adapterWith([], {
          discovery: [
            { body: modelsReply(['alpha-model']) },
            { body: modelsReply(['alpha-model', 'beta-model']) },
          ],
        })
        await adapter.listModels('opencode-go')
        is(fetch.modelsRequests.length, 1, 'a cold catalog is discovered once')
        await adapter.catalogSnapshot()
        await adapter.listModels('opencode-go')
        is(fetch.modelsRequests.length, 1, 'every later read is answered from memory')
        // Forced reads are the point of the page's own control: a person
        // watching it must see the service's current answer.
        const result = await adapter.refreshCatalog()
        is(result.ok, true)
        is(fetch.modelsRequests.length, 2, 'a refresh reaches the service')
        equal(result.added, ['beta-model'])
        await adapter.listModels('opencode-go')
        is(fetch.modelsRequests.length, 2, 'and the answer replaces what memory held')
      },
    },
    {
      name: 'a variant is offered as its own model and called as its base',
      async run() {
        const { adapter, fetch } = adapterWith([{ body: CHAT_BODY }], {
          config: { modelVariants: [{ model: 'glm-5.3', name: 'fast' }] },
        })
        const models = await adapter.listModels('opencode-go')
        ok(models.some((model) => model.id === 'glm-5.3@fast'), 'the variant is offered')
        const info = await adapter.resolveModel('opencode-go', 'glm-5.3@fast', undefined)
        is(info.id, 'glm-5.3@fast', 'the harness sees the alias')
        is(info.name, 'GLM 5.3 (fast)')
        ok(String(info.description).includes('variant of glm-5.3'), `the listing says what it is: ${info.description}`)
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3@fast',
          messages: [userMessage('hi')],
          sessionId: 'variant-session',
        })
        // The alias is local: the service only knows the model it serves.
        const body = JSON.parse(fetch.requests[0].init.body)
        is(body.model, 'glm-5.3')
      },
    },
    {
      name: 'a variant leads with the protocol it names and falls back to the rest',
      async run() {
        const { adapter, fetch } = adapterWith(
          [protocolUnsupported('glm-5.3'), { body: CHAT_BODY }],
          { config: { modelVariants: [{ model: 'glm-5.3', name: 'messages', protocol: 'anthropic' }] } },
        )
        // The variant prefers the protocol it names; the base still serves the
        // same model over another, so the call recovers instead of failing.
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3@messages',
          messages: [userMessage('hi')],
          sessionId: 'variant-protocol',
        })
        is(fetch.requests.length, 2)
        ok(fetch.requests[0].url.endsWith('/messages'), fetch.requests[0].url)
        ok(fetch.requests[1].url.endsWith('/chat/completions'), fetch.requests[1].url)
        is(JSON.parse(fetch.requests[1].init.body).model, 'glm-5.3')
      },
    },
    {
      name: 'a variant carries its own thinking level and output cap',
      async run() {
        const { adapter, fetch } = adapterWith([{ body: CHAT_BODY }], {
          config: { modelVariants: [{ model: 'glm-5.3', name: 'fast', effort: 'low', maxTokens: 4_096 }] },
        })
        const info = await adapter.resolveModel('opencode-go', 'glm-5.3@fast', undefined)
        is(info.defaultMaxTokens, 4_096)
        // The preset is the level a call opens with; the harness reads it from
        // here, and the base model has none of its own to offer.
        is(info.reasoning?.defaultEffort, 'low')
        is((await adapter.resolveModel('opencode-go', 'glm-5.3', undefined)).reasoning?.defaultEffort, undefined)
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3@fast',
          messages: [userMessage('hi')],
          sessionId: 'variant-effort',
          maxTokens: 2_048,
        })
        // A preset is a default, not a cage: a call that names its own cap wins.
        is(JSON.parse(fetch.requests[0].init.body).max_tokens, 2_048)
      },
    },
    {
      name: 'a variant the catalog cannot build is reported and not offered',
      async run() {
        const logger = recordingLogger()
        const { adapter } = adapterWith([], {
          logger,
          config: { modelVariants: [{ model: 'no-such-model', name: 'fast' }] },
        })
        const models = await adapter.listModels('opencode-go')
        ok(!models.some((model) => model.id === 'no-such-model@fast'), 'the variant is not offered')
        const line = logger.lines.find((text) => text.includes('modelVariants name models'))
        ok(line !== undefined, `the warning names the miss: ${logger.lines.join(' | ')}`)
        ok(line.includes('no-such-model'), 'the model is named')
      },
    },
    {
      name: 'a buildable variant is named once at catalog assembly',
      async run() {
        const logger = recordingLogger()
        const { adapter } = adapterWith([], {
          logger,
          config: { modelVariants: [{ model: 'glm-5.3', name: 'fast' }] },
        })
        await adapter.listModels('opencode-go')
        const line = logger.lines.find((text) => text.includes('modelVariants adds'))
        ok(line !== undefined, `the line names the variant: ${logger.lines.join(' | ')}`)
        ok(line.includes('glm-5.3@fast'), 'by its catalog id')
      },
    },
    {
      name: 'catalogSnapshot reports the variants and the ids they could not use',
      async run() {
        const { adapter } = adapterWith([], {
          config: { modelVariants: [{ model: 'glm-5.3', name: 'fast' }, { model: 'ghost', name: 'x' }] },
        })
        const snapshot = await adapter.catalogSnapshot()
        equal(snapshot.variants, [{ model: 'glm-5.3', name: 'fast' }, { model: 'ghost', name: 'x' }])
        equal(snapshot.variantsWithoutModel, ['ghost'])
        is(snapshot.counts.variants, 1)
        equal(
          snapshot.models.find((model) => model.id === 'glm-5.3@fast').variant,
          { of: 'glm-5.3', name: 'fast', label: 'GLM 5.3 (fast)', offered: true },
        )
        is(snapshot.models.find((model) => model.id === 'glm-5.3').variant, null)
      },
    },
    {
      name: 'hiddenModels drops the named models from the listing but not from the route',      async run() {
        const { adapter } = adapterWith([], { config: { hiddenModels: ['glm-5.3', 'kimi-k3'] } })
        const models = await adapter.listModels('opencode-go')
        ok(!models.some((model) => model.id === 'glm-5.3'), 'the named model is not offered')
        ok(!models.some((model) => model.id === 'kimi-k3'), 'the second named model is not offered')
        ok(models.some((model) => model.id === 'gpt-5.6-luna'), 'the rest of the catalog is offered')
        // Hiding is a listing decision: a session already pinned to the model
        // still resolves and still calls it.
        const info = await adapter.resolveModel('opencode-go', 'glm-5.3', undefined)
        is(info.id, 'glm-5.3')
        // And it comes back the moment the configuration stops naming it.
        const reopened = adapterWith([], { config: { hiddenModels: [] } })
        const listed = await reopened.adapter.listModels('opencode-go')
        ok(listed.some((model) => model.id === 'glm-5.3'), 'an empty list hides nothing')
      },
    },
    {
      name: 'catalogSnapshot reports every model with the reason it is hidden',
      async run() {
        const { adapter } = adapterWith([], {
          config: { hiddenModels: ['glm-5.3'], hideTrainingModels: true },
        })
        const snapshot = await adapter.catalogSnapshot()
        is(snapshot.source, 'discover')
        const total = snapshot.models.length
        is(snapshot.counts.total, total)
        const glm = snapshot.models.find((model) => model.id === 'glm-5.3')
        is(glm.hidden, true)
        is(glm.hiddenReason, 'configured')
        const gated = snapshot.models.find((model) => model.id === 'muse-spark-1.3-contributor')
        is(gated.hidden, true)
        is(gated.hiddenReason, 'training')
        is(gated.trainingGated, true)
        const plain = snapshot.models.find((model) => model.id === 'gpt-5.6-luna')
        is(plain.hidden, false)
        is(plain.hiddenReason, null)
        equal(snapshot.hidden, ['glm-5.3'])
        is(snapshot.counts.hidden, 1)
        is(snapshot.counts.hiddenByTraining, snapshot.models.filter((model) => model.trainingGated).length)
        is(snapshot.counts.listed, total - snapshot.counts.hidden - snapshot.counts.hiddenByTraining)
        // The listing the harness reads and the snapshot the page renders agree,
        // which is what keeps the page from claiming a model is offered when the
        // runtime drops it.
        const listed = await adapter.listModels('opencode-go')
        equal(
          listed.map((model) => model.id).sort(),
          snapshot.models.filter((model) => !model.hidden).map((model) => model.id).sort(),
        )
      },
    },
    {
      name: 'catalogSnapshot carries the facts a picker row shows',
      async run() {
        const { adapter } = adapterWith([])
        const snapshot = await adapter.catalogSnapshot()
        const luna = snapshot.models.find((model) => model.id === 'gpt-5.6-luna')
        equal(luna.protocols, ['responses'])
        is(luna.contextWindow, 1_050_000)
        ok(luna.maxTokens > 0)
        is(luna.reasoning, true)
        equal(luna.inputModalities, ['text'])
        // Sorted by id, so the page's list does not reshuffle between reads, and
        // the count of hidden models matches the list it also returns.
        equal(snapshot.models.map((model) => model.id), [...snapshot.models.map((model) => model.id)].sort())
        is(snapshot.hidden.length, snapshot.counts.hidden)
      },
    },
    {
      name: 'catalog assembly names the models this deployment hides',
      async run() {
        const logger = recordingLogger()
        const { adapter } = adapterWith([], { logger, config: { hiddenModels: ['glm-5.3', 'no-such-model'] } })
        await adapter.listModels('opencode-go')
        const line = logger.lines.find((text) => text.includes('hiddenModels keeps'))
        ok(line !== undefined, `a line names the field: ${logger.lines.join(' | ')}`)
        ok(line.includes('glm-5.3'), 'the hidden model is named')
        const unknown = logger.lines.find((text) => text.includes('does not list'))
        ok(unknown !== undefined, 'an unknown id is reported on its own')
        ok(unknown.includes('no-such-model'), 'the unknown id is named')
      },
    },
    {
      name: 'catalog assembly says once which models need the workspace setting',
      async run() {
        const logger = recordingLogger()
        const { adapter } = adapterWith([], { logger })
        await adapter.listModels('opencode-go')
        const line = logger.lines.find((text) => text.includes('train on request data'))
        ok(line !== undefined, `a line names the constraint: ${logger.lines.join(' | ')}`)
        ok(line.includes('muse-spark-1.3-contributor'), 'the model is named')
        ok(line.includes('Allow models that train on request data'), 'the setting is named')

        const hidden = recordingLogger()
        const hiddenAdapter = adapterWith([], { logger: hidden, config: { hideTrainingModels: true } })
        await hiddenAdapter.adapter.listModels('opencode-go')
        const hiddenLine = hidden.lines.find((text) => text.includes('train on request data'))
        ok(hiddenLine !== undefined, 'the hidden models are still named')
        ok(hiddenLine.includes('hidden'), `the line says they are hidden: ${hiddenLine}`)
      },
    },
    {
      name: 'listModels advertises the configured catalog',
      async run() {
        const { adapter } = adapterWith([])
        const models = await adapter.listModels('opencode-go')
        ok(models.length >= 30, `the fallback catalog is advertised (${models.length})`)
        const luna = models.find((model) => model.id === 'gpt-5.6-luna')
        is(luna.provider, 'opencode-go')
        is(luna.name, 'GPT 5.6 Luna')
      },
    },
    {
      name: 'resolveModel reports the measured context window, not one assumed value',
      async run() {
        const { adapter } = adapterWith([])
        const info = await adapter.resolveModel('opencode-go', 'glm-5.3', undefined)
        // glm-5.3 is catalogued at a 1M-token window; the fallback assumption is 256K.
        equal(info.context, { contextWindow: 1_000_000 })
        is(info.defaultMaxTokens, 131_072)
        equal(info.inputModalities, ['text'])
        ok(info.reasoning.efforts.length > 0, 'the reasoning ladder is advertised')
      },
    },
    {
      name: 'listModels carries each model own context window, cap, and modalities',
      async run() {
        const { adapter } = adapterWith([])
        const models = await adapter.listModels('opencode-go')
        const flash = models.find((model) => model.id === 'deepseek-v4.1-flash')
        is(flash.contextWindow, 1_000_000)
        is(flash.maxTokens, 384_000)
        const luna = models.find((model) => model.id === 'gpt-5.6-luna')
        is(luna.contextWindow, 1_050_000)
        // Two models the old assumed default reported identically now differ.
        ok(
          flash.contextWindow !== luna.contextWindow,
          'a listing distinguishes two models with different windows',
        )
      },
    },
    {
      name: 'an image modality is declared only when the attachment seam is mounted',
      async run() {
        const config = { config: { modelSource: 'config', models: [{ id: 'sees', input: ['text', 'image'] }] } }
        const without = adapterWith([], config)
        const withoutInfo = await without.adapter.resolveModel('opencode-go', 'sees', undefined)
        equal(withoutInfo.inputModalities, ['text'])

        const withSeam = adapterWith([], { ...config, attachments: { readImageRequest: async () => undefined } })
        const withInfo = await withSeam.adapter.resolveModel('opencode-go', 'sees', undefined)
        equal(withInfo.inputModalities, ['text', 'image'])
      },
    },
    {
      name: 'reasoning history signatures are recovered from replayState',
      async run() {
        const signatures = signaturesFromHistory([
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'because' },
              { type: 'tool-call', id: 'c1', name: 't', arguments: '{}' },
            ],
            source: { kind: 'model', provider: 'opencode-go', model: 'm', replayState: { response: {}, blocks: [{ type: 'reasoning', signature: 'sig-42' }, { type: 'tool-call' }] } },
          },
        ])
        equal(signatures, { because: 'sig-42' })
      },
    },
    {
      name: 'the retry policy defaults to the harness normal policy',
      async run() {
        const { adapter } = adapterWith([])
        const policy = adapter.providerRetryPolicy('opencode-go')
        is(policy.mode, 'normal')
        is(policy.maxRetries, 5)
      },
    },
    {
      name: 'providerInfo names the route and the service',
      async run() {
        const { adapter } = adapterWith([])
        equal(adapter.providerInfo('opencode-go'), { id: 'opencode-go', name: 'OpenCode Go' })
      },
    },
    {
      name: 'an empty completion is an EMPTY_RESPONSE failure rather than a silent success',
      async run() {
        const { adapter } = adapterWith([
          {
            body: sse([
              { data: { id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
              { data: '[DONE]' },
            ]),
          },
        ])
        let error
        try {
          await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] })
        } catch (thrown) {
          error = thrown
        }
        is(error?.code, 'EMPTY_RESPONSE')
      },
    },
    {
      name: 'the API key never appears in a failure message',
      async run() {
        const { adapter } = adapterWith([
          { status: 401, headers: { 'content-type': 'application/json' }, body: '{"error":{"message":"bad key"}}' },
        ])
        process.env.TEST_KEY = 'sk-super-secret-value'
        let error
        try {
          await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] })
        } catch (thrown) {
          error = thrown
        }
        ok(!String(error?.message).includes('sk-super-secret-value'), 'the secret is not in the message')
        ok(!JSON.stringify(error?.failure ?? {}).includes('sk-super-secret-value'), 'the secret is not in the failure facts')
      },
    },
  ],
}
