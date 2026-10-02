/**
 * Host suite for the configuration bridge: the HTTP surface the plugin's own
 * page in the Harness web client talks to.
 *
 * Every case drives the real handler the way a browser would, through the fakes
 * in `_bridge-harness.mjs`. What is checked here is the contract the page
 * depends on — routing, the request fence, validation, and which layer a write
 * lands in — not the rendering, which only a browser can show.
 */

import {
  MANAGED_CONFIG_FIELDS,
  UI_ROUTES,
  UI_ROUTE_PREFIX,
  findEntry,
  nextOverride,
  validateApiKey,
  validateFieldValue,
} from '../../lib/ui/bridge.js'
import { fenceRejection, isLoopbackHostname } from '../../lib/ui/http.js'
import {
  bridgeUnderTest,
  call,
  fakeCredentials,
  fakeEditor,
  fakeSnapshot,
  local,
} from './_bridge-harness.mjs'
import { equal, includes, is, ok } from '../helpers.mjs'

export default {
  name: 'ui bridge',
  cases: [
    {
      name: 'the route prefix and endpoints are one flat namespace',
      run() {
        is(UI_ROUTE_PREFIX, '/opencode-go')
        is(UI_ROUTES.state, '/opencode-go/state')
        is(UI_ROUTES.models, '/opencode-go/models')
        is(UI_ROUTES.refresh, '/opencode-go/refresh')
        is(UI_ROUTES.config, '/opencode-go/config')
        is(UI_ROUTES.credential, '/opencode-go/credential')
        equal([...MANAGED_CONFIG_FIELDS], ['apiKeyEnv', 'hiddenModels', 'modelVariants'])
      },
    },
    {
      name: 'GET state reports the route, the credential, and the catalog',
      async run() {
        const { instance } = bridgeUnderTest({
          config: {
            provider: 'opencode-go',
            apiKeyEnv: 'OC_KEY',
            baseURL: 'https://relay.test/v1',
            hiddenModels: ['space-bunny-free'],
          },
          credentials: fakeCredentials({ OC_KEY: 'sk-stored' }),
        })
        const res = await call(instance, local())
        is(res.captured.statusCode, 200)
        is(res.captured.headers['content-type'], 'application/json; charset=utf-8')
        is(res.captured.headers['cache-control'], 'no-store')
        is(res.json.ok, true)
        is(res.json.route.provider, 'opencode-go')
        is(res.json.route.apiKeyEnv, 'OC_KEY')
        is(res.json.route.baseURL, 'https://relay.test/v1')
        is(res.json.credential.configured, true)
        is(res.json.credential.writable, true)
        is(res.json.catalog.counts.total, 3)
        is(res.json.catalog.counts.listed, 2)
        is(res.json.catalog.counts.variants, 1)
        is(res.json.config.editable, true)
        is(res.json.config.entry.id, 'opencode-go')
        equal(res.json.config.fields, ['apiKeyEnv', 'hiddenModels', 'modelVariants'])
        is(res.json.config.values.apiKeyEnv, 'OC_KEY')
        equal(res.json.config.values.hiddenModels, ['space-bunny-free'])
      },
    },
    {
      name: 'GET models reports every model with the reason it is hidden',
      async run() {
        const { instance } = bridgeUnderTest()
        const res = await call(instance, local({ url: UI_ROUTES.models }))
        is(res.captured.statusCode, 200)
        is(res.json.ok, true)
        is(res.json.models.length, 3)
        equal(res.json.hidden, ['space-bunny-free'])
        const hidden = res.json.models.find((model) => model.id === 'space-bunny-free')
        is(hidden.hidden, true)
        is(hidden.hiddenReason, 'configured')
        const listed = res.json.models.find((model) => model.id === 'glm-5.3')
        is(listed.hidden, false)
        is(listed.hiddenReason, null)
        is(listed.reasoning, true)
      },
    },
    {
      name: 'GET models reports a catalog it cannot read instead of failing',
      async run() {
        const { instance } = bridgeUnderTest({
          snapshot: async () => {
            throw new Error('catalog offline')
          },
        })
        const res = await call(instance, local({ url: UI_ROUTES.models }))
        is(res.captured.statusCode, 503)
        is(res.json.ok, false)
        is(res.json.error, 'catalog-unavailable')
        includes(res.json.message, 'catalog offline')
      },
    },
    {
      name: 'POST refresh reports what the service changed',
      async run() {
        const { instance } = bridgeUnderTest()
        const res = await call(instance, local({ method: 'POST', url: UI_ROUTES.refresh, headers: { host: '127.0.0.1:1' } }))
        is(res.captured.statusCode, 200)
        is(res.json.ok, true)
        equal(res.json.added, ['new-model'])
        equal(res.json.removed, ['gone-model'])
        is(res.json.discovered, 3)
        // The answer carries the fresh catalog, so the page renders one round
        // trip and never shows a list that disagrees with the diff beside it.
        is(res.json.catalog.counts.total, 3)
      },
    },
    {
      name: 'a refresh that cannot reach the service reports it and keeps the catalog',
      async run() {
        const { instance } = bridgeUnderTest({
          refresh: async () => {
            throw new Error('network is down')
          },
        })
        const res = await call(instance, local({ method: 'POST', url: UI_ROUTES.refresh, headers: { host: '127.0.0.1:1' } }))
        is(res.captured.statusCode, 503)
        is(res.json.error, 'discovery-failed')
        includes(res.json.message, 'network is down')
      },
    },
    {
      name: 'a discovery failure reported by the adapter keeps the catalog in the answer',
      async run() {
        const { instance } = bridgeUnderTest({
          refresh: async () => ({
            ok: false,
            reason: 'discovery-failed',
            message: 'HTTP 502 upstream',
            catalog: fakeSnapshot(),
          }),
        })
        const res = await call(instance, local({ method: 'POST', url: UI_ROUTES.refresh, headers: { host: '127.0.0.1:1' } }))
        is(res.captured.statusCode, 503)
        includes(res.json.message, 'HTTP 502')
        is(res.json.catalog.counts.total, 3)
      },
    },
    {
      name: 'a catalog built from configuration says there is nothing to fetch',
      async run() {
        const { instance } = bridgeUnderTest({
          config: { modelSource: 'config', models: [{ id: 'only-model' }] },
          refresh: async () => ({ ok: false, reason: 'not-discovering', catalog: fakeSnapshot() }),
        })
        const res = await call(instance, local({ method: 'POST', url: UI_ROUTES.refresh, headers: { host: '127.0.0.1:1' } }))
        is(res.captured.statusCode, 409)
        is(res.json.error, 'not-discovering')
        is(res.json.catalog.counts.total, 3)
      },
    },
    {
      name: 'the refresh endpoint answers only POST',
      async run() {
        const { instance } = bridgeUnderTest()
        const res = await call(instance, local({ url: UI_ROUTES.refresh }))
        is(res.captured.statusCode, 405)
        is(res.captured.headers.allow, 'POST')
      },
    },
    {
      name: 'a deployment without a refresh path says so instead of failing',
      async run() {
        const { instance } = bridgeUnderTest({ refresh: undefined })
        const res = await call(instance, local({ method: 'POST', url: UI_ROUTES.refresh, headers: { host: '127.0.0.1:1' } }))
        is(res.captured.statusCode, 503)
        is(res.json.error, 'discovery-failed')
      },
    },
    {
      name: 'the state catalog summary is a summary, not the model list',
      async run() {
        const { instance } = bridgeUnderTest()
        const res = await call(instance, local())
        is(res.json.catalog.models, undefined)
        equal(res.json.catalog.counts, { total: 3, listed: 2, hidden: 1, hiddenByTraining: 0, variants: 1 })
        is(res.json.catalog.source, 'discover')
        is(res.json.catalog.fetchedAt, 1_700_000_000_000)
      },
    },
    {
      name: 'state never carries the stored key, only its presence',
      async run() {
        const secret = 'sk-do-not-echo-this'
        const { instance } = bridgeUnderTest({ credentials: fakeCredentials({ OPENCODE_GO_API_KEY: secret }) })
        const res = await call(instance, local())
        ok(!JSON.stringify(res.json).includes(secret), 'the payload must not contain the key')
        is(res.json.credential.configured, true)
        is(res.json.config.values.apiKeyEnv, 'OPENCODE_GO_API_KEY')
      },
    },
    {
      name: 'state reports a credential store and editor this deployment lacks',
      async run() {
        const { instance } = bridgeUnderTest({ credentials: undefined, configEditor: undefined })
        const res = await call(instance, local())
        is(res.json.credential, null)
        is(res.json.config.editable, false)
        is(res.json.config.reason, 'no-config-editor')
      },
    },
    {
      name: 'state reports the profile override of each managed field',
      async run() {
        const { instance } = bridgeUnderTest({ configEditor: fakeEditor({ override: { apiKeyEnv: 'OC_HOME_KEY' } }) })
        const res = await call(instance, local())
        equal(res.json.config.override, { apiKeyEnv: 'OC_HOME_KEY' })
      },
    },
    {
      name: 'state survives a catalog that cannot be read',
      async run() {
        const { instance } = bridgeUnderTest({
          snapshot: async () => {
            throw new Error('catalog blew up')
          },
        })
        const res = await call(instance, local())
        is(res.captured.statusCode, 200)
        is(res.json.catalog.error, 'catalog blew up')
        is(res.json.credential.configured, false)
      },
    },
    {
      name: 'the request fence refuses a non-loopback authority',
      async run() {
        const { instance } = bridgeUnderTest()
        const res = await call(instance, { headers: { host: 'evil.example:19387' } })
        is(res.captured.statusCode, 403)
        is(res.captured.body, undefined)
      },
    },
    {
      name: 'the request fence refuses cross-site and foreign-origin requests',
      async run() {
        const { instance } = bridgeUnderTest()
        const crossSite = await call(instance, { headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } })
        is(crossSite.captured.statusCode, 403)
        const foreign = await call(instance, { headers: { host: '127.0.0.1:1', origin: 'http://evil.example' } })
        is(foreign.captured.statusCode, 403)
        const sameOrigin = await call(instance, { headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' } })
        is(sameOrigin.captured.statusCode, 200)
      },
    },
    {
      name: 'a mounted connection service owns the policy, fence and all',
      async run() {
        const asked = []
        const connection = {
          requestRejection(req) {
            asked.push(req.url)
            return 401
          },
        }
        const { instance } = bridgeUnderTest({ connection })
        const res = await call(instance, local())
        is(res.captured.statusCode, 401)
        is(res.captured.body, undefined)
        equal(asked, [UI_ROUTES.state])
      },
    },
    {
      name: 'the loopback predicate matches the harness rule',
      run() {
        is(isLoopbackHostname('localhost'), true)
        is(isLoopbackHostname('127.0.0.1'), true)
        is(isLoopbackHostname('127.255.0.9'), true)
        is(isLoopbackHostname('[::1]'), true)
        is(isLoopbackHostname('10.0.0.1'), false)
        is(isLoopbackHostname('127.0.0'), false)
        is(isLoopbackHostname('localhost.evil.example'), false)
      },
    },
    {
      name: 'an authority-less or malformed target is refused rather than judged',
      run() {
        is(fenceRejection({ headers: {} }), 403)
        is(fenceRejection({ headers: { host: 'nonsense host' } }), 403)
      },
    },
    {
      name: 'POST config writes only the managed fields',
      async run() {
        const editor = fakeEditor({ inherited: { provider: 'opencode-go', baseURL: 'https://default.test/v1' } })
        const { instance } = bridgeUnderTest({ configEditor: editor })
        const res = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
          body: { set: { apiKeyEnv: 'OC_OTHER_KEY' } },
        }))
        is(res.captured.statusCode, 200)
        equal(editor.writes, [{ apiKeyEnv: 'OC_OTHER_KEY' }])
        equal(res.json.config.override, { apiKeyEnv: 'OC_OTHER_KEY' })
        is(res.json.config.values.apiKeyEnv, 'OPENCODE_GO_API_KEY')
      },
    },
    {
      name: 'POST config writes the hidden set as one array',
      async run() {
        const editor = fakeEditor({ inherited: { provider: 'opencode-go' } })
        const { instance } = bridgeUnderTest({ configEditor: editor })
        const res = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: { set: { hiddenModels: ['glm-5.3', 'space-bunny-free'] } },
        }))
        is(res.captured.statusCode, 200)
        equal(editor.writes, [{ hiddenModels: ['glm-5.3', 'space-bunny-free'] }])
        equal(res.json.config.override.hiddenModels, ['glm-5.3', 'space-bunny-free'])
      },
    },
    {
      name: 'an empty hidden set is written, not dropped',
      async run() {
        const editor = fakeEditor({ override: { hiddenModels: ['glm-5.3'] } })
        const { instance } = bridgeUnderTest({ configEditor: editor })
        await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: { set: { hiddenModels: [] } },
        }))
        // Showing every model again is a decision, so the override says so
        // instead of falling back to the bundle layer's value.
        equal(editor.writes, [{ hiddenModels: [] }])
      },
    },
    {
      name: 'a malformed hidden set is refused by field, before the editor',
      async run() {
        const editor = fakeEditor()
        const { instance } = bridgeUnderTest({ configEditor: editor })
        for (const value of ['glm-5.3', ['glm-5.3', ''], [42], null]) {
          const res = await call(instance, local({
            method: 'POST',
            url: UI_ROUTES.config,
            headers: { host: '127.0.0.1:1' },
            body: { set: { hiddenModels: value } },
          }))
          is(res.captured.statusCode, 400, `${JSON.stringify(value)} must be refused`)
          is(res.json.error, 'invalid-field-value')
          includes(res.json.message, 'hiddenModels')
        }
        equal(editor.writes, [])
      },
    },
    {
      name: 'a credential reference that is not a name is refused early',
      async run() {
        const { instance } = bridgeUnderTest()
        const res = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: { set: { apiKeyEnv: 'not a name' } },
        }))
        is(res.captured.statusCode, 400)
        is(res.json.error, 'invalid-field-value')
        includes(res.json.message, 'apiKeyEnv')
      },
    },
    {
      name: 'GET models carries each variant beside the model it varies',
      async run() {
        const { instance } = bridgeUnderTest()
        const res = await call(instance, local({ url: UI_ROUTES.models }))
        const fast = res.json.models.find((model) => model.id === 'glm-5.3@fast')
        equal(fast.variant, { of: 'glm-5.3', name: 'fast', label: 'GLM 5.3 (fast)', offered: true })
        is(fast.defaultEffort, 'low')
        // The base model is not a variant, and the field says so rather than
        // being absent: the page distinguishes the two by value, not by `in`.
        is(res.json.models.find((model) => model.id === 'glm-5.3').variant, null)
      },
    },
    {
      name: 'the catalog carries the declared variants, including unusable ones',
      async run() {
        const declared = [{ model: 'glm-5.3', name: 'fast', protocol: 'anthropic-messages', effort: 'low' }]
        const { instance } = bridgeUnderTest({
          snapshot: async () => fakeSnapshot({
            variants: declared,
            variantsWithoutModel: ['typo-model'],
          }),
        })
        const res = await call(instance, local({ url: UI_ROUTES.models }))
        equal(res.json.variants, declared)
        equal(res.json.variantsWithoutModel, ['typo-model'])
      },
    },
    {
      name: 'POST config writes the variant list as declared',
      async run() {
        const editor = fakeEditor()
        const { instance } = bridgeUnderTest({ configEditor: editor })
        const variants = [
          { model: 'glm-5.3', name: 'fast', protocol: 'anthropic-messages', effort: 'low', maxTokens: 32_768 },
          { model: 'gpt-5.6-luna', name: 'deep', label: 'Luna (deep)', effort: 'max' },
        ]
        const res = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: { set: { modelVariants: variants } },
        }))
        is(res.captured.statusCode, 200)
        equal(editor.writes, [{ modelVariants: variants }])
      },
    },
    {
      name: 'a malformed variant list is refused by field, before the editor',
      async run() {
        const editor = fakeEditor()
        const { instance } = bridgeUnderTest({ configEditor: editor })
        const rejected = {
          'not an array': { model: 'glm-5.3', name: 'fast' },
          'no model': [{ name: 'fast' }],
          'no name': [{ model: 'glm-5.3' }],
          'a nested variant': [{ model: 'glm-5.3@fast', name: 'faster' }],
          'a model with whitespace': [{ model: 'glm 5.3', name: 'fast' }],
          'a name that is not an id': [{ model: 'glm-5.3', name: 'the fast one' }],
          'an unknown protocol': [{ model: 'glm-5.3', name: 'fast', protocol: 'grpc' }],
          'a zero cap': [{ model: 'glm-5.3', name: 'fast', maxTokens: 0 }],
          'a duplicated id': [{ model: 'glm-5.3', name: 'fast' }, { model: 'glm-5.3', name: 'fast' }],
        }
        for (const [label, value] of Object.entries(rejected)) {
          const res = await call(instance, local({
            method: 'POST',
            url: UI_ROUTES.config,
            headers: { host: '127.0.0.1:1' },
            body: { set: { modelVariants: value } },
          }))
          is(res.captured.statusCode, 400, `${label} must be refused`)
          is(res.json.error, 'invalid-field-value')
          includes(res.json.message, 'modelVariants')
        }
        equal(editor.writes, [])
      },
    },
    {
      name: 'the variant validator accepts what the config schema accepts',
      run() {
        is(validateFieldValue('modelVariants', []), undefined)
        is(validateFieldValue('modelVariants', [{ model: 'glm-5.3', name: 'fast' }]), undefined)
        is(
          validateFieldValue('modelVariants', [{
            model: 'glm-5.3',
            name: 'fast',
            label: 'GLM 5.3 (fast)',
            protocol: 'anthropic',
            effort: 'low',
            contextWindow: 200_000,
            maxTokens: 32_768,
          }]),
          undefined,
        )
      },
    },
    {
      name: 'the field validator names each shape it accepts',
      run() {
        is(validateFieldValue('apiKeyEnv', 'OC_KEY'), undefined)
        is(validateFieldValue('apiKeyEnv', 'OC-KEY'), 'apiKeyEnv must be a credential reference such as OPENCODE_GO_API_KEY')
        is(validateFieldValue('hiddenModels', []), undefined)
        is(validateFieldValue('hiddenModels', ['a']), undefined)
        is(validateFieldValue('hiddenModels', 'a'), 'hiddenModels must be an array of model ids')
        is(validateFieldValue('hiddenModels', ['']), 'every hiddenModels entry must be a non-empty model id')
        is(validateFieldValue('somethingElse', 'anything'), undefined)
      },
    },
    {
      name: 'a hand-written override survives a managed write',
      async run() {
        const editor = fakeEditor({
          inherited: { provider: 'opencode-go', baseURL: 'https://default.test/v1', hideTrainingModels: false },
          override: { baseURL: 'https://gateway.test/v1', hideTrainingModels: true },
        })
        const { instance } = bridgeUnderTest({ configEditor: editor })
        await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: { set: { apiKeyEnv: 'OC_KEY' } },
        }))
        equal(editor.writes[0], {
          baseURL: 'https://gateway.test/v1',
          hideTrainingModels: true,
          apiKeyEnv: 'OC_KEY',
        })
      },
    },
    {
      name: 'a managed write drops a field a parent layer already supplies',
      async run() {
        const editor = fakeEditor({
          inherited: { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
          override: { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
        })
        const { instance } = bridgeUnderTest({ configEditor: editor })
        await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: {},
        }))
        equal(editor.writes, [{}])
      },
    },
    {
      name: 'unset hands a field back to its parent layer',
      async run() {
        const editor = fakeEditor({ override: { apiKeyEnv: 'OC_KEY' } })
        const { instance } = bridgeUnderTest({ configEditor: editor })
        await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: { unset: ['apiKeyEnv'] },
        }))
        equal(editor.writes, [{}])
      },
    },
    {
      name: 'a field this page does not manage is refused by name',
      async run() {
        const editor = fakeEditor()
        const { instance } = bridgeUnderTest({ configEditor: editor })
        const res = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: { set: { retryPolicy: { maxRetries: 9 } } },
        }))
        is(res.captured.statusCode, 400)
        is(res.json.error, 'field-not-editable')
        includes(res.json.message, 'retryPolicy')
        equal(editor.writes, [])
      },
    },
    {
      name: 'a deployment without a config editor says so instead of failing',
      async run() {
        const { instance } = bridgeUnderTest({ configEditor: undefined })
        const res = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: { set: { apiKeyEnv: 'OC_KEY' } },
        }))
        is(res.captured.statusCode, 503)
        is(res.json.error, 'no-config-editor')
      },
    },
    {
      name: 'a row the editor cannot address is reported, not guessed at',
      async run() {
        const { instance } = bridgeUnderTest({ configEditor: { entries: () => [], edit: async () => {} } })
        const res = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: { set: { apiKeyEnv: 'OC_KEY' } },
        }))
        is(res.captured.statusCode, 409)
        is(res.json.error, 'entry-not-found')
      },
    },
    {
      name: 'a refused editor write is reported with its own reason',
      async run() {
        const editor = {
          entries: () => [{ id: 'opencode-go', name: 'dsh-opencode-go' }],
          async edit() {
            throw new Error('settings/conflict')
          },
        }
        const { instance } = bridgeUnderTest({ configEditor: editor })
        const res = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: { set: { apiKeyEnv: 'OC_KEY' } },
        }))
        is(res.captured.statusCode, 409)
        is(res.json.error, 'config-write-failed')
        includes(res.json.message, 'settings/conflict')
      },
    },
    {
      name: 'POST credential stores the key and answers with its status only',
      async run() {
        const credentials = fakeCredentials()
        const { instance } = bridgeUnderTest({ credentials })
        const secret = 'sk-page-written'
        const res = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.credential,
          headers: { host: '127.0.0.1:1' },
          body: { value: secret },
        }))
        is(res.captured.statusCode, 200)
        is(credentials.stored.get('OPENCODE_GO_API_KEY'), secret)
        is(res.json.credential.configured, true)
        ok(!JSON.stringify(res.json).includes(secret), 'the answer must not echo the key')
      },
    },
    {
      name: 'the key is stored under the configured reference',
      async run() {
        const credentials = fakeCredentials()
        const { instance } = bridgeUnderTest({ credentials, config: { apiKeyEnv: 'OC_TEAM_KEY' } })
        await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.credential,
          headers: { host: '127.0.0.1:1' },
          body: { value: 'sk-team' },
        }))
        is(credentials.stored.get('OC_TEAM_KEY'), 'sk-team')
        is(credentials.stored.has('OPENCODE_GO_API_KEY'), false)
      },
    },
    {
      name: 'DELETE credential clears the stored key',
      async run() {
        const credentials = fakeCredentials({ OPENCODE_GO_API_KEY: 'sk-old' })
        const { instance } = bridgeUnderTest({ credentials })
        const res = await call(instance, local({ method: 'DELETE', url: UI_ROUTES.credential }))
        is(res.captured.statusCode, 200)
        is(credentials.stored.has('OPENCODE_GO_API_KEY'), false)
        is(res.json.credential.configured, false)
      },
    },
    {
      name: 'an unusable key is refused before the store sees it',
      async run() {
        const credentials = fakeCredentials()
        const { instance } = bridgeUnderTest({ credentials })
        for (const value of ['', '   ', 'OPENCODE_GO_API_KEY=sk-x', 'sk-with space', '"sk-quoted"', 'ключ', 42]) {
          const res = await call(instance, local({
            method: 'POST',
            url: UI_ROUTES.credential,
            headers: { host: '127.0.0.1:1' },
            body: { value },
          }))
          is(res.captured.statusCode, 400, `value ${JSON.stringify(value)} must be refused`)
          is(res.json.error, 'invalid-credential')
        }
        is(credentials.stored.size, 0)
      },
    },
    {
      name: 'the key validator accepts a real key and names each refusal',
      run() {
        equal(validateApiKey('  sk-live-abc  '), { ok: true, value: 'sk-live-abc' })
        is(validateApiKey('').ok, false)
        is(validateApiKey('a\nb').ok, false)
        includes(validateApiKey('DEEPSEEK_API_KEY=sk-x'), 'paste the key alone')
        includes(validateApiKey("'sk-x'"), 'without shell quotes')
      },
    },
    {
      name: 'a deployment without a credential store says so instead of failing',
      async run() {
        const { instance } = bridgeUnderTest({ credentials: undefined })
        const res = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.credential,
          headers: { host: '127.0.0.1:1' },
          body: { value: 'sk-x' },
        }))
        is(res.captured.statusCode, 503)
        is(res.json.error, 'no-credential-service')
        const cleared = await call(instance, local({ method: 'DELETE', url: UI_ROUTES.credential }))
        is(cleared.captured.statusCode, 503)
        is(cleared.json.error, 'no-credential-service')
      },
    },
    {
      name: 'a read-only credential source keeps its refusal',
      async run() {
        const credentials = {
          async describe() {
            return { configured: true, source: 'environment', writable: false }
          },
          async set() {
            throw new Error('the environment supplies this variable and cannot be overwritten')
          },
          async unset() {
            throw new Error('the environment supplies this variable and cannot be overwritten')
          },
        }
        const { instance } = bridgeUnderTest({ credentials })
        const res = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.credential,
          headers: { host: '127.0.0.1:1' },
          body: { value: 'sk-x' },
        }))
        is(res.captured.statusCode, 409)
        is(res.json.error, 'credential-write-refused')
        includes(res.json.message, 'environment')
      },
    },
    {
      name: 'each endpoint answers only its own methods',
      async run() {
        const { instance } = bridgeUnderTest()
        const onState = await call(instance, local({ method: 'POST', url: UI_ROUTES.state }))
        is(onState.captured.statusCode, 405)
        is(onState.captured.headers.allow, 'GET')
        const onConfig = await call(instance, local({ method: 'GET', url: UI_ROUTES.config }))
        is(onConfig.captured.statusCode, 405)
        is(onConfig.captured.headers.allow, 'POST')
        const onCredential = await call(instance, local({ method: 'PUT', url: UI_ROUTES.credential }))
        is(onCredential.captured.statusCode, 405)
        is(onCredential.captured.headers.allow, 'POST, DELETE')
      },
    },
    {
      name: 'an unknown path under the prefix is a 404, not a page',
      async run() {
        const { instance } = bridgeUnderTest()
        const res = await call(instance, local({ url: `${UI_ROUTE_PREFIX}/nope` }))
        is(res.captured.statusCode, 404)
        is(res.json.error, 'not-found')
      },
    },
    {
      name: 'a malformed or oversized body is reported as such',
      async run() {
        const { instance } = bridgeUnderTest()
        const bad = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: '{not json',
        }))
        is(bad.captured.statusCode, 400)
        is(bad.json.error, 'invalid-json')
        const huge = await call(instance, local({
          method: 'POST',
          url: UI_ROUTES.config,
          headers: { host: '127.0.0.1:1' },
          body: JSON.stringify({ set: { apiKeyEnv: 'x'.repeat(70 * 1024) } }),
        }))
        is(huge.captured.statusCode, 413)
        is(huge.json.error, 'body-too-large')
      },
    },
    {
      name: 'the override builder keeps what differs and drops what does not',
      run() {
        equal(
          nextOverride(
            { provider: 'opencode-go', apiKeyEnv: 'OC_HOME', retryPolicy: { maxRetries: 3 } },
            { provider: 'opencode-go', apiKeyEnv: 'OPENCODE_GO_API_KEY', retryPolicy: { maxRetries: 5 } },
          ),
          { apiKeyEnv: 'OC_HOME', retryPolicy: { maxRetries: 3 } },
        )
        equal(nextOverride({ a: [1, 2] }, { a: [1, 2] }), {})
        equal(nextOverride({ a: [1, 2] }, { a: [1, 3] }), { a: [1, 2] })
        equal(nextOverride(undefined, undefined, {}, ['b']), {})
        // A contradictory request resolves to the value: `set` is applied last.
        equal(nextOverride(undefined, undefined, { b: 1 }, ['b']), { b: 1 })
      },
    },
    {
      name: 'the entry is found by row id, then by module name',
      run() {
        const rows = [{ id: 'ui-settings', name: '@deepseek-ai/dsh-client-ui-settings' }]
        is(findEntry(rows, 'opencode-go'), undefined)
        is(findEntry([...rows, { id: 'custom-row', name: 'dsh-opencode-go' }], 'opencode-go')?.id, 'custom-row')
        is(findEntry([{ id: 'scoped', name: '@acme/dsh-opencode-go' }], 'opencode-go')?.id, 'scoped')
        is(findEntry([{ id: 'opencode-go', name: 'anything' }, { id: 'other', name: 'dsh-opencode-go' }], 'opencode-go')?.id, 'opencode-go')
      },
    },
  ],
}
