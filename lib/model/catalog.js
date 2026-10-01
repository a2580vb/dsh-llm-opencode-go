/**
 * Model catalog: capability records, protocol selection, and the built-in
 * fallback.
 *
 * OpenCode Go tells us *which ids exist* (`GET /models`) but not what each id
 * can do, and it is strict about protocol: a model that only speaks
 * `/responses` answers `400 ModelProtocolUnsupported` on `/chat/completions`
 * rather than degrading. So a protocol per model is a hard requirement, and
 * this module is where that fact lives.
 *
 * Three sources feed one record, in increasing priority:
 *   1. {@link FALLBACK_MODELS}, measured against the live service.
 *   2. the discovered id list from `GET /models` (adds ids we have not seen).
 *   3. `models` / `modelOverrides` / `protocolOverrides` from the plugin config.
 *
 * @module dsh-opencode-go/model/catalog
 */

import { PROTOCOLS, PROTOCOL_LIST, normalizeProtocol } from '../config.js'

/** The context window assumed for a model the service does not describe. */
export const FALLBACK_CONTEXT_WINDOW = 262_144

/** The output cap assumed for a model the service does not describe. */
export const FALLBACK_MAX_TOKENS = 32_768

/**
 * The thinking levels assumed for a model the service does not describe.
 *
 * `minimal` is included because Chat Completions accepts it, and the resolver
 * narrows the list per protocol: the Responses API has no `minimal`, so a
 * Responses model never advertises it.
 */
export const FALLBACK_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'max'])

/** One fallback catalog entry with the shared defaults applied. */
function model(id, extra) {
  return Object.freeze({
    id,
    name: displayName(id),
    // OpenCode Go publishes no capacity figures, so a record that does not
    // override these takes the adapter's documented fallbacks. They are filled
    // in here rather than left undefined so every consumer of a record — the
    // resolver, the request builder, a model selector — reads one shape.
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxTokens: FALLBACK_MAX_TOKENS,
    reasoningEfforts: FALLBACK_EFFORTS,
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
 * Measured against the live service; `deepseek-*` ids accept every protocol,
 * and each group is ordered by what that model family is documented for.
 */
export const FALLBACK_MODELS = Object.freeze([
  // Reasoning coding models: reachable over all three protocols.
  model('deepseek-v4-pro', { protocols: [...PROTOCOL_LIST], reasoning: true }),
  model('deepseek-v4-flash', { protocols: [...PROTOCOL_LIST], reasoning: true }),
  model('deepseek-v4.1-flash', { protocols: [...PROTOCOL_LIST], reasoning: true }),
  model('deepseek-flash', { protocols: [...PROTOCOL_LIST], reasoning: true }),
  model('deepseek-v4-flash-vision-exp', { protocols: [...PROTOCOL_LIST], reasoning: true }),

  // Responses-only family.
  model('gpt-6-luna', { protocols: [PROTOCOLS.RESPONSES], reasoning: true }),
  model('gpt-5.6-luna', { protocols: [PROTOCOLS.RESPONSES], reasoning: true }),
  model('grok-4.7', { protocols: [PROTOCOLS.RESPONSES], reasoning: true }),
  model('grok-4.6', { protocols: [PROTOCOLS.RESPONSES], reasoning: true }),

  // Anthropic-Messages-native family.
  model('minimax-m2.7', { protocols: [PROTOCOLS.ANTHROPIC], reasoning: true }),

  // Chat Completions plus Anthropic Messages.
  model('minimax-m3', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('kimi-k3', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('qwen3.8-max', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('qwen3.8-flash', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('qwen3.7-plus', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),
  model('space-bunny-free', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true }),

  // Chat Completions only.
  model('glm-5.3', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('glm-5.3-flash', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('glm-5.2', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('kimi-k2.7-code', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('mimo-v2.6-pro', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('mimo-v2.6-flash', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('mimo-v2.5-pro', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('mimo-v2.5', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('longcat-2.0', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('longcat-2.5-preview-free', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('hy3', { protocols: [PROTOCOLS.CHAT], reasoning: true }),
  model('hy4-preview', { protocols: [PROTOCOLS.CHAT], reasoning: true }),

  // Contributor-tier ids: present in /models, refused for this account on every
  // protocol. Kept in the catalog so the reason is a clear provider error
  // instead of a missing-model surprise.
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

/** Normalize one modality list, dropping anything the harness does not model. */
function normalizeInput(value, context) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new TypeError(`dsh-opencode-go: ${context} "input" must be an array`)
  }
  const out = []
  for (const item of value) {
    const text = String(item)
    if (text === 'image' && !out.includes('image')) out.push('image')
  }
  // Text is always present; declaring it explicitly would be noise.
  return Object.freeze(['text', ...out])
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
    contextWindow: positiveInt(source.contextWindow, `model "${id}" "contextWindow"`)
      ?? base?.contextWindow
      ?? config.defaultContextWindow,
    maxTokens: positiveInt(source.maxTokens, `model "${id}" "maxTokens"`)
      ?? base?.maxTokens
      ?? config.defaultMaxTokens,
    reasoning,
    reasoningEfforts,
    defaultEffort: source.defaultEffort === undefined || source.defaultEffort === null
      ? base?.defaultEffort
      : String(source.defaultEffort),
    tier: source.tier === undefined ? base?.tier : String(source.tier),
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
      records.set(id, Object.freeze({
        id,
        name: row.name === undefined ? displayName(id) : String(row.name),
        protocols: Object.freeze([config.defaultProtocol]),
        inputModalities: undefined,
        contextWindow: config.defaultContextWindow,
        maxTokens: config.defaultMaxTokens,
        reasoning: undefined,
        reasoningEfforts: config.reasoningEfforts,
        defaultEffort: undefined,
        tier: undefined,
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
      contextWindow: base?.contextWindow ?? config.defaultContextWindow,
      maxTokens: base?.maxTokens ?? config.defaultMaxTokens,
      reasoning: base?.reasoning,
      reasoningEfforts: base?.reasoningEfforts ?? config.reasoningEfforts,
      defaultEffort: base?.defaultEffort,
      tier: base?.tier,
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
