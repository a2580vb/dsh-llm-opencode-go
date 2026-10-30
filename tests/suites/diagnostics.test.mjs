/**
 * The diagnostics log, and what one failed attempt leaves in it.
 *
 * The log exists for facts the harness cannot keep: the `cause` under a
 * `fetch failed`, whether the response headers ever arrived, and how far into a
 * stream a connection died. So these cases drive the real adapter against a
 * fake transport that fails in each of those ways, and then read the file the
 * plugin would have written.
 */

import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { resolveConfig } from '../../lib/config.js'
import { DiagnosticsLog, causeChain, diagnosticsPath } from '../../lib/diagnostics/log.js'
import { OpenCodeGoAdapter } from '../../lib/index.js'
import { ModelCache } from '../../lib/model/cache.js'
import { equal, is, ok, rejectsWithCode } from '../helpers.mjs'
import { createScratch } from './_scratch.mjs'

const scratch = createScratch()

/** A `fetch` that replays scripted answers, or throws where a script says to. */
function fakeFetch(script) {
  const implementation = async (url, init) => {
    const next = script.shift()
    if (next === undefined) throw new Error(`unexpected request to ${url}`)
    if (next.error !== undefined) throw next.error
    const headers = new Headers(next.headers ?? { 'content-type': 'text/event-stream' })
    return new Response(next.body ?? '', { status: next.status ?? 200, headers })
  }
  implementation.requests = 0
  return implementation
}

/** A `GET /models` answer; the cases generate, they do not discover. */
function modelsReply(ids) {
  return JSON.stringify({
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'opencode' })),
  })
}

/** The relay's `fetch failed`, with the real reason on `cause` where undici puts it. */
function fetchFailed(code = 'ECONNRESET') {
  const refused = Object.assign(new Error(`read ${code}`), { code, errno: code === 'ECONNRESET' ? -4077 : -3008, syscall: 'read' })
  return Object.assign(new TypeError('fetch failed'), {
    cause: new AggregateError([refused], 'connect ECONNRESET'),
  })
}

/** A chat-completions stream that yields one delta and then dies. */
function dyingStream() {
  const frames = `data: ${JSON.stringify({
    id: 'r1',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
  })}\n\n`
  const bytes = new TextEncoder().encode(frames)
  let served = false
  return new ReadableStream({
    pull(controller) {
      if (!served) {
        served = true
        controller.enqueue(bytes)
        return
      }
      controller.error(new TypeError('terminated'))
    },
  })
}

/** One complete chat-completions body, as the relay sends it. */
const CHAT_BODY = [
  { id: 'r1', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
  { id: 'r1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { id: 'r1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
].map((data) => `data: ${JSON.stringify(data)}\n\n`).join('') + 'data: [DONE]\n\n'

function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} }
}

function recordingLogger() {
  const lines = []
  return {
    lines,
    info: (...args) => lines.push(args.map(String).join(' ')),
    warn: (...args) => lines.push(args.map(String).join(' ')),
    debug() {},
    error: (...args) => lines.push(args.map(String).join(' ')),
  }
}

/**
 * An adapter over scripted answers, writing its diagnostics to `path`.
 */
function adapterWith(script, input = {}) {
  const config = resolveConfig({
    baseURL: 'https://relay.test/v1',
    apiKeyEnv: 'TEST_KEY',
    modelsCachePath: input.cachePath ?? scratch.path('models'),
    diagnosticsPath: input.path ?? scratch.path('diagnostics'),
    diagnostics: input.diagnostics,
  })
  process.env.TEST_KEY = input.key ?? 'sk-test-value'
  const discovery = fakeFetch([{ body: modelsReply([]) }])
  const completion = fakeFetch(script)
  const fetch = async (url, init) => (String(url).endsWith('/models') ? discovery(url, init) : completion(url, init))
  const logger = input.logger ?? silentLogger()
  const cache = new ModelCache(config, {
    authHeaders: async () => ({ authorization: 'Bearer sk-test-value' }),
    logger,
    fetch,
  })
  const diagnostics = new DiagnosticsLog(config, {
    logger,
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
    ...(input.keptRotations === undefined ? {} : { keptRotations: input.keptRotations }),
  })
  const adapter = new OpenCodeGoAdapter({
    options: () => config,
    resolveApiKey: async () => input.key ?? 'sk-test-value',
    cache,
    diagnostics,
    attachments: () => undefined,
    logger,
    fetch,
  })
  return { adapter, config, diagnostics }
}

/** Every record in a log file, oldest first. */
async function readRecords(path) {
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

/** One user text message, as the harness sends it. */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** Collect a stream, expecting it to fail. */
async function drain(adapter) {
  const chunks = []
  try {
    for await (const chunk of adapter.stream({
      provider: 'opencode-go',
      model: 'glm-5.3',
      messages: [userMessage('hi')],
      sessionId: 'session-test',
    })) chunks.push(chunk)
  } catch (error) {
    return { error, chunks }
  }
  throw new Error('expected the stream to fail')
}

export default {
  name: 'diagnostics',
  cases: scratch.withCleanup([
    {
      name: 'the default path sits under the log directory, not the cache',
      run() {
        const path = diagnosticsPath(resolveConfig({}))
        ok(path.endsWith(join('.dsh', 'logs', 'opencode-go.jsonl')), `unexpected default path: ${path}`)
        is(diagnosticsPath({ diagnosticsPath: 'C:/custom/log.jsonl' }), 'C:/custom/log.jsonl')
      },
    },
    {
      name: 'off records nothing at all',
      async run() {
        const path = scratch.path('off')
        const log = new DiagnosticsLog(resolveConfig({ diagnostics: 'off', diagnosticsPath: path }))
        log.record({ outcome: 'error', code: 'TRANSPORT' })
        await log.flush()
        await rejectsWithCode(readFile(path), 'ENOENT', 'no file is created when the level is off')
      },
    },
    {
      name: 'the default level keeps failures and drops successes',
      async run() {
        const path = scratch.path('failures')
        const log = new DiagnosticsLog(resolveConfig({ diagnosticsPath: path }))
        log.record({ outcome: 'ok', model: 'glm-5.3' })
        log.record({ outcome: 'error', code: 'TRANSPORT', model: 'glm-5.3' })
        await log.flush()
        const records = await readRecords(path)
        is(records.length, 1, 'only the failure is written')
        is(records[0].code, 'TRANSPORT')
      },
    },
    {
      name: 'all keeps the successful attempts too',
      async run() {
        const path = scratch.path('all')
        const log = new DiagnosticsLog(resolveConfig({ diagnostics: 'all', diagnosticsPath: path }))
        log.record({ outcome: 'ok' })
        log.record({ outcome: 'error' })
        await log.flush()
        equal((await readRecords(path)).map((record) => record.outcome), ['ok', 'error'])
      },
    },
    {
      name: 'the file rotates instead of growing without limit',
      async run() {
        const path = scratch.path('rotate')
        const log = new DiagnosticsLog(resolveConfig({ diagnostics: 'all', diagnosticsPath: path }), {
          maxBytes: 300,
          keptRotations: 2,
        })
        for (let index = 0; index < 30; index += 1) log.record({ outcome: 'ok', n: index, pad: 'x'.repeat(40) })
        await log.flush()
        const live = (await stat(path)).size
        ok(live <= 300, `the live file stays under the threshold, got ${live}`)
        const rotated = (await readdir(dirname(path))).filter((name) => name.includes('rotate-'))
        ok(rotated.some((name) => name.endsWith('.1')), `the first rotation exists: ${rotated.join(', ')}`)
        ok(rotated.every((name) => !name.endsWith('.3')), `nothing older than the kept rotations: ${rotated.join(', ')}`)
        // The newest record is the last line of the live file, whatever rotated.
        const records = await readRecords(path)
        is(records.at(-1).n, 29)
      },
    },
    {
      name: 'a cause chain is flattened into the line',
      run() {
        const links = causeChain(fetchFailed('ECONNREFUSED'))
        ok(links.some((link) => link.name === 'TypeError' && link.message === 'fetch failed'), `outer link: ${JSON.stringify(links)}`)
        ok(links.some((link) => link.code === 'ECONNREFUSED'), `the member of the aggregate: ${JSON.stringify(links)}`)
        ok(links.some((link) => link.via === 'errors'), 'members are marked as such')
      },
    },
    {
      name: 'a call that never got a response is logged as a connection failure',
      async run() {
        const path = scratch.path('connect')
        const { adapter, diagnostics } = adapterWith([{ error: fetchFailed('ECONNRESET') }], { path })
        await drain(adapter)
        await diagnostics.flush()
        const [record] = await readRecords(path)
        is(record.outcome, 'error')
        is(record.code, 'TRANSPORT')
        is(record.phase, 'connect')
        is(record.events, 0)
        is(record.headersReceived, false, 'no headers arrived')
        ok(record.requestBytes > 0, 'the request it would have sent was measured')
        ok(record.durationMs >= 0)
        ok(record.timeoutMs > 0 && record.streamIdleTimeoutMs > 0, 'the budgets it ran under are recorded')
        ok(record.cause.some((link) => link.code === 'ECONNRESET'), `the reason under fetch failed: ${JSON.stringify(record.cause)}`)
      },
    },
    {
      name: 'a stream that dies halfway is logged as a stream failure, with what it had read',
      async run() {
        const path = scratch.path('stream')
        const { adapter, diagnostics } = adapterWith([{ body: dyingStream() }], { path })
        const { error } = await drain(adapter)
        is(error.code, 'TRANSPORT')
        await diagnostics.flush()
        const [record] = await readRecords(path)
        is(record.phase, 'stream')
        ok(record.events >= 1, `the events that arrived before the break are counted: ${record.events}`)
        ok(record.streamMs >= 0, 'the time inside the stream is separated from the connect time')
        ok(record.cause.some((link) => link.message === 'terminated'), `the socket's own words: ${JSON.stringify(record.cause)}`)
      },
    },
    {
      name: 'a refused request records the status and the provider request id',
      async run() {
        const path = scratch.path('refused')
        const { adapter, diagnostics } = adapterWith([{
          status: 400,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-42' },
          body: JSON.stringify({ error: { message: 'no tool output found', type: 'invalid_request_error' } }),
        }], { path })
        await drain(adapter)
        await diagnostics.flush()
        const [record] = await readRecords(path)
        is(record.outcome, 'error')
        is(record.code, 'INVALID_REQUEST')
        is(record.status, 400)
        is(record.phase, 'response')
        is(record.requestId, 'req-42')
      },
    },
    {
      name: 'a successful attempt is written only when the level asks for it',
      async run() {
        const quiet = scratch.path('quiet')
        const first = adapterWith([{ body: CHAT_BODY }], { path: quiet })
        const chunks = []
        for await (const chunk of first.adapter.stream({
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
          sessionId: 'session-test',
        })) chunks.push(chunk)
        await first.diagnostics.flush()
        await rejectsWithCode(readFile(quiet), 'ENOENT', 'a working call leaves no file behind')

        const loud = scratch.path('loud')
        const second = adapterWith([{ body: CHAT_BODY }], { path: loud, diagnostics: 'all' })
        for await (const chunk of second.adapter.stream({
          provider: 'opencode-go',
          model: 'glm-5.3',
          messages: [userMessage('hi')],
          sessionId: 'session-test',
        })) void chunk
        await second.diagnostics.flush()
        const [record] = await readRecords(loud)
        is(record.outcome, 'ok')
        ok(record.events > 0, 'how many events a working stream produced')
        is(record.headersReceived, true)
      },
    },
    {
      name: 'the log never carries the credential or a message body',
      async run() {
        const path = scratch.path('secret')
        const { adapter, diagnostics } = adapterWith([{ error: fetchFailed('ECONNRESET') }], {
          path,
          key: 'sk-do-not-log-this',
        })
        await drain(adapter)
        await diagnostics.flush()
        const text = await readFile(path, 'utf8')
        ok(!text.includes('sk-do-not-log-this'), 'the key stays out of the file')
        ok(!text.includes('authorization'), 'no header is written')
        ok(!text.includes('Bearer'), 'no auth scheme is written either')
      },
    },
    {
      name: 'a log that cannot be written warns once and never fails the call',
      async run() {
        // A regular file where a directory would have to be: creating the log's
        // directory then fails on every platform this plugin supports.
        const blocker = scratch.path('blocker')
        await writeFile(blocker, 'not a directory', 'utf8')
        const logger = recordingLogger()
        const { adapter, diagnostics } = adapterWith([{ body: CHAT_BODY }, { body: CHAT_BODY }], {
          path: join(blocker, 'diagnostics', 'opencode-go.jsonl'),
          diagnostics: 'all',
          logger,
        })
        for (const run of [1, 2]) {
          for await (const chunk of adapter.stream({
            provider: 'opencode-go',
            model: 'glm-5.3',
            messages: [userMessage(`hi ${run}`)],
            sessionId: 'session-test',
          })) void chunk
        }
        await diagnostics.flush()
        const warnings = logger.lines.filter((line) => line.includes('diagnostics log'))
        is(warnings.length, 1, `reported once, not once per attempt: ${JSON.stringify(logger.lines)}`)
      },
    },
  ]),
}
