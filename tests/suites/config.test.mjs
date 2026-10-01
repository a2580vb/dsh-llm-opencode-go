/** Configuration resolution: defaults, validation, and the User-Agent rule. */

import { readFile } from 'node:fs/promises'

import {
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
        is(config.healthCheck, 'off')
        ok(Object.isFrozen(config))
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
