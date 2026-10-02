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
      name: 'the User-Agent leads with the plugin identity',
      run() {
        const config = resolveConfig({})
        is(userAgentValue(config), 'dsh-opencode-go/0.1.0')
      },
    },
    {
      name: 'a configured attribution appends the harness identity instead of replacing it',
      run() {
        const config = resolveConfig({ attribution: 'deepseek-harness/0.2.0-rc.2' })
        is(userAgentValue(config), 'dsh-opencode-go/0.1.0 deepseek-harness/0.2.0-rc.2')
      },
    },
    {
      name: 'a renamed product token still leads the User-Agent',
      run() {
        const config = resolveConfig({ userAgentProduct: 'acme-client' })
        is(userAgentValue(config), 'acme-client/0.1.0')
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
        is(config.userAgent, 'dsh-opencode-go/0.1.0 deepseek-harness/0.2.0')
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
      async run() {
        const manifest = JSON.parse(
          await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
        )
        is(PLUGIN_VERSION, manifest.version, 'PLUGIN_VERSION drifted from the manifest')
      },
    },
  ],
}
