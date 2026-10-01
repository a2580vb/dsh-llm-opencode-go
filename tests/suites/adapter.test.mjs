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

/** Not-an-error response the relay sends for an unsupported protocol. */
function protocolUnsupported(model) {
  return {
    status: 400,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'error', error: { type: 'ModelProtocolUnsupported', message: 'Model does not support this protocol.' } , model }),
  }
}

/** A per-adapter cache path, so one case's discovery never reaches another. */
let cacheCounter = 0

/**
 * Build an adapter over scripted responses.
 *
 * The catalog is the measured fallback unless a case opts into an explicit
 * `models` list, because discovery is what a real deployment gets: the case
 * that exercises `GET /models` opts out by leaving `modelSource` alone.
 */
function adapterWith(script, overrides = {}) {
  cacheCounter += 1
  const config = resolveConfig({
    baseURL: 'https://relay.test/v1',
    apiKeyEnv: 'TEST_KEY',
    modelsCachePath: overrides.cachePath
      ?? `L:\\e2\\dsh-plugin\\opencodego-transfrom\\.test-cache\\${cacheCounter}.json`,
    ...overrides.config,
  })
  process.env.TEST_KEY = 'sk-test-value'
  const fetch = fakeFetch(script)
  const cache = new ModelCache(config, {
    authHeaders: async () => ({ authorization: 'Bearer sk-test-value' }),
    logger: silentLogger(),
  })
  const adapter = new OpenCodeGoAdapter({
    options: () => config,
    resolveApiKey: async () => 'sk-test-value',
    cache,
    attachments: () => overrides.attachments,
    discover: (provider) => adapter.listModels(provider),
    logger: silentLogger(),
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
      name: 'resolveModel reports the context window and no image modality by default',
      async run() {
        const { adapter } = adapterWith([])
        const info = await adapter.resolveModel('opencode-go', 'glm-5.3', undefined)
        equal(info.context, { contextWindow: 262_144 })
        equal(info.inputModalities, ['text'])
        ok(info.reasoning.efforts.length > 0, 'the reasoning ladder is advertised')
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
