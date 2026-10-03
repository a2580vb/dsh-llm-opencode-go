/**
 * The subscription's own usage, read from the service.
 *
 * `GET {baseURL}/usage` answers the three windows OpenCode Go meters a plan by:
 *
 *   { "usage": { "rolling":  { "status": "ok", "percent": 8,  "resetsAt": "…" },
 *                "weekly":   { "status": "ok", "percent": 8,  "resetsAt": "…" },
 *                "monthly":  { "status": "ok", "percent": 13, "resetsAt": "…" } } }
 *
 * This is the only number in the plugin that is the *provider's* rather than
 * this route's own count, and it is the one a person watching a subscription
 * actually wants: the local table says what was spent, this says how close the
 * plan is to its limits.
 *
 * Two facts about it shape everything here:
 *
 *   - It is not part of the documented API. The published surface is the model
 *     endpoints; this one is what the console uses, and it may move or vanish
 *     without notice. So a missing or unreadable answer is a named, ordinary
 *     outcome the page reports — never an error that fails a request or a page.
 *   - It costs a round trip and only moves when a request is made, so it is
 *     read on demand and cached for a while: opening the page twice does not
 *     ask the service twice.
 *
 * @module dsh-llm-opencode-go/usage/subscription
 */

/** Where the endpoint sits under `baseURL`. */
export const SUBSCRIPTION_PATH = '/usage'

/** How long an answer is reused, in milliseconds. */
export const SUBSCRIPTION_CACHE_MS = 60_000

/** The windows, in the order the page shows them, widest commitment last. */
export const SUBSCRIPTION_WINDOWS = Object.freeze(['rolling', 'weekly', 'monthly'])

/** One window's `status` when the plan is inside its limit. */
const STATUS_OK = 'ok'

/**
 * Normalize the service's answer.
 *
 * Unknown windows are kept rather than dropped — the service adding a fourth
 * window should show up without a release here — and unknown fields are ignored
 * rather than echoed, because the page renders whatever this returns and a
 * shape it did not expect is exactly what should not reach the DOM.
 *
 * @param {unknown} payload - the decoded response body.
 * @returns {{ windows: readonly object[] } | undefined} the normalized answer, or undefined when unusable.
 */
export function parseSubscription(payload) {
  const usage = payload?.usage
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined
  const order = (name) => {
    const at = SUBSCRIPTION_WINDOWS.indexOf(name)
    return at === -1 ? SUBSCRIPTION_WINDOWS.length : at
  }
  const windows = []
  for (const [name, value] of Object.entries(usage)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const percent = Number(value.percent)
    if (!Number.isFinite(percent)) continue
    windows.push({
      name,
      status: typeof value.status === 'string' ? value.status : STATUS_OK,
      percent: Math.max(0, Math.min(100, percent)),
      // Reported as the service sent it, and separately as a boolean, so the
      // page never has to parse a date to decide whether a window is spent.
      resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : null,
    })
  }
  windows.sort((left, right) => order(left.name) - order(right.name) || left.name.localeCompare(right.name))
  return windows.length === 0 ? undefined : { windows }
}

/**
 * Read the subscription's usage, with a short cache.
 *
 * One reader per plugin activation, so a reload starts from a clean cache and
 * the answer can never outlive the configuration it was fetched with.
 */
export class SubscriptionReader {
  /**
   * @param {object} config - the resolved plugin configuration.
   * @param {object} deps - injected collaborators.
   * @param {() => Promise<Record<string, string>>} deps.authHeaders - per-request auth headers.
   * @param {typeof fetch} [deps.fetch] - the fetch implementation, for tests.
   * @param {object} [deps.logger] - a Cordis-style logger (`info`/`warn`).
   * @param {() => number} [deps.now] - the clock, for tests.
   */
  constructor(config, deps = {}) {
    this.config = config
    this.deps = deps
    /** @type {{ fetchedAt: number, windows: readonly object[] } | undefined} */
    this.entry = undefined
    this.inflight = undefined
  }

  /** The lifetime in milliseconds. */
  get lifetimeMs() {
    return (this.config.subscriptionCacheSeconds ?? SUBSCRIPTION_CACHE_MS / 1000) * 1000
  }

  /**
   * The subscription's usage.
   *
   * Never throws: every failure is a named reason the page renders in words,
   * because a quota readout is an enhancement and a deployment without one must
   * still show its own counters.
   *
   * @param {object} [input] - how to read.
   * @param {boolean} [input.force] - ignore the cache and ask the service.
   * @returns {Promise<object>} `{ ok: true, windows, fetchedAt }` or `{ ok: false, reason, message }`.
   */
  async read(input = {}) {
    const now = this.now()
    if (input.force !== true && this.entry !== undefined && now - this.entry.fetchedAt < this.lifetimeMs) {
      return { ok: true, cached: true, fetchedAt: this.entry.fetchedAt, windows: this.entry.windows }
    }
    // One request per burst: a page that asks twice, or a reader and a reader,
    // shares the answer that is already in flight.
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.#read(now).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** The single network read, with its answer cached. */
  async #read(now) {
    let headers
    try {
      headers = { ...(this.deps.authHeaders === undefined ? {} : await this.deps.authHeaders()) }
    } catch (error) {
      return this.failure('no-credential', error)
    }
    const implementation = this.deps.fetch ?? globalThis.fetch
    if (typeof implementation !== 'function') return { ok: false, reason: 'unreachable', message: 'fetch is unavailable' }

    let response
    try {
      response = await implementation(`${this.config.baseURL}${SUBSCRIPTION_PATH}`, {
        method: 'GET',
        headers: { ...headers, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(this.config.timeoutMs, 30_000)),
      })
    } catch (error) {
      return this.failure('unreachable', error)
    }
    if (response.status === 401 || response.status === 403) return this.failure('unauthorized')
    // A gateway that mirrors the model surface need not serve this one, and a
    // service that dropped it answers 404: both mean "ask your console".
    if (response.status === 404 || response.status === 405) return this.failure('unsupported')
    if (!response.ok) return this.failure('failed', undefined, `HTTP ${response.status}`)

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      return this.failure('failed', error)
    }
    const parsed = parseSubscription(payload)
    if (parsed === undefined) return { ok: false, reason: 'unsupported', message: 'the service answered without usage windows' }
    this.entry = { fetchedAt: now, windows: parsed.windows }
    return { ok: true, cached: false, fetchedAt: now, windows: parsed.windows }
  }

  /** Record one failure as a reason the page can name, and warn once per read. */
  failure(reason, error, detail) {
    const message = detail ?? error?.message ?? (error === undefined ? undefined : String(error))
    if (reason !== 'unsupported' && reason !== 'unauthorized') {
      this.deps.logger?.warn?.(
        'dsh-llm-opencode-go: could not read the subscription usage (%s): %s',
        reason,
        message ?? 'no detail',
      )
    }
    return { ok: false, reason, ...(message === undefined ? {} : { message }) }
  }

  /** The clock, in epoch milliseconds. */
  now() {
    return this.deps.now === undefined ? Date.now() : this.deps.now()
  }
}
