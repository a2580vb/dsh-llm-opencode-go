/** Configuration resolution: defaults, validation, and the User-Agent rule. */

import { readFile } from 'node:fs/promises'

import {
  Config,
  DEFAULT_BASE_URL,
  PLUGIN_VERSION,
  PROTOCOLS,
  resolveConfig,
  userAgentValue,
} from '../../lib/config.js'
import { equal, is, ok, rejectsWith } from '../helpers.mjs'

// The version these cases expect comes from the manifest, so a release moves it
// in one place rather than in every assertion. `release.test.mjs` covers the
// places the manifest cannot reach by itself.
const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))

export default {
  name: 'config',
  cases: [
    {
      name: 'a bare row loads with every default',
      run() {
        const config = resolveConfig(undefined)
        is(config.provider, 'opencode-go')
        is(config.apiKeyEnv, 'OPENCODE_GO_API_KEY')
        is(config.baseURL, DEFAULT_BASE_URL)
        is(config.userAgentProduct, 'dsh-opencode-go')
        is(config.modelSource, 'discover')
        is(config.defaultProtocol, PROTOCOLS.CHAT)
        is(config.sessionHeader, 'session-id')
        is(config.sendClientHeader, true)
        is(config.hideTrainingModels, false)
        is(config.healthCheck, 'off')
        ok(Object.isFrozen(config))
      },
    },
    {
      name: 'the quota schedule\'s two intervals default, and the ceiling never falls under the floor',
      run() {
        // The page's own schedule is bounded by these, and a ceiling below the
        // floor bounds nothing: no interval satisfies both. The ceiling is the one
        // that gives way, because an answer left stale for longer than the reader
        // asked is the failure it exists to prevent, while a check costs one round
        // trip to a route on this machine.
        const bare = resolveConfig(undefined)
        is(bare.subscriptionMinIntervalSeconds, 30)
        is(bare.subscriptionMaxIntervalSeconds, 1_800)

        const configured = resolveConfig({ subscriptionMinIntervalSeconds: 10, subscriptionMaxIntervalSeconds: 120 })
        is(configured.subscriptionMinIntervalSeconds, 10)
        is(configured.subscriptionMaxIntervalSeconds, 120)

        const crossed = resolveConfig({ subscriptionMinIntervalSeconds: 600, subscriptionMaxIntervalSeconds: 30 })
        is(crossed.subscriptionMinIntervalSeconds, 600)
        is(crossed.subscriptionMaxIntervalSeconds, 600)

        // Zero is not "off" here: an interval of nothing is a poll, and a poll is
        // the thing this schedule exists to replace.
        for (const value of [0, -1, 'soon']) {
          for (const field of ['subscriptionMinIntervalSeconds', 'subscriptionMaxIntervalSeconds']) {
            let thrown
            try {
              resolveConfig({ [field]: value })
            } catch (error) {
              thrown = error
            }
            ok(thrown !== undefined, `${field}: ${String(value)} was refused`)
            ok(String(thrown?.message).includes(field), `${field} was named`)
          }
        }
      },
    },
    {
      name: 'hideTrainingModels is a declared boolean, or refused by name',
      run: async () => {
        is(resolveConfig({ hideTrainingModels: true }).hideTrainingModels, true)
        await rejectsWith(
          Promise.resolve().then(() => resolveConfig({ hideTrainingModels: 'yes' })),
          'hideTrainingModels',
        )
        // The schema the loader calls first must object too, so activation fails
        // with the field rather than at the first listing.
        const issues = Config['~standard'].validate({ hideTrainingModels: 'yes' }).issues
        ok(Array.isArray(issues) && issues.length > 0, 'the schema reported the field')
        ok(issues.some((issue) => String(issue.message).includes('hideTrainingModels')), 'by name')
      },
    },
    {
      name: 'the development guide baseURL is normalized without its trailing slash',
      run() {
        const config = resolveConfig({ baseURL: 'https://opencode.ai/zen/go/v1/' })
        is(config.baseURL, 'https://opencode.ai/zen/go/v1')
      },
    },
    {
      name: 'a baseURL with credentials, a query, or a fragment is refused',
      run: async () => {
        await rejectsWith(
          Promise.resolve().then(() => resolveConfig({ baseURL: 'https://user:pw@example.test/v1' })),
          'embedded credentials',
        )
        await rejectsWith(
          Promise.resolve().then(() => resolveConfig({ baseURL: 'https://example.test/v1?x=1' })),
          'query or fragment',
        )
      },
    },
    {
      name: 'a credential reference outside the environment-name grammar is refused',
      run: async () => {
        await rejectsWith(
          Promise.resolve().then(() => resolveConfig({ apiKeyEnv: 'sk-literal-key' })),
          'credential reference',
        )
      },
    },
    {
      name: 'an unknown session mode, model source, or protocol is refused by name',
      run: async () => {
        await rejectsWith(Promise.resolve().then(() => resolveConfig({ sessionHeader: 'always' })), 'sessionHeader')
        await rejectsWith(Promise.resolve().then(() => resolveConfig({ modelSource: 'auto' })), 'modelSource')
        await rejectsWith(Promise.resolve().then(() => resolveConfig({ defaultProtocol: 'grpc' })), 'defaultProtocol')
      },
    },
    {
      name: 'a non-positive timeout is refused rather than silently ignored',
      run: async () => {
        await rejectsWith(Promise.resolve().then(() => resolveConfig({ timeoutMs: 0 })), 'positive number')
        await rejectsWith(Promise.resolve().then(() => resolveConfig({ timeoutMs: -5 })), 'positive number')
      },
    },
    {
      name: 'reasoning efforts are de-duplicated and frozen',
      run() {
        const config = resolveConfig({ reasoningEfforts: ['low', 'low', 'max'] })
        equal([...config.reasoningEfforts], ['low', 'max'])
      },
    },
    {
      name: 'hiddenModels defaults to nothing and normalizes what it is given',
      run() {
        equal([...resolveConfig({}).hiddenModels], [])
        equal(
          [...resolveConfig({ hiddenModels: [' glm-5.3 ', 'glm-5.3', 'kimi-k3'] }).hiddenModels],
          ['glm-5.3', 'kimi-k3'],
        )
        // An id the catalog does not list is kept: the service adds models
        // without asking this plugin, and hiding one early should just work.
        equal([...resolveConfig({ hiddenModels: ['not-yet-served'] }).hiddenModels], ['not-yet-served'])
        ok(Object.isFrozen(resolveConfig({ hiddenModels: ['a'] }).hiddenModels))
      },
    },
    {
      name: 'a malformed hiddenModels list is refused by name, in both validators',
      run: async () => {
        for (const value of ['glm-5.3', ['glm-5.3', ''], [null], [{ id: 'glm-5.3' }]]) {
          await rejectsWith(
            Promise.resolve().then(() => resolveConfig({ hiddenModels: value })),
            'hiddenModels',
          )
        }
        const issues = Config['~standard'].validate({ hiddenModels: ['glm-5.3', 7] }).issues
        ok(Array.isArray(issues) && issues.length > 0, 'the schema objected too')
        ok(issues.some((issue) => String(issue.message).includes('hiddenModels')), 'by name')
      },
    },
    {
      name: 'modelVariants defaults to nothing and normalizes each entry',
      run() {
        equal([...resolveConfig({}).modelVariants], [])
        const config = resolveConfig({
          modelVariants: [
            {
              model: ' glm-5.3 ',
              name: ' fast ',
              label: ' GLM 5.3 Turbo ',
              protocol: 'messages',
              effort: 'low',
              contextWindow: 200_000,
              maxTokens: 32_768,
            },
          ],
        })
        equal(config.modelVariants, [{
          model: 'glm-5.3',
          name: 'fast',
          label: 'GLM 5.3 Turbo',
          protocol: 'anthropic',
          effort: 'low',
          contextWindow: 200_000,
          maxTokens: 32_768,
        }])
        ok(Object.isFrozen(config.modelVariants))
        ok(Object.isFrozen(config.modelVariants[0]))
        // Options an entry does not state are absent, not undefined: the
        // variant inherits them, and a present `undefined` would read as a
        // decision to clear them.
        equal(Object.keys(resolveConfig({ modelVariants: [{ model: 'a', name: 'b' }] }).modelVariants[0]), ['model', 'name'])
      },
    },
    {
      name: 'a variant name has to be usable as part of a model id',
      run: async () => {
        for (const name of ['the fast one', 'fast/slow', '@fast', '', 'x'.repeat(1) + '!']) {
          await rejectsWith(
            Promise.resolve().then(() => resolveConfig({ modelVariants: [{ model: 'glm-5.3', name }] })),
            'name',
          )
        }
        for (const model of ['glm 5.3', 'glm-5.3@fast', '']) {
          await rejectsWith(
            Promise.resolve().then(() => resolveConfig({ modelVariants: [{ model, name: 'fast' }] })),
            'model',
          )
        }
      },
    },
    {
      name: 'a duplicated variant id and a wrong protocol or cap are refused by name',
      run: async () => {
        await rejectsWith(
          Promise.resolve().then(() => resolveConfig({
            modelVariants: [{ model: 'glm-5.3', name: 'fast' }, { model: 'glm-5.3', name: 'fast', effort: 'low' }],
          })),
          'glm-5.3@fast',
        )
        await rejectsWith(
          Promise.resolve().then(() => resolveConfig({
            modelVariants: [{ model: 'glm-5.3', name: 'fast', protocol: 'carrier-pigeon' }],
          })),
          'glm-5.3@fast',
        )
        for (const field of ['contextWindow', 'maxTokens']) {
          await rejectsWith(
            Promise.resolve().then(() => resolveConfig({
              modelVariants: [{ model: 'glm-5.3', name: 'fast', [field]: -1 }],
            })),
            field,
          )
        }
      },
    },
    {
      name: 'the schema refuses the variant shapes resolveConfig refuses',
      run() {
        for (const value of ['glm-5.3', [null], [{ model: 'glm-5.3' }], [{ name: 'fast' }]]) {
          const issues = Config['~standard'].validate({ modelVariants: value }).issues
          ok(Array.isArray(issues) && issues.length > 0, `${JSON.stringify(value)} must be refused`)
          ok(issues.some((issue) => String(issue.message).includes('modelVariants')), 'by name')
        }
        is('issues' in Config['~standard'].validate({ modelVariants: [{ model: 'glm-5.3', name: 'fast' }] }), false)
      },
    },
    {
      name: 'the User-Agent leads with the plugin identity',
      run() {
        const config = resolveConfig({})
        is(userAgentValue(config), `dsh-opencode-go/${version}`)
      },
    },
    {
      name: 'a configured attribution appends the harness identity instead of replacing it',
      run() {
        const config = resolveConfig({ attribution: 'deepseek-harness/0.2.0-rc.2' })
        is(userAgentValue(config), `dsh-opencode-go/${version} deepseek-harness/0.2.0-rc.2`)
      },
    },
    {
      name: 'a renamed product token still leads the User-Agent',
      run() {
        const config = resolveConfig({ userAgentProduct: 'acme-client' })
        is(userAgentValue(config), `acme-client/${version}`)
      },
    },
    {
      name: 'a product token that would break the header syntax is refused',
      run: async () => {
        await rejectsWith(
          Promise.resolve().then(() => resolveConfig({ userAgentProduct: 'bad token' })),
          'product token',
        )
      },
    },
    {
      name: 'the User-Agent is resolved once on the snapshot',
      run() {
        const config = resolveConfig({ attribution: 'deepseek-harness/0.2.0' })
        is(config.userAgent, `dsh-opencode-go/${version} deepseek-harness/0.2.0`)
        is(config.userAgent, userAgentValue(config), 'the snapshot and the helper agree')
      },
    },
    {
      name: 'an attribution that is not a product token is refused',
      run: async () => {
        await rejectsWith(
          Promise.resolve().then(() => resolveConfig({ attribution: 'two words' })),
          'product token',
        )
      },
    },
    {
      name: 'the reported version matches package.json',
      run() {
        is(PLUGIN_VERSION, version, 'PLUGIN_VERSION drifted from the manifest')
      },
    },
  ],
}
