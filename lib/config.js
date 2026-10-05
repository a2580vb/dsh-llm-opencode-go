/**
 * Plugin configuration: schema, defaults, and normalization.
 *
 * The raw Cordis row `config` is untrusted input. `resolveConfig()` turns it
 * into one frozen, fully-defaulted snapshot that the rest of the plugin reads,
 * so no downstream module has to repeat a default or defend against a
 * malformed field.
 *
 * @module dsh-llm-opencode-go/config
 */

/** Protocol identifiers this adapter can speak on the wire. */
export const PROTOCOLS = Object.freeze({
  RESPONSES: 'responses',
  CHAT: 'chat-completions',
  ANTHROPIC: 'anthropic',
})

/** Every protocol, in the order the built-in fallback catalog prefers them. */
export const PROTOCOL_LIST = Object.freeze([
  PROTOCOLS.RESPONSES,
  PROTOCOLS.CHAT,
  PROTOCOLS.ANTHROPIC,
])

export const DEFAULT_PROVIDER = 'opencode-go'
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'
export const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY'
export const DEFAULT_USER_AGENT_PRODUCT = 'dsh-opencode-go'

/**
 * The retry policy this route reports.
 *
 * The harness resolves an omitted policy to normal mode with five retries over
 * the transient codes, and the retry executor — not this adapter — performs the
 * re-runs. The default is declared here rather than left to the harness so the
 * plugin's behaviour does not depend on which harness default it lands on.
 */
export const DEFAULT_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

/**
 * This plugin's own version, reported in the `User-Agent`.
 *
 * It is a literal rather than a read of `package.json`, because the plugin is
 * loaded as a module and a manifest read would fail in a bundled deployment.
 * `tests/suites/release.test.mjs` fails if it drifts from the manifest.
 */
export const PLUGIN_VERSION = '0.2.0'

/**
 * Upstream error type OpenCode Go returns when a model exists but is not
 * reachable over the protocol the request used. Seeing it is how the adapter
 * learns a model's protocol without a hard-coded table.
 */
export const MODEL_PROTOCOL_UNSUPPORTED = 'ModelProtocolUnsupported'

/**
 * Identifiers the Go relay uses for its training-consent refusal.
 *
 * The relay serves a few models whose provider trains on request data, and it
 * gates them behind a **workspace** setting rather than a request field. Two
 * spellings reach this adapter: the current service answers `DataPolicyError`,
 * and deployments that put the refusal inside an upstream error body also carry
 * an `Account.TrainingNotAllowed` code. Both are recognized so the failure is
 * named once, in `error/mapping.js`, whichever spelling arrives.
 */
export const DATA_POLICY_ERROR = 'DataPolicyError'
export const TRAINING_NOT_ALLOWED = 'TrainingNotAllowed'

/**
 * The workspace setting that unblocks those models, as the console labels it.
 *
 * The plugin never changes it: whether prompts may train someone else's model is
 * the workspace owner's decision, not something an adapter may opt into on a
 * user's behalf. It only appears in the failure message, so the reader knows
 * exactly which switch is missing. See `model/capabilities.js`.
 */
export const TRAINING_CONSENT_SETTING = 'Allow models that train on request data'

/** Where the console holds that setting, for the failure message. */
export const TRAINING_CONSENT_CONSOLE = 'https://opencode.ai/workspace'

/**
 * The Cordis config schema, in the Standard Schema shape.
 *
 * Cordis does not read a schema library object: it calls
 * `Config['~standard'].validate(raw)` and expects a synchronous
 * `{ value }` or `{ issues }` result. Implementing that interface directly is
 * what keeps this plugin free of a schema-library dependency — and therefore
 * installable into any DSH version.
 *
 * The schema is deliberately shape-only, and its `value` is the input unchanged.
 * Defaults belong in {@link resolveConfig}, which every code path goes through
 * anyway, so a second copy here could only ever disagree with it. Everything a
 * deployment can get wrong about a field is reported by name from that one
 * place.
 */
function standardSchema() {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-llm-opencode-go',
      /** Validate the raw row config; see the note above about defaults. */
      validate(value) {
        const problems = checkShape(value)
        if (problems.length > 0) {
          return { issues: problems.map((problem) => ({ message: problem })) }
        }
        return { value }
      },
    },
  }
}

export const Config = standardSchema()

/** One accepted protocol name as a YAML-friendly list. */
function protocolNames() {
  return PROTOCOL_LIST.join(', ')
}

/**
 * Field-by-field shape checks, returning one human message per problem.
 *
 * Accepting `undefined` for every field is deliberate: the row config is
 * usually absent entirely, and a missing field means "use the default".
 */
function checkShape(value) {
  if (value === undefined || value === null) return []
  if (typeof value !== 'object' || Array.isArray(value)) {
    return [`config must be an object, received ${describe(value)}`]
  }
  const problems = []

  const isNonEmptyString = (field) => {
    const raw = value[field]
    if (raw === undefined || raw === null) return
    if (typeof raw !== 'string' || raw.trim() === '') problems.push(`${field} must be a non-empty string`)
  }
  const isPositiveNumber = (field) => {
    const raw = value[field]
    if (raw === undefined || raw === null) return
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) problems.push(`${field} must be a positive number`)
  }
  const isBoolean = (field) => {
    const raw = value[field]
    if (raw === undefined || raw === null) return
    if (typeof raw !== 'boolean' && raw !== 'true' && raw !== 'false') {
      problems.push(`${field} must be a boolean`)
    }
  }
  const isObject = (field) => {
    const raw = value[field]
    if (raw === undefined || raw === null) return
    if (typeof raw !== 'object' || Array.isArray(raw)) problems.push(`${field} must be an object`)
  }
  const isArray = (field) => {
    const raw = value[field]
    if (raw === undefined || raw === null) return
    if (!Array.isArray(raw)) problems.push(`${field} must be an array`)
  }
  const inList = (field, allowed) => {
    const raw = value[field]
    if (raw === undefined || raw === null) return
    if (!allowed.includes(String(raw))) {
      problems.push(`${field} must be one of ${allowed.map((item) => `"${item}"`).join(', ')}`)
    }
  }

  for (const field of ['provider', 'baseURL', 'userAgentProduct', 'attribution', 'modelsCachePath', 'usagePath']) {
    isNonEmptyString(field)
  }
  isNonEmptyString('apiKeyEnv')
  for (const field of ['timeoutMs', 'streamIdleTimeoutMs', 'modelsCacheSeconds', 'subscriptionCacheSeconds', 'subscriptionMinIntervalSeconds', 'subscriptionMaxIntervalSeconds', 'defaultContextWindow', 'defaultMaxTokens']) {
    isPositiveNumber(field)
  }
  for (const field of ['sendClientHeader', 'disableReasoningReplay', 'hideTrainingModels']) isBoolean(field)
  for (const field of ['modelOverrides', 'protocolOverrides', 'retryPolicy']) isObject(field)
  for (const field of ['models', 'reasoningEfforts', 'hiddenModels', 'modelVariants']) isArray(field)
  inList('modelSource', ['discover', 'config'])
  inList('defaultProtocol', PROTOCOL_LIST)
  inList('sessionHeader', ['session-id', 'uuid', 'off'])
  inList('sendImages', ['auto', 'always', 'off'])
  inList('healthCheck', ['off', 'startup'])

  // A few shapes the generic checks above cannot express.
  if (value.apiKeyEnv !== undefined && value.apiKeyEnv !== null
    && (typeof value.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value.apiKeyEnv).trim()))) {
    problems.push('apiKeyEnv must be a credential reference such as OPENCODE_GO_API_KEY')
  }
  if (value.models !== undefined && value.models !== null) {
    for (const entry of value.models) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push('every models entry must be an object')
        break
      }
      if (entry.id === undefined || entry.id === null || String(entry.id).trim() === '') {
        problems.push('every models entry needs an id')
        break
      }
    }
  }
  if (value.hiddenModels !== undefined && value.hiddenModels !== null) {
    for (const entry of value.hiddenModels) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        problems.push('every hiddenModels entry must be a non-empty model id')
        break
      }
    }
  }
  if (value.modelVariants !== undefined && value.modelVariants !== null) {
    for (const entry of value.modelVariants) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push('every modelVariants entry must be an object')
        break
      }
      if (entry.model === undefined || entry.model === null || String(entry.model).trim() === '') {
        problems.push('every modelVariants entry needs the model it varies')
        break
      }
      if (entry.name === undefined || entry.name === null || String(entry.name).trim() === '') {
        problems.push('every modelVariants entry needs a name')
        break
      }
    }
  }
  if (value.protocolOverrides !== undefined && value.protocolOverrides !== null
    && typeof value.protocolOverrides === 'object' && !Array.isArray(value.protocolOverrides)) {
    for (const [id, protocol] of Object.entries(value.protocolOverrides)) {
      if (normalizeProtocol(protocol) === undefined) {
        problems.push(`protocolOverrides["${id}"] must be one of ${protocolNames()}`)
      }
    }
  }
  return problems
}

/**
 * Normalize a protocol name, accepting the aliases deployments tend to write.
 *
 * Declared here rather than imported from the catalog so the row validator has
 * no dependency on the catalog, which imports this module.
 *
 * @param {unknown} value - a candidate protocol name.
 * @returns {string | undefined} the canonical name, or undefined when unknown.
 */
export function normalizeProtocol(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim().toLowerCase()
  if (text === '') return undefined
  if (PROTOCOL_LIST.includes(text)) return text
  if (text === 'chat' || text === 'openai' || text === 'openai-completions' || text === 'chat_completions') {
    return PROTOCOLS.CHAT
  }
  if (text === 'response' || text === 'openai-responses') return PROTOCOLS.RESPONSES
  if (text === 'messages' || text === 'anthropic-messages' || text === 'claude') return PROTOCOLS.ANTHROPIC
  return undefined
}

/** One request's own status name, used in diagnostics instead of a bare value. */
function describe(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function configError(field, value, expected) {
  return new TypeError(
    `dsh-llm-opencode-go: config field "${field}" ${describe(value)} is not ${expected}`,
  )
}

/** A non-negative finite number, or the fallback when the field is unusable. */
function positiveNumber(config, field, fallback) {
  const raw = config[field]
  if (raw === undefined || raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw configError(field, raw, 'a positive number')
  return value
}

/** One of `allowed`, else `fallback` when absent; anything else is a mistake. */
function oneOf(config, field, allowed, fallback) {
  const raw = config[field]
  if (raw === undefined || raw === null) return fallback
  const value = String(raw)
  if (!allowed.includes(value)) {
    throw configError(field, raw, `one of ${allowed.map((item) => `"${item}"`).join(', ')}`)
  }
  return value
}

function boolean(config, field, fallback) {
  const raw = config[field]
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'boolean') return raw
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw configError(field, raw, 'a boolean')
}

/**
 * A URL usable as an API root: HTTP(S), no embedded credentials, and no query
 * or fragment, because this adapter appends paths to it.
 */
function apiRoot(config, field, fallback) {
  const raw = config[field]
  const text = raw === undefined || raw === null || String(raw).trim() === ''
    ? fallback
    : String(raw).trim()
  let url
  try {
    url = new URL(text)
  } catch {
    throw configError(field, raw, 'an absolute http(s) URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw configError(field, raw, 'an http(s) URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw configError(field, raw, 'a URL without embedded credentials')
  }
  if (url.search !== '' || url.hash !== '') {
    throw configError(field, raw, 'a URL without a query or fragment')
  }
  // Trailing slashes never change the appended path, so drop them once here.
  return url.toString().replace(/\/+$/, '')
}

/** A credential reference: the POSIX-shell identifier the seam can resolve. */
function credentialRefName(config, field, fallback) {
  const raw = config[field]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const value = String(raw).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw configError(field, raw, 'a credential reference such as OPENCODE_GO_API_KEY')
  }
  return value
}

/** A product token that can ride in a User-Agent without breaking its syntax. */
/**
 * A `User-Agent` product token: `name` or `name/version`, with no whitespace.
 *
 * The whole value is validated rather than only its first word, because this
 * plugin's own request identity is the point of the field — a token that broke
 * the header's grammar would silently change what OpenCode sees.
 */
function productToken(config, field, fallback) {
  const raw = config[field]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const value = String(raw).trim()
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(value)) {
    throw configError(field, raw, 'a product token such as "dsh-opencode-go" or "deepseek-harness/0.2.0"')
  }
  return value
}

function effortList(config) {
  const raw = config.reasoningEfforts
  if (raw === undefined || raw === null) {
    return Object.freeze(['minimal', 'low', 'medium', 'high', 'max'])
  }
  if (!Array.isArray(raw)) throw configError('reasoningEfforts', raw, 'an array of level names')
  const seen = new Set()
  const levels = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw configError('reasoningEfforts', raw, 'an array of non-empty strings')
    }
    const level = item.trim()
    if (!seen.has(level)) {
      seen.add(level)
      levels.push(level)
    }
  }
  return Object.freeze(levels)
}

/** A model id as `modelVariants` writes it: no whitespace, and no `@`. */
const VARIANT_BASE_ID = /^[^\s@]+$/

/**
 * A variant name: the half that becomes part of a model id (`model@name`).
 *
 * The grammar is deliberately narrower than "any string": a variant id is
 * handed to the model selector, written into a session, and typed by hand in a
 * `provider/model` field, so it has to survive all three.
 */
const VARIANT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The variant presets this deployment declares.
 *
 * A variant is one model's settings under a name — a protocol to lead with, a
 * default thinking level, a context window, an output cap — exposed as its own
 * catalog entry (`<model>@<name>`), so choosing between them is the same
 * gesture as choosing between models. Nothing here reaches the wire by itself:
 * the variant only changes what the base record advertises and which protocol
 * the request opens with.
 *
 * Two mistakes are refused rather than absorbed, because both would otherwise
 * fail silently at the far end of a call: an unusable name (it is an id), and
 * the same `model@name` declared twice (one would win at random).
 */
function variantList(config) {
  const raw = config.modelVariants
  if (raw === undefined || raw === null) return Object.freeze([])
  if (!Array.isArray(raw)) throw configError('modelVariants', raw, 'an array of variant entries')
  const seen = new Set()
  const variants = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw configError('modelVariants', raw, 'an array of objects naming a model and a variant')
    }
    const model = optionalString(entry, 'model')
    const name = optionalString(entry, 'name')
    if (model === undefined || !VARIANT_BASE_ID.test(model)) {
      throw new TypeError(
        `dsh-llm-opencode-go: modelVariants entry ${describe(entry)} needs a "model" it varies:`
        + ' a model id with no whitespace and no "@"',
      )
    }
    if (name === undefined || !VARIANT_NAME.test(name)) {
      throw new TypeError(`dsh-llm-opencode-go: modelVariants "${model}" needs a "name" matching ${String(VARIANT_NAME)}`)
    }
    const id = `${model}@${name}`
    if (seen.has(id)) {
      throw new TypeError(`dsh-llm-opencode-go: modelVariants declares "${id}" twice; a variant id must be unique`)
    }
    seen.add(id)
    const protocol = entry.protocol === undefined || entry.protocol === null
      ? undefined
      : (() => {
        const normalized = normalizeProtocol(entry.protocol)
        if (normalized === undefined) {
          throw new TypeError(
            `dsh-llm-opencode-go: modelVariants "${id}" protocol ${describe(entry.protocol)}`
            + ` is not a protocol (${protocolNames()})`,
          )
        }
        return normalized
      })()
    const label = optionalString(entry, 'label')
    const effort = optionalString(entry, 'effort')
    const contextWindow = optionalCapacity(entry, 'contextWindow', id)
    const maxTokens = optionalCapacity(entry, 'maxTokens', id)
    variants.push(Object.freeze({
      model,
      name,
      ...(label === undefined ? {} : { label }),
      ...(protocol === undefined ? {} : { protocol }),
      ...(effort === undefined ? {} : { effort }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }))
  }
  return Object.freeze(variants)
}

/** A trimmed non-empty string field, or undefined when absent. */
function optionalString(entry, field) {
  const raw = entry[field]
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined
  return String(raw).trim()
}

/** A positive integer capacity field, or undefined when absent. */
function optionalCapacity(entry, field, id) {
  const raw = entry[field]
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`dsh-llm-opencode-go: modelVariants "${id}" ${field} ${describe(raw)} is not a positive integer`)
  }
  return value
}

/**
 * The model ids this deployment keeps out of the listing.
 *
 * Ids are normalized the way the catalog keys them (trimmed, deduplicated), so
 * a value a person typed on the configuration page matches the record it names.
 * An id the catalog has never heard of is kept rather than dropped: the service
 * lists new models without asking this plugin, and a hidden entry for one of
 * them should start working the moment it appears.
 */
function hiddenModelList(config) {
  const raw = config.hiddenModels
  if (raw === undefined || raw === null) return Object.freeze([])
  if (!Array.isArray(raw)) throw configError('hiddenModels', raw, 'an array of model ids')
  const seen = new Set()
  const ids = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw configError('hiddenModels', raw, 'an array of non-empty model ids')
    }
    const id = item.trim()
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return Object.freeze(ids)
}

/**
 * Resolve the raw row config into the one snapshot every other module reads.
 *
 * @param {unknown} raw - the Cordis row `config`, possibly undefined.
 * @returns {Readonly<object>} a frozen, fully-defaulted configuration snapshot.
 * @throws {TypeError} naming the field and the expected shape.
 */
export function resolveConfig(raw) {
  const config = raw === undefined || raw === null ? {} : raw
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError(`dsh-llm-opencode-go: config must be an object, received ${describe(raw)}`)
  }

  const userAgentProduct = productToken(config, 'userAgentProduct', DEFAULT_USER_AGENT_PRODUCT)
  const attribution = productToken(config, 'attribution', undefined)

  // How the page paces its own subscription checks. The quota moves only when a
  // call is made, so a page on a fixed timer would spend round trips on an answer
  // that has not changed; the two intervals bound the two ways that can go wrong
  // — checking too often while a session is working, and letting a quiet answer
  // go stale while something else spends the plan. See `createSubscriptionStore`
  // in `lib/client.js` for the schedule itself.
  const subscriptionMinIntervalSeconds = positiveNumber(config, 'subscriptionMinIntervalSeconds', 30)
  // A ceiling under the floor is a schedule with no interval that satisfies both,
  // and the ceiling is the one that has to hold: an answer left stale for longer
  // than the reader asked is the failure it exists to prevent, while the extra
  // check costs one round trip to a route on this machine.
  const subscriptionMaxIntervalSeconds = Math.max(
    subscriptionMinIntervalSeconds,
    positiveNumber(config, 'subscriptionMaxIntervalSeconds', 1_800),
  )

  const snapshot = {
    provider: (() => {
      const rawProvider = config.provider
      const value = rawProvider === undefined || rawProvider === null || String(rawProvider).trim() === ''
        ? DEFAULT_PROVIDER
        : String(rawProvider).trim()
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
        throw configError('provider', rawProvider, 'a provider route name')
      }
      return value
    })(),
    apiKeyEnv: credentialRefName(config, 'apiKeyEnv', DEFAULT_API_KEY_ENV),
    baseURL: apiRoot(config, 'baseURL', DEFAULT_BASE_URL),
    userAgentProduct,
    attribution,
    /** The resolved `User-Agent`, computed once so every request agrees. */
    userAgent: userAgentValue({ userAgentProduct, attribution }),
    timeoutMs: positiveNumber(config, 'timeoutMs', 600_000),
    streamIdleTimeoutMs: positiveNumber(config, 'streamIdleTimeoutMs', 300_000),
    modelSource: oneOf(config, 'modelSource', ['discover', 'config'], 'discover'),
    modelsCacheSeconds: positiveNumber(config, 'modelsCacheSeconds', 21_600),
    // The subscription's quota moves only when a request is made, and reading
    // it costs a round trip, so the page reuses an answer inside this window
    // and forces a fresh one when the reader asks.
    subscriptionCacheSeconds: positiveNumber(config, 'subscriptionCacheSeconds', 60),
    subscriptionMinIntervalSeconds,
    subscriptionMaxIntervalSeconds,
    modelsCachePath: (() => {
      const rawPath = config.modelsCachePath
      if (rawPath === undefined || rawPath === null || String(rawPath).trim() === '') return undefined
      return String(rawPath).trim()
    })(),
    usagePath: (() => {
      const rawPath = config.usagePath
      if (rawPath === undefined || rawPath === null || String(rawPath).trim() === '') return undefined
      return String(rawPath).trim()
    })(),
    models: Array.isArray(config.models) ? config.models : (() => {
      if (config.models === undefined || config.models === null) return []
      throw configError('models', config.models, 'an array of model entries')
    })(),
    modelOverrides: plainObject(config, 'modelOverrides'),
    protocolOverrides: plainObject(config, 'protocolOverrides'),
    defaultProtocol: oneOf(config, 'defaultProtocol', PROTOCOL_LIST, PROTOCOLS.CHAT),
    defaultContextWindow: positiveNumber(config, 'defaultContextWindow', 262_144),
    defaultMaxTokens: positiveNumber(config, 'defaultMaxTokens', 32_768),
    reasoningEfforts: effortList(config),
    sessionHeader: oneOf(config, 'sessionHeader', ['session-id', 'uuid', 'off'], 'session-id'),
    sendClientHeader: boolean(config, 'sendClientHeader', true),
    sendImages: oneOf(config, 'sendImages', ['auto', 'always', 'off'], 'auto'),
    disableReasoningReplay: boolean(config, 'disableReasoningReplay', false),
    hideTrainingModels: boolean(config, 'hideTrainingModels', false),
    hiddenModels: hiddenModelList(config),
    modelVariants: variantList(config),
    healthCheck: oneOf(config, 'healthCheck', ['off', 'startup'], 'off'),
    retryPolicy: config.retryPolicy === undefined || config.retryPolicy === null
      ? DEFAULT_RETRY_POLICY
      : Object.freeze({ ...DEFAULT_RETRY_POLICY, ...plainObject(config, 'retryPolicy') }),
  }

  return Object.freeze(snapshot)
}

function plainObject(config, field) {
  const raw = config[field]
  if (raw === undefined || raw === null) return Object.freeze({})
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw configError(field, raw, 'an object')
  }
  return Object.freeze({ ...raw })
}

/**
 * The `User-Agent` this plugin sends.
 *
 * OpenCode asks a client to identify itself rather than shipping a generic SDK
 * name, so the plugin's own product token leads. A deployment that also wants
 * to name the harness sets `attribution` to its product token, which is
 * appended: `User-Agent` is a space-separated product list, so both identities
 * stay truthful and neither replaces the other.
 *
 * @param {object} config - at least `userAgentProduct` and `attribution`.
 * @returns {string} the header value.
 */
export function userAgentValue(config) {
  const own = `${config.userAgentProduct}/${PLUGIN_VERSION}`
  return config.attribution === undefined ? own : `${own} ${config.attribution}`
}
