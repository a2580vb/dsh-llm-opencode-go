/**
 * What this route has spent.
 *
 * Usage is the one fact only this plugin can see: the harness reports tokens per
 * call to whoever made it, and nothing above this adapter knows which model a
 * token went to or which deployment paid for it. So the adapter records every
 * call here, and the configuration page reads it back.
 *
 * The shape is a per-day, per-model counter, not an event log:
 *
 *   { version, updatedAt, days: { '2026-01-05': { 'glm-5.3': { requests, … } } } }
 *
 * An event log would be more precise and unbounded; a person asking "what did
 * last week cost me" wants a table, and a counter file stays small enough to
 * read on every page load. Days outside the retention window are dropped when
 * the file is written, so the file cannot grow without limit.
 *
 * Writes are debounced rather than per-call: a token count that reaches disk a
 * few seconds late is worth far more than an `fs` call in the middle of a
 * stream. A crash loses at most the current debounce window, and the plugin's
 * own unload flushes whatever is pending.
 *
 * @module dsh-opencode-go/usage/store
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** File format version; a mismatch discards the file instead of guessing. */
const CACHE_VERSION = 1

/** How long a day's counters are kept, in days. */
export const RETENTION_DAYS = 30

/** How long a change may wait for the next write, in milliseconds. */
export const FLUSH_DELAY_MS = 5_000

/**
 * The default usage path: `~/.dsh/cache/opencode-go-usage.json`.
 *
 * Beside the model cache on purpose: both are facts about this machine's use of
 * this route, and a deployment that relocates one has probably relocated the
 * other.
 *
 * @param {object} config - the resolved plugin configuration.
 * @returns {string} an absolute path.
 */
export function usagePath(config) {
  return config.usagePath ?? join(homedir(), '.dsh', 'cache', 'opencode-go-usage.json')
}

/**
 * The local calendar day an instant belongs to.
 *
 * Local rather than UTC because the person reading the table thinks in their
 * own days; a token spent at 23:00 belongs to the day they spent it.
 *
 * @param {number} when - epoch milliseconds.
 * @returns {string} `YYYY-MM-DD` in the machine's own time zone.
 */
export function dayKey(when) {
  const date = new Date(when)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** One day's counters, as the file stores them. */
function emptyCounters() {
  return {
    requests: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

/** Add one record's numbers onto a counter row, in place. */
function accumulate(row, record) {
  row.requests += 1
  if (record.ok !== true) row.failures += 1
  row.inputTokens += record.inputTokens
  row.outputTokens += record.outputTokens
  row.totalTokens += record.totalTokens
  row.cacheReadTokens += record.cacheReadTokens
  row.cacheWriteTokens += record.cacheWriteTokens
}

/**
 * Read one token figure off a harness `TokenUsage`, tolerating what it omits.
 *
 * @param {object} usage - a `TokenUsage`-shaped object, or anything else.
 * @param {string} field - the field to read.
 * @returns {number} a non-negative integer.
 */
function count(usage, field) {
  const value = Number(usage?.[field])
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * The counters this deployment has accumulated.
 *
 * One instance per plugin activation, sharing the adapter's lifetime: a reload
 * reads the file again, so an edit to the row config does not lose the history.
 */
export class UsageStore {
  /**
   * @param {object} config - the resolved plugin configuration.
   * @param {object} [deps] - injected collaborators.
   * @param {object} [deps.logger] - a Cordis-style logger (`info`/`warn`).
   * @param {() => number} [deps.now] - the clock, for tests.
   * @param {number} [deps.flushDelayMs] - the write debounce, for tests.
   */
  constructor(config, deps = {}) {
    this.config = config
    this.deps = deps
    /** @type {Record<string, Record<string, object>>} day -> model -> counters */
    this.days = {}
    this.loaded = false
    this.dirty = false
    this.timer = undefined
    /** A write that failed is reported once, not once per call. */
    this.warned = false
  }

  /** The file this store reads and writes. */
  get path() {
    return usagePath(this.config)
  }

  /** The clock, in epoch milliseconds. */
  now() {
    return this.deps.now === undefined ? Date.now() : this.deps.now()
  }

  /**
   * Read the file once.
   *
   * A missing, unreadable, or corrupt file is not an error: it means this
   * deployment has no history yet, which is the same starting point as a new
   * installation. Starting empty is always better than refusing to start.
   *
   * @returns {Promise<void>} resolves once the history is in memory.
   */
  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'))
      if (parsed?.version !== CACHE_VERSION || typeof parsed.days !== 'object' || parsed.days === null) return
      this.days = prune(parsed.days, this.now())
    } catch {
      // No history yet, or one this version cannot read.
    }
  }

  /**
   * Count one finished call, successful or not.
   *
   * Recording a failure is deliberate: a refused call still costs whatever the
   * request carried, and a model that only ever fails is exactly what a usage
   * table should reveal.
   *
   * @param {object} call - one call's outcome.
   * @param {string} call.model - the model id the harness asked for.
   * @param {object} [call.usage] - the harness `TokenUsage` the stream reported.
   * @param {boolean} call.ok - whether the call completed.
   * @param {number} [call.at] - when it finished.
   * @returns {void}
   */
  record(call) {
    const at = call.at ?? this.now()
    const day = dayKey(at)
    const models = this.days[day] ?? (this.days[day] = {})
    const row = models[call.model] ?? (models[call.model] = emptyCounters())
    accumulate(row, {
      ok: call.ok,
      inputTokens: count(call.usage, 'inputTokens'),
      outputTokens: count(call.usage, 'outputTokens'),
      totalTokens: count(call.usage, 'totalTokens')
        || count(call.usage, 'inputTokens') + count(call.usage, 'outputTokens'),
      cacheReadTokens: count(call.usage, 'cacheReadTokens'),
      cacheWriteTokens: count(call.usage, 'cacheWriteTokens'),
    })
    this.dirty = true
    this.schedule()
  }

  /** Arrange the next write, unless one is already arranged. */
  schedule() {
    if (this.timer !== undefined || this.deps.flushDelayMs === 0) return
    const delay = this.deps.flushDelayMs ?? FLUSH_DELAY_MS
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, delay)
    // A pending write must not hold the process open; the unload path flushes.
    this.timer?.unref?.()
  }

  /**
   * Write the counters out, if anything changed.
   *
   * Pruning happens here rather than on read, so an idle deployment's file
   * shrinks the next time it counts something instead of growing a day at a
   * time forever.
   *
   * @returns {Promise<boolean>} whether the file was written.
   */
  async flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.dirty) return false
    await this.load()
    this.days = prune(this.days, this.now())
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(this.path, JSON.stringify({
        version: CACHE_VERSION,
        updatedAt: this.now(),
        days: this.days,
      }), 'utf8')
      this.dirty = false
      this.warned = false
      return true
    } catch (error) {
      // A usage table that cannot be written is worth one warning, never a
      // failed call: the numbers are a report, not the request.
      if (!this.warned) {
        this.warned = true
        this.deps.logger?.warn?.(
          'dsh-opencode-go: could not write the usage file at %s: %s',
          this.path,
          error?.message ?? String(error),
        )
      }
      return false
    }
  }

  /**
   * The table the page renders.
   *
   * @param {object} [input] - the window to report.
   * @param {number} [input.days] - how many days back to include, today last.
   * @returns {Promise<object>} totals, the per-day series, and the per-model breakdown.
   */
  async summary(input = {}) {
    await this.load()
    const window = Number.isInteger(input.days) && input.days > 0 ? input.days : 7
    const today = this.now()
    const keys = []
    for (let back = 0; back < window; back += 1) keys.push(dayKey(today - back * 86_400_000))
    const wanted = new Set(keys)

    const totals = emptyCounters()
    const byModel = new Map()
    const byDay = []
    let earliest
    for (const day of Object.keys(this.days).sort()) {
      if (!wanted.has(day)) continue
      const dayRow = emptyCounters()
      for (const [model, row] of Object.entries(this.days[day])) {
        mergeCounters(dayRow, row)
        mergeCounters(totals, row)
        const modelRow = byModel.get(model) ?? emptyCounters()
        mergeCounters(modelRow, row)
        byModel.set(model, modelRow)
        if (earliest === undefined || day < earliest) earliest = day
      }
      byDay.push({ day, counters: dayRow })
    }

    const models = [...byModel.entries()]
      .map(([model, counters]) => ({ model, counters }))
      .sort((left, right) => right.counters.totalTokens - left.counters.totalTokens
        || right.counters.requests - left.counters.requests
        || left.model.localeCompare(right.model))

    return {
      window,
      today: dayKey(today),
      days: byDay,
      models,
      totals,
      firstDay: earliest ?? null,
      retentionDays: RETENTION_DAYS,
      retention: Object.keys(this.days).sort(),
    }
  }
}

/** Add every counter of `from` onto `onto`, in place. */
function mergeCounters(onto, from) {
  for (const field of Object.keys(emptyCounters())) {
    onto[field] += Number.isFinite(from?.[field]) ? from[field] : 0
  }
}

/** Drop days outside the retention window, keeping the newest. */
function prune(days, now) {
  const cutoff = dayKey(now - (RETENTION_DAYS - 1) * 86_400_000)
  const kept = {}
  for (const [day, models] of Object.entries(days)) {
    if (day < cutoff) continue
    if (models === null || typeof models !== 'object') continue
    kept[day] = models
  }
  return kept
}
