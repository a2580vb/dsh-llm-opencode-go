/**
 * Model catalog: capability records, protocol selection, and the built-in
 * fallback.
 *
 * OpenCode Go tells us *which ids exist* (`GET /models`) but not what each id
 * can do. Two of those facts are hard requirements rather than niceties:
 *
 *   - **protocol** — a model that only speaks `/responses` answers
 *     `400 ModelProtocolUnsupported` on `/chat/completions` rather than
 *     degrading, so a protocol per model is measured against the live service;
 *   - **capacity and modalities** — the context window, the output cap, and
 *     whether the model takes images, which its `/models` reply omits and the
 *     OpenCode catalogue publishes. Those live in `./limits.js`.
 *
 * Three sources feed one record, in increasing priority:
 *   1. {@link FALLBACK_MODELS}, measured against the live service, together
 *      with the measured capacity table.
 *   2. the discovered id list from `GET /models` (adds ids we have not seen).
 *   3. `models` / `modelOverrides` / `protocolOverrides` from the plugin config.
 *
 * @module dsh-opencode-go/model/catalog
 */

import { PROTOCOLS, PROTOCOL_LIST, normalizeProtocol } from '../config.js'
import { capabilityFor } from './limits.js'

/** The context window assumed for a model the service does not describe. */
export const FALLBACK_CONTEXT_WINDOW = 262_144

/** The output cap assumed for a model the service does not describe. */
export const FALLBACK_MAX_TOKENS = 32_768

/**
 * The models the Go relay gates behind the workspace training-consent setting.
 *
 * The service's own check is an id list, and it applies to the Go endpoints
 * only: for these ids the relay answers `DataPolicyError` until the workspace
 * allows providers that train on request data, while the Zen catalogue serves
 * the differently-named `…-contributor-free` id without that gate. The list is
 * kept here in the service's own shape, so what this plugin warns about cannot
 * drift from what the service refuses — and one entry is all a newly gated id
 * needs, because the listing note, the resolution note, and the failure
 * classification all follow from it. See `model/capabilities.js` and
 * `error/mapping.js`.
 */
export const TRAINING_CONSENT_MODELS = Object.freeze([
  'muse-spark-1.3-contributor',
  'muse-spark-1.2-contributor',
])

/**
 * Whether one model id is gated behind that workspace setting.
 *
 * @param {unknown} id - a model id.
 * @returns {boolean} true when the relay requires training consent for it.
 */
export function requiresTrainingConsent(id) {
  return TRAINING_CONSENT_MODELS.includes(String(id))
}

/**
 * The thinking levels assumed for a model the service does not describe.
 *
 * `minimal` is included because Chat Completions accepts it, and the resolver
 * narrows the list per protocol: the Responses API has no `minimal`, so a
 * Responses model never advertises it.
 */
export const FALLBACK_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'max'])

/**
 * One fallback catalog entry, with the measured capacity applied.
 *
 * Capacity and modalities come from the measured table rather than from this
 * call site, so a model's context window is stated once and the same record
 * serves the model selector, the call-config validator, and the request
 * builder. `inputModalities` is **not** set here: the provider's own list is
 * kept in `providerModalities`, and which of those this adapter can actually put
 * on the wire is decided in `./capabilities.js`, where the mounted services are
 * known.
 *
 * @param {string} id - the model id.
 * @param {object} extra - the measured protocol list and reasoning flag.
 * @returns {object} a frozen record.
 */
function model(id, extra) {
  const capability = capabilityFor(id, {
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxTokens: FALLBACK_MAX_TOKENS,
  })
  return Object.freeze({
    id,
    name: displayName(id),
    contextWindow: capability.contextWindow,
    maxTokens: capability.maxTokens,
    reasoningEfforts: FALLBACK_EFFORTS,
    providerModalities: capability.modalities,
    capacitySource: capability.source,
    // Derived rather than repeated per entry: the relay's gate is an id list,
    // and this is the same list. See TRAINING_CONSENT_MODELS.
    trainingConsent: requiresTrainingConsent(id),
    ...extra,
  })
}

/**
 * Wire protocols a model accepts, most-preferred first.
 *
 * Preference order is Responses, Chat Completions, then Anthropic Messages:
 * that is the order the protocol modules are listed in the package README, and
 * it keeps the id-to-endpoint mapping stable for a given deployment. Pin a
 * different one with `protocolOverrides` or a `models[].protocol` entry.
 *
 * The list below is **measured against the live service**, one model at a time,
 * by asking each endpoint the model might serve. Every id `GET /models` returns
 * has a row here, so no served model has to discover its own protocol by failing
 * first. Re-measure with `.live-cache/probe-protocols.mjs` (see the README) when
 * the service adds a model.
 */
export const FALLBACK_MODELS = Object.freeze([
  // Reachable over all three protocols.
  model('deepseek-v4-pro', { protocols: [...PROTOCOL_LIST], reasoning: true }),
  model('deepseek-v4-flash', { protocols: [...PROTOCOL_LIST], reasoning: true }),
  model('deepseek-v4.1-flash', { protocols: [...PROTOCOL_LIST], reasoning: true }),
  model('deepseek-v4-flash-vision-exp', { protocols: [...PROTOCOL_LIST], reasoning: true }),
  // Served by the relay, absent from its own `/models` list and from the
  // catalogue. Kept so a route that answers still has a row.
  model('deepseek-flash', { protocols: [...PROTOCOL_LIST], reasoning: true }),

  // Responses only.
  model('gpt-6-luna', { protocols: [PROTOCOLS.RESPONSES], reasoning: true }),
  model('gpt-5.6-luna', { protocols: [PROTOCOLS.RESPONSES], reasoning: true }),
  model('grok-4.7', { protocols: [PROTOCOLS.RESPONSES], reasoning: true }),
  model('grok-4.6', { protocols: [PROTOCOLS.RESPONSES], reasoning: true }),

  // Anthropic Messages only.
  model('minimax-m2.7', { protocols: [PROTOCOLS.ANTHROPIC], reasoning: true }),

  // Chat Completions plus Anthropic Messages.
  model('minimax-m2.5', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('minimax-m3', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('kimi-k3', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('qwen3.6-plus', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('qwen3.7-max', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('qwen3.8-max', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('qwen3.8-flash', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('qwen3.7-plus', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('space-bunny-free', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),

  // Chat Completions only.
  model('glm-5.3', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('glm-5.3-flash', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('glm-5.2', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('glm-5.1', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('kimi-k2.7-code', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('kimi-k2.6', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('mimo-v2.6-pro', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('mimo-v2.6-flash', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('mimo-v2.5-pro', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('mimo-v2.5', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('longcat-2.0', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('longcat-2.5-preview-free', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('hy3', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('hy4-preview', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('omen-alpha', { protocols: [PROTOCOLS.CHAT], reasoning: true }),

  // Contributor-tier ids: served by Go, but gated behind the workspace
  // training-consent setting (`TRAINING_CONSENT_MODELS`). Kept in the catalog so
  // the model is selectable, its note states what it needs, and the refusal it
  // answers is classified as that missing setting rather than as a bad request.
  model('muse-spark-1.3-contributor', { protocols: [PROTOCOLS.RESPONSES], reasoning: true, tier: 'contributor' }),
  model('muse-spark-1.2-contributor', { protocols: [PROTOCOLS.RESPONSES], reasoning: true, tier: 'contributor' }),
])

/**
 * A readable label derived from a model id: `gpt-5.6-luna` becomes
 * `GPT 5.6 Luna`. Only used when neither the service nor the config names one.
 *
 * A short all-alphabetic segment of at most three letters reads as an
 * initialism and is uppercased (`gpt` → `GPT`, `hy` → `HY`, `glm` → `GLM`),
 * while a longer word keeps ordinary title case so a real name such as `luna`
 * is not shouted. A numeric segment, including a version such as `5.6`, keeps
 * its own case, so an invented label never looks more official than it is.
 *
 * @param {string} id - the model id.
 * @returns {string} a human-facing label.
 */
export function displayName(id) {
  return String(id)
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => (/^[a-z]+$/.test(part) && part.length <= 3
      ? part.toUpperCase()
      : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

/** Shallow-copy one plain object, treating a non-object as absent. */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/**
 * Normalize a configured input-modality list.
 *
 * Only `text` and `image` are accepted, because those are the two modalities the
 * harness models and the two this adapter can put on a wire. A provider list
 * that names more (the catalogue gives several models `video`, `audio`, or
 * `pdf`) is reduced before it reaches here; a hand-written entry that names one
 * is a configuration mistake worth reporting rather than silently narrowing,
 * since the adapter cannot carry it either way.
 *
 * @param {unknown} value - the configured list.
 * @param {string} context - the field being described, for diagnostics.
 * @returns {readonly string[] | undefined} the normalized list.
 */
function normalizeInput(value, context) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new TypeError(`dsh-opencode-go: ${context} "input" must be an array`)
  }
  const out = []
  for (const item of value) {
    const text = String(item).trim()
    if (text === 'text') continue
    if (text !== 'image') {
      throw new TypeError(
        `dsh-opencode-go: ${context} "input" names "${text}", which this adapter cannot send`
        + ' (accepted: text, image)',
      )
    }
    if (!out.includes('image')) out.push('image')
  }
  // Text is always present; declaring it explicitly would be noise.
  return Object.freeze(['text', ...out])
}

/**
 * The provider's own input-modality list for one config entry.
 *
 * Accepted as `modalities: { input: [...] }` for a verbatim paste of a catalogue
 * record, or as a bare `modalities: [...]`. Anything the harness does not model
 * is kept as declared rather than rejected: the list is the provider's claim,
 * and `./capabilities.js` is where the subset this adapter can actually send is
 * decided.
 *
 * @param {object} source - the raw config entry.
 * @returns {readonly string[] | undefined} the declared modalities.
 */
function declaredModalities(source) {
  const raw = source.modalities
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw) ? raw : asObject(raw)?.input
  if (list === undefined || list === null) return undefined
  if (!Array.isArray(list)) {
    throw new TypeError('dsh-opencode-go: a model entry "modalities" must be an array or { input: [...] }')
  }
  const out = []
  for (const item of list) {
    const text = String(item).trim()
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  return Object.freeze(out)
}

/** Positive integer or undefined. */
function positiveInt(value, context) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`dsh-opencode-go: ${context} must be a positive number`)
  }
  return Math.floor(number)
}

/** A declared boolean, or a TypeError naming the model and the field. */
function declaredBoolean(value, id, field) {
  if (value === true || value === false) return value
  throw new TypeError(`dsh-opencode-go: model "${id}" "${field}" must be a boolean`)
}

/**
 * Turn one raw catalog entry (from config or discovery) into a record.
 *
 * @param {unknown} raw - a `models[]` entry, a `modelOverrides` value, or a discovery row.
 * @param {object} config - the resolved plugin configuration.
 * @param {object} [base] - the record this entry refines, when merging.
 * @returns {object | undefined} the normalized record, or undefined when `raw` names no id.
 */
export function normalizeModelEntry(raw, config, base) {
  const source = asObject(raw)
  if (source === undefined) {
    throw new TypeError(`dsh-opencode-go: a model entry must be an object, received ${JSON.stringify(raw)}`)
  }
  const id = source.id === undefined || source.id === null ? base?.id : String(source.id).trim()
  if (id === undefined || id === '') return undefined

  const declaredProtocol = normalizeProtocol(source.protocol ?? source.api)
  const protocols = declaredProtocol === undefined
    ? base?.protocols
    : Object.freeze([declaredProtocol, ...(base?.protocols ?? []).filter((p) => p !== declaredProtocol)])

  const reasoning = source.reasoning === undefined
    ? base?.reasoning
    : source.reasoning === false
      ? false
      : source.reasoning === true
        ? true
        : (() => {
          throw new TypeError(`dsh-opencode-go: model "${id}" "reasoning" must be a boolean`)
        })()

  const reasoningEfforts = source.efforts === undefined || source.efforts === null
    ? base?.reasoningEfforts ?? config.reasoningEfforts
    : (() => {
      if (!Array.isArray(source.efforts)) {
        throw new TypeError(`dsh-opencode-go: model "${id}" "efforts" must be an array`)
      }
      const levels = []
      for (const item of source.efforts) {
        const level = String(item).trim()
        if (level !== '' && !levels.includes(level)) levels.push(level)
      }
      return Object.freeze(levels)
    })()

  const capacity = positiveInt(source.contextWindow, `model "${id}" "contextWindow"`)
    ?? positiveInt(asObject(source.limit)?.context, `model "${id}" "limit.context"`)
  const outputCap = positiveInt(source.maxTokens, `model "${id}" "maxTokens"`)
    ?? positiveInt(asObject(source.limit)?.output, `model "${id}" "limit.output"`)
  const modalities = declaredModalities(source)
  // An entry may state this either way: absent, the id's own gate applies (the
  // measured list above), so a deployment never has to repeat a fact the service
  // already fixes. A deployment that reaches a relay without the gate — a
  // compatible gateway, a region with different policy — can say so explicitly.
  const trainingConsent = source.trainingConsent === undefined
    ? (base?.trainingConsent ?? requiresTrainingConsent(id))
    : declaredBoolean(source.trainingConsent, id, 'trainingConsent')

  return Object.freeze({
    id,
    name: source.name === undefined || source.name === null || String(source.name).trim() === ''
      ? base?.name ?? displayName(id)
      : String(source.name).trim(),
    description: source.description === undefined ? base?.description : String(source.description),
    protocols: protocols === undefined || protocols.length === 0
      ? Object.freeze([config.defaultProtocol])
      : Object.freeze([...protocols]),
    inputModalities: source.input === undefined
      ? base?.inputModalities
      : normalizeInput(source.input, `model "${id}"`),
    providerModalities: modalities ?? base?.providerModalities,
    contextWindow: capacity ?? base?.contextWindow ?? config.defaultContextWindow,
    maxTokens: outputCap ?? base?.maxTokens ?? config.defaultMaxTokens,
    reasoning,
    reasoningEfforts,
    defaultEffort: source.defaultEffort === undefined || source.defaultEffort === null
      ? base?.defaultEffort
      : String(source.defaultEffort),
    tier: source.tier === undefined ? base?.tier : String(source.tier),
    trainingConsent,
    capacitySource: capacity === undefined && outputCap === undefined
      ? base?.capacitySource
      : 'config',
    source: base?.source ?? 'config',
  })
}

/**
 * Build the effective catalog for one configuration snapshot.
 *
 * @param {object} config - the resolved plugin configuration.
 * @param {readonly {id: string, name?: string}[]} [discovered] - ids reported by `GET /models`.
 * @returns {ReadonlyMap<string, object>} model id to capability record.
 */
export function buildCatalog(config, discovered) {
  const records = new Map()

  if (config.modelSource === 'config') {
    // An explicit `models` list is the whole catalog, exactly as written.
    for (const raw of config.models) {
      const record = normalizeModelEntry(raw, config)
      if (record !== undefined) records.set(record.id, record)
    }
  } else {
    // Discovery mode: measured fallback first, then whatever the service lists,
    // then the deployment's own entries on top.
    for (const record of FALLBACK_MODELS) records.set(record.id, record)
    for (const row of discovered ?? []) {
      const id = row?.id === undefined ? undefined : String(row.id).trim()
      if (id === undefined || id === '') continue
      if (records.has(id)) {
        const base = records.get(id)
        if (row.name !== undefined && base.name === displayName(id)) {
          records.set(id, Object.freeze({ ...base, name: String(row.name) }))
        }
        continue
      }
      const capability = capabilityFor(id, {
        contextWindow: config.defaultContextWindow,
        maxTokens: config.defaultMaxTokens,
      })
      records.set(id, Object.freeze({
        id,
        name: row.name === undefined ? displayName(id) : String(row.name),
        protocols: Object.freeze([config.defaultProtocol]),
        inputModalities: undefined,
        providerModalities: capability.modalities,
        contextWindow: capability.contextWindow,
        maxTokens: capability.maxTokens,
        reasoning: undefined,
        reasoningEfforts: config.reasoningEfforts,
        defaultEffort: undefined,
        tier: undefined,
        trainingConsent: requiresTrainingConsent(id),
        capacitySource: capability.source,
        source: 'discovered',
      }))
    }
    for (const raw of config.models) {
      const record = normalizeModelEntry(raw, config)
      if (record !== undefined) records.set(record.id, record)
    }
  }

  // `protocolOverrides` is the terse form of one-protocol-per-model config.
  for (const [id, value] of Object.entries(config.protocolOverrides)) {
    const protocol = normalizeProtocol(value)
    if (protocol === undefined) {
      throw new TypeError(
        `dsh-opencode-go: protocolOverrides["${id}"] ${JSON.stringify(value)} is not a protocol`
        + ` (${PROTOCOL_LIST.join(', ')})`,
      )
    }
    const base = records.get(id)
    records.set(id, Object.freeze({
      id,
      name: base?.name ?? displayName(id),
      description: base?.description,
      protocols: Object.freeze([protocol, ...(base?.protocols ?? []).filter((p) => p !== protocol)]),
      inputModalities: base?.inputModalities,
      providerModalities: base?.providerModalities,
      contextWindow: base?.contextWindow ?? config.defaultContextWindow,
      maxTokens: base?.maxTokens ?? config.defaultMaxTokens,
      reasoning: base?.reasoning,
      reasoningEfforts: base?.reasoningEfforts ?? config.reasoningEfforts,
      defaultEffort: base?.defaultEffort,
      tier: base?.tier,
      trainingConsent: base?.trainingConsent ?? requiresTrainingConsent(id),
      capacitySource: base?.capacitySource,
      source: base?.source ?? 'config',
    }))
  }

  // `modelOverrides` reshapes records without restating them.
  for (const [id, value] of Object.entries(config.modelOverrides)) {
    const base = records.get(id)
    const record = normalizeModelEntry({ ...asObject(value), id }, config, base)
    if (record !== undefined) records.set(id, record)
  }

  return records
}

/** One model's preferred protocol, or undefined when the record names none. */
export function preferredProtocol(record) {
  return record?.protocols?.[0]
}

/**
 * Why one catalog record is kept out of the listing, when it is.
 *
 * Two deployment decisions can remove a model from what the harness offers,
 * and they are deliberately separate: `hiddenModels` is this deployment's own
 * choice about its own menu, while `hideTrainingModels` keeps every model whose
 * provider trains on request data out of the list because using one needs a
 * workspace setting this plugin cannot grant.
 *
 * Being absent from the listing is never the same as being unusable: a record
 * stays resolvable and callable, so a session already pinned to a hidden model
 * keeps working. One predicate serves both the listing and the configuration
 * page, so the page cannot claim a model is listed while the runtime drops it.
 *
 * @param {object} record - a catalog record.
 * @param {object} config - the resolved plugin configuration.
 * @returns {'configured' | 'training' | undefined} the reason, or undefined when listed.
 */
export function hiddenReason(record, config) {
  if (config?.hiddenModels?.includes(record?.id) === true) return 'configured'
  if (config?.hideTrainingModels === true && record?.trainingConsent === true) return 'training'
  return undefined
}
