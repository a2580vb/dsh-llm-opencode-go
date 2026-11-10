/**
 * Discovery: what one `GET /models` row contributes to the catalog.
 *
 * Since 2026-11 each row describes itself — name, description, limits,
 * modalities, reasoning ladder and the catalogue's preferred wire entry — and
 * the cache keeps that row verbatim-ish. These cases pin the two joins that
 * make the facts reach a model record: the row parser (untrusted body → one
 * normalized row) and the catalog merge (row + built-in record + config, in
 * that order of precedence). A version 1 cache and a row that states nothing
 * are covered too, because a deployment upgrading in place still starts from
 * them.
 */

import { readFile, writeFile } from 'node:fs/promises'

import { PROTOCOLS, resolveConfig } from '../../lib/config.js'
import { ModelCache, parseModelList } from '../../lib/model/cache.js'
import {
  buildCatalog,
  discoveryRecord,
  harnessModalities,
  hiddenReason,
  preferredProtocol,
} from '../../lib/model/catalog.js'
import { equal, is, ok } from '../helpers.mjs'
import { createScratch } from './_scratch.mjs'

const scratch = createScratch()

/** A silent logger, so the cache client's own lines do not reach the test output. */
const silent = { info() {}, warn() {}, debug() {}, error() {} }

/** Await a call that must fail, returning the failure it threw. */
async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the call to fail')
}

/** A `fetch` that answers one `/models` payload and records what it was asked. */
function modelsFetch(payload) {
  const requests = []
  const implementation = async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  implementation.requests = requests
  return implementation
}

export default {
  name: 'model/discovery',
  cases: scratch.withCleanup([
    {
      name: 'a rich /models row keeps the facts this adapter can use',
      run() {
        const rows = parseModelList({
          object: 'list',
          data: [{
            id: 'sample-model',
            object: 'model',
            created: 123,
            owned_by: 'opencode',
            name: 'Sample Model',
            description: 'a sample model',
            canonical_id: 'vendor/sample-model',
            limit: { context: 400_000, input: 380_000, output: 64_000 },
            modalities: { input: ['text', 'image/png', 'application/pdf'], output: ['text'] },
            capabilities: {
              reasoning: { supported: true, effort: ['none', 'low', 'high'] },
              tools: { supported: true },
            },
            api: { 'chat-completions': { base_url: 'https://relay.test/openai/v1' } },
            cost: { text: {} },
          }],
        })
        is(rows.length, 1)
        equal(rows[0], {
          id: 'sample-model',
          name: 'Sample Model',
          description: 'a sample model',
          limit: { context: 400_000, output: 64_000, input: 380_000 },
          modalities: ['text', 'image/png', 'application/pdf'],
          // `none` is expressed by omitting the effort, never by advertising it.
          reasoning: { supported: true, efforts: ['low', 'high'] },
          api: ['chat-completions'],
        })
        // `created` and the OpenAI envelope fields are request facts, not model facts.
        is(rows[0].created, undefined)
        is(rows[0].object, undefined)
      },
    },
    {
      name: 'a row that states nothing usable is dropped, not propagated',
      run() {
        equal(parseModelList({ data: [{ id: '' }, {}, null, { id: 'ok' }] }), [{ id: 'ok' }])
        equal(parseModelList({ data: [{ id: 'bad-limit', limit: { context: 'nope' } }] }), [{ id: 'bad-limit' }])
        equal(parseModelList({ data: [{ id: 'bad-modalities', modalities: { input: 'text' } }] }), [{ id: 'bad-modalities' }])
        equal(parseModelList(null), [])
        equal(parseModelList({ data: 'nope' }), [])
        // The enriched `{models: {...}}` map some gateways publish is accepted too.
        equal(parseModelList({ models: { mapped: { name: 'Mapped' } } }), [{ id: 'mapped', name: 'Mapped' }])
      },
    },
    {
      name: 'MIME modalities become the catalogue vocabulary this package shares',
      run() {
        equal(
          harnessModalities(['text', 'image/jpeg', 'application/pdf', 'video/mp4', 'audio/mpeg']),
          ['text', 'image', 'video', 'audio', 'pdf'],
        )
        equal(harnessModalities(['image/png']), ['text', 'image'])
        is(harnessModalities([]), undefined)
        is(harnessModalities(undefined), undefined)
      },
    },
    {
      name: 'a row for an id the table cannot name brings its own capacity and ladder',
      run() {
        const record = discoveryRecord({
          id: 'brand-new-model',
          limit: { context: 123_456, output: 7_890 },
          modalities: ['text', 'image/jpeg'],
          reasoning: { supported: true, efforts: ['low', 'high'] },
          api: ['messages'],
        }, resolveConfig({}), undefined)
        is(record.contextWindow, 123_456)
        is(record.maxTokens, 7_890)
        equal([...record.providerModalities], ['text', 'image'])
        equal([...record.reasoningEfforts], ['low', 'high'])
        is(record.reasoning, true)
        is(record.capacitySource, 'GET /models')
        equal([...record.protocols], [PROTOCOLS.ANTHROPIC, PROTOCOLS.RESPONSES, PROTOCOLS.CHAT])
        is(record.source, 'discovered')
      },
    },
    {
      name: 'a row refines the built-in record instead of replacing it',
      run() {
        const config = resolveConfig({})
        const base = buildCatalog(config, []).get('gpt-5.6-luna')
        const refined = discoveryRecord({
          id: 'gpt-5.6-luna',
          name: 'Luna (live)',
          limit: { context: 999_999, output: 1_000 },
          modalities: ['text', 'application/pdf'],
          reasoning: { supported: true, efforts: ['low', 'max'] },
          // The catalogue prefers another entry than the table did; the table's
          // measured preference stays first and the entry joins the list.
          api: ['chat-completions'],
        }, config, base)
        is(refined.contextWindow, 999_999)
        is(refined.maxTokens, 1_000)
        is(refined.name, 'Luna (live)')
        equal([...refined.providerModalities], ['text', 'pdf'])
        equal([...refined.reasoningEfforts], ['low', 'max'])
        equal([...refined.protocols], [PROTOCOLS.RESPONSES, PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC])
        is(preferredProtocol(refined), PROTOCOLS.RESPONSES)
        // Facts only the fallback table knows survive the merge.
        is(refined.trainingConsent, base.trainingConsent)
        is(refined.requiresReasoningReplay, base.requiresReasoningReplay)
        is(refined.tier, base.tier)
      },
    },
    {
      name: 'discovery refines the catalog and a config entry still wins the name',
      run() {
        const config = resolveConfig({ models: [{ id: 'gpt-5.6-luna', name: 'Configured Luna' }] })
        const records = buildCatalog(config, [{
          id: 'gpt-5.6-luna',
          name: 'Live Luna',
          limit: { context: 111_111, output: 222 },
        }])
        const record = records.get('gpt-5.6-luna')
        is(record.name, 'Configured Luna')
        // A name-only config entry does not throw away the live capacity.
        is(record.contextWindow, 111_111)
        is(record.maxTokens, 222)
        is(record.capacitySource, 'GET /models')
      },
    },
    {
      name: 'a version 1 row states no facts, so the fallback table still answers',
      run() {
        const config = resolveConfig({})
        const record = buildCatalog(config, [{ id: 'gpt-5.6-luna', name: 'Legacy Name' }]).get('gpt-5.6-luna')
        is(record.name, 'Legacy Name')
        is(record.contextWindow, 1_050_000)
        is(record.maxTokens, 128_000)
        equal([...record.protocols], [PROTOCOLS.RESPONSES, PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC])
        is(record.source, 'discovered')
      },
    },
    {
      name: 'an id with no row anywhere uses its family’s measured figures',
      run() {
        const record = buildCatalog(resolveConfig({}), [{ id: 'qwen3.9-unreleased' }]).get('qwen3.9-unreleased')
        is(record.contextWindow, 1_000_000)
        is(record.maxTokens, 131_072)
        ok(String(record.capacitySource).includes('family:qwen'), `the source names the family: ${record.capacitySource}`)
        equal([...record.protocols], [PROTOCOLS.CHAT, PROTOCOLS.RESPONSES, PROTOCOLS.ANTHROPIC])
      },
    },
    {
      name: 'the cache file keeps the rich rows it fetched',
      async run() {
        const path = scratch.path('models')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: path,
        })
        const fetch = modelsFetch({
          object: 'list',
          data: [
            {
              id: 'one',
              name: 'One',
              limit: { context: 10, output: 2 },
              modalities: { input: ['text', 'image/png'] },
              capabilities: { reasoning: { supported: true, effort: ['low'] } },
              api: { responses: { base_url: 'https://relay.test/openai/v1' } },
            },
            { id: 'two' },
          ],
        })
        const cache = new ModelCache(config, {
          authHeaders: async () => ({ authorization: 'Bearer test' }),
          logger: silent,
          fetch,
        })
        const rows = await cache.discover()
        is(rows.length, 2)
        is(fetch.requests.length, 1)
        const file = JSON.parse(await readFile(path, 'utf8'))
        is(file.version, 2)
        is(file.rows.length, 2)
        equal(file.rows, rows)
        // A later process reads the file it wrote, not the service: the rows must
        // survive that round trip with their rich facts intact. They come back
        // marked as restored from disk, because this process did not fetch them.
        const reloaded = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger: silent,
          fetch: async () => {
            throw new Error('a fresh cache file must not be re-fetched')
          },
        })
        const reloadedRows = await reloaded.discover()
        equal(reloadedRows.map((row) => {
          const { fromDisk, ...rest } = row
          return rest
        }), rows)
        ok(reloadedRows.every((row) => row.fromDisk === true), 'every restored row says so')
      },
    },
    {
      name: 'a version 1 cache file still loads, without a network request',
      async run() {
        const path = scratch.path('models')
        await writeFile(path, JSON.stringify({
          version: 1,
          baseURL: 'https://relay.test/v1',
          fetchedAt: Date.now(),
          ids: [{ id: 'legacy-model', name: 'Legacy Model' }],
        }), 'utf8')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: path,
        })
        const cache = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger: silent,
          fetch: async () => {
            throw new Error('a fresh version 1 cache must not be re-fetched')
          },
        })
        const rows = await cache.discover()
        // The provenance marker is what keeps such a row from reviving a
        // retired model; it is not a service fact and is never written back.
        equal(rows, [{ id: 'legacy-model', name: 'Legacy Model', fromDisk: true }])
      },
    },
    {
      name: 'a version 1 cache row cannot revive a retired model',
      async run() {
        const path = scratch.path('models')
        await writeFile(path, JSON.stringify({
          version: 1,
          baseURL: 'https://relay.test/v1',
          fetchedAt: Date.now(),
          ids: [{ id: 'deepseek-v4-flash' }],
        }), 'utf8')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: path,
        })
        const cache = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger: silent,
          fetch: async () => {
            throw new Error('a fresh version 1 cache must not be re-fetched')
          },
        })
        const record = buildCatalog(config, await cache.discover()).get('deepseek-v4-flash')
        is(record.retired, true)
        is(hiddenReason(record, config), 'retired')
        // A live row — one the service answers with today — does revive it.
        const live = buildCatalog(config, [{ id: 'deepseek-v4-flash', limit: { context: 1_000_000, output: 384_000 } }])
          .get('deepseek-v4-flash')
        is(live.retired, false)
      },
    },
    {
      name: 'a cache file written for another endpoint is fetched instead of served',
      async run() {
        // Both on-disk shapes name their endpoint, and a file is only an answer
        // for the endpoint that wrote it: serving another gateway's rows would
        // answer discovery with models this route may not serve, without a request.
        for (const shape of [
          { version: 1, ids: [{ id: 'old-gateway-model' }] },
          { version: 2, rows: [{ id: 'old-gateway-model' }] },
        ]) {
          const path = scratch.path(`models-v${shape.version}`)
          await writeFile(path, JSON.stringify({
            ...shape,
            baseURL: 'https://old-gateway.test/v1',
            fetchedAt: Date.now(),
          }), 'utf8')
          const config = resolveConfig({
            baseURL: 'https://relay.test/v1',
            apiKeyEnv: 'TEST_KEY',
            modelsCachePath: path,
          })
          const fetch = modelsFetch({ data: [{ id: 'this-gateway-model' }] })
          const cache = new ModelCache(config, {
            authHeaders: async () => ({}),
            logger: silent,
            fetch,
          })
          const rows = await cache.discover()
          equal(rows.map((row) => row.id), ['this-gateway-model'], `a version ${shape.version} file for another endpoint is not served`)
          is(fetch.requests.length, 1, `a version ${shape.version} file for another endpoint is fetched exactly once`)
          // The file is replaced with this endpoint's answer, not left behind.
          const file = JSON.parse(await readFile(path, 'utf8'))
          is(file.baseURL, config.baseURL, `the version ${shape.version} file now belongs to this endpoint`)
          equal(file.rows.map((row) => row.id), ['this-gateway-model'])
        }
      },
    },
    {
      name: 'another endpoint’s cache is not a fallback when this endpoint is unreachable',
      async run() {
        const path = scratch.path('models')
        await writeFile(path, JSON.stringify({
          version: 2,
          baseURL: 'https://old-gateway.test/v1',
          fetchedAt: Date.now(),
          rows: [{ id: 'old-gateway-model' }],
        }), 'utf8')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: path,
        })
        let requests = 0
        const cache = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger: silent,
          fetch: async () => {
            requests += 1
            throw new Error('the endpoint is unreachable')
          },
        })
        // A failing request is not a reason to answer with the other gateway's
        // models: discovery comes back empty and the catalog keeps its built-ins.
        equal(await cache.discover(), [])
        is(requests, 1)
      },
    },
    {
      name: 'a version 2 cache row cannot revive a retired model',
      async run() {
        const path = scratch.path('models')
        await writeFile(path, JSON.stringify({
          version: 2,
          baseURL: 'https://relay.test/v1',
          fetchedAt: Date.now(),
          rows: [{ id: 'deepseek-v4-flash', name: 'Flash' }],
        }), 'utf8')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: path,
        })
        const fetch = modelsFetch({ data: [{ id: 'deepseek-v4-flash' }] })
        const cache = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger: silent,
          fetch,
        })
        // A version 2 file states facts, but it states them for the moment it was
        // written; the built-in table may have retired the id since. A row read
        // from disk therefore keeps the retirement instead of clearing it.
        const cached = buildCatalog(config, await cache.discover()).get('deepseek-v4-flash')
        is(cached.retired, true)
        is(hiddenReason(cached, config), 'retired')
        is(fetch.requests.length, 0, 'the fresh file is still served without a request')
        // Only a row fetched in this process makes the model current again.
        const live = buildCatalog(config, await cache.fetchNow()).get('deepseek-v4-flash')
        is(live.retired, false)
        is(fetch.requests.length, 1)
      },
    },
    {
      name: 'a fresh cache file answers discovery without a request and reports its age',
      async run() {
        const fetchedAt = Date.now() - 1_000
        const path = scratch.path('models')
        await writeFile(path, JSON.stringify({
          version: 2,
          baseURL: 'https://relay.test/v1',
          fetchedAt,
          rows: [{ id: 'warm-model', name: 'Warm' }],
        }), 'utf8')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: path,
        })
        let requests = 0
        const cache = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger: silent,
          fetch: async () => {
            requests += 1
            throw new Error('a fresh cache file must not be fetched')
          },
        })
        const rows = await cache.discover()
        equal(rows.map((row) => row.id), ['warm-model'])
        is(requests, 0)
        is(cache.fetchedAt, fetchedAt)
      },
    },
    {
      name: 'a stale cache file is served while one refresh runs behind it',
      async run() {
        const path = scratch.path('models')
        await writeFile(path, JSON.stringify({
          version: 2,
          baseURL: 'https://relay.test/v1',
          fetchedAt: Date.now() - 7 * 60 * 60 * 1000,
          rows: [{ id: 'stale-model', name: 'Stale' }],
        }), 'utf8')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: path,
        })
        // One gated request, so the case observes the served answer before the
        // refresh can replace it instead of racing a timer.
        let release
        const gate = new Promise((resolve) => {
          release = resolve
        })
        let reachedFetch
        const fetchStarted = new Promise((resolve) => {
          reachedFetch = resolve
        })
        const requests = []
        const fetch = async (url) => {
          requests.push(String(url))
          reachedFetch()
          await gate
          return new Response(JSON.stringify({ data: [{ id: 'live-model' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        const cache = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger: silent,
          fetch,
        })
        const rows = await cache.discover()
        equal(rows.map((row) => row.id), ['stale-model'])
        await fetchStarted
        is(requests.length, 1)
        // The refresh is behind the answer: discovery already returned while the
        // request is still unanswered.
        is(cache.entry.rows[0].id, 'stale-model')
        release()
        await cache.refresh()
        is(cache.entry.rows[0].id, 'live-model')
        const file = JSON.parse(await readFile(path, 'utf8'))
        equal(file.rows.map((row) => row.id), ['live-model'])
        ok(file.fetchedAt > Date.now() - 60_000, 'the refreshed file carries the new fetch time')
      },
    },
    {
      name: 'an unreadable cache file is treated as a miss and fetched',
      async run() {
        const path = scratch.path('models')
        await writeFile(path, '{ this is not the cache shape', 'utf8')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: path,
        })
        const fetch = modelsFetch({ data: [{ id: 'live-model' }] })
        const cache = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger: silent,
          fetch,
        })
        const rows = await cache.discover()
        equal(rows.map((row) => row.id), ['live-model'])
        is(fetch.requests.length, 1)
        // A miss is replaced by a valid file, so the next process starts warm.
        const file = JSON.parse(await readFile(path, 'utf8'))
        is(file.version, 2)
        is(file.baseURL, config.baseURL)
        equal(file.rows.map((row) => row.id), ['live-model'])
      },
    },
    {
      name: 'concurrent discovery shares one on-disk read instead of a second request',
      async run() {
        const path = scratch.path('models')
        const diskRaw = JSON.stringify({
          version: 2,
          baseURL: 'https://relay.test/v1',
          fetchedAt: Date.now() - 1_000,
          rows: [{ id: 'disk-model', name: 'Disk' }],
        })
        await writeFile(path, diskRaw, 'utf8')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: path,
        })
        let releaseRead
        const readGate = new Promise((resolve) => {
          releaseRead = resolve
        })
        let reads = 0
        const gatedRead = async () => {
          reads += 1
          await readGate
          return diskRaw
        }
        const fetch = modelsFetch({ data: [{ id: 'live-model' }] })
        const cache = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger: silent,
          fetch,
          readFile: gatedRead,
        })
        const first = cache.discover()
        // The first read is still in flight; the second call must join it
        // instead of deciding the file is a miss and sending its own request.
        const second = cache.discover()
        is(cache.loadedFile, false, 'loaded is not decided before the read finishes')
        releaseRead()
        const [left, right] = await Promise.all([first, second])
        equal(left.map((row) => row.id), ['disk-model'])
        equal(right.map((row) => row.id), ['disk-model'], 'the second call is not a miss')
        is(fetch.requests.length, 0, 'the valid file answers both calls')
        is(reads, 1, 'the cache file is read once')
        is(cache.loadedFile, true, 'loaded is decided once the read finishes')
        is(cache.entry.rows[0].id, 'disk-model')
        is(await cache.loadFromDisk(), true)
        is(reads, 1, 'a settled load is reused, not read again')
      },
    },
    {
      name: 'a disk read that finishes late cannot replace a newer live answer',
      async run() {
        const path = scratch.path('models')
        const diskRaw = JSON.stringify({
          version: 2,
          baseURL: 'https://relay.test/v1',
          fetchedAt: Date.now(),
          rows: [{ id: 'disk-model' }],
        })
        await writeFile(path, diskRaw, 'utf8')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: path,
        })
        let releaseRead
        const readGate = new Promise((resolve) => {
          releaseRead = resolve
        })
        let reads = 0
        const gatedRead = async () => {
          reads += 1
          await readGate
          return diskRaw
        }
        const fetch = modelsFetch({ data: [{ id: 'live-model' }] })
        const cache = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger: silent,
          fetch,
          readFile: gatedRead,
        })
        const discovering = cache.discover()
        // A forced read lands while the cold start is still reading the file;
        // the live answer is newer than what that read will return.
        const live = await cache.fetchNow()
        equal(live.map((row) => row.id), ['live-model'])
        is(cache.entry.rows[0].id, 'live-model', 'the live answer is installed')
        releaseRead()
        const rows = await discovering
        equal(rows.map((row) => row.id), ['live-model'], 'discovery serves the newer answer')
        is(cache.entry.rows[0].id, 'live-model', 'the late file does not replace it')
        is(reads, 1)
        is(fetch.requests.length, 1, 'the forced read is the only request')
        const file = JSON.parse(await readFile(path, 'utf8'))
        equal(file.rows.map((row) => row.id), ['live-model'], 'the file also states the newer answer')
      },
    },
    {
      name: 'a 401 that echoes the key keeps it out of the error and the log',
      async run() {
        const canary = 'sk-canary-discovery-401-7f2a'
        const body = JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'invalid_api_key',
            message: `Incorrect API key provided: ${canary}`,
          },
          echo: `the body also carried ${canary}`,
        })
        let requests = 0
        const fetch = async () => {
          requests += 1
          return new Response(body, {
            status: 401,
            headers: { 'content-type': 'application/json' },
          })
        }
        const lines = []
        const logger = {
          info() {},
          warn(...args) {
            lines.push(args.map((arg) => String(arg)).join(' '))
          },
          debug() {},
          error() {},
        }
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: scratch.path('models'),
        })
        const cache = new ModelCache(config, {
          authHeaders: async () => ({ authorization: `Bearer ${canary}` }),
          logger,
          fetch,
        })
        // Cold discovery reports the failure through the logger and still
        // answers empty, so the caller keeps its built-in catalog.
        equal(await cache.discover(), [])
        is(requests, 1)
        // The page's forced read surfaces the same failure; neither path may
        // repeat the body the relay used to reject the key.
        const error = await rejection(cache.fetchNow())
        is(requests, 2)
        ok(!String(error.message).includes(canary), error.message)
        ok(!String(error.message).includes('Incorrect API key provided'), 'the body is not quoted in the error')
        ok(!String(error.cause?.message ?? '').includes(canary), 'the cause is not the body')
        is(error.status, 401)
        ok(String(error.message).includes('401'), error.message)
        const log = lines.join('\n')
        ok(!log.includes(canary), log)
        ok(!log.includes('Incorrect API key provided'), log)
        ok(log.includes('401'), log)
      },
    },
    {
      name: 'a malformed /models body becomes a controlled failure without its text',
      async run() {
        // The parser names only the first few characters of the text it could
        // not read, so this canary is short enough to be the part it quotes.
        const canary = 'sk-canary'
        const body = `${canary} is not JSON`
        let requests = 0
        const fetch = async () => {
          requests += 1
          // A 200 whose body is not JSON: the parser error quotes the text it
          // could not read, which is provider-controlled and may carry a key.
          return new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        const lines = []
        const logger = {
          info() {},
          warn(...args) {
            lines.push(args.map((arg) => String(arg)).join(' '))
          },
          debug() {},
          error() {},
        }
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: scratch.path('models'),
        })
        const cache = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger,
          fetch,
        })
        const error = await rejection(cache.fetchNow())
        ok(!String(error.message).includes(canary), error.message)
        ok(!String(error.message).includes('Unexpected token'), 'the parser excerpt is not repeated')
        is(error.status, 200)
        ok(String(error.message).includes('200'), error.message)
        // Cold discovery takes the same path and logs the controlled sentence.
        equal(await cache.discover(), [])
        is(requests, 2)
        const log = lines.join('\n')
        ok(!log.includes(canary), log)
        ok(!log.includes('Unexpected token'), log)
        ok(log.includes('200'), log)
      },
    },
    {
      name: 'a failed forced refresh keeps the directory it already served',
      async run() {
        const path = scratch.path('models')
        const fetchedAt = Date.now() - 1_000
        await writeFile(path, JSON.stringify({
          version: 2,
          baseURL: 'https://relay.test/v1',
          fetchedAt,
          rows: [{ id: 'disk-model' }],
        }), 'utf8')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: path,
        })
        let requests = 0
        const fetch = async () => {
          requests += 1
          return new Response('upstream is unwell', { status: 503 })
        }
        const cache = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger: silent,
          fetch,
        })
        const before = await cache.discover()
        equal(before.map((row) => row.id), ['disk-model'])
        is(cache.fetchedAt, fetchedAt)
        const error = await rejection(cache.fetchNow())
        is(requests, 1)
        ok(String(error.message).includes('503'), error.message)
        // A failed refresh is reported, but it is not a reason to drop a usable
        // directory: the served rows and the file behind them stay as they were.
        equal((await cache.discover()).map((row) => row.id), ['disk-model'])
        is(cache.fetchedAt, fetchedAt)
        const file = JSON.parse(await readFile(path, 'utf8'))
        equal(file.rows.map((row) => row.id), ['disk-model'])
        is(requests, 1, 'the surviving directory still answers without another request')
      },
    },
  ]),
}
