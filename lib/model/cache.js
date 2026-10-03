/**
 * Model discovery and its cache.
 *
 * `GET {baseURL}/models` is cheap but not free, and the answer changes only
 * when OpenCode ships a new model. So the adapter keeps one memory value per
 * endpoint and one small JSON file beside the harness cache directory:
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

/** Cache format version; a mismatch discards the file instead of guessing. */
const CACHE_VERSION = 1

/** bearer-authenticated catalog request, with everything the relay expects. */
function modelsHeaders(config, headers) {
  return {
    ...headers,
    accept: 'application/json',
  }
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
    /** @type {{ ids: readonly {id: string, name?: string}[], fetchedAt: number } | undefined} */
    this.entry = undefined
    /** @type {Promise<readonly {id: string, name?: string}[]> | undefined} */
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
   * Candidate ids for the catalog.
   *
   * Never throws: discovery is an enhancement, and a deployment with no network
   * at startup must still get its configured and built-in models.
   *
   * @returns {Promise<readonly {id: string, name?: string}[]>} discovered ids, possibly empty.
   */
  async discover() {
    if (this.config.modelSource !== 'discover') return []

    const now = Date.now()
    if (fresh(this.entry, now, this.lifetimeMs)) return this.entry.ids

    if (this.entry !== undefined) {
      // Serve what we have and refresh behind the request.
      void this.refresh().catch(() => {})
      return this.entry.ids
    }

    if (await this.loadFromDisk()) {
      if (fresh(this.entry, Date.now(), this.lifetimeMs)) return this.entry.ids
      void this.refresh().catch(() => {})
      return this.entry.ids
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
    return this.entry?.ids ?? []
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
   * @returns {Promise<readonly {id: string, name?: string}[]>} the rows the service lists now.
   * @throws when the request fails; the previous entry is untouched.
   */
  async fetchNow() {
    if (this.config.modelSource !== 'discover') return this.entry?.ids ?? []
    // `refresh()` collapses concurrent callers onto one request, so a forced
    // read and a background refresh cannot become two requests.
    return this.refresh()
  }

  /** Fetch once, collapsing concurrent callers onto one request. */
  async refresh() {
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.fetchModels()
      .then(async (ids) => {
        this.entry = { ids, fetchedAt: Date.now() }
        await this.saveToDisk()
        this.deps.logger?.info?.(
          'dsh-llm-opencode-go: discovered %d models from %s',
          ids.length,
          this.config.baseURL,
        )
        return ids
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
      if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.ids)) return false
      const ids = parsed.ids
        .filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string')
        .map((row) => (typeof row.name === 'string' ? { id: row.id, name: row.name } : { id: row.id }))
      if (ids.length === 0) return false
      const fetchedAt = Number(parsed.fetchedAt)
      this.entry = { ids, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0 }
      return true
    } catch {
      // Missing, unreadable, or corrupt: treat as no cache and fetch.
      return false
    }
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
        ids: this.entry.ids,
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
 * Parse a `/models` reply into `{id, name}` rows.
 *
 * The documented shape is `{object: 'list', data: [{id, object, created, owned_by}]}`,
 * and an enriched `{models: {...}}` map is accepted too, because gateways that
 * mirror the OpenAI surface sometimes publish that instead.
 *
 * @param {unknown} payload - the decoded JSON body.
 * @returns {readonly {id: string, name?: string}[]} rows in the order received.
 */
export function parseModelList(payload) {
  const rows = []
  const push = (id, name) => {
    if (typeof id !== 'string' || id.trim() === '') return
    rows.push(name === undefined ? { id } : { id, name })
  }

  if (Array.isArray(payload?.data)) {
    for (const row of payload.data) push(row?.id, typeof row?.name === 'string' ? row.name : undefined)
  } else if (payload?.models !== null && typeof payload?.models === 'object') {
    for (const [key, value] of Object.entries(payload.models)) {
      push(key, typeof value?.name === 'string' ? value.name : undefined)
    }
  }
  return rows
}
