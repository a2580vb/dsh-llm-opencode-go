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
  preferredProtocol,
} from '../../lib/model/catalog.js'
import { equal, is, ok } from '../helpers.mjs'
import { createScratch } from './_scratch.mjs'

const scratch = createScratch()

/** A silent logger, so the cache client's own lines do not reach the test output. */
const silent = { info() {}, warn() {}, debug() {}, error() {} }

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
        // survive that round trip with their rich facts intact.
        const reloaded = new ModelCache(config, {
          authHeaders: async () => ({}),
          logger: silent,
          fetch: async () => {
            throw new Error('a fresh cache file must not be re-fetched')
          },
        })
        equal(await reloaded.discover(), rows)
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
        equal(await cache.discover(), [{ id: 'legacy-model', name: 'Legacy Model' }])
      },
    },
  ]),
}
