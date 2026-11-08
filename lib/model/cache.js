/**
 * Model discovery and its cache.
 *
 * `GET {baseURL}/models` is cheap but not free, and the answer changes only
 * when OpenCode ships a new model or a model gains new facts. Since 2026-11 the
 * service answers with more than ids: each row carries a name, a description,
 * its `limit` (context/output/input caps), its `modalities`, its `capabilities`
 * (including the reasoning effort ladder) and an `api` map naming the
 * catalogue's preferred wire entry. Discovery keeps those facts — the catalog
 * in `./catalog.js` turns them into records — while the shape stays tolerant:
 * a gateway that still answers with ids only, or a cache file written by an
 * older version, is still usable.
 *
 * The adapter keeps one memory value per endpoint and one small JSON file
 * beside the harness cache directory:
 *
 *   memory hit, unexpired      -> served with no I/O at all
 *   memory hit, expired        -> served immediately, refreshed in the background
 *   memory miss, file hit      -> served immediately, refreshed in the background
 *   memory miss, file miss     -> awaited, because there is nothing to serve
 *
 * A refresh failure never removes a usable catalog: the stale value is kept and
 * the failure is only logged. Only a cold start with no network fails, and even
 * then the caller falls back to the built-in catalog.
 *
 * @module dsh-llm-opencode-go/model/cache
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Cache format version.
 *
 * Version 2 stores the catalogue rows themselves, not just `{id, name}`; a
 * version 1 file is still read, because it holds the same ids and a deployment
 * upgrading in place should not throw away a warm cache for a shape change.
 * A version this code does not know is discarded instead of guessed.
 */
const CACHE_VERSION = 2

/** The shape version 1 wrote: `{id, name?}` rows under `ids`. */
const LEGACY_CACHE_VERSION = 1

/** bearer-authenticated catalog request, with everything the relay expects. */
function modelsHeaders(config, headers) {
  return {
    ...headers,
    accept: 'application/json',
  }
}

/** A plain object, or undefined for anything else. */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** A trimmed non-empty string, or undefined. */
function text(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** A positive integer, or undefined. */
function positiveInt(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return Math.floor(number)
}

/** A de-duplicated list of trimmed strings, or undefined when nothing remains. */
function stringList(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    const entry = text(item)
    if (entry !== undefined && !out.includes(entry)) out.push(entry)
  }
  return out.length === 0 ? undefined : out
}

/**
 * One discovery row, reduced to the facts this adapter can use.
 *
 * The service's row is untrusted input: a gateway may answer a different shape,
 * an old cache may hold less, and a field may be a string where a number was
 * documented. Everything unexpected is dropped rather than propagated, so the
 * catalog reads one normalized shape.
 *
 * @param {unknown} raw - one row of a `/models` reply.
 * @returns {Readonly<object> | undefined} the normalized row, or undefined when it names no id.
 */
function catalogueRow(raw) {
  const source = asObject(raw)
  if (source === undefined) return undefined
  const id = text(source.id)
  if (id === undefined) return undefined

  const row = { id }
  const name = text(source.name)
  if (name !== undefined) row.name = name
  const description = text(source.description)
  if (description !== undefined) row.description = description

  const limit = asObject(source.limit)
  if (limit !== undefined) {
    const context = positiveInt(limit.context)
    const output = positiveInt(limit.output)
    const input = positiveInt(limit.input)
    if (context !== undefined || output !== undefined || input !== undefined) {
      row.limit = Object.freeze({
        ...(context === undefined ? {} : { context }),
        ...(output === undefined ? {} : { output }),
        ...(input === undefined ? {} : { input }),
      })
    }
  }

  const modalities = catalogueModalities(source.modalities)
  if (modalities !== undefined) row.modalities = modalities

  // The first read of a service row keeps the reasoning ladder under
  // `capabilities.reasoning`; a row this code wrote to disk carries it at the
  // top level. Both shapes are accepted so a cache round trip loses nothing.
  const reasoning = asObject(source.reasoning) ?? asObject(asObject(source.capabilities)?.reasoning)
  if (reasoning !== undefined) {
    // `none` is how the catalogue says thinking can be switched off, which this
    // adapter expresses by omitting the effort rather than by naming the level.
    const efforts = (stringList(reasoning.effort ?? reasoning.efforts) ?? []).filter((level) => level !== 'none')
    row.reasoning = Object.freeze({
      supported: reasoning.supported === true,
      efforts: Object.freeze(efforts),
    })
  }

  const api = catalogueApi(source.api)
  if (api !== undefined) row.api = api

  return Object.freeze(row)
}

/** The input-modality list from either `/models` spelling (`{input: [...]}` or a bare array). */
function catalogueModalities(value) {
  const list = Array.isArray(value) ? value : asObject(value)?.input
  return stringList(list)
}

/** The protocol keys of one `api` map, or the already-normalized key list. */
function catalogueApi(value) {
  if (Array.isArray(value)) {
    const keys = value.filter((key) => typeof key === 'string' && key.trim() !== '')
    return keys.length === 0 ? undefined : Object.freeze(keys)
  }
  const map = asObject(value)
  if (map === undefined) return undefined
  const keys = Object.keys(map).filter((key) => asObject(map[key]) !== undefined)
  return keys.length === 0 ? undefined : Object.freeze(keys)
}

/**
 * One discovery row without the in-memory provenance marker.
 *
 * `legacy` says a row came from a version 1 cache file rather than a live
 * answer; it steers the catalog's merge but is not a fact about the service, so
 * it is not written back into a version 2 file.
 *
 * @param {Readonly<object>} row - one discovery row.
 * @returns {Readonly<object>} the row as the cache file should carry it.
 */
function persistableRow(row) {
  if (row.legacy !== true) return row
  const { legacy, ...rest } = row
  return rest
}

/**
 * Resolve the default on-disk cache path: `~/.dsh/cache/opencode-go-models.json`.
 *
 * @param {object} config - the resolved plugin configuration.
 * @returns {string} an absolute path.
 */
export function cachePath(config) {
  return config.modelsCachePath ?? join(homedir(), '.dsh', 'cache', 'opencode-go-models.json')
}

/** Whether a cache entry is still inside its lifetime. */
function fresh(entry, now, lifetimeMs) {
  return entry !== undefined && now - entry.fetchedAt < lifetimeMs
}

/**
 * One discovery client per (endpoint, credential reference) pair.
 *
 * It is created by the adapter and shares the adapter's lifetime, so a plugin
 * reload starts from a clean slate and a disposed plugin never writes a file
 * nobody will read.
 */
export class ModelCache {
  /**
   * @param {object} config - the resolved plugin configuration.
   * @param {object} deps - injected collaborators.
   * @param {() => Promise<Record<string, string>>} deps.authHeaders - per-request auth headers.
   * @param {object} deps.logger - a Cordis-style logger (`info`/`warn`).
   * @param {typeof fetch} [deps.fetch] - the fetch implementation, for tests.
   */
  constructor(config, deps) {
    this.config = config
    this.deps = deps
    /** @type {{ rows: readonly object[], fetchedAt: number } | undefined} */
    this.entry = undefined
    /** @type {Promise<readonly object[]> | undefined} */
    this.inflight = undefined
    this.loadedFile = false
  }

  /** The lifetime in milliseconds. */
  get lifetimeMs() {
    return this.config.modelsCacheSeconds * 1000
  }

  /**
   * When the served discovery answer was fetched, or undefined when there is
   * none. The configuration page reports it as the age of the catalog, which is
   * the one fact that makes a stale listing explicable.
   */
  get fetchedAt() {
    return this.entry?.fetchedAt
  }

  /**
   * Candidate rows for the catalog.
   *
   * Never throws: discovery is an enhancement, and a deployment with no network
   * at startup must still get its configured and built-in models.
   *
   * @returns {Promise<readonly object[]>} discovered rows, possibly empty.
   */
  async discover() {
    if (this.config.modelSource !== 'discover') return []

    const now = Date.now()
    if (fresh(this.entry, now, this.lifetimeMs)) return this.entry.rows

    if (this.entry !== undefined) {
      // Serve what we have and refresh behind the request.
      void this.refresh().catch(() => {})
      return this.entry.rows
    }

    if (await this.loadFromDisk()) {
      if (fresh(this.entry, Date.now(), this.lifetimeMs)) return this.entry.rows
      void this.refresh().catch(() => {})
      return this.entry.rows
    }

    try {
      await this.refresh()
    } catch (error) {
      this.deps.logger?.warn?.(
        'dsh-llm-opencode-go: GET %s/models failed: %s',
        this.config.baseURL,
        error?.message ?? String(error),
      )
    }
    return this.entry?.rows ?? []
  }

  /**
   * Read `GET /models` now, whatever the cache says.
   *
   * This is the one path that must not answer from memory: it is what the
   * configuration page's own "fetch the list" control calls, so a person
   * watching the page sees the service's current answer rather than the answer
   * this process already had. Failure leaves the previous entry in place — the
   * caller reports the failure and keeps a usable catalog.
   *
   * @returns {Promise<readonly object[]>} the rows the service lists now.
   * @throws when the request fails; the previous entry is untouched.
   */
  async fetchNow() {
    if (this.config.modelSource !== 'discover') return this.entry?.rows ?? []
    // `refresh()` collapses concurrent callers onto one request, so a forced
    // read and a background refresh cannot become two requests.
    return this.refresh()
  }

  /** Fetch once, collapsing concurrent callers onto one request. */
  async refresh() {
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.fetchModels()
      .then(async (rows) => {
        this.entry = { rows, fetchedAt: Date.now() }
        await this.saveToDisk()
        this.deps.logger?.info?.(
          'dsh-llm-opencode-go: discovered %d models from %s',
          rows.length,
          this.config.baseURL,
        )
        return rows
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** The single network read. */
  async fetchModels() {
    const headers = {
      ...modelsHeaders(this.config, await this.deps.authHeaders()),
    }
    // The adapter's own `fetch` seam reaches here too: one injected
    // implementation covers discovery and generation alike.
    const implementation = this.deps.fetch ?? globalThis.fetch
    if (typeof implementation !== 'function') {
      throw new Error('globalThis.fetch is unavailable')
    }
    const response = await implementation(`${this.config.baseURL}/models`, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(this.config.timeoutMs, 60_000)),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}${detail === '' ? '' : ` ${detail.slice(0, 200)}`}`)
    }
    const payload = await response.json()
    return parseModelList(payload)
  }

  /** Read and validate the on-disk entry once per client. */
  async loadFromDisk() {
    if (this.loadedFile) return this.entry !== undefined
    this.loadedFile = true
    try {
      const raw = await readFile(cachePath(this.config), 'utf8')
      const parsed = JSON.parse(raw)
      const rows = this.#rowsFromFile(parsed)
      if (rows === undefined || rows.length === 0) return false
      const fetchedAt = Number(parsed?.fetchedAt)
      this.entry = { rows, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0 }
      return true
    } catch {
      // Missing, unreadable, or corrupt: treat as no cache and fetch.
      return false
    }
  }

  /** The rows a cache file holds, whichever shape version wrote it. */
  #rowsFromFile(parsed) {
    if (parsed?.version === LEGACY_CACHE_VERSION && Array.isArray(parsed.ids)) {
      const rows = parsed.ids
        .map((raw) => {
          const row = catalogueRow(raw)
          if (row === undefined) return undefined
          // A version 1 file was written before the service described its rows,
          // so it is a name list, not a fresh statement about what is served.
          // `catalog.js` reads this marker and lets such a row refine a record
          // but not revive one the built-in table has since retired.
          return Object.freeze({ ...row, legacy: true })
        })
        .filter((row) => row !== undefined)
      return rows.length === parsed.ids.length ? rows : undefined
    }
    if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.rows)) return undefined
    const rows = parsed.rows.map((raw) => catalogueRow(raw)).filter((row) => row !== undefined)
    return rows.length === parsed.rows.length ? rows : undefined
  }

  /** Persist the entry; a failure is a warning, never a request failure. */
  async saveToDisk() {
    if (this.entry === undefined) return
    const path = cachePath(this.config)
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify({
        version: CACHE_VERSION,
        baseURL: this.config.baseURL,
        fetchedAt: this.entry.fetchedAt,
        // The provenance marker is for this process's catalog, not a fact about
        // the service; a file this code writes carries only service facts.
        rows: this.entry.rows.map(persistableRow),
      }), 'utf8')
    } catch (error) {
      this.deps.logger?.warn?.(
        'dsh-llm-opencode-go: could not write the model cache at %s: %s',
        path,
        error?.message ?? String(error),
      )
    }
  }
}

/**
 * Parse a `/models` reply into normalized discovery rows.
 *
 * The documented envelope is `{object: 'list', data: [{id, object, created,
 * owned_by, ...}]}`, and an enriched `{models: {...}}` map is accepted too,
 * because gateways that mirror the OpenAI surface sometimes publish that
 * instead. Each row is reduced by {@link catalogueRow}: the service's richer
 * fields (name, description, limit, modalities, reasoning effort, api) are
 * kept when present, and anything unexpected is dropped. An empty or foreign
 * payload yields an empty list rather than throwing — discovery is an
 * enhancement, and a shape the adapter does not know must not take the route
 * down.
 *
 * @param {unknown} payload - the decoded JSON body.
 * @returns {readonly {id: string, name?: string}[]} normalized rows in the order received.
 */
export function parseModelList(payload) {
  const rows = []
  const push = (raw) => {
    const row = catalogueRow(raw)
    if (row !== undefined) rows.push(row)
  }
  if (Array.isArray(payload?.data)) {
    for (const raw of payload.data) push(raw)
  } else if (payload?.models !== null && payload?.models !== undefined && typeof payload?.models === 'object') {
    for (const [key, value] of Object.entries(payload.models)) {
      push({ ...(asObject(value) ?? {}), id: key })
    }
  }
  return rows
}
