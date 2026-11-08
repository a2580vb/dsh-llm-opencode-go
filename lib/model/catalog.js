/**
 * Model catalog: capability records, protocol preference, and the built-in
 * fallback.
 *
 * `GET /models` names the models the relay serves and, since 2026-11, describes
 * each one: its display name, a description, `limit` (context, input and output
 * caps), `modalities`, `capabilities` (including the reasoning effort ladder)
 * and an `api` map naming the catalogue's preferred wire entry. Discovery keeps
 * those rows (`./cache.js`); this module turns them into records, so a model
 * added after the snapshot ships with its real figures instead of a family
 * guess.
 *
 * The service serves three wire protocols. A record keeps an ordered protocol
 * list: the catalogue's preferred entry first, the remaining protocols behind
 * it. A refusal that names the protocol (`ModelProtocolUnsupported`) retries
 * the next entry, so a wrong first guess costs one refused attempt rather than
 * a failed call.
 *
 * Three sources feed one record, in increasing priority:
 *   1. {@link FALLBACK_MODELS}, measured against the live service, together
 *      with the measured capacity table in `./limits.js` — the fallback for a
 *      deployment whose discovery is off, empty, or served from an old cache.
 *   2. the discovered rows from `GET /models` (ids plus the facts above).
 *   3. `models` / `modelOverrides` / `protocolOverrides` from the plugin config.
 *
 * @module dsh-llm-opencode-go/model/catalog
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
 * Whether one model's upstream requires its own earlier reasoning replayed.
 *
 * DeepSeek's thinking mode refuses a request that carries `tools` unless every
 * previous turn's `reasoning_content` comes back; on the Responses wire the Go
 * relay takes that as a plain-text `reasoning` item. The requirement belongs to
 * that provider rather than to the protocol: the OpenAI- and xAI-served models
 * validate a replayed reasoning item against state this harness does not retain
 * and answer a mismatch with an opaque `400`, so they must keep sending none.
 *
 * The relay serves one provider family per id prefix and every DeepSeek id the
 * catalogue lists shares this one, so the prefix is the fact instead of a list
 * that a new release would silently fall out of.
 *
 * @param {unknown} id - a model id.
 * @returns {boolean} true when prior reasoning must be replayed for this model.
 */
export function requiresReasoningReplay(id) {
  return String(id).toLowerCase().startsWith('deepseek-')
}

/**
 * The thinking levels assumed for a model the service does not describe.
 *
 * A discovered row carries the model's own effort ladder; this list answers for
 * a version 1 cache, a configuration-only deployment, or a row whose
 * `capabilities.reasoning.supported` is true without naming levels. `minimal`
 * is included because Chat Completions accepts it, and the resolver narrows the
 * list per protocol: the Responses API has no `minimal`, so a Responses model
 * never advertises it. `none` is not a level here either: thinking off is
 * expressed by omitting the effort, not by naming it.
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
 * A row can be marked `retired`: the catalog is append-only, so a model the
 * service stops serving keeps its row — a session pinned to it still resolves
 * its last measured figures and gets the service's own refusal — but the row is
 * never listed and no protocol is tried for it. `replacement` is the id the
 * service names when it retires a model in favour of another.
 *
 * @param {string} id - the model id.
 * @param {object} extra - the measured protocol list, reasoning flag and retirement state.
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
    // Likewise derived from the id: the model's provider decides whether its
    // own reasoning has to come back on the Responses wire.
    requiresReasoningReplay: requiresReasoningReplay(id),
    retired: extra.retired === true,
    ...extra,
  })
}

/**
 * The protocols a model record tries, most-preferred first.
 *
 * The service serves three wire protocols, and every model `GET /models` lists
 * accepts all three as of 2026-11-08. The catalogue still names one preferred
 * entry per model through its `api` map, and that is the first attempt; the
 * other protocols stay behind it as fallbacks. A model that answers
 * `400 ModelProtocolUnsupported` moves to the next entry, so a preference this
 * table was wrong about costs an attempt, not a call.
 *
 * @param {string} preferred - the protocol to try first.
 * @returns {readonly string[]} every protocol, the preferred one first.
 */
function protocolOrder(preferred) {
  return Object.freeze([preferred, ...PROTOCOL_LIST.filter((protocol) => protocol !== preferred)])
}

/**
 * The built-in catalog, measured against the live service.
 *
 * Every id `GET /models` listed on 2026-11-08 has an active row here, so no
 * served model has to discover its own protocol by failing first.
 *
 * The table is **append-only**. A model the service stops serving is not
 * deleted: its row is marked `retired`, which keeps it in the catalog (an
 * existing session still resolves its last measured figures) while keeping it
 * out of every picker, and lets a caller's failure be the service's own
 * `MODEL_DEPRECATED` / `MODEL_UNAVAILABLE` rather than an unknown-model error.
 * New ids are added as they appear; nothing historical is removed. The retired
 * rows' capacity still lives in `./limits.js`'s `DELISTED_CAPABILITIES`.
 *
 * The first protocol of each row is the entry the service's own catalogue names
 * (`api`); the order behind it follows the package's protocol order. Re-measure
 * with `scripts/probe-protocols.mjs` when the service adds a model.
 *
 * Contributor-tier ids are served by Go but gated behind the workspace
 * training-consent setting (`TRAINING_CONSENT_MODELS`). They stay selectable so
 * the selector can state what they need, rather than hiding the option.
 */
export const FALLBACK_MODELS = Object.freeze([
  // Chat Completions preferred: the relay's own ids and most of its catalogue.
  model('beam-free', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('deepseek-v4.1-flash', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('deepseek-v4-pro', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('glm-5.2', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('glm-5.3', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('glm-5.3-flash', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('hy3', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('hy4', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('hy4-preview', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('iceman-contributor-free', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('kimi-k2.7-code', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('kimi-k3', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('kimi-k3.1-pro', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('longcat-2.0', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('mimo-v2.6-flash', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('mimo-v2.6-pro', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('minimax-m3.1-flash', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),
  model('step-5-preview', { protocols: protocolOrder(PROTOCOLS.CHAT), reasoning: true }),

  // Responses preferred: the OpenAI-shaped ids.
  model('crouton-alpha-free', { protocols: protocolOrder(PROTOCOLS.RESPONSES), reasoning: true }),
  model('gemini-4-argon', { protocols: protocolOrder(PROTOCOLS.RESPONSES), reasoning: true }),
  model('gpt-5.6-luna', { protocols: protocolOrder(PROTOCOLS.RESPONSES), reasoning: true }),
  model('gpt-6-luna', { protocols: protocolOrder(PROTOCOLS.RESPONSES), reasoning: true }),
  model('grok-4.7', { protocols: protocolOrder(PROTOCOLS.RESPONSES), reasoning: true }),
  model('muse-spark-1.2-contributor', { protocols: protocolOrder(PROTOCOLS.RESPONSES), reasoning: true, tier: 'contributor' }),
  model('muse-spark-1.3-contributor', { protocols: protocolOrder(PROTOCOLS.RESPONSES), reasoning: true, tier: 'contributor' }),

  // Anthropic Messages preferred: the Anthropic-shaped ids.
  model('claude-haiku-5-5', { protocols: protocolOrder(PROTOCOLS.ANTHROPIC), reasoning: true }),
  model('minimax-m3', { protocols: protocolOrder(PROTOCOLS.ANTHROPIC), reasoning: true }),
  model('qwen3.7-plus', { protocols: protocolOrder(PROTOCOLS.ANTHROPIC), reasoning: true }),
  model('qwen3.8-flash', { protocols: protocolOrder(PROTOCOLS.ANTHROPIC), reasoning: true }),
  model('qwen3.8-max', { protocols: protocolOrder(PROTOCOLS.ANTHROPIC), reasoning: true }),

  // Retired rows, kept rather than deleted (see the table's comment above). The
  // protocols are the last measured set; a retired id fails before any protocol
  // is chosen, so the list only serves to describe what it used to answer.
  // `replacement` is the id the service names when it retires a model into a
  // successor. Add rows here when the service retires a model; never remove one.
  model('deepseek-v4-flash', { protocols: [...PROTOCOL_LIST], reasoning: true, retired: true }),
  model('deepseek-v4-flash-vision-exp', { protocols: [...PROTOCOL_LIST], reasoning: true, retired: true }),
  model('deepseek-flash', { protocols: [...PROTOCOL_LIST], reasoning: true, retired: true }),
  model('glm-5.1', { protocols: [PROTOCOLS.CHAT], reasoning: true, retired: true, replacement: 'glm-5.3' }),
  model('grok-4.6', { protocols: [PROTOCOLS.RESPONSES], reasoning: true, retired: true }),
  model('kimi-k2.6', { protocols: [PROTOCOLS.CHAT], reasoning: true, retired: true, replacement: 'kimi-k2.7-code' }),
  model('longcat-2.5-preview-free', { protocols: [PROTOCOLS.CHAT], reasoning: true, retired: true }),
  model('mimo-v2.5', { protocols: [PROTOCOLS.CHAT], reasoning: true, retired: true, replacement: 'mimo-v2.6-flash' }),
  model('mimo-v2.5-pro', { protocols: [PROTOCOLS.CHAT], reasoning: true, retired: true, replacement: 'mimo-v2.6-pro' }),
  model('minimax-m2.5', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true, retired: true }),
  model('minimax-m2.7', { protocols: [PROTOCOLS.ANTHROPIC], reasoning: true, retired: true, replacement: 'minimax-m3.1-flash' }),
  model('omen-alpha', { protocols: [PROTOCOLS.CHAT], reasoning: true, retired: true }),
  model('qwen3.6-plus', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true, retired: true }),
  model('qwen3.7-max', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true, retired: true, replacement: 'qwen3.8-max' }),
  model('space-bunny-free', { protocols: [PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC], reasoning: true, retired: true }),
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
    throw new TypeError(`dsh-llm-opencode-go: ${context} "input" must be an array`)
  }
  const out = []
  for (const item of value) {
    const text = String(item).trim()
    if (text === 'text') continue
    if (text !== 'image') {
      throw new TypeError(
        `dsh-llm-opencode-go: ${context} "input" names "${text}", which this adapter cannot send`
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
    throw new TypeError('dsh-llm-opencode-go: a model entry "modalities" must be an array or { input: [...] }')
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
    throw new TypeError(`dsh-llm-opencode-go: ${context} must be a positive number`)
  }
  return Math.floor(number)
}

/** A declared boolean, or a TypeError naming the model and the field. */
function declaredBoolean(value, id, field) {
  if (value === true || value === false) return value
  throw new TypeError(`dsh-llm-opencode-go: model "${id}" "${field}" must be a boolean`)
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
    throw new TypeError(`dsh-llm-opencode-go: a model entry must be an object, received ${JSON.stringify(raw)}`)
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
          throw new TypeError(`dsh-llm-opencode-go: model "${id}" "reasoning" must be a boolean`)
        })()

  const reasoningEfforts = source.efforts === undefined || source.efforts === null
    ? base?.reasoningEfforts ?? config.reasoningEfforts
    : (() => {
      if (!Array.isArray(source.efforts)) {
        throw new TypeError(`dsh-llm-opencode-go: model "${id}" "efforts" must be an array`)
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
  // An entry that states no capacity still names an id: the measured table (or
  // its family row) describes it when the catalogue does, and the configured
  // defaults only answer for an id nothing has measured. This is what the
  // fallback table is for; a `modelSource: config` deployment has no discovery
  // rows to supply the fact otherwise.
  const measured = capacity === undefined && outputCap === undefined && base === undefined
    ? capabilityFor(id, {
      contextWindow: config.defaultContextWindow,
      maxTokens: config.defaultMaxTokens,
    })
    : undefined
  // An entry may state this either way: absent, the id's own gate applies (the
  // measured list above), so a deployment never has to repeat a fact the service
  // already fixes. A deployment that reaches a relay without the gate — a
  // compatible gateway, a region with different policy — can say so explicitly.
  const trainingConsent = source.trainingConsent === undefined
    ? (base?.trainingConsent ?? requiresTrainingConsent(id))
    : declaredBoolean(source.trainingConsent, id, 'trainingConsent')
  // A fact about the provider, not something a deployment tunes: an entry that
  // restates the id keeps whatever the record already derived for it.
  const reasoningReplay = base?.requiresReasoningReplay ?? requiresReasoningReplay(id)

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
    providerModalities: modalities ?? base?.providerModalities ?? measured?.modalities,
    contextWindow: capacity ?? base?.contextWindow ?? measured?.contextWindow ?? config.defaultContextWindow,
    maxTokens: outputCap ?? base?.maxTokens ?? measured?.maxTokens ?? config.defaultMaxTokens,
    reasoning,
    reasoningEfforts,
    defaultEffort: source.defaultEffort === undefined || source.defaultEffort === null
      ? base?.defaultEffort
      : String(source.defaultEffort),
    tier: source.tier === undefined ? base?.tier : String(source.tier),
    trainingConsent,
    requiresReasoningReplay: reasoningReplay,
    // Retirement is a fact about the built-in row, not a deployment setting: an
    // entry that refines a retired model keeps it retired. Only discovery, which
    // sees the service serve the id again, clears the mark.
    retired: base?.retired === true,
    replacement: base?.replacement,
    capacitySource: capacity === undefined && outputCap === undefined
      ? (base?.capacitySource ?? measured?.source)
      : 'config',
    source: base?.source ?? 'config',
  })
}

/**
 * The protocol identifiers a `/models` row's `api` map can name.
 *
 * One entry per wire protocol this adapter can carry. `generate-content`
 * (Google) is deliberately absent: the catalogue names it for one model, but
 * this adapter has no transport for it, and the relay still serves that model
 * over the three protocols above.
 */
const API_PROTOCOLS = Object.freeze({
  'chat-completions': PROTOCOLS.CHAT,
  responses: PROTOCOLS.RESPONSES,
  messages: PROTOCOLS.ANTHROPIC,
})

/** The protocol one discovery row prefers, as its `api` map names it. */
function discoveryProtocolPreference(row) {
  const keys = Array.isArray(row?.api) ? row.api : []
  for (const key of keys) {
    const protocol = API_PROTOCOLS[key]
    if (protocol !== undefined) return protocol
  }
  return undefined
}

/**
 * Map one discovery row's MIME modality list onto the vocabulary this package
 * shares with the catalogue.
 *
 * `/models` names concrete types (`image/jpeg`, `application/pdf`, …) while
 * `./limits.js` and `model/capabilities.js` speak `text`/`image`/`video`/
 * `audio`/`pdf`. `text` is always present: a model that can take another
 * modality can still take text, and this adapter can always send it.
 *
 * @param {readonly string[] | undefined} mimes - the row's `modalities.input`.
 * @returns {readonly string[] | undefined} catalogue-vocabulary modalities, or undefined when the row names none.
 */
export function harnessModalities(mimes) {
  if (!Array.isArray(mimes) || mimes.length === 0) return undefined
  const present = new Set(['text'])
  for (const mime of mimes) {
    const value = String(mime).trim().toLowerCase()
    if (value === 'text' || value.startsWith('text/')) present.add('text')
    else if (value.startsWith('image/')) present.add('image')
    else if (value.startsWith('video/')) present.add('video')
    else if (value.startsWith('audio/')) present.add('audio')
    else if (value === 'application/pdf' || value === 'pdf') present.add('pdf')
  }
  return Object.freeze(['text', 'image', 'video', 'audio', 'pdf'].filter((modality) => present.has(modality)))
}

/** The effort ladder one discovery row states, in the order the service lists it. */
function discoveryEfforts(row) {
  const efforts = Array.isArray(row?.reasoning?.efforts) ? row.reasoning.efforts : []
  const levels = efforts.filter((level) => typeof level === 'string' && level !== 'none' && level.trim() !== '')
  return levels.length === 0 ? undefined : Object.freeze([...new Set(levels)])
}

/**
 * One discovery row as a catalog record, refined onto the record already known
 * for that id when there is one.
 *
 * The live row wins over the built-in table wherever it states a fact: capacity,
 * modalities, reasoning, name and description. A record keeps everything the
 * fallback table knew that the row does not restate (contributor tier, default
 * effort, a config-level input restriction), so the two sources compose instead
 * of one erasing the other.
 *
 * Protocol lists are widened, not replaced: the record's known protocols keep
 * their order and every other protocol is appended, because the service accepts
 * all three for the models it lists. A version 1 cache row carries no `api`
 * map, so it adds no preference of its own; an id with no built-in row gets the
 * catalogue's preferred entry first, or the configured default protocol.
 *
 * @param {object} row - one normalized discovery row (`./cache.js`).
 * @param {object} config - the resolved plugin configuration.
 * @param {object} [base] - the record already built for this id, when there is one.
 * @returns {object} a frozen catalog record.
 */
export function discoveryRecord(row, config, base) {
  const id = String(row.id)
  const limit = row.limit
  const capability = base === undefined
    ? capabilityFor(id, { contextWindow: config.defaultContextWindow, maxTokens: config.defaultMaxTokens })
    : undefined
  const contextWindow = limit?.context ?? base?.contextWindow ?? capability.contextWindow
  const maxTokens = limit?.output ?? base?.maxTokens ?? capability.maxTokens
  const preferred = discoveryProtocolPreference(row) ?? config.defaultProtocol
  const known = base?.protocols ?? []
  const protocols = known.length > 0
    ? [...known, ...PROTOCOL_LIST.filter((protocol) => !known.includes(protocol))]
    : [preferred, ...PROTOCOL_LIST.filter((protocol) => protocol !== preferred)]
  const providerModalities = harnessModalities(row.modalities) ?? base?.providerModalities ?? capability?.modalities
  const efforts = discoveryEfforts(row)
  return Object.freeze({
    id,
    name: row.name ?? base?.name ?? displayName(id),
    description: row.description ?? base?.description,
    protocols: Object.freeze(protocols),
    inputModalities: base?.inputModalities,
    providerModalities,
    contextWindow,
    maxTokens,
    // A row that says reasoning is unsupported keeps it off; a row that names
    // the ladder turns it on; a version 1 row says nothing and the fallback
    // table's answer stands.
    reasoning: row.reasoning === undefined ? base?.reasoning : row.reasoning.supported,
    reasoningEfforts: efforts ?? base?.reasoningEfforts ?? config.reasoningEfforts,
    defaultEffort: base?.defaultEffort,
    tier: base?.tier,
    trainingConsent: base?.trainingConsent ?? requiresTrainingConsent(id),
    requiresReasoningReplay: base?.requiresReasoningReplay ?? requiresReasoningReplay(id),
    // A live row is what makes a model current again; a row restored from a
    // version 1 cache is only a name for an id the service listed *when that
    // file was written*, so it may refine the record but it cannot revive one
    // the built-in table has since retired. Only the next live fetch can.
    retired: row.legacy === true ? (base?.retired === true) : false,
    capacitySource: limit === undefined ? (base?.capacitySource ?? capability?.source ?? 'assumed') : 'GET /models',
    source: 'discovered',
  })
}

/**
 * Build the effective catalog for one configuration snapshot.
 *
 * @param {object} config - the resolved plugin configuration.
 * @param {readonly object[]} [discovered] - rows reported by `GET /models`.
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
      records.set(id, discoveryRecord(row.id === id ? row : { ...row, id }, config, records.get(id)))
    }
    for (const raw of config.models) {
      // The deployment's entry refines the record discovery produced: a field it
      // does not restate keeps the live fact rather than the config default.
      const id = raw?.id === undefined ? undefined : String(raw.id).trim()
      const record = normalizeModelEntry(raw, config, id === undefined ? undefined : records.get(id))
      if (record !== undefined) records.set(record.id, record)
    }
  }

  // `protocolOverrides` is the terse form of one-protocol-per-model config.
  for (const [id, value] of Object.entries(config.protocolOverrides)) {
    const protocol = normalizeProtocol(value)
    if (protocol === undefined) {
      throw new TypeError(
        `dsh-llm-opencode-go: protocolOverrides["${id}"] ${JSON.stringify(value)} is not a protocol`
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
      requiresReasoningReplay: base?.requiresReasoningReplay ?? requiresReasoningReplay(id),
      // Choosing a protocol is not a statement about whether the model still
      // exists: a retired id stays retired through this reshape, exactly as it
      // does through `modelOverrides`.
      retired: base?.retired === true,
      replacement: base?.replacement,
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

  // Variants come last: each one refines the record that is already final, so
  // a variant cannot be reshaped by an override that was meant for its base.
  for (const variant of config.modelVariants ?? []) {
    const base = records.get(variant.model)
    // A variant whose base the catalog does not list is not offered: it would
    // advertise capacities nothing measured, and every call through it would
    // fail at the far end. `unmatchedVariantModels` reports the ids instead.
    if (base === undefined) continue
    records.set(variantId(variant.model, variant.name), variantRecord(base, variant, config))
  }

  return records
}

/** The catalog id one variant is offered under: `<model>@<name>`. */
export function variantId(model, name) {
  return `${model}@${name}`
}

/**
 * Split a catalog id into the variant it names, when it names one.
 *
 * A base model id may not itself contain `@` (see `config.js`), so the first
 * `@` is always the separator and a variant id never nests.
 *
 * @param {string} id - a catalog id.
 * @returns {{ model: string, name: string } | undefined} the parts, or undefined.
 */
export function splitVariantId(id) {
  const text = String(id ?? '')
  const at = text.indexOf('@')
  if (at <= 0 || at === text.length - 1) return undefined
  return { model: text.slice(0, at), name: text.slice(at + 1) }
}

/**
 * The model id the wire must carry.
 *
 * A variant is a local alias: the harness selects and reports `<model>@<name>`,
 * while the service only knows `<model>`. Everything that leaves this process
 * asks here, so the alias never reaches the provider.
 *
 * @param {object} record - a catalog record.
 * @returns {string} the provider's own model id.
 */
export function wireModelId(record) {
  return record?.variantOf ?? record?.id
}

/**
 * One variant as a catalog record: the base's facts with the variant's changes.
 *
 * Two contradictions are refused at catalog assembly rather than absorbed,
 * because each would otherwise fail silently somewhere far from the mistake:
 * a variant that asks for a thinking level its model does not offer, and one
 * that asks for thinking on a model that does not think.
 *
 * @param {object} base - the final record of the model being varied.
 * @param {object} variant - one resolved `modelVariants` entry.
 * @param {object} config - the resolved plugin configuration.
 * @returns {object} the frozen variant record.
 */
function variantRecord(base, variant, config) {
  const id = variantId(variant.model, variant.name)
  const protocols = variant.protocol === undefined
    ? base.protocols
    : Object.freeze([variant.protocol, ...(base.protocols ?? []).filter((entry) => entry !== variant.protocol)])
  const efforts = base.reasoningEfforts ?? config.reasoningEfforts
  if (variant.effort !== undefined) {
    if (base.reasoning !== true) {
      throw new TypeError(
        `dsh-llm-opencode-go: modelVariants "${id}" sets an effort, but model "${base.id}" does not support reasoning`,
      )
    }
    if (!efforts.includes(variant.effort)) {
      throw new TypeError(
        `dsh-llm-opencode-go: modelVariants "${id}" effort ${JSON.stringify(variant.effort)} is not one model`
        + ` "${base.id}" offers (${efforts.join(', ')})`,
      )
    }
  }
  return Object.freeze({
    ...base,
    id,
    name: variant.label ?? `${base.name} (${variant.name})`,
    protocols,
    contextWindow: variant.contextWindow ?? base.contextWindow,
    maxTokens: variant.maxTokens ?? base.maxTokens,
    reasoning: base.reasoning,
    // A variant of a thinking model is a thinking model: naming the level a
    // call opens with is the whole point of the preset, so it becomes the
    // model's own default. A variant that names none keeps whatever the base
    // had, which is usually nothing.
    defaultEffort: variant.effort ?? base.defaultEffort,
    capacitySource: variant.contextWindow === undefined && variant.maxTokens === undefined
      ? base.capacitySource
      : 'variant',
    variantOf: variant.model,
    variantName: variant.name,
    source: 'variant',
  })
}

/**
 * The models named by `modelVariants` that the catalog does not list.
 *
 * A variant is dropped when its base is absent (see {@link variantRecord}), and
 * this is how a deployment hears about it: an id nothing matches is a typo, or
 * a model the service no longer serves.
 *
 * @param {ReadonlyMap<string, object>} records - the assembled catalog.
 * @param {object} config - the resolved plugin configuration.
 * @returns {string[]} the unmatched base model ids, de-duplicated.
 */
export function unmatchedVariantModels(records, config) {
  const missing = []
  for (const variant of config.modelVariants ?? []) {
    if (!records.has(variant.model) && !missing.includes(variant.model)) missing.push(variant.model)
  }
  return missing
}

/** One model's preferred protocol, or undefined when the record names none. */
export function preferredProtocol(record) {
  return record?.protocols?.[0]
}

/**
 * Why one catalog record is kept out of the listing, when it is.
 *
 * Three things can remove a model from what the harness offers, and they are
 * deliberately separate: `hiddenModels` is this deployment's own choice about
 * its own menu, `retired` marks a model the service no longer serves (the row
 * stays for existing sessions but must not be offered), and `hideTrainingModels`
 * keeps every model whose provider trains on request data out of the list
 * because using one needs a workspace setting this plugin cannot grant. The
 * deployment's own choice is reported first, so a historically hidden id keeps
 * its explanation even after the model retires.
 *
 * Being absent from the listing is never the same as being unusable: a record
 * stays resolvable and callable, so a session already pinned to a hidden or
 * retired model still reaches the service (which is what can name a
 * replacement). One predicate serves both the listing and the configuration
 * page, so the page cannot claim a model is listed while the runtime drops it.
 *
 * @param {object} record - a catalog record.
 * @param {object} config - the resolved plugin configuration.
 * @returns {'configured' | 'retired' | 'training' | undefined} the reason, or undefined when listed.
 */
export function hiddenReason(record, config) {
  if (config?.hiddenModels?.includes(record?.id) === true) return 'configured'
  if (record?.retired === true) return 'retired'
  if (config?.hideTrainingModels === true && record?.trainingConsent === true) return 'training'
  return undefined
}
