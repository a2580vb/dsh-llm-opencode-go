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

/** A config-editor stand-in: one entry with an inherited and a profile layer. */
export function fakeEditor({ id = 'opencode-go', name = 'dsh-opencode-go', inherited = {}, override = {} } = {}) {
  const entry = { id, name }
  const state = { inherited: { ...inherited }, override: { ...override } }
  return {
    entry,
    state,
    writes: [],
    entries: () => [entry],
    configuration: () => [{ entry, inherited: { ...state.inherited }, override: { ...state.override } }],
    async edit(target, change) {
      const next = change({ ...state.inherited, ...state.override }, { ...state.inherited })
      this.writes.push(next)
      state.override = { ...next }
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

/**
 * The bridge under test, with every optional collaborator controllable.
 *
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
    logger: { info: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
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
