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
 * @module dsh-opencode-go/ui/bridge
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
export const MANAGED_CONFIG_FIELDS = Object.freeze(['apiKeyEnv', 'hiddenModels', 'modelVariants'])

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
      const id = `${model}@${name}`
      if (seen.has(id)) return `modelVariants declares "${id}" twice; a variant id must be unique`
      seen.add(id)
    }
    return undefined
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
 * A deployment may insert the row under any id, so the default id first, then
 * the module specifier the bundle patch names, decides. Returning undefined is
 * a normal outcome the page reports as "not editable".
 *
 * @param {readonly object[]} entries - `configEditor.entries()`.
 * @param {string} provider - the configured route name (the default row id).
 * @returns {object | undefined} the entry.
 */
export function findEntry(entries, provider) {
  const list = Array.isArray(entries) ? entries : []
  return list.find((entry) => entry?.id === provider)
    ?? list.find((entry) => entry?.name === MODULE_NAME)
    ?? list.find((entry) => typeof entry?.name === 'string' && entry.name.endsWith(`/${MODULE_NAME}`))
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
 * @param {object} [deps.logger] - a Cordis-style logger.
 * @returns {object} the bridge handlers plus its route handler.
 */
export function createBridge(deps) {
  const logger = deps.logger
  const snapshot = deps.snapshot ?? (async () => null)
  const refresh = deps.refresh ?? (async () => ({ ok: false, reason: 'not-supported' }))

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

  /** The credential state as a UI-safe description, never a value. */
  async function credentialStatus() {
    const config = deps.config()
    const credentials = deps.credentials()
    if (credentials === undefined || typeof credentials.describe !== 'function') return null
    try {
      const info = await credentials.describe(config.apiKeyEnv)
      return {
        reference: config.apiKeyEnv,
        configured: info?.configured === true,
        source: info?.source ?? undefined,
        writable: info?.writable === true,
      }
    } catch (error) {
      return {
        reference: config.apiKeyEnv,
        configured: false,
        writable: false,
        error: error?.message ?? String(error),
      }
    }
  }

  /** Which layer supplies each managed field, as far as this deployment knows. */
  async function configStatus() {
    const config = deps.config()
    const values = {}
    for (const field of MANAGED_CONFIG_FIELDS) values[field] = config[field]
    const editor = deps.configEditor()
    const base = { fields: MANAGED_CONFIG_FIELDS, values, override: {} }
    if (editor === undefined || typeof editor.entries !== 'function') {
      return { ...base, editable: false, reason: 'no-config-editor' }
    }
    const entry = findEntry(editor.entries(), config.provider)
    if (entry === undefined) return { ...base, editable: false, reason: 'entry-not-found' }
    let override = {}
    try {
      const rows = typeof editor.configuration === 'function' ? editor.configuration() : []
      const row = (Array.isArray(rows) ? rows : []).find((item) => item?.entry?.id === entry.id)
      override = isPlainObject(row?.override) ? row.override : {}
    } catch {
      override = {}
    }
    const overridden = {}
    for (const field of MANAGED_CONFIG_FIELDS) {
      if (field in override) overridden[field] = override[field]
    }
    return { ...base, editable: true, entry: { id: entry.id, name: entry.name }, override: overridden }
  }

  /** Everything the page renders on load. */
  async function state() {
    const config = deps.config()
    const catalogSnapshot = await catalog()
    let credential
    try {
      credential = await credentialStatus()
    } catch (error) {
      credential = { reference: config.apiKeyEnv, configured: false, writable: false, error: String(error?.message ?? error) }
    }
    const environment = process.env[config.apiKeyEnv]
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
      environment: {
        variable: config.apiKeyEnv,
        present: environment !== undefined && String(environment).trim() !== '',
      },
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
    const editor = deps.configEditor()
    if (editor === undefined || typeof editor.edit !== 'function') {
      return { ok: false, status: 503, error: 'no-config-editor', message: 'this deployment has no profile configuration editor' }
    }
    const entry = findEntry(editor.entries(), config.provider)
    if (entry === undefined) {
      return { ok: false, status: 409, error: 'entry-not-found', message: `no profile entry for "${MODULE_NAME}"` }
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
    logger?.info?.('dsh-opencode-go: an API key was stored for %s through the settings page', config.apiKeyEnv)
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
    logger?.info?.('dsh-opencode-go: the stored API key for %s was cleared from the settings page', config.apiKeyEnv)
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
      logger?.warn?.('dsh-opencode-go: settings-page request failed: %s', message)
      return sendJson(response, 500, { ok: false, error: 'internal', message })
    }
  }

  return {
    state,
    models,
    refreshModels,
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
