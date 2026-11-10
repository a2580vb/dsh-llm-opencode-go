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
 * An event log would be more precise and would grow once per call; a person
 * asking "what did last week cost me" wants a table. The complete history is
 * kept as one counter row per model per day, so its size follows the number of
 * active days and models rather than the number of requests.
 *
 * Writes are debounced rather than per-call: a token count that reaches disk a
 * few seconds late is worth far more than an `fs` call in the middle of a
 * stream. A crash loses at most the current debounce window, and the plugin's
 * own unload flushes whatever is pending.
 *
 * @module dsh-llm-opencode-go/usage/store
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** File format version; a mismatch discards the file instead of guessing. */
const CACHE_VERSION = 1

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

/**
 * A day or model dictionary with no inherited members.
 *
 * Both are keyed by values this module does not choose: a model id comes from
 * the harness, and day/model names come back from the usage file. On a plain
 * object, `__proto__` resolves to the prototype, `constructor` to the Object
 * constructor, and `toString` to an inherited method, so writing "the record for
 * this id" would reach shared objects instead of creating a key. A dictionary
 * with a null prototype has no such members: every string is an ordinary own
 * key, and JSON serialises it exactly like the plain object it replaces.
 *
 * @returns {Record<string, unknown>} an empty dictionary.
 */
function emptyDictionary() {
  return Object.create(null)
}

/**
 * Read an own member of a dictionary.
 *
 * Used on values that came from the usage file: an inherited member is not a
 * record this file holds, and reading it is how `__proto__` gets counted as a
 * model. `Object.hasOwn` makes the distinction explicit without trusting the
 * dictionary's prototype.
 *
 * @param {unknown} source - the dictionary, or anything else.
 * @param {string} key - the member to read.
 * @returns {unknown} the own value, or `undefined`.
 */
function ownMember(source, key) {
  return source !== null && typeof source === 'object' && Object.hasOwn(source, key)
    ? source[key]
    : undefined
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
    // How many calls came back with a cache figure at all, zero included. "The
    // service said nothing was cached" and "the service did not say" are
    // different facts, and a hit rate of 0% would state the first when only the
    // second is known.
    cacheReported: 0,
  }
}

/** Add one record's numbers onto a counter row, in place. */
function accumulate(row, record) {
  row.requests += 1
  if (record.ok !== true) row.failures += 1
  for (const [field, value] of Object.entries(record)) {
    if (field === 'ok') continue
    // A row read from a file written before a field existed has no member of
    // that name, and `undefined + 0` is NaN, which would poison every later
    // write. Absent therefore means zero, here as well as in `mergeCounters`.
    const current = Number.isFinite(row[field]) ? row[field] : 0
    row[field] = current + (Number.isFinite(value) ? value : 0)
  }
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
   * @param {(path: string, encoding: string) => Promise<string>} [deps.readFile] - the history read, for gate tests.
   * @param {(path: string, data: string, encoding: string) => Promise<void>} [deps.writeFile] - the history write, for gate tests.
   * @param {(path: string, options: object) => Promise<string | undefined>} [deps.mkdir] - the directory creation, for gate tests.
   */
  constructor(config, deps = {}) {
    this.config = config
    this.deps = deps
    /** @type {Record<string, Record<string, object>>} day -> model -> counters */
    this.days = emptyDictionary()
    /** Whether the one history read has finished. */
    this.loaded = false
    /** The first read in flight, shared by every caller that arrives during it. */
    this.loading = undefined
    this.dirty = false
    /**
     * Increments on every recorded call.
     *
     * A write serialises one revision; when this number moved before the write
     * finished, the write is older than the memory it would mark written, so
     * the next flush has to run instead of trusting that write.
     */
    this.revision = 0
    /** The tail of the write queue: flushes run one at a time. */
    this.writing = Promise.resolve()
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
   * Every caller that arrives while the read is in flight awaits that same
   * read, and `loaded` turns true only when it finishes: reporting the read as
   * done before it is done makes a concurrent `summary` fold an empty table.
   *
   * @returns {Promise<void>} resolves once the history is in memory.
   */
  load() {
    if (this.loaded) return Promise.resolve()
    if (this.loading !== undefined) return this.loading
    this.loading = this.#readHistory()
    return this.loading
  }

  /** The body of the one first read; see {@link load}. */
  async #readHistory() {
    try {
      const read = this.deps.readFile ?? readFile
      const parsed = JSON.parse(await read(this.path, 'utf8'))
      if (parsed?.version !== CACHE_VERSION || typeof parsed.days !== 'object' || parsed.days === null) return
      // Merged into what is already counted, not assigned over it.
      //
      // A call can be counted before this first read -- recording never waits
      // for the file -- and `flush` reads through here. Assigning the file's map
      // therefore threw away whatever this activation had counted so far, which
      // is the first call after every restart: the one that often primes the
      // cache, so its cache figures vanished with it. This read runs once, which
      // is what keeps the merge from counting the same record twice.
      this.days = mergeDays(this.days, validDays(parsed.days))
    } catch {
      // No history yet, or one this version cannot read.
    } finally {
      this.loaded = true
      this.loading = undefined
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
    const models = this.days[day] ?? (this.days[day] = emptyDictionary())
    // `call.model` is harness input, so it may name anything at all -- including
    // a member every object inherits. An own-property lookup is what makes such
    // a name a record of its own instead of a read of (and write to) the
    // prototype chain.
    const row = Object.hasOwn(models, call.model)
      ? models[call.model]
      : (models[call.model] = emptyCounters())
    const reported = call.usage?.cacheReadTokens !== undefined || call.usage?.cacheWriteTokens !== undefined
    accumulate(row, {
      ok: call.ok,
      inputTokens: count(call.usage, 'inputTokens'),
      outputTokens: count(call.usage, 'outputTokens'),
      // The parts add up to the total when the provider did not state one: every
      // figure here is exclusive, because the mapper has already taken the
      // cached part out of the input count.
      totalTokens: count(call.usage, 'totalTokens')
        || count(call.usage, 'inputTokens') + count(call.usage, 'outputTokens')
          + count(call.usage, 'cacheReadTokens') + count(call.usage, 'cacheWriteTokens'),
      cacheReadTokens: count(call.usage, 'cacheReadTokens'),
      cacheWriteTokens: count(call.usage, 'cacheWriteTokens'),
      cacheReported: reported ? 1 : 0,
    })
    this.revision += 1
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
   * Writes are queued: two flushes can overlap (a debounce timer firing while
   * the unload path runs), and two snapshots written concurrently may finish in
   * either order, so the older one could replace the newer file. One writer at
   * a time is what makes the last write the newest snapshot.
   *
   * @returns {Promise<boolean>} whether the file was written.
   */
  async flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    // The failure handler keeps the queue alive after a rejected step; the
    // returned promise still reports that step's outcome to its caller.
    const next = this.writing.then(() => this.#writeSnapshot(), () => this.#writeSnapshot())
    this.writing = next.then(() => undefined, () => undefined)
    return next
  }

  /** One queued write; see {@link flush}. */
  async #writeSnapshot() {
    if (!this.dirty) return false
    await this.load()
    // The revision and the table are read in the same synchronous step, so the
    // snapshot describes exactly one revision of memory.
    const revision = this.revision
    const days = validDays(this.days)
    try {
      const ensure = this.deps.mkdir ?? mkdir
      const write = this.deps.writeFile ?? writeFile
      await ensure(dirname(this.path), { recursive: true })
      await write(this.path, JSON.stringify({
        version: CACHE_VERSION,
        updatedAt: this.now(),
        days,
      }), 'utf8')
      this.warned = false
      // A call recorded while the write was in flight is newer than this
      // snapshot: leaving the store dirty is what makes the next timer or
      // unload flush write it. Clearing it here loses that record.
      if (this.revision === revision) this.dirty = false
      return true
    } catch (error) {
      // A usage table that cannot be written is worth one warning, never a
      // failed call: the numbers are a report, not the request.
      if (!this.warned) {
        this.warned = true
        this.deps.logger?.warn?.(
          'dsh-llm-opencode-go: could not write the usage file at %s: %s',
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
   * @param {number | 'all'} [input.days] - how many days back to include, or the complete history.
   * @returns {Promise<object>} totals, the per-day series, and the per-model breakdown.
   */
  async summary(input = {}) {
    await this.load()
    const all = input.days === 'all'
    const window = all || (Number.isInteger(input.days) && input.days > 0) ? input.days : 7
    const today = this.now()
    const wanted = new Set()
    if (!all) {
      // A calendar day is not always 86_400_000 ms: a DST change makes one
      // local day 23 or 25 hours long, so subtracting milliseconds from an
      // early hour can skip the transition day (spring) or land on the same
      // day twice (fall). Stepping the local date instead walks the calendar
      // the reader sees.
      const anchor = new Date(today)
      for (let back = 0; back < window; back += 1) {
        const day = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - back)
        wanted.add(dayKey(day.getTime()))
      }
    }

    const totals = emptyCounters()
    const byModel = new Map()
    const byDay = []
    let earliest
    for (const day of Object.keys(this.days).sort()) {
      if (!all && !wanted.has(day)) continue
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
      // `null` is explicit: the local history has no age-based expiry.
      retentionDays: null,
      retention: Object.keys(this.days).sort(),
    }
  }
}

/** Add every counter of `from` onto `onto`, in place. */
function mergeCounters(onto, from) {
  for (const field of Object.keys(emptyCounters())) {
    // A row read from a file written before a field existed has no member of
    // that name, and an inherited member is not this row's count.
    const value = ownMember(from, field)
    onto[field] += Number.isFinite(value) ? value : 0
  }
}

/**
 * Add two day maps together, day by day and model by model.
 *
 * Used to fold the file into what this activation has already counted, so the
 * two histories add up rather than one replacing the other.
 */
function mergeDays(counted, fromFile) {
  // Null-prototype maps so a file's `__proto__` day or model stays a key of its
  // own instead of replacing the map's prototype (and disappearing from the
  // keys, which is how the record used to be lost).
  const merged = emptyDictionary()
  for (const day of new Set([...Object.keys(fromFile), ...Object.keys(counted)])) {
    const fileDay = ownMember(fromFile, day)
    const countedDay = ownMember(counted, day)
    const models = emptyDictionary()
    const fileModels = Object.keys(fileDay ?? {})
    const countedModels = Object.keys(countedDay ?? {})
    for (const model of new Set([...fileModels, ...countedModels])) {
      const row = emptyCounters()
      mergeCounters(row, ownMember(fileDay, model))
      mergeCounters(row, ownMember(countedDay, model))
      models[model] = row
    }
    merged[day] = models
  }
  return merged
}

/** Copy every readable day without discarding history because of its age. */
function validDays(days) {
  // Re-key into null-prototype maps for the same reason as `mergeDays`: the day
  // and model names are file data, and `kept[day] = models` on a plain object
  // would send `__proto__` to the setter rather than create a day.
  const kept = emptyDictionary()
  for (const [day, models] of Object.entries(days)) {
    if (models === null || typeof models !== 'object') continue
    const copy = emptyDictionary()
    for (const [model, row] of Object.entries(models)) copy[model] = row
    kept[day] = copy
  }
  return kept
}
