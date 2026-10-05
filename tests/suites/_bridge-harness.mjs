/**
 * Shared harness for the configuration-bridge suites.
 *
 * The bridge is driven with fake `req`/`res` objects, so the routing, the
 * fence, the validation, and the write path are exercised without a socket and
 * without a harness package. A suite that needs a different collaborator reads
 * the same builders with overrides.
 */

import { createBridge } from '../../lib/ui/bridge.js'
import { resolveConfig } from '../../lib/config.js'

/** A request stand-in with the shape the HTTP helpers read. */
export function request({ method = 'GET', url, headers = {}, body } = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  return {
    method,
    url: url ?? '/opencode-go/state',
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
}

/** A response stand-in capturing status, headers, and body. */
export function response() {
  const captured = { statusCode: 0, headers: {}, body: undefined }
  return {
    captured,
    get statusCode() {
      return captured.statusCode
    },
    set statusCode(value) {
      captured.statusCode = value
    },
    setHeader(name, value) {
      captured.headers[String(name).toLowerCase()] = value
    },
    end(body) {
      captured.body = body
    },
    get json() {
      return captured.body === undefined ? undefined : JSON.parse(captured.body)
    },
  }
}

/** A credential seam stand-in backed by a map. */
export function fakeCredentials(initial) {
  const store = new Map(initial === undefined ? [] : Object.entries(initial))
  return {
    stored: store,
    async resolve(ref) {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'store' }
    },
    async describe(ref) {
      const value = store.get(ref)
      return { configured: value !== undefined, source: value === undefined ? undefined : 'store', writable: true }
    },
    async set(ref, value) {
      if (value === '') throw new Error('an empty value cannot be stored')
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
}

/**
 * A config-editor stand-in over the real Loader entry shape.
 *
 * A Loader entry carries its row fields under `options` and its live fiber on
 * `fiber`, and `configEditor.edit` refuses anything else:
 *
 *   if (!this.entries().includes(entry) || entry.fiber === void 0) throw …
 *   if (fiber.state !== 2) throw "Configuration plugin is no longer active"
 *   change(entry.options.config, inherited)
 *
 * The stand-in reproduces all three checks, because a stand-in that accepted a
 * flatter shape would keep passing while the real deployment answered
 * "no profile entry for dsh-llm-opencode-go" — which is exactly what happened.
 */
export function fakeEditor({ id = 'opencode-go', name = 'dsh-llm-opencode-go', inherited = {}, override = {} } = {}) {
  const fiber = { state: 2 }
  const entry = { options: { id, name, config: { ...inherited, ...override } }, fiber, parent: null }
  const state = { inherited: { ...inherited }, override: { ...override } }
  const assertAddressable = (target) => {
    if (![entry].includes(target) || target.fiber === undefined) {
      throw new Error('Configuration entry is no longer available')
    }
    if (target.fiber.state !== 2) throw new Error('Configuration plugin is no longer active')
  }
  return {
    entry,
    state,
    writes: [],
    entries: () => [entry],
    configuration: () => [{ entry, inherited: { ...state.inherited }, override: { ...state.override } }],
    async edit(target, change) {
      assertAddressable(target)
      const next = change({ ...state.inherited, ...state.override }, { ...state.inherited })
      this.writes.push(next)
      state.override = { ...next }
      entry.options.config = { ...state.inherited, ...next }
    },
  }
}

/** A catalog snapshot stand-in: a listed model, a hidden one, and a variant. */
export function fakeSnapshot(overrides = {}) {
  const models = overrides.models ?? [
    {
      id: 'glm-5.3',
      name: 'GLM 5.3',
      hidden: false,
      hiddenReason: null,
      trainingGated: false,
      protocols: ['chat-completions', 'anthropic-messages'],
      contextWindow: 200_000,
      maxTokens: 131_072,
      reasoning: true,
      inputModalities: ['text'],
      defaultEffort: null,
      variant: null,
    },
    {
      id: 'glm-5.3@fast',
      name: 'GLM 5.3 (fast)',
      hidden: false,
      hiddenReason: null,
      trainingGated: false,
      protocols: ['anthropic-messages', 'chat-completions'],
      contextWindow: 200_000,
      maxTokens: 32_768,
      reasoning: true,
      inputModalities: ['text'],
      defaultEffort: 'low',
      variant: { of: 'glm-5.3', name: 'fast', label: 'GLM 5.3 (fast)', offered: true },
    },
    {
      id: 'space-bunny-free',
      name: 'Space Bunny Free',
      hidden: true,
      hiddenReason: 'configured',
      trainingGated: false,
      protocols: ['chat-completions'],
      contextWindow: 131_072,
      maxTokens: 32_768,
      reasoning: false,
      inputModalities: ['text'],
      defaultEffort: null,
      variant: null,
    },
  ]
  const hidden = overrides.hidden ?? models.filter((model) => model.hiddenReason === 'configured').map((model) => model.id)
  return {
    source: 'discover',
    fetchedAt: 1_700_000_000_000,
    counts: {
      total: models.length,
      listed: models.filter((model) => !model.hidden).length,
      hidden: hidden.length,
      hiddenByTraining: models.filter((model) => model.hiddenReason === 'training').length,
      variants: models.filter((model) => model.variant !== null && model.variant !== undefined).length,
    },
    models,
    hidden,
    variants: overrides.variants ?? [],
    variantsWithoutModel: overrides.variantsWithoutModel ?? [],
    ...overrides,
  }
}

/** One row of usage counters, with the zeros a table will render filled in. */
export function fakeCounters(overrides = {}) {
  return {
    requests: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  }
}

/**
 * The bridge under test, with every optional collaborator controllable. *
 * Presence is read with `in`, not by value: a suite that says
 * `credentials: undefined` is asking for a deployment without a credential
 * store, which is a different case from leaving the collaborator out.
 */
export function bridgeUnderTest(overrides = {}) {
  const config = resolveConfig(overrides.config ?? {})
  const credentials = 'credentials' in overrides ? overrides.credentials : fakeCredentials()
  const configEditor = 'configEditor' in overrides ? overrides.configEditor : fakeEditor()
  const connection = 'connection' in overrides ? overrides.connection : undefined
  const logs = []
  const instance = createBridge({
    config: () => config,
    credentials: () => credentials,
    configEditor: () => configEditor,
    connection: () => connection,
    snapshot: overrides.snapshot ?? (async () => fakeSnapshot()),
    refresh: 'refresh' in overrides ? overrides.refresh : (async () => ({
      ok: true,
      fetchedAt: 1_700_000_100_000,
      discovered: 3,
      added: ['new-model'],
      removed: ['gone-model'],
      catalog: fakeSnapshot(),
    })),
    usage: 'usage' in overrides ? overrides.usage : (async (days) => ({
      window: days,
      today: '2026-01-15',
      days: [{ day: '2026-01-15', counters: fakeCounters({ requests: 4, inputTokens: 400, outputTokens: 100, totalTokens: 500 }) }],
      models: [{ model: 'glm-5.3', counters: fakeCounters({ requests: 4, inputTokens: 400, outputTokens: 100, totalTokens: 500 }) }],
      totals: fakeCounters({ requests: 4, inputTokens: 400, outputTokens: 100, totalTokens: 500 }),
      firstDay: '2026-01-15',
      retentionDays: 30,
      retention: ['2026-01-15'],
    })),
    subscription: 'subscription' in overrides ? overrides.subscription : (async () => ({
      ok: true,
      cached: false,
      fetchedAt: 1_700_000_000_000,
      minIntervalSeconds: 30,
      maxIntervalSeconds: 1_800,
      windows: [
        { name: 'rolling', status: 'ok', percent: 8, resetsAt: '2026-01-16T00:00:00.000Z' },
        { name: 'weekly', status: 'ok', percent: 8, resetsAt: '2026-01-19T00:00:00.000Z' },
        { name: 'monthly', status: 'ok', percent: 13, resetsAt: '2026-02-01T00:00:00.000Z' },
      ],
    })),
    subscriptionStatus: 'subscriptionStatus' in overrides
      ? overrides.subscriptionStatus
      : () => ({ activity: false, minIntervalSeconds: 30, maxIntervalSeconds: 1_800 }),
    logger: { info: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    // Optional collaborators the page reads when a deployment has them. Absent
    // means "this composition does not mount one", which is a shape the page
    // has to survive, so they are only passed when a case names them.
    ...('launchEnvironment' in overrides ? { launchEnvironment: overrides.launchEnvironment } : {}),
    ...('entry' in overrides ? { entry: overrides.entry } : {}),
  })
  return { instance, config, credentials, configEditor, logs }
}

/** Call one endpoint and return the captured answer. */
export async function call(instance, options) {
  const res = response()
  await instance.handle(request(options), res)
  return res
}

/** Request defaults the local fence admits: a loopback authority, no markers. */
export const local = (options = {}) => ({ headers: { host: '127.0.0.1:19387' }, ...options })
