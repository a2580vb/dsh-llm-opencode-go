/**
 * The graphical-configuration bridge: the one HTTP surface the plugin's own
 * page in the Harness web client talks to.
 *
 * The harness exposes typed Host Remote namespaces only for capabilities its
 * own build selects, so a plugin that ships a page owns its own carrier. This
 * bridge is that carrier: a small JSON API under {@link UI_ROUTE_PREFIX},
 * mounted on the harness's `webServer` and reachable only through the
 * connection service's request policy (a browser session cookie, plus the
 * host/origin fence). It never returns secret material — a credential is
 * reported the way `credentials.describe()` reports it, never by value.
 *
 * Feature order builds on this file: each later feature adds endpoints (or
 * fields on {@link MANAGED_CONFIG_FIELDS}) without changing the shape the page
 * already uses.
 *
 * @module dsh-llm-opencode-go/ui/bridge
 */

import { PROTOCOL_LIST, normalizeProtocol } from '../config.js'
import { PLUGIN_IDENTITY } from '../error/errors.js'
import {
  headerValue,
  readJsonBody,
  rejectionFor,
  sendJson,
  sendMethodNotAllowed,
} from './http.js'

/** The route prefix every endpoint of this plugin lives under. */
export const UI_ROUTE_PREFIX = '/opencode-go'

/** The endpoints, exactly as registered on the web server. */
export const UI_ROUTES = Object.freeze({
  /** `GET` — everything the page renders on load. */
  state: `${UI_ROUTE_PREFIX}/state`,
  /** `GET` — the whole catalog, listed or not, with each hidden reason. */
  models: `${UI_ROUTE_PREFIX}/models`,
  /** `POST` — re-read `GET /models` and report what changed. */
  refresh: `${UI_ROUTE_PREFIX}/refresh`,
  /** `GET` — what this route has spent, per day and per model. */
  usage: `${UI_ROUTE_PREFIX}/usage`,
  /** `GET` — the subscription's own quota, read from the service. */
  subscription: `${UI_ROUTE_PREFIX}/subscription`,
  /**
   * `GET` — whether the quota answer on file has gone old, answered from memory.
   *
   * This one never leaves the machine: it is how a page finds out that a read
   * would be worth making, without making one to find out. See
   * `SubscriptionReader.status`.
   */
  activity: `${UI_ROUTE_PREFIX}/activity`,
  /** `POST` — write the profile-layer overrides this plugin manages. */
  config: `${UI_ROUTE_PREFIX}/config`,
  /** `POST` set / `DELETE` clear — the API key behind `apiKeyEnv`. */
  credential: `${UI_ROUTE_PREFIX}/credential`,
})

/**
 * The configuration fields the page may write.
 *
 * Everything else in the row config stays where it is: the write path rebuilds
 * the profile override from the live entry, so a field this list does not name
 * keeps whichever layer set it. Each feature adds the fields it owns.
 */
export const MANAGED_CONFIG_FIELDS = Object.freeze([
  'apiKeyEnv',
  'hiddenModels',
  'modelVariants',
  'subscriptionMinIntervalSeconds',
  'subscriptionMaxIntervalSeconds',
])

/**
 * The two seconds values that bound the quota schedule, in the order they bound
 * it: the floor first, then the ceiling.
 *
 * They are a pair and are validated as one, because either alone is a legal
 * number and the pair is what can be wrong. See {@link validateFieldPair}.
 */
export const INTERVAL_FIELDS = Object.freeze([
  'subscriptionMinIntervalSeconds',
  'subscriptionMaxIntervalSeconds',
])

/** The keys one `modelVariants` entry may carry, and nothing else. */
export const VARIANT_FIELDS = Object.freeze([
  'model',
  'name',
  'label',
  'protocol',
  'effort',
  'contextWindow',
  'maxTokens',
])

/**
 * The module specifier the Loader row's `name` carries, used to find the row
 * this page configures when its id is not the default one.
 */
export const MODULE_NAME = PLUGIN_IDENTITY.product

/**
 * Check one API key the way the harness's own Models page does.
 *
 * Two rules, both about the value's journey rather than its content: it must be
 * something an HTTP header can carry, and it must be the key alone — a pasted
 * `NAME=value` line or a shelved quoted value is the mistake this catches
 * before it is stored, where it would fail as an opaque 401 later.
 *
 * @param {unknown} raw - the submitted value.
 * @returns {{ ok: true, value: string } | { ok: false, message: string }} the verdict.
 */
export function validateApiKey(raw) {
  if (typeof raw !== 'string') return { ok: false, message: 'the API key must be a string' }
  const value = raw.trim()
  if (value === '') return { ok: false, message: 'the API key must not be empty' }
  if (!/^[\x21-\x7e]+$/.test(value)) {
    return { ok: false, message: 'the API key must be printable ASCII with no whitespace (an HTTP header value)' }
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
    return { ok: false, message: 'paste the key alone, not an "NAME=value" environment line' }
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return { ok: false, message: 'paste the key without shell quotes' }
  }
  return { ok: true, value }
}

/**
 * Check one managed field's value before it reaches the profile patch.
 *
 * The plugin's own Config schema validates the candidate anyway, so this is not
 * the security boundary: it exists so a wrong shape is answered with the field
 * and the expectation instead of a loader message the page can only relay.
 *
 * @param {string} field - one of {@link MANAGED_CONFIG_FIELDS}.
 * @param {unknown} value - the submitted value.
 * @returns {string | undefined} a message when the value is unusable.
 */
export function validateFieldValue(field, value) {
  if (field === 'apiKeyEnv') {
    if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim())) {
      return 'apiKeyEnv must be a credential reference such as OPENCODE_GO_API_KEY'
    }
    return undefined
  }
  if (INTERVAL_FIELDS.includes(field)) {
    // The resolution behind this field accepts any positive number, so the page
    // refuses exactly what the schema refuses: zero and below are a schedule with
    // no interval at all, which is the poll the schedule exists to replace.
    const seconds = typeof value === 'number' ? value : Number.NaN
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return `${field} must be a positive number of seconds`
    }
    return undefined
  }
  if (field === 'hiddenModels') {
    if (!Array.isArray(value)) return 'hiddenModels must be an array of model ids'
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        return 'every hiddenModels entry must be a non-empty model id'
      }
    }
    return undefined
  }
  if (field === 'modelVariants') {
    if (!Array.isArray(value)) return 'modelVariants must be an array of variant entries'
    const seen = new Set()
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return 'every modelVariants entry must be an object naming a model and a variant'
      }
      const model = typeof entry.model === 'string' ? entry.model.trim() : ''
      const name = typeof entry.name === 'string' ? entry.name.trim() : ''
      if (model === '' || /[\s@]/.test(model)) {
        return 'every modelVariants entry needs a "model": a model id with no whitespace and no "@"'
      }
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        return `modelVariants "${model}" needs a "name" of letters, digits, dot, dash, or underscore`
      }
      if (entry.protocol !== undefined && entry.protocol !== null && normalizeProtocol(entry.protocol) === undefined) {
        return `modelVariants "${model}@${name}" protocol must be one of ${PROTOCOL_LIST.join(', ')}`
      }
      for (const capacity of ['contextWindow', 'maxTokens']) {
        const raw = entry[capacity]
        if (raw === undefined || raw === null) continue
        if (!Number.isInteger(Number(raw)) || Number(raw) <= 0) {
          return `modelVariants "${model}@${name}" ${capacity} must be a positive integer`
        }
      }
      // Every key this entry may carry, and nothing else: the value is written
      // into the profile patch verbatim, so an unknown key (a typo, or a shape
      // the page echoed back from a snapshot) would be persisted rather than
      // reported.
      const unknown = Object.keys(entry).filter((key) => !VARIANT_FIELDS.includes(key))
      if (unknown.length > 0) {
        return `modelVariants "${model}@${name}" carries ${unknown.join(', ')}, which the config does not declare (${VARIANT_FIELDS.join(', ')})`
      }
      const id = `${model}@${name}`
      if (seen.has(id)) return `modelVariants declares "${id}" twice; a variant id must be unique`
      seen.add(id)
    }
    return undefined
  }
  return undefined
}

/**
 * Check the two schedule intervals against each other, given one write.
 *
 * Each is a legal number on its own, so neither can be rejected alone: what can
 * be wrong is the pair. A floor above the ceiling describes a schedule with no
 * interval that satisfies both, and the resolution behind this would silently
 * lift the ceiling to meet the floor — so a reader who asked for a 1-hour floor
 * and a 30-minute ceiling would be shown a 1-hour ceiling and never learn that
 * their second number was overruled. Refusing the write says so instead.
 *
 * A field the write does not mention is checked as the value now in force, so
 * raising only the floor past an unchanged ceiling is caught too. A field that
 * is neither submitted nor resolved cannot be checked and is not guessed at.
 *
 * @param {object} set - the field values this write carries.
 * @param {object} [current] - the config as it resolves now.
 * @returns {string | undefined} a message when the pair cannot hold.
 */
export function validateFieldPair(set, current = {}) {
  const submitted = set !== null && typeof set === 'object' ? set : {}
  const live = current !== null && typeof current === 'object' ? current : {}
  const [floorField, ceilingField] = INTERVAL_FIELDS
  const valueOf = (field) => (field in submitted ? submitted[field] : live[field])
  const floor = Number(valueOf(floorField))
  const ceiling = Number(valueOf(ceilingField))
  // An unsubmitted field the config does not carry yet is filled in by the
  // resolution's own default, so there is nothing to compare here.
  if (!Number.isFinite(floor) || !Number.isFinite(ceiling)) return undefined
  if (floor > ceiling) {
    return `${floorField} (${String(floor)}s) cannot exceed ${ceilingField} (${String(ceiling)}s): `
      + 'a ceiling below the floor would be lifted to it, so the interval you asked for would not hold'
  }
  return undefined
}

/**
 * Rebuild the profile-layer override for one plugin row.
 *
 * `current` is the config the entry resolves to now and `inherited` is what it
 * would resolve to without any profile override, so a key that differs between
 * the two is either a managed field's current value or something the user wrote
 * by hand — both are kept, and a key equal to its inherited value is dropped
 * because restating it would only pin a bundle-layer default. The result is an
 * override holding exactly the fields that are deliberately different.
 *
 * @param {object} current - the live resolved config of the entry.
 * @param {object} inherited - the same config with the profile override removed.
 * @param {object} [set] - field values to write.
 * @param {readonly string[]} [unset] - fields to hand back to their parent layer.
 * @returns {object} the next raw config for the profile layer.
 */
export function nextOverride(current, inherited, set = {}, unset = []) {
  const next = {}
  const live = current !== null && typeof current === 'object' ? current : {}
  const base = inherited !== null && typeof inherited === 'object' ? inherited : {}
  for (const [key, value] of Object.entries(live)) {
    if (base[key] === undefined || !deepEqual(value, base[key])) next[key] = value
  }
  for (const key of unset) delete next[key]
  for (const [key, value] of Object.entries(set)) next[key] = value
  return next
}

/** Structural equality over the JSON-shaped values a row config holds. */
function deepEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => deepEqual(left[key], right[key]))
  }
  return false
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Find the Loader row this page configures.
 *
 * A Loader entry keeps its row fields under `options` (`options.id` is the row
 * id, `options.name` the module specifier), and `configEditor.edit` demands the
 * very object `entries()` returned, so the plugin's own entry is preferred by
 * identity and everything else is a fallback for a deployment whose editor
 * lists a different object for the same row.
 *
 * A deployment may insert the row under any id, so the route name first, then
 * the module specifier the bundle patch names, decides. Returning undefined is
 * a normal outcome the page reports as "not editable".
 *
 * @param {readonly object[]} entries - `configEditor.entries()`.
 * @param {string} provider - the configured route name (the default row id).
 * @param {object} [own] - the plugin's own Loader entry, when it has one.
 * @returns {object | undefined} the entry.
 */
export function findEntry(entries, provider, own) {
  const list = Array.isArray(entries) ? entries : []
  const rowId = (entry) => entry?.options?.id
  const rowName = (entry) => entry?.options?.name
  if (own !== undefined && own !== null && list.includes(own)) return own
  return list.find((entry) => rowId(entry) === provider)
    ?? list.find((entry) => rowName(entry) === MODULE_NAME)
    ?? list.find((entry) => typeof rowName(entry) === 'string' && rowName(entry).endsWith(`/${MODULE_NAME}`))
    ?? (own === undefined ? undefined : list.find((entry) => entry === own))
}

/** The row id and module specifier of an entry, for reporting back. */
export function entryIdentity(entry) {
  return { id: entry?.options?.id, name: entry?.options?.name }
}

/**
 * Build the bridge over its injected collaborators.
 *
 * Every collaborator is a thunk, because all of them may be absent and any of
 * them may be replaced while the plugin stays loaded — the harness re-resolves
 * a service per use rather than caching it in a plugin.
 *
 * @param {object} deps - injected collaborators.
 * @param {() => object} deps.config - the live resolved plugin configuration.
 * @param {() => object | undefined} deps.credentials - the credential seam.
 * @param {() => object | undefined} deps.configEditor - the profile config editor.
 * @param {() => object | undefined} deps.connection - the connection service.
 * @param {() => Promise<object>} [deps.snapshot] - the whole model catalog, hidden models included.
 * @param {() => Promise<object>} [deps.refresh] - re-read the service's model list.
 * @param {(days: number) => Promise<object>} [deps.usage] - the usage table for a window.
 * @param {(input: object) => Promise<object>} [deps.subscription] - the service's own quota readout.
 * @param {() => object} [deps.subscriptionStatus] - whether that readout has gone old, from memory.
 * @param {() => object | undefined} [deps.entry] - this plugin's own Loader entry.
 * @param {() => object | undefined} [deps.launchEnvironment] - the launch-time environment snapshot.
 * @param {object} [deps.logger] - a Cordis-style logger.
 * @returns {object} the bridge handlers plus its route handler.
 */
export function createBridge(deps) {
  const logger = deps.logger
  const snapshot = deps.snapshot ?? (async () => null)
  const refresh = deps.refresh ?? (async () => ({ ok: false, reason: 'not-supported' }))
  const usage = deps.usage ?? (async () => null)
  const subscription = deps.subscription ?? (async () => ({ ok: false, reason: 'unsupported' }))
  const subscriptionStatusOf = deps.subscriptionStatus ?? (() => ({ activity: false }))

  /** The windows the usage table offers, and the one it opens on. */
  const USAGE_WINDOWS = Object.freeze([1, 7, 30])

  /**
   * The catalog, or a null the page reads as unavailable.
   *
   * Discovery never throws to reach here — the adapter falls back to its
   * built-in catalog — but a deployment whose cache cannot be read at all still
   * has to render a page, so the failure becomes one field.
   */
  async function catalog() {
    try {
      return await snapshot()
    } catch (error) {
      return { error: error?.message ?? String(error) }
    }
  }

  /** The catalog facts the page's own sections need, without the model list. */
  function catalogSummary(catalogSnapshot) {
    if (catalogSnapshot === null || catalogSnapshot === undefined) return { error: 'unavailable' }
    if (catalogSnapshot.error !== undefined) return { error: catalogSnapshot.error }
    return {
      source: catalogSnapshot.source,
      fetchedAt: catalogSnapshot.fetchedAt ?? null,
      counts: catalogSnapshot.counts ?? null,
      error: null,
    }
  }

  /**
   * Where the credential reference resolves from, as far as this deployment
   * can tell — never including the value.
   *
   * The harness layers a reference: the launching environment beats the managed
   * store, which beats a `.env` file. That order decides what a page can do, so
   * it is reported rather than guessed at: a value the launching environment
   * supplies cannot be replaced or removed from inside a running process, and a
   * value from a `.env` file comes back the moment the store is cleared.
   */
  function environmentFacts() {
    const config = deps.config()
    const snapshot = deps.launchEnvironment === undefined ? undefined : deps.launchEnvironment()
    let found
    try {
      found = typeof snapshot?.get === 'function' ? snapshot.get(config.apiKeyEnv) : undefined
    } catch {
      found = undefined
    }
    if (found !== undefined && found !== null) {
      return {
        variable: config.apiKeyEnv,
        present: String(found.value ?? '').trim() !== '',
        source: typeof found.source === 'string' ? found.source : null,
        path: typeof found.path === 'string' ? found.path : null,
      }
    }
    // Without a snapshot the inherited environment is the only layer this
    // process can still see, and it is the same one the launcher would report.
    const raw = process.env[config.apiKeyEnv]
    const present = raw !== undefined && String(raw).trim() !== ''
    return {
      variable: config.apiKeyEnv,
      present,
      source: present ? 'process' : null,
      path: null,
    }
  }

  /** The credential state as a UI-safe description, never a value. */
  async function credentialStatus() {
    const config = deps.config()
    const credentials = deps.credentials()
    const facts = environmentFacts()
    if (credentials === undefined || typeof credentials.describe !== 'function') {
      return { reference: config.apiKeyEnv, configured: false, source: undefined, writable: false, removable: false, blockedBy: 'no-store', environment: facts }
    }
    let info
    try {
      info = await credentials.describe(config.apiKeyEnv)
    } catch (error) {
      return {
        reference: config.apiKeyEnv,
        configured: false,
        writable: false,
        removable: false,
        blockedBy: 'no-store',
        error: error?.message ?? String(error),
        environment: facts,
      }
    }
    const source = info?.source ?? undefined
    const configured = info?.configured === true
    // Which layer a write would have to beat, derived from the layer order
    // rather than from the store's own word: the launching environment ranks
    // above the managed store, and the store ranks above a `.env` file. So a
    // value the launching environment supplies cannot be replaced or removed
    // from inside this process whatever the store says, and a `.env` value only
    // stands when nothing above it supplies one.
    const blockedBy = facts.present && facts.source === 'process'
      ? 'launching-environment'
      : (!configured && facts.present && (facts.source === 'project-env' || facts.source === 'user-env'))
        ? 'env-file'
        : null
    return {
      reference: config.apiKeyEnv,
      configured,
      source,
      writable: info?.writable === true,
      // Whether clearing would actually remove the value the route uses.
      removable: configured && blockedBy === null,
      blockedBy,
      environment: facts,
    }
  }

  /** Which layer supplies each managed field, as far as this deployment knows. */
  async function configStatus() {
    const config = deps.config()
    const values = {}
    for (const field of MANAGED_CONFIG_FIELDS) values[field] = config[field]
    const editor = deps.configEditor?.()
    const base = { fields: MANAGED_CONFIG_FIELDS, values, override: {} }
    if (editor === undefined || typeof editor.entries !== 'function') {
      return { ...base, editable: false, reason: 'no-config-editor' }
    }
    const entry = findEntry(editor.entries(), config.provider, deps.entry?.())
    if (entry === undefined) return { ...base, editable: false, reason: 'entry-not-found' }
    let override = {}
    try {
      const rows = typeof editor.configuration === 'function' ? editor.configuration() : []
      const row = (Array.isArray(rows) ? rows : []).find((item) => item?.entry === entry)
        ?? (Array.isArray(rows) ? rows : []).find((item) => item?.entry?.options?.id === entry.options?.id)
      override = isPlainObject(row?.override) ? row.override : {}
    } catch {
      override = {}
    }
    const overridden = {}
    for (const field of MANAGED_CONFIG_FIELDS) {
      if (field in override) overridden[field] = override[field]
    }
    return { ...base, editable: true, entry: entryIdentity(entry), override: overridden }
  }

  /** Everything the page renders on load. */
  async function state() {
    const config = deps.config()
    const catalogSnapshot = await catalog()
    let credential
    try {
      credential = await credentialStatus()
    } catch (error) {
      credential = {
        reference: config.apiKeyEnv,
        configured: false,
        writable: false,
        removable: false,
        blockedBy: 'no-store',
        error: String(error?.message ?? error),
        environment: environmentFacts(),
      }
    }
    return {
      ok: true,
      plugin: { name: MODULE_NAME, version: PLUGIN_IDENTITY.version },
      route: {
        provider: config.provider,
        baseURL: config.baseURL,
        apiKeyEnv: config.apiKeyEnv,
        modelSource: config.modelSource,
        hideTrainingModels: config.hideTrainingModels === true,
      },
      credential,
      environment: credential.environment,
      config: await configStatus(),
      catalog: catalogSummary(catalogSnapshot),
    }
  }

  /**
   * Re-read the service's model list on request, and answer with what changed.
   *
   * The answer always carries the catalog, so the page can render the fresh
   * facts whichever way this went. Two refusals are named rather than failed:
   * a deployment that builds its catalog from configuration has nothing to
   * fetch, and a discovery that fails leaves the existing catalog alone.
   *
   * @returns {Promise<object>} `{ ok, ... }` with the catalog either way.
   */
  async function refreshModels() {
    let outcome
    try {
      outcome = await refresh()
    } catch (error) {
      return {
        ok: false,
        status: 503,
        error: 'discovery-failed',
        message: error?.message ?? String(error),
      }
    }
    if (outcome?.ok === true) return { ok: true, status: 200, ...outcome }
    if (outcome?.reason === 'not-discovering') {
      return {
        ok: false,
        status: 409,
        error: 'not-discovering',
        message: 'this deployment builds its catalog from configuration, so there is nothing to fetch',
        catalog: outcome.catalog,
      }
    }
    return {
      ok: false,
      status: 503,
      error: 'discovery-failed',
      message: outcome?.message ?? 'the model list could not be read',
      catalog: outcome?.catalog,
    }
  }

  /**
   * The subscription's own quota, read from the service.
   *
   * This is the one endpoint here that leaves the machine, and it does so only
   * because the reader asked: the service meters three windows and answers them
   * with a percentage, which is the number a person watching a plan wants. Every
   * failure is a named reason rather than a 5xx, because a deployment whose
   * gateway does not serve it must still show its own counters.
   *
   * @param {URLSearchParams} query - the request's query string.
   * @returns {Promise<object>} `{ ok, ... }` with a reason when there is none.
   */
  async function subscriptionStatus(query) {
    const force = query?.get?.('refresh') === '1'
    let result
    try {
      result = await subscription({ force })
    } catch (error) {
      return { ok: false, status: 200, error: 'unsupported', message: error?.message ?? String(error) }
    }
    return { ok: result?.ok === true, status: 200, ...result }
  }

  /**
   * Whether a quota read would be worth making, answered from memory.
   *
   * The page's schedule needs to know this as often as its floor allows, and it
   * must not cost a round trip to the service to find out — so this reads the
   * reader's own state and nothing else. It has no failure mode worth reporting:
   * a deployment whose reader cannot be reached is a deployment whose page will
   * find out on its next read, and a probe that answered 5xx would put an error
   * on screen for something no reader asked about.
   *
   * @returns {object} `{ ok: true, activity, minIntervalSeconds, maxIntervalSeconds }`.
   */
  function activityStatus() {
    let status
    try {
      status = subscriptionStatusOf()
    } catch (error) {
      return { ok: false, status: 200, error: 'unsupported', message: error?.message ?? String(error) }
    }
    return { ok: true, status: 200, ...status }
  }

  /**
   * What this route has spent, over one window.
   *
   * The window is a query parameter the page owns, clamped to the list of
   * windows the page offers: an unbounded window would turn a long-lived
   * deployment's table into an accidental memory test.
   *
   * @param {URLSearchParams} query - the request's query string.
   * @returns {Promise<object>} `{ ok, ...table }` or the reason there is none.
   */
  async function usageTable(query) {
    const requested = Number(query?.get?.('days'))
    const days = USAGE_WINDOWS.includes(requested) ? requested : 7
    let table
    try {
      table = await usage(days)
    } catch (error) {
      return { ok: false, status: 500, error: 'usage-unavailable', message: error?.message ?? String(error) }
    }
    if (table === null || table === undefined) {
      return {
        ok: false,
        status: 503,
        error: 'usage-unavailable',
        message: 'this deployment does not record usage',
      }
    }
    return { ok: true, status: 200, windows: [...USAGE_WINDOWS], ...table }
  }

  /**
   * The whole catalog: every model, whether the listing offers it, and why not.
   *
   * @returns {Promise<object>} `{ ok: true, ...snapshot }` or the reason it is unavailable.
   */
  async function models() {
    const catalogSnapshot = await catalog()
    if (catalogSnapshot?.error !== undefined && catalogSnapshot?.models === undefined) {
      return { ok: false, status: 503, error: 'catalog-unavailable', message: String(catalogSnapshot.error) }
    }
    return { ok: true, status: 200, ...catalogSnapshot }
  }

  /**
   * Write the profile-layer overrides this plugin manages.
   *
   * The change runs inside the editor's own reconcile step, so it reads the
   * entry as it stands at the moment of the write instead of trusting the
   * snapshot this request started from.
   *
   * @param {unknown} body - the decoded request body.
   * @returns {Promise<object>} `{ ok: true, state }` or a named refusal.
   */
  async function writeConfig(body) {
    const payload = isPlainObject(body) ? body : {}
    const set = isPlainObject(payload.set) ? payload.set : {}
    const unset = Array.isArray(payload.unset) ? payload.unset.map(String) : []
    for (const field of [...Object.keys(set), ...unset]) {
      if (!MANAGED_CONFIG_FIELDS.includes(field)) {
        return { ok: false, status: 400, error: 'field-not-editable', message: `"${field}" is not editable from this page` }
      }
    }
    for (const [field, value] of Object.entries(set)) {
      const problem = validateFieldValue(field, value)
      if (problem !== undefined) return { ok: false, status: 400, error: 'invalid-field-value', message: problem }
    }
    const config = deps.config()
    // The pair is checked against the config as it resolves now, so a write that
    // moves only one of the two is judged against the other one in force.
    const pairProblem = validateFieldPair(set, config)
    if (pairProblem !== undefined) {
      return { ok: false, status: 400, error: 'invalid-field-pair', message: pairProblem }
    }
    const editor = deps.configEditor?.()
    if (editor === undefined || typeof editor.edit !== 'function') {
      return { ok: false, status: 503, error: 'no-config-editor', message: 'this deployment has no profile configuration editor' }
    }
    const entry = findEntry(editor.entries(), config.provider, deps.entry?.())
    if (entry === undefined) {
      return {
        ok: false,
        status: 409,
        error: 'entry-not-found',
        message: `the Loader has no profile row for this plugin ("${MODULE_NAME}"), so there is nothing to write into`,
      }
    }
    try {
      await editor.edit(entry, (current, inherited) => nextOverride(current, inherited, set, unset))
    } catch (error) {
      return {
        ok: false,
        status: 409,
        error: 'config-write-failed',
        message: error?.message ?? String(error),
      }
    }
    // The answer reports the override that is now persisted rather than a
    // re-resolved snapshot: an ordinary config field takes effect when the
    // Loader reloads this row, which the page observes by reading state again.
    return { ok: true, status: 200, config: await configStatus() }
  }

  /**
   * Store the API key behind the configured credential reference.
   *
   * @param {unknown} body - the decoded request body, carrying `value`.
   * @returns {Promise<object>} `{ ok: true, credential }` or a named refusal.
   */
  async function writeCredential(body) {
    const payload = isPlainObject(body) ? body : {}
    const config = deps.config()
    const credentials = deps.credentials()
    if (credentials === undefined || typeof credentials.set !== 'function') {
      return {
        ok: false,
        status: 503,
        error: 'no-credential-service',
        message: 'this deployment has no credential store; export the variable instead',
      }
    }
    const checked = validateApiKey(payload.value)
    if (!checked.ok) return { ok: false, status: 400, error: 'invalid-credential', message: checked.message }
    try {
      await credentials.set(config.apiKeyEnv, checked.value)
    } catch (error) {
      return {
        ok: false,
        status: 409,
        error: 'credential-write-refused',
        message: error?.message ?? String(error),
      }
    }
    logger?.info?.('dsh-llm-opencode-go: an API key was stored for %s through the settings page', config.apiKeyEnv)
    return { ok: true, status: 200, credential: await credentialStatus() }
  }

  /** Remove the stored API key; a read-only source shadows this and refuses. */
  async function clearCredential() {
    const config = deps.config()
    const credentials = deps.credentials()
    if (credentials === undefined || typeof credentials.unset !== 'function') {
      return {
        ok: false,
        status: 503,
        error: 'no-credential-service',
        message: 'this deployment has no credential store',
      }
    }
    try {
      await credentials.unset(config.apiKeyEnv)
    } catch (error) {
      return {
        ok: false,
        status: 409,
        error: 'credential-write-refused',
        message: error?.message ?? String(error),
      }
    }
    logger?.info?.('dsh-llm-opencode-go: the stored API key for %s was cleared from the settings page', config.apiKeyEnv)
    return { ok: true, status: 200, credential: await credentialStatus() }
  }

  /** The web-server route handler: reject, dispatch, answer. */
  async function handle(request, response) {
    const rejection = rejectionFor(deps.connection(), request)
    if (rejection !== undefined) {
      // No body: an unauthenticated caller learns nothing about the surface.
      response.statusCode = rejection
      response.end()
      return
    }
    const pathname = pathnameOf(request)
    try {
      if (pathname === UI_ROUTES.state) {
        if (request.method !== 'GET') return sendMethodNotAllowed(response, ['GET'])
        return sendJson(response, 200, await state())
      }
      if (pathname === UI_ROUTES.models) {
        if (request.method !== 'GET') return sendMethodNotAllowed(response, ['GET'])
        const result = await models()
        return sendJson(response, result.status, result)
      }
      if (pathname === UI_ROUTES.refresh) {
        if (request.method !== 'POST') return sendMethodNotAllowed(response, ['POST'])
        const result = await refreshModels()
        return sendJson(response, result.status, result)
      }
      if (pathname === UI_ROUTES.usage) {
        if (request.method !== 'GET') return sendMethodNotAllowed(response, ['GET'])
        const result = await usageTable(new URL(request.url ?? '/', 'http://localhost').searchParams)
        return sendJson(response, result.status, result)
      }
      if (pathname === UI_ROUTES.subscription) {
        if (request.method !== 'GET') return sendMethodNotAllowed(response, ['GET'])
        const result = await subscriptionStatus(new URL(request.url ?? '/', 'http://localhost').searchParams)
        return sendJson(response, result.status, result)
      }
      if (pathname === UI_ROUTES.activity) {
        if (request.method !== 'GET') return sendMethodNotAllowed(response, ['GET'])
        const result = activityStatus()
        return sendJson(response, result.status, result)
      }
      if (pathname === UI_ROUTES.config) {
        if (request.method !== 'POST') return sendMethodNotAllowed(response, ['POST'])
        const result = await writeConfig(await readJsonBody(request))
        return sendJson(response, result.status, result)
      }
      if (pathname === UI_ROUTES.credential) {
        if (request.method === 'POST') {
          const result = await writeCredential(await readJsonBody(request))
          return sendJson(response, result.status, result)
        }
        if (request.method === 'DELETE') {
          const result = await clearCredential()
          return sendJson(response, result.status, result)
        }
        return sendMethodNotAllowed(response, ['POST', 'DELETE'])
      }
      return sendJson(response, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      const message = error?.message ?? String(error)
      if (message === 'body-too-large') {
        return sendJson(response, 413, { ok: false, error: 'body-too-large', message })
      }
      if (message === 'invalid-json') {
        return sendJson(response, 400, { ok: false, error: 'invalid-json', message })
      }
      logger?.warn?.('dsh-llm-opencode-go: settings-page request failed: %s', message)
      return sendJson(response, 500, { ok: false, error: 'internal', message })
    }
  }

  return {
    state,
    models,
    refreshModels,
    usageTable,
    subscriptionStatus,
    writeConfig,
    writeCredential,
    clearCredential,
    credentialStatus,
    configStatus,
    handle,
  }
}

/** The pathname of a request, or `''` when the target is unparseable. */
function pathnameOf(request) {
  try {
    return new URL(String(request?.url ?? '/'), 'http://localhost').pathname
  } catch {
    return ''
  }
}
