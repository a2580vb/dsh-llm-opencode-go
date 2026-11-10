/**
 * The adapter end to end, against a fake transport.
 *
 * These cases drive the real `OpenCodeGoAdapter`: real configuration, real
 * catalog, real request building, real header assembly, and the real protocol
 * fallback. Only `fetch` is replaced, so what is asserted here is the HTTP
 * request the plugin would actually send and the chunks it would actually
 * produce.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'

import { PROTOCOLS, resolveConfig } from '../../lib/config.js'
import * as adapterModule from '../../lib/index.js'
import { ModelCache } from '../../lib/model/cache.js'
import { createSessionState } from '../../lib/session/headers.js'
import { equal, is, ok, rejectsWithCode } from '../helpers.mjs'
import { createScratch } from './_scratch.mjs'

const { OpenCodeGoAdapter, requestHeaders, signaturesFromHistory } = adapterModule

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
function routedFetch(modelsScript, chatScriptOrFetch) {
  const discovery = fakeFetch(modelsScript)
  const chat = typeof chatScriptOrFetch === 'function' ? chatScriptOrFetch : fakeFetch(chatScriptOrFetch)
  const implementation = async (url, init) => {
    const target = String(url).endsWith('/models') ? discovery : chat
    return target(url, init)
  }
  implementation.requests = chat.requests
  implementation.modelsRequests = discovery.requests
  return implementation
}

/**
 * A `fetch` whose `200` headers arrive at once and whose body emits scripted
 * SSE pieces on a clock.
 *
 * The clock is what makes the deadline cases observable: the body keeps
 * producing for `pieces.length * gapMs`, and `stallAfter`/`stallMs` describe a
 * body that stops producing — the shape the idle watchdog exists to catch.
 */
function streamingFetch(pieces, { gapMs = 20, stallAfter = 0, stallMs = 0 } = {}) {
  const requests = []
  const encoder = new TextEncoder()
  const implementation = async (url, init) => {
    requests.push({ url: String(url), init })
    let closed = false
    const body = new ReadableStream({
      async start(controller) {
        // A caller abort tears the body down the way a real socket does: the
        // pending read rejects instead of ending cleanly.
        const stop = () => {
          if (closed) return
          closed = true
          try {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'))
          } catch {
            // The consumer already cancelled the body.
          }
        }
        init.signal?.addEventListener('abort', stop, { once: true })
        try {
          for (const [index, piece] of pieces.entries()) {
            if (closed) return
            await sleep(gapMs)
            if (closed) return
            controller.enqueue(encoder.encode(piece))
            if (stallAfter !== 0 && index + 1 === stallAfter) await sleep(stallMs)
          }
          if (!closed) controller.close()
        } catch {
          // The consumer went away mid-piece; nothing left to emit.
        }
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  implementation.requests = requests
  return implementation
}

/** A `fetch` that never answers; the case lets the connect deadline end it. */
function neverAnswersFetch() {
  const requests = []
  const implementation = (url, init) => {
    requests.push({ url: String(url), init })
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
    })
  }
  implementation.requests = requests
  return implementation
}

/**
 * A `fetch` that answers with a refusal whose body the case controls.
 *
 * A refusal is a status plus a body, and the two can fail independently: the
 * headers say `503`, while the body read is a second, separate failure. The
 * `mode` chooses which one this stub exercises.
 *
 * @param {object} [input] - the refusal to send.
 * @param {number} [input.status] - the HTTP status.
 * @param {object} [input.headers] - response headers.
 * @param {'fail' | 'abort' | 'stall'} [input.mode] - how the body read ends.
 * @param {Error} [input.error] - the immediate read failure in `fail` mode.
 * @returns {typeof fetch} the stub, with its recorded `requests`.
 */
function refusalBodyFetch({ status = 503, headers = {}, mode = 'fail', error = new TypeError('body lost') } = {}) {
  const requests = []
  const implementation = async (url, init) => {
    requests.push({ url: String(url), init })
    const body = new ReadableStream({
      start(controller) {
        if (mode === 'fail') {
          controller.error(error)
          return
        }
        if (mode === 'abort') {
          init.signal?.addEventListener('abort', () => {
            try {
              controller.error(new DOMException('The operation was aborted.', 'AbortError'))
            } catch {
              // The reader already cancelled it.
            }
          }, { once: true })
        }
        // `stall`: neither enqueue nor close; only a teardown ends the read.
      },
    })
    return new Response(body, {
      status,
      headers: new Headers({ 'content-type': 'application/json', ...headers }),
    })
  }
  implementation.requests = requests
  return implementation
}

/** Let queued promise callbacks run, without depending on a timer. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * A `fetch` whose response body the case feeds by hand.
 *
 * Nothing happens between reads unless the case calls `push` or `close`, so the
 * idle watchdog can be observed against a clock the case also owns.
 */
function handFedFetch() {
  const requests = []
  const encoder = new TextEncoder()
  let controller
  const implementation = async (url, init) => {
    requests.push({ url: String(url), init })
    const body = new ReadableStream({
      start(source) {
        controller = source
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  implementation.requests = requests
  implementation.ready = async () => {
    while (controller === undefined) await settle()
  }
  implementation.push = (text) => controller.enqueue(encoder.encode(text))
  implementation.close = () => controller.close()
  return implementation
}

/**
 * Replace the process clock for one case.
 *
 * The idle watchdog is a `setTimeout`; a synchronous clock lets a case advance
 * past a budget without waiting for it, so "a ping arrived in time" and "the
 * stream was actually silent" are both deterministic facts rather than races.
 */
function installClock() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let now = 0
  let nextId = 1
  const timers = new Map()
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const id = nextId
    nextId += 1
    timers.set(id, { at: now + Number(delay), run: () => callback(...args) })
    return id
  }
  globalThis.clearTimeout = (id) => {
    timers.delete(id)
  }
  return {
    now: () => now,
    advance(ms) {
      const target = now + ms
      for (;;) {
        let dueId
        let due
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (due === undefined || timer.at < due.at) {
            due = timer
            dueId = id
          }
        }
        if (due === undefined) break
        timers.delete(dueId)
        now = due.at
        due.run()
      }
      now = target
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
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

/** The scratch area every case's cache files live in, removed one case at a time. */
const scratch = createScratch()

/**
 * A cache path of this case's own.
 *
 * `scratch.path` mints a name no earlier run can have used — see `_scratch.mjs`
 * for why the process id was not enough — and this case's own cleanup deletes it
 * afterwards. So discovery starts cold and every case measures the requests it
 * asked for, however many runs the machine has behind it.
 */
const cacheFile = () => scratch.path('models')

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
  // The key a case names is the key the request carries: a credential set in
  // the environment after the adapter was built never reaches a request, and a
  // leak test whose secret takes that route proves nothing.
  const apiKey = overrides.key ?? 'sk-test-value'
  process.env.TEST_KEY = apiKey
  const fetch = routedFetch(overrides.discovery ?? [{ body: modelsReply([]) }], overrides.fetch ?? script)
  const logger = overrides.logger ?? silentLogger()
  const cache = new ModelCache(config, {
    authHeaders: async () => ({ authorization: `Bearer ${apiKey}` }),
    logger,
    // Discovery reads through the same scripted implementation as generation,
    // so a case can answer `GET /models` and a completion from one script.
    fetch,
  })
  const adapter = new OpenCodeGoAdapter({
    options: () => config,
    resolveApiKey: async () => apiKey,
    cache,
    usage: overrides.usage,
    subscription: overrides.subscription,
    attachments: () => overrides.attachments,
    discover: (provider) => adapter.listModels(provider),
    logger,
    fetch,
  })
  return { adapter, config, fetch }
}

/** A usage store stand-in: it records what the adapter counted. */
class RecordingUsage {
  constructor() {
    this.records = []
  }

  record(entry) {
    this.records.push(entry)
  }
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

const RESPONSES_BODY = sse([
  { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1' } } },
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } } },
  { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 0, delta: 'hi' } },
  { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } } },
  {
    event: 'response.completed',
    data: { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 3, output_tokens: 1 } } },
  },
])

export default {
  name: 'adapter',
  cases: scratch.withCleanup([
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
      name: 'freshConnectionOnLargeBody asks for a new connection only for large bodies',
      async run() {
        const { adapter, fetch } = adapterWith(
          [{ body: CHAT_BODY }, { body: CHAT_BODY }],
          { config: { freshConnectionOnLargeBody: true } },
        )
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
          sessionId: 'session-abc',
        })
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('x'.repeat(300 * 1024))],
          sessionId: 'session-abc',
        })
        // Small: keep the keep-alive socket. Large: travel on a fresh one.
        is(new Headers(fetch.requests[0].init.headers).get('connection'), null)
        is(new Headers(fetch.requests[1].init.headers).get('connection'), 'close')
      },
    },
    {
      name: 'freshConnectionOnLargeBody is off by default',
      async run() {
        const { adapter, fetch } = adapterWith([{ body: CHAT_BODY }])
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('x'.repeat(300 * 1024))],
          sessionId: 'session-abc',
        })
        is(new Headers(fetch.requests[0].init.headers).get('connection'), null)
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

        await collect(adapter, { provider: 'opencode-go', model: 'minimax-m3', messages: [userMessage('hi')] })
        const messagesHeaders = new Headers(fetch.requests[1].init.headers)
        is(messagesHeaders.get('x-api-key'), 'sk-test-value')
        is(messagesHeaders.get('authorization'), null)
        is(messagesHeaders.get('anthropic-version'), '2023-06-01')
        is(fetch.requests[1].url, 'https://relay.test/v1/messages')
      },
    },
    {
      name: 'protocol request headers reach the real fetch init for every protocol',
      async run() {
        const messagesBody = sse([
          { event: 'message_start', data: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 1 } } } },
          { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ])
        const { adapter, fetch } = adapterWith([
          { body: CHAT_BODY },
          { body: RESPONSES_BODY },
          { body: messagesBody },
        ])
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
          sessionId: 'header-session',
        })
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'gpt-5.6-luna',
          messages: [userMessage('hi')],
          sessionId: 'header-session',
        })
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'minimax-m3',
          messages: [userMessage('hi')],
          sessionId: 'header-session',
        })
        // `prepare()` declares the stream's Accept; it used to be dropped on the
        // floor between the protocol module and `fetch`.
        const chatHeaders = new Headers(fetch.requests[0].init.headers)
        is(chatHeaders.get('accept'), 'text/event-stream')
        is(chatHeaders.get('authorization'), 'Bearer sk-test-value')
        const responsesHeaders = new Headers(fetch.requests[1].init.headers)
        is(responsesHeaders.get('accept'), 'text/event-stream')
        is(responsesHeaders.get('authorization'), 'Bearer sk-test-value')
        is(fetch.requests[1].url, 'https://relay.test/v1/responses')
        // Messages keeps its own auth scheme: merging protocol headers must not
        // move it back to a bearer token or drop its version header.
        const messagesHeaders = new Headers(fetch.requests[2].init.headers)
        is(messagesHeaders.get('accept'), 'text/event-stream')
        is(messagesHeaders.get('x-api-key'), 'sk-test-value')
        is(messagesHeaders.get('anthropic-version'), '2023-06-01')
        is(messagesHeaders.get('authorization'), null)
        is(fetch.requests[2].url, 'https://relay.test/v1/messages')
      },
    },
    {
      name: 'protocol headers are the base, and request identity and auth are authoritative over them',
      run() {
        // The precedence is part of the contract: a protocol module may declare
        // wire headers, but it cannot replace the credential or the session id
        // the request is actually authenticated and pinned with.
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: cacheFile(),
        })
        const headers = requestHeaders({
          config,
          sessionState: createSessionState(),
          sessionId: 'session-xyz',
          protocol: PROTOCOLS.CHAT,
          apiKey: 'sk-test-value',
          requestBytes: 1,
          wireHeaders: {
            accept: 'text/event-stream',
            'content-type': 'text/plain',
            authorization: 'Bearer impostor',
            'x-opencode-session': 'impostor',
            'user-agent': 'impostor-agent',
            'x-protocol-extra': 'kept',
          },
        })
        is(headers.accept, 'text/event-stream', 'the protocol header survives')
        is(headers['x-protocol-extra'], 'kept', 'a header only the protocol declares survives')
        is(headers['content-type'], 'application/json', 'the adapter decides the body type')
        is(headers.authorization, 'Bearer sk-test-value', 'the resolved credential wins')
        is(headers['x-opencode-session'], 'session-xyz', 'the session identity wins')
        ok(headers['user-agent'].startsWith('dsh-opencode-go/'), 'the product identity wins')
      },
    },
    {
      name: 'a protocol refusal falls through to the next protocol the model serves',
      async run() {
        const { adapter, fetch } = adapterWith([protocolUnsupported('gpt-5.6-luna'), { body: CHAT_BODY }])
        const { blocks, finish } = await collect(adapter, {
          provider: 'opencode-go',
          model: 'gpt-5.6-luna',
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
      name: 'a DeepSeek call replays its own reasoning; a provider that keeps its own state does not',
      async run() {
        const tools = [{ name: 'get_weather', description: 'd', parameters: { type: 'object', properties: {} } }]
        const history = [
          userMessage('What is the weather in Paris?'),
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'Call the tool.' },
              { type: 'text', text: 'Checking.' },
              { type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{"city":"Paris"}' },
            ],
          },
          { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '18C' }] },
        ]

        const deepseek = adapterWith([{ body: RESPONSES_BODY }], {
          config: { protocolOverrides: { 'deepseek-v4.1-flash': PROTOCOLS.RESPONSES } },
        })
        await collect(deepseek.adapter, {
          provider: 'opencode-go',
          model: 'deepseek-v4.1-flash',
          messages: history,
          tools,
        })
        const input = JSON.parse(deepseek.fetch.requests[0].init.body).input
        // The relay takes the text as a `summary` part, ahead of the turn it belongs to.
        equal(input[1], { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Call the tool.' }] })
        equal(input[2], { role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] })

        const openai = adapterWith([{ body: RESPONSES_BODY }])
        await collect(openai.adapter, {
          provider: 'opencode-go',
          model: 'gpt-5.6-luna',
          messages: history,
          tools,
        })
        const other = JSON.parse(openai.fetch.requests[0].init.body).input
        is(other.some((item) => item.type === 'reasoning'), false, 'a provider with its own reasoning state gets none')
      },
    },
    {
      name: 'a backend that refuses a message shape is named as a content refusal',
      async run() {
        // The chat route's far end spells a tool message as a string and says so
        // when it cannot; reporting that as a malformed request would send the
        // reader looking for a fault in a request that is well formed.
        const { adapter } = adapterWith([{
          status: 400,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Upstream request failed: [invalid_request_error] tool message content must be a string on the gRPC path',
            },
          }),
        }])
        let error
        try {
          await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] })
        } catch (thrown) {
          error = thrown
        }
        is(error?.code, 'UNSUPPORTED_CONTENT')
        // The refusal names the shape the far end takes; the wording around it is
        // allowed to change, so only that fact is pinned.
        ok(String(error?.message).includes('plain string'), 'the shape it expects is named')
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
      name: 'a completed call is counted with the tokens the stream reported',
      async run() {
        const usage = new RecordingUsage()
        const { adapter } = adapterWith([{ body: CHAT_BODY }], { usage })
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
          sessionId: 'usage-session',
        })
        is(usage.records.length, 1)
        const [record] = usage.records
        is(record.model, 'glm-5.3')
        is(record.ok, true)
        // The figures are the ones the provider reported, not a guess: this is
        // the number a usage table is worth having.
        is(record.usage.inputTokens, 5)
        is(record.usage.outputTokens, 2)
        is(record.usage.totalTokens, 7)
      },
    },
    {
      name: 'a finished call is what tells the quota reader that the plan may have moved',
      async run() {
        // The quota moves only when a call is made, and this is the one place that
        // knows a call was made. Nothing is read here — the reader only marks the
        // time — but it is the fact a page's schedule is built on, so it has to be
        // reported by the same moment the counters are.
        const notes = []
        const { adapter } = adapterWith([{ body: CHAT_BODY }], {
          usage: new RecordingUsage(),
          subscription: { noteActivity: () => notes.push('spent') },
        })
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
          sessionId: 'activity-session',
        })
        equal(notes, ['spent'])

        // A call whose outcome nobody observed is not counted as a call, and it is
        // not evidence that the plan moved either: the same rule holds for both.
        const abandoned = []
        const { adapter: other } = adapterWith([{ body: CHAT_BODY }], {
          usage: new RecordingUsage(),
          subscription: { noteActivity: () => abandoned.push('spent') },
        })
        const controller = new AbortController()
        const stream = collect(other, {
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
          sessionId: 'abandoned-session',
          signal: controller.signal,
        })
        controller.abort()
        await stream.catch(() => undefined)
        equal(abandoned, [], 'an abandoned call is not evidence of anything')
      },
    },
    {
      name: 'a variant is counted under the alias the harness selected',
      async run() {
        const usage = new RecordingUsage()
        const { adapter } = adapterWith([{ body: CHAT_BODY }], {
          usage,
          config: { modelVariants: [{ model: 'glm-5.3', name: 'fast' }] },
        })
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3@fast',
          messages: [userMessage('hi')],
          sessionId: 'usage-variant',
        })
        // The wire carried the model; the table carries what a person chose,
        // because that is the thing they can act on.
        is(usage.records[0].model, 'glm-5.3@fast')
      },
    },
    {
      name: 'a refused call is counted as a failure',
      async run() {
        const usage = new RecordingUsage()
        const { adapter } = adapterWith([{ status: 500, body: 'boom' }], { usage })
        let thrown
        try {
          await collect(adapter, {
            provider: 'opencode-go',
            model: 'glm-5.3',
            messages: [userMessage('hi')],
            sessionId: 'usage-failure',
          })
        } catch (error) {
          thrown = error
        }
        ok(thrown !== undefined, 'the call failed')
        is(usage.records.length, 1)
        is(usage.records[0].ok, false)
        is(usage.records[0].model, 'glm-5.3')
      },
    },
    {
      name: 'a stream that breaks mid-flight is counted too',
      async run() {
        const usage = new RecordingUsage()
        const { adapter } = adapterWith([{ body: sse([
          { data: { id: 'r1', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] } },
        ]) }], { usage })
        let thrown
        try {
          await collect(adapter, {
            provider: 'opencode-go',
            model: 'glm-5.3',
            messages: [userMessage('hi')],
            sessionId: 'usage-broken',
          })
        } catch (error) {
          thrown = error
        }
        // A request the provider accepted and billed for is counted even when
        // the stream never terminated: that is exactly the case a person wants
        // to see, and the one an "only count successes" rule would hide.
        ok(thrown !== undefined, 'the stream failed')
        is(usage.records.length, 1)
        is(usage.records[0].ok, false)
      },
    },
    {
      name: 'tokens reported before a failed finish still reach the usage table, for every protocol',
      async run() {
        // The provider billed these tokens before the stream was lost. The
        // harness never receives the terminal usage chunk of a failed stream,
        // so the counting layer is fed by the translators' own usage callback.
        const cases = [
          {
            protocol: 'chat-completions',
            model: 'glm-5.3',
            body: sse([
              { data: { id: 'r1', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] } },
              { data: { id: 'r1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } },
              { data: { error: { type: 'server_error', message: 'upstream busy' } } },
            ]),
            check(record) {
              is(record.inputTokens, 5)
              is(record.outputTokens, 2)
              is(record.totalTokens, 7)
            },
          },
          {
            protocol: 'responses',
            model: 'gpt-5.6-luna',
            body: sse([
              { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
              { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 0, delta: 'hi' } },
              {
                event: 'response.completed',
                data: { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
              },
              { event: 'error', data: { type: 'error', error: { type: 'server_error', message: 'stream lost' } } },
            ]),
            check(record) {
              is(record.inputTokens, 3)
              is(record.outputTokens, 1)
              is(record.totalTokens, 4)
            },
          },
          {
            protocol: 'anthropic',
            model: 'minimax-m3',
            body: sse([
              { event: 'message_start', data: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 5, cache_read_input_tokens: 2 } } } },
              { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
              { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
              { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
              { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
              { event: 'error', data: { type: 'error', error: { type: 'server_error', message: 'stream lost' } } },
            ]),
            check(record) {
              is(record.inputTokens, 5)
              is(record.outputTokens, 1)
              is(record.cacheReadTokens, 2)
              is(record.totalTokens, 8)
            },
          },
        ]
        for (const attempt of cases) {
          const usage = new RecordingUsage()
          const { adapter } = adapterWith([{ body: attempt.body }], { usage })
          const chunks = []
          let thrown
          try {
            for await (const chunk of adapter.stream({
              provider: 'opencode-go',
              model: attempt.model,
              messages: [userMessage('hi')],
              sessionId: `usage-reported-${attempt.protocol}`,
            })) {
              chunks.push(chunk)
            }
          } catch (error) {
            thrown = error
          }
          ok(thrown !== undefined, `${attempt.protocol}: the stream failed`)
          is(chunks.filter((chunk) => chunk.type === 'usage').length, 0,
            `${attempt.protocol}: the harness got no usage chunk before the failure`)
          is(usage.records.length, 1, `${attempt.protocol}: counted once`)
          is(usage.records[0].ok, false, `${attempt.protocol}: counted as a failure`)
          is(usage.records[0].model, attempt.model)
          attempt.check(usage.records[0].usage)
        }
      },
    },
    {
      name: 'one call that falls back to another protocol is counted once',
      async run() {
        const usage = new RecordingUsage()
        const { adapter } = adapterWith([protocolUnsupported('gpt-5.6-luna'), { body: CHAT_BODY }], { usage })
        await collect(adapter, {
          provider: 'opencode-go',
          model: 'gpt-5.6-luna',
          messages: [userMessage('hi')],
          sessionId: 'usage-fallback',
        })
        // Two attempts, one call: a table that counted the retry would report
        // traffic nobody asked for.
        is(usage.records.length, 1)
        is(usage.records[0].ok, true)
        is(usage.records[0].usage.totalTokens, 7)
      },
    },
    {
      name: 'a message-only stream error is classified from its message, with the key redacted, for every protocol',
      async run() {
        const canary = 'sk-stream-canary-6b1d'
        const cases = [
          {
            protocol: 'chat-completions',
            model: 'glm-5.3',
            body: sse([{ data: { error: { message: `Rate limit exceeded for ${canary}` } } }]),
          },
          {
            protocol: 'responses',
            model: 'gpt-5.6-luna',
            body: sse([{
              event: 'error',
              data: { type: 'error', error: { message: `Rate limit exceeded for ${canary}` } },
            }]),
          },
          {
            protocol: 'anthropic',
            model: 'minimax-m3',
            body: sse([{
              event: 'error',
              data: { type: 'error', error: { message: `Rate limit exceeded for ${canary}` } },
            }]),
          },
        ]
        for (const attempt of cases) {
          const { adapter } = adapterWith([{ body: attempt.body }], { key: canary })
          const error = await rejectsWithCode(
            collect(adapter, {
              provider: 'opencode-go',
              model: attempt.model,
              messages: [userMessage('hi')],
              sessionId: `message-only-${attempt.protocol}`,
            }),
            'RATE_LIMIT',
          )
          ok(String(error.message).includes('Rate limit exceeded'), `${attempt.protocol}: the wording is kept`)
          ok(!String(error.message).includes(canary), `${attempt.protocol}: the message carries no key`)
          ok(!JSON.stringify(error.failure).includes(canary), `${attempt.protocol}: the facts carry no key`)
          ok(!String(error.cause?.message ?? error.cause ?? '').includes(canary), `${attempt.protocol}: the cause carries no key`)
        }
      },
    },
    {
      name: 'a deployment without a usage store still calls models',
      async run() {
        const { adapter } = adapterWith([{ body: CHAT_BODY }])
        const { blocks } = await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
          sessionId: 'no-usage',
        })
        equal(blocks.map((block) => block.type), ['text'])
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
        is(
          snapshot.counts.listed,
          total - snapshot.counts.hidden - snapshot.counts.hiddenByTraining - snapshot.counts.retired,
        )
        // A retired model stays in the snapshot as history, with the replacement
        // the service named for it.
        const retired = snapshot.models.find((model) => model.id === 'minimax-m2.7')
        is(retired.hidden, true)
        is(retired.hiddenReason, 'retired')
        is(retired.retired, true)
        is(retired.replacement, 'minimax-m3.1-flash')
        ok(snapshot.counts.retired >= 15, `the retired rows are counted: ${snapshot.counts.retired}`)
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
      name: 'a retired model stays resolvable but is never offered',
      async run() {
        const { adapter } = adapterWith([])
        const listed = await adapter.listModels('opencode-go')
        ok(!listed.some((model) => model.id === 'deepseek-v4-flash'), 'a retired id is not offered')
        ok(listed.every((model) => !model.id.startsWith('mimo-v2.5')), 'nor is any other retired id')
        // Resolving one still answers, so a session pinned to it reaches the
        // service and hears the retirement from the service itself.
        const info = await adapter.resolveModel('opencode-go', 'deepseek-v4-flash', undefined)
        is(info.id, 'deepseek-v4-flash')
        is(info.context?.contextWindow, 1_000_000)
        is(info.defaultMaxTokens, 384_000)
      },
    },
    {
      name: 'catalogSnapshot carries the facts a picker row shows',
      async run() {
        const { adapter } = adapterWith([])
        const snapshot = await adapter.catalogSnapshot()
        const luna = snapshot.models.find((model) => model.id === 'gpt-5.6-luna')
        equal(luna.protocols, ['responses', 'chat-completions', 'anthropic'])
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
      name: 'reasoning history signatures are recovered per message and per block',
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
        // Indexed by message and then by content block, not by the reasoning
        // text: a signature belongs to one block, and identical text elsewhere
        // is a different thought with a different signature.
        equal(signatures, [undefined, ['sig-42', undefined]])
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
      name: 'a refusal that echoes the API key never puts it in the thrown failure',
      async run() {
        const canary = 'sk-adapter-canary-7f3c9d'
        for (const status of [400, 401]) {
          const { adapter, fetch } = adapterWith([{
            status,
            headers: { 'content-type': 'application/json', 'x-request-id': `req-${status}` },
            body: JSON.stringify({
              error: {
                type: 'invalid_request_error',
                code: 'invalid_api_key',
                message: `provider detail: ${canary}`,
              },
              echo: `the raw body also carried ${canary}`,
            }),
          }], { key: canary })
          let error
          try {
            await collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] })
          } catch (thrown) {
            error = thrown
          }
          // The key really rode in the request. Without this the old case passed
          // because the secret it looked for was never sent at all.
          is(fetch.requests.length, 1, 'a terminal refusal makes one attempt')
          is(fetch.requests[0].init.headers.authorization, `Bearer ${canary}`, 'the request carried the canary')
          is(error?.code, status === 401 ? 'AUTH' : 'INVALID_REQUEST')
          is(error?.failure?.status, status)
          ok(!String(error?.message).includes(canary), 'the secret is not in the message')
          ok(!JSON.stringify(error?.failure ?? {}).includes(canary), 'the secret is not in the failure facts')
          ok(
            !String(error?.cause?.message ?? error?.cause ?? '').includes(canary),
            'the secret is not in the cause',
          )
          // Redaction removes the secret, not the provider's explanation of it.
          ok(String(error?.message).includes('provider detail:'), 'the detail around the secret stays')
        }
      },
    },
    {
      name: 'a stream that keeps arriving outlives the connect deadline',
      async run() {
        // Regression: the deadline timer was never cleared, so it capped the
        // whole attempt and a generation that kept producing died at timeoutMs.
        // The deadline covers connection and response headers only; from there
        // the idle watchdog guards the stream, and this body keeps arriving.
        const pieces = Array.from({ length: 16 }, (_, index) => sse([
          {
            data: {
              id: 'r1',
              choices: [{ index: 0, delta: { role: 'assistant', content: index === 0 ? 'hi' : '.' }, finish_reason: null }],
            },
          },
        ]))
        pieces.push(sse([{ data: { id: 'r1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } }]))
        pieces.push(sse([{ data: '[DONE]' }]))
        const { adapter } = adapterWith([], {
          fetch: streamingFetch(pieces, { gapMs: 25 }),
          config: { timeoutMs: 150, streamIdleTimeoutMs: 2_000 },
        })
        const { finish } = await collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
        })
        // 16 pieces x 25 ms is 400 ms of body, well past the 150 ms budget.
        equal(finish, { kind: 'stop' })
      },
    },
    {
      name: 'a stream that stops arriving is a retryable TIMEOUT',
      async run() {
        const pieces = [
          sse([{ data: { id: 'r1', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] } }]),
        ]
        const { adapter } = adapterWith([], {
          fetch: streamingFetch(pieces, { gapMs: 10, stallAfter: 1, stallMs: 500 }),
          config: { timeoutMs: 5_000, streamIdleTimeoutMs: 120 },
        })
        const error = await rejectsWithCode(
          collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] }),
          'TIMEOUT',
        )
        ok(String(error.message).includes('stream was idle'), 'the message names the idle watchdog')
      },
    },
    {
      name: 'waiting past the deadline for response headers is a TIMEOUT, not a caller abort',
      async run() {
        const { adapter } = adapterWith([], {
          fetch: neverAnswersFetch(),
          config: { timeoutMs: 80, streamIdleTimeoutMs: 5_000 },
        })
        const error = await rejectsWithCode(
          collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] }),
          'TIMEOUT',
        )
        ok(!String(error.message).includes('aborted by the caller'), 'a deadline is not a caller abort')
      },
    },
    {
      name: 'a caller abort during the stream stays ABORTED',
      async run() {
        const pieces = Array.from({ length: 40 }, () => sse([
          { data: { id: 'r1', choices: [{ index: 0, delta: { role: 'assistant', content: '.' }, finish_reason: null }] } },
        ]))
        const { adapter } = adapterWith([], {
          fetch: streamingFetch(pieces, { gapMs: 20 }),
          config: { timeoutMs: 5_000, streamIdleTimeoutMs: 5_000 },
        })
        const controller = new AbortController()
        const stream = collect(adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
          signal: controller.signal,
        })
        setTimeout(() => controller.abort(), 120)
        const error = await rejectsWithCode(stream, 'ABORTED')
        ok(String(error.message).includes('aborted by the caller'), 'the caller owns this failure')
      },
    },
    {
      name: 'a pre-cancelled call resolves no catalog and touches no network, cold or warm',
      async run() {
        /** A signal that is already aborted: the caller changed their mind. */
        const aborted = () => {
          const controller = new AbortController()
          controller.abort()
          return controller.signal
        }
        const options = (signal) => ({
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
          signal,
        })

        // Cold: nothing has assembled the catalog, so a directory read would be
        // exactly the `/models` request this call must not make.
        const cold = adapterWith([])
        for (const call of [
          () => cold.adapter.listModels('opencode-go', aborted()),
          () => cold.adapter.resolveModel('opencode-go', 'glm-5.3', aborted()),
          () => cold.adapter.prepareCall('opencode-go', 'glm-5.3', aborted()),
          () => collect(cold.adapter, options(aborted())),
        ]) {
          const error = await rejectsWithCode(call(), 'ABORTED')
          ok(String(error.message).includes('aborted by the caller'), 'the caller owns the failure')
          ok(!(error instanceof DOMException), 'the raw DOMException never reaches the caller')
        }
        is(cold.fetch.modelsRequests.length, 0, 'a pre-cancelled cold call asks for no directory')
        is(cold.fetch.requests.length, 0, 'and sends no completion request')

        // Warm: the catalog is already in memory, and the abort still ends the
        // call before a generation request is built.
        const warm = adapterWith([])
        await warm.adapter.listModels('opencode-go')
        is(warm.fetch.modelsRequests.length, 1, 'the warm-up read the directory once')
        for (const call of [
          () => warm.adapter.resolveModel('opencode-go', 'glm-5.3', aborted()),
          () => warm.adapter.prepareCall('opencode-go', 'glm-5.3', aborted()),
          () => collect(warm.adapter, options(aborted())),
        ]) {
          const error = await rejectsWithCode(call(), 'ABORTED')
          ok(!(error instanceof DOMException), 'the raw DOMException never reaches the caller')
        }
        is(warm.fetch.modelsRequests.length, 1, 'a pre-cancelled warm call asks for no directory')
        is(warm.fetch.requests.length, 0, 'and sends no completion request')
      },
    },
    {
      name: 'a refusal whose body cannot be read is a TRANSPORT failure that keeps the known status',
      async run() {
        const { adapter, fetch } = adapterWith([], {
          fetch: refusalBodyFetch({
            status: 503,
            headers: { 'x-request-id': 'req-body-503' },
          }),
        })
        const error = await rejectsWithCode(
          collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] }),
          'TRANSPORT',
        )
        is(fetch.requests.length, 1, 'one request was made')
        is(error.failure.status, 503, 'the status that did arrive is kept')
        is(error.failure.requestId, 'req-body-503', 'the request id that did arrive is kept')
        ok(!String(error.message).includes('HTTP 503:'), 'an unread body is not reported as a refusal detail')
        ok(String(error.message).includes('transport failed'), 'the read failure is a transport failure')
      },
    },
    {
      name: 'a caller abort or deadline while reading a refusal body wins over the read failure',
      async run() {
        const caller = new AbortController()
        const first = adapterWith([], {
          fetch: refusalBodyFetch({ status: 500, mode: 'abort' }),
          config: { timeoutMs: 5_000 },
        })
        const pending = collect(first.adapter, {
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
          signal: caller.signal,
        })
        setTimeout(() => caller.abort(), 25)
        const aborted = await rejectsWithCode(pending, 'ABORTED')
        ok(String(aborted.message).includes('aborted by the caller'), 'the caller owns this failure')
        is(aborted.failure.status, 500, 'the status that did arrive is still kept')

        const second = adapterWith([], {
          fetch: refusalBodyFetch({ status: 500, mode: 'abort' }),
          config: { timeoutMs: 60 },
        })
        const timedOut = await rejectsWithCode(
          collect(second.adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] }),
          'TIMEOUT',
        )
        is(timedOut.failure.status, 500, 'the status that did arrive is still kept')
      },
    },
    {
      name: 'a stable refusal keeps its code when the response headers are classifier-hostile',
      async run() {
        const cases = [
          {
            status: 401,
            headers: { 'x-opencode-log-id': '', 'x-request-id': ' req-401 ', 'retry-after': '0.0001' },
            body: { error: { message: 'invalid key' } },
            code: 'AUTH',
            requestId: 'req-401',
          },
          {
            status: 402,
            headers: { 'retry-after': 'Infinity' },
            body: { error: { message: 'quota exhausted' } },
            code: 'QUOTA',
            requestId: undefined,
          },
        ]
        for (const entry of cases) {
          const { adapter } = adapterWith([{
            status: entry.status,
            headers: { 'content-type': 'application/json', ...entry.headers },
            body: JSON.stringify(entry.body),
          }])
          const error = await rejectsWithCode(
            collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] }),
            entry.code,
          )
          is(error.failure.status, entry.status)
          is(error.failure.requestId, entry.requestId)
          is(error.failure.providerRetryAfterMs, undefined, 'a zero or infinite hint is not passed on')
          ok(!String(error.message).includes('transport failed'), 'a classifier exception cannot demote the code')
        }
      },
    },
    {
      name: 'a protocol refusal with a blank log id keeps its code instead of becoming TRANSPORT',
      async run() {
        const refusal = protocolUnsupported('glm-5.3')
        refusal.headers['x-opencode-log-id'] = ''
        refusal.headers['x-request-id'] = 'req-protocol'
        const { adapter, fetch } = adapterWith([refusal, refusal, refusal])
        const error = await rejectsWithCode(
          collect(adapter, { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] }),
          'PROTOCOL_UNSUPPORTED',
        )
        is(error.failure.requestId, 'req-protocol', 'the fallback request id is kept')
        is(fetch.requests.length, 3, 'every protocol the model declares was tried')
      },
    },
    {
      name: 'a keep-alive comment and a partial frame each renew the idle budget',
      async run() {
        // A connection that is only pinging is still alive, and so is one that
        // has delivered half a frame. Neither produces a decoded frame, so the
        // watchdog must be fed from the reads themselves.
        const clock = installClock()
        const fetch = handFedFetch()
        try {
          const { adapter } = adapterWith([], {
            fetch,
            config: { timeoutMs: 60_000, streamIdleTimeoutMs: 100 },
          })
          const stream = collect(adapter, {
            provider: 'opencode-go',
            model: 'glm-5.3',
            messages: [userMessage('hi')],
          })
          stream.catch(() => {})
          await fetch.ready()
          await settle()
          clock.advance(50)
          fetch.push(': ping\n\n')
          await settle()
          // 130 ms after the attempt began, past the first arm; only the ping's
          // renewal keeps the stream alive.
          clock.advance(80)
          fetch.push('data: {"id":"r1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n')
          await settle()
          clock.advance(80)
          fetch.push('\ndata: {"id":"r1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
          fetch.close()
          const { finish } = await stream
          equal(finish, { kind: 'stop' })
        } finally {
          clock.restore()
        }
      },
    },
    {
      name: 'time the harness spends holding the stream is not upstream idle time',
      async run() {
        // Once a chunk reaches the caller, waiting for the caller to ask again
        // is not the provider being silent. The idle budget covers only the
        // reads the adapter itself is waiting on.
        const clock = installClock()
        const fetch = handFedFetch()
        let iterator
        try {
          const { adapter } = adapterWith([], {
            fetch,
            config: { timeoutMs: 60_000, streamIdleTimeoutMs: 100 },
          })
          iterator = adapter.stream({
            provider: 'opencode-go',
            model: 'glm-5.3',
            messages: [userMessage('hi')],
          })[Symbol.asyncIterator]()
          const first = iterator.next()
          await fetch.ready()
          await settle()
          fetch.push(sse([
            { data: { id: 'r1', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] } },
          ]))
          const started = await first
          is(started.value.type, 'block-start')
          const delivered = await iterator.next()
          is(delivered.value.type, 'text-delta')
          // The provider has finished its whole answer while the harness still
          // holds the stream: no read is outstanding, so no upstream silence
          // exists to time out.
          fetch.push(sse([{ data: { id: 'r1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } }]))
          fetch.push(sse([{ data: '[DONE]' }]))
          fetch.close()
          clock.advance(5_000)
          const rest = []
          for (;;) {
            const next = await iterator.next()
            if (next.done) break
            rest.push(next.value)
          }
          const finish = rest.find((chunk) => chunk.type === 'finish')
          equal(finish?.reason, { kind: 'stop' })
        } finally {
          clock.restore()
          void iterator?.return?.().catch(() => {})
        }
      },
    },
    {
      name: 'actual upstream silence still trips the idle watchdog under a controlled clock',
      async run() {
        const clock = installClock()
        const fetch = handFedFetch()
        try {
          const { adapter } = adapterWith([], {
            fetch,
            config: { timeoutMs: 60_000, streamIdleTimeoutMs: 100 },
          })
          const stream = collect(adapter, {
            provider: 'opencode-go',
            model: 'glm-5.3',
            messages: [userMessage('hi')],
          })
          stream.catch(() => {})
          await fetch.ready()
          await settle()
          // Nothing is read for longer than the budget: this is the case the
          // watchdog exists for, and it must not be disabled by the pause rule.
          clock.advance(150)
          const error = await rejectsWithCode(stream, 'TIMEOUT')
          ok(String(error.message).includes('stream was idle'), 'the message names the idle watchdog')
        } finally {
          clock.restore()
        }
      },
    },
  ]),
}
