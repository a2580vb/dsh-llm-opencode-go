/** Configuration resolution: defaults, validation, and the User-Agent rule. */

import { readFile } from 'node:fs/promises'

import {
  Config,
  DEFAULT_BASE_URL,
  DEFAULT_RETRY_POLICY,
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

// The harness bounds every locally scheduled timer at 2^31 - 1 ms; a retry
// delay above it is a `setTimeout` overflow, so the policy has to stop here.
const MAX_DELAY_MS = 2_147_483_647

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
        is(config.usageNumberFormat, 'compact')
        is(config.showQuotaCapsule, true)
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
      name: 'freshConnectionOnLargeBody is a declared boolean, off by default',
      run: async () => {
        is(resolveConfig(undefined).freshConnectionOnLargeBody, false)
        is(resolveConfig({ freshConnectionOnLargeBody: true }).freshConnectionOnLargeBody, true)
        await rejectsWith(
          Promise.resolve().then(() => resolveConfig({ freshConnectionOnLargeBody: 'yes' })),
          'freshConnectionOnLargeBody',
        )
      },
    },
    {
      name: 'showQuotaCapsule is a declared boolean, on by default',
      run: async () => {
        is(resolveConfig(undefined).showQuotaCapsule, true)
        is(resolveConfig({ showQuotaCapsule: false }).showQuotaCapsule, false)
        await rejectsWith(
          Promise.resolve().then(() => resolveConfig({ showQuotaCapsule: 'yes' })),
          'showQuotaCapsule',
        )
        // The schema the loader calls first must object too, so activation fails
        // with the field rather than at the first page load.
        const issues = Config['~standard'].validate({ showQuotaCapsule: 'yes' }).issues
        ok(Array.isArray(issues) && issues.length > 0, 'the schema reported the field')
        ok(issues.some((issue) => String(issue.message).includes('showQuotaCapsule')), 'by name')
      },
    },
    {
      name: 'showRetiredModels is a declared boolean, on by default',
      run: async () => {
        // On by default: the history a reader already had stays visible until
        // they choose to keep it out of the list.
        is(resolveConfig(undefined).showRetiredModels, true)
        is(resolveConfig({ showRetiredModels: false }).showRetiredModels, false)
        await rejectsWith(
          Promise.resolve().then(() => resolveConfig({ showRetiredModels: 'yes' })),
          'showRetiredModels',
        )
        const issues = Config['~standard'].validate({ showRetiredModels: 'yes' }).issues
        ok(Array.isArray(issues) && issues.length > 0, 'the schema reported the field')
        ok(issues.some((issue) => String(issue.message).includes('showRetiredModels')), 'by name')
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
      name: 'an unknown session mode, model source, protocol, or number format is refused by name',
      run: async () => {
        await rejectsWith(Promise.resolve().then(() => resolveConfig({ sessionHeader: 'always' })), 'sessionHeader')
        await rejectsWith(Promise.resolve().then(() => resolveConfig({ modelSource: 'auto' })), 'modelSource')
        await rejectsWith(Promise.resolve().then(() => resolveConfig({ defaultProtocol: 'grpc' })), 'defaultProtocol')
        is(resolveConfig({ usageNumberFormat: 'full' }).usageNumberFormat, 'full')
        await rejectsWith(Promise.resolve().then(() => resolveConfig({ usageNumberFormat: 'words' })), 'usageNumberFormat')
        const issues = Config['~standard'].validate({ usageNumberFormat: 'words' }).issues
        ok(issues.some((issue) => String(issue.message).includes('usageNumberFormat')), 'the schema names the field too')
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
      name: 'a wrong container type is reported as issues, never thrown',
      run() {
        // Cordis calls the schema before any plugin code runs, so a type
        // mistake must come back as an issue naming the field: a validator
        // that throws its own TypeError aborts activation with no field named.
        const fields = ['models', 'hiddenModels', 'modelVariants', 'reasoningEfforts']
        const wrong = [true, 7, {}, { length: 1 }, 'not-a-list']
        for (const field of fields) {
          for (const value of wrong) {
            let result
            try {
              result = Config['~standard'].validate({ [field]: value })
            } catch (error) {
              throw new Error(`${field}: ${JSON.stringify(value)} made the validator throw: ${error?.message}`)
            }
            ok(Array.isArray(result.issues), `${field}: ${JSON.stringify(value)} returned issues`)
            ok(result.issues.length > 0, `${field}: ${JSON.stringify(value)} was refused`)
            ok(
              result.issues.some((issue) => String(issue.message).includes(field)),
              `${field}: the issue names the field: ${JSON.stringify(result.issues)}`,
            )

            // The schema and the resolution are the two validators a row
            // crosses, so the resolution refuses the same value by name.
            let thrown
            try {
              resolveConfig({ [field]: value })
            } catch (error) {
              thrown = error
            }
            ok(thrown !== undefined, `${field}: ${JSON.stringify(value)} did not reach the snapshot`)
            ok(String(thrown.message).includes(field), `${field}: the resolution names the field`)
          }
          is('issues' in Config['~standard'].validate({ [field]: [] }), false, `${field}: an empty list is valid`)
        }

        // The row config itself is a container too. A Date, Map, or RegExp has
        // no declared keys, so accepting one would silently resolve every
        // field to its default. Both validators name the config instead.
        for (const value of [new Date(0), new Map(), /config/, new Set()]) {
          let result
          try {
            result = Config['~standard'].validate(value)
          } catch (error) {
            throw new Error(`${String(value)} made the validator throw: ${error?.message}`)
          }
          ok(Array.isArray(result.issues) && result.issues.length > 0, `${String(value)} returned issues`)
          ok(result.issues.some((issue) => String(issue.message).includes('config')), 'the issue names the config')
          let thrown
          try {
            resolveConfig(value)
          } catch (error) {
            thrown = error
          }
          ok(thrown !== undefined, `${String(value)} did not reach the snapshot`)
        }
      },
    },
    {
      name: 'a retry policy the page refuses is refused by the schema and by resolution',
      run() {
        const rejected = [
          [{ maxRetries: 'many' }, 'maxRetries'],
          [{ maxRetries: -1 }, 'maxRetries'],
          [{ maxRetries: 21 }, 'maxRetries'],
          [{ maxRetries: 1.5 }, 'maxRetries'],
          [{ initialDelayMs: 20_000, maxDelayMs: 10_000 }, 'initialDelayMs'],
          // A partial policy is judged against the defaults it inherits, so a
          // handwritten floor above the default ceiling cannot slip through.
          [{ initialDelayMs: 20_000 }, 'initialDelayMs'],
          [{ maxDelayMs: 100 }, 'initialDelayMs'],
          [{ initialDelayMs: 0 }, 'initialDelayMs'],
          [{ maxDelayMs: 1.5 }, 'maxDelayMs'],
          // The delay ceiling is the harness's own timer bound, inclusive: one
          // millisecond over it would overflow `setTimeout` and fire at once.
          [{ maxDelayMs: MAX_DELAY_MS + 1 }, 'maxDelayMs'],
          [{ initialDelayMs: MAX_DELAY_MS + 1, maxDelayMs: MAX_DELAY_MS + 1 }, 'initialDelayMs'],
          [{ jitterRatio: 2 }, 'jitterRatio'],
          [{ jitterRatio: -0.1 }, 'jitterRatio'],
          [{ mode: 'turbo' }, 'mode'],
          // This route only exposes the bounded mode; `always` is not a value
          // the page or a hand-written row may select here.
          [{ mode: 'always' }, 'mode'],
          [{ retryableCodes: 'TRANSPORT' }, 'retryableCodes'],
          [{ retryableCodes: [''] }, 'retryableCodes'],
          [{ extra: 1 }, 'extra'],
          ['normal', 'retryPolicy'],
          [[], 'retryPolicy'],
          [new Date(0), 'retryPolicy'],
          [new Map(), 'retryPolicy'],
          [/retry/, 'retryPolicy'],
        ]
        for (const [policy, field] of rejected) {
          const result = Config['~standard'].validate({ retryPolicy: policy })
          ok(Array.isArray(result.issues) && result.issues.length > 0, `${JSON.stringify(policy)} was refused`)
          const text = result.issues.map((issue) => issue.message).join(' | ')
          ok(text.includes(field), `${JSON.stringify(policy)} names ${field}: ${text}`)

          let thrown
          try {
            resolveConfig({ retryPolicy: policy })
          } catch (error) {
            thrown = error
          }
          ok(thrown !== undefined, `${JSON.stringify(policy)} did not reach the snapshot`)
          ok(String(thrown.message).includes(field), `${JSON.stringify(policy)} names ${field}: ${thrown.message}`)
        }
      },
    },
    {
      name: 'a retry policy is normalized over the one default set and frozen',
      run() {
        equal(resolveConfig(undefined).retryPolicy, DEFAULT_RETRY_POLICY)
        // An absent row field and an explicit null both mean "use the
        // defaults"; only a submitted value is a policy to check.
        is('issues' in Config['~standard'].validate({ retryPolicy: null }), false, 'null is the defaults')
        equal(resolveConfig({ retryPolicy: null }).retryPolicy, DEFAULT_RETRY_POLICY)

        const codes = ['TIMEOUT']
        const config = resolveConfig({ retryPolicy: { maxRetries: 0, retryableCodes: codes } })
        equal(config.retryPolicy, {
          ...DEFAULT_RETRY_POLICY,
          maxRetries: 0,
          retryableCodes: ['TIMEOUT'],
        })
        ok(Object.isFrozen(config.retryPolicy), 'the policy is frozen')
        ok(Object.isFrozen(config.retryPolicy.retryableCodes), 'its code list is frozen too')

        // The snapshot owns its copy: a caller that later mutates the array it
        // passed in cannot change what the adapter reports.
        codes.push('SERVER')
        equal([...config.retryPolicy.retryableCodes], ['TIMEOUT'])

        for (const policy of [
          { maxRetries: 0 },
          { maxRetries: 20 },
          { jitterRatio: 0 },
          { jitterRatio: 1 },
          { initialDelayMs: 100, maxDelayMs: 100 },
          // The ceiling itself is a legal delay; the two delays may both sit on
          // it, because the cross-field rule is "not above", not "below".
          { maxDelayMs: MAX_DELAY_MS },
          { initialDelayMs: MAX_DELAY_MS, maxDelayMs: MAX_DELAY_MS },
        ]) {
          is('issues' in Config['~standard'].validate({ retryPolicy: policy }), false, `${JSON.stringify(policy)} is valid`)
          const resolved = resolveConfig({ retryPolicy: policy }).retryPolicy
          if (policy.initialDelayMs !== undefined) is(resolved.initialDelayMs, policy.initialDelayMs)
          if (policy.maxDelayMs !== undefined) is(resolved.maxDelayMs, policy.maxDelayMs)
        }

        // "Plain object" includes a null-prototype record: it has no inherited
        // members, so it is exactly the shape a lookup table hands over.
        const nullPrototype = Object.assign(Object.create(null), { maxRetries: 1 })
        is('issues' in Config['~standard'].validate({ retryPolicy: nullPrototype }), false, 'a null-prototype record is a policy')
        is(resolveConfig({ retryPolicy: nullPrototype }).retryPolicy.maxRetries, 1)
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
    {
      name: 'a stream truncated before its terminal event is retryable',
      run() {
        // A clean EOF is the same network class as a transport reset: the
        // answer was cut off, not requested wrongly. A malformed response is
        // not retried, because trying again cannot change the payload.
        ok(DEFAULT_RETRY_POLICY.retryableCodes.includes('STREAM_CLOSED'))
        ok(!DEFAULT_RETRY_POLICY.retryableCodes.includes('MALFORMED_RESPONSE'))
      },
    },
  ],
}
