/**
 * What one model call actually met on the wire.
 *
 * A failure reaches the harness as a code and a sentence, and the harness keeps
 * those — so "the call failed" is never lost. What is lost is the layer under
 * them: an undici `fetch` rejects with `TypeError: fetch failed` and carries the
 * real reason (`ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`, a socket closed by the
 * far end) only in its `cause`, and a stream that dies halfway is reported after
 * the request was already accepted. Neither is visible anywhere afterwards, and
 * without it two failures a week apart look identical.
 *
 * So this module appends one JSON line per attempt outcome to a file a person
 * can read after the fact. Three properties are deliberate:
 *
 *   - **Metadata only.** Model, protocol, timing, status, error code, the cause
 *     chain, and how many events arrived. No request body, no headers, no key:
 *     a diagnostics file that leaks a credential is worse than no file.
 *   - **Failures by default.** A working call writes nothing, so an untouched
 *     installation never grows a log. `diagnostics: all` records successes too,
 *     which is what a latency question needs.
 *   - **Bounded.** The file rotates at {@link MAX_LOG_BYTES} and keeps
 *     {@link KEPT_ROTATIONS} predecessors, so a deployment that fails in a loop
 *     cannot fill a disk.
 *
 * Writing never fails a call and never throws: the log is evidence about a
 * request, not part of it.
 *
 * @module dsh-llm-opencode-go/diagnostics/log
 */

import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** How large the log may grow before it rotates, in bytes. */
export const MAX_LOG_BYTES = 1_048_576

/** How many rotated files are kept beside the live one. */
export const KEPT_ROTATIONS = 2

/** The most of any single message the log carries, in characters. */
export const MESSAGE_LIMIT = 400

/** How deep a `cause` chain is followed before it is assumed to be a cycle. */
const CAUSE_DEPTH = 5

/**
 * The default diagnostics path: `~/.dsh/logs/opencode-go.jsonl`.
 *
 * Beside the usage counters and the model cache, under a directory of its own so
 * "this is a log, not state" is visible in `ls`.
 *
 * @param {object} config - the resolved plugin configuration.
 * @returns {string} an absolute path.
 */
export function diagnosticsPath(config) {
  return config?.diagnosticsPath ?? join(homedir(), '.dsh', 'logs', 'opencode-go.jsonl')
}

/**
 * The reason chain behind a failure, as plain data.
 *
 * A transport failure's own message is a summary ("fetch failed"); the answer to
 * "but why" is one or more `cause` links down, and for a `fetch` to a
 * multi-address host it is an `AggregateError` whose members are the per-address
 * attempts. Both are flattened into one array, oldest detail last, so a reader
 * sees the whole chain in a single log line.
 *
 * @param {unknown} error - the thrown value.
 * @returns {object[]} one entry per link, each with only serializable fields.
 */
export function causeChain(error) {
  const links = []
  const seen = new Set()
  let current = error
  for (let depth = 0; depth < CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== 'object' || seen.has(current)) break
    seen.add(current)
    const link = describeFailure(current)
    if (link !== undefined) links.push(link)
    if (Array.isArray(current.errors)) {
      for (const member of current.errors.slice(0, 4)) {
        if (member === null || typeof member !== 'object') continue
        const inner = describeFailure(member)
        if (inner !== undefined) links.push({ ...inner, via: 'errors' })
      }
    }
    current = current.cause
  }
  return links
}

/**
 * The serializable fields of one thrown value.
 *
 * `name`, `message`, and whatever of `code`/`errno`/`syscall`/`address`/`port`
 * the value carries: system and undici errors put the diagnosis in exactly those
 * properties, and a stack trace is not worth the bytes.
 *
 * @param {object} error - a thrown value or a member of an aggregate.
 * @returns {object | undefined} the fields, or undefined when it has no message.
 */
function describeFailure(error) {
  const message = typeof error.message === 'string' ? error.message.trim() : ''
  const name = typeof error.name === 'string' && error.name !== '' ? error.name : undefined
  if (message === '' && name === undefined) return undefined
  const link = {
    name,
    message: message === '' ? undefined : limit(message),
    code: scalar(error.code),
    errno: scalar(error.errno),
    syscall: scalar(error.syscall),
    address: scalar(error.address),
    port: scalar(error.port),
  }
  for (const field of Object.keys(link)) if (link[field] === undefined) delete link[field]
  return Object.keys(link).length === 0 ? undefined : link
}

/** A string or number as it should appear in the log, or undefined. */
function scalar(value) {
  if (typeof value === 'string') return value === '' ? undefined : limit(value)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

/** One line's worth of a long message. */
function limit(text) {
  return text.length <= MESSAGE_LIMIT ? text : `${text.slice(0, MESSAGE_LIMIT)}…`
}

/**
 * The diagnostics log of one plugin activation.
 *
 * Appends are queued rather than awaited by the caller: the record is written on
 * the attempt's own path, and a slow disk must not hold a stream open. The queue
 * also keeps two records from interleaving inside one line, which would make the
 * file unreadable for the reason it exists.
 */
export class DiagnosticsLog {
  /**
   * @param {object} config - the resolved plugin configuration.
   * @param {object} [deps] - injected collaborators.
   * @param {object} [deps.logger] - a Cordis-style logger, for write failures.
   * @param {number} [deps.maxBytes] - the rotation threshold, for tests.
   * @param {number} [deps.keptRotations] - how many predecessors are kept.
   */
  constructor(config, deps = {}) {
    this.config = config
    this.deps = deps
    /** The tail of the write chain; every append waits for the one before it. */
    this.queue = Promise.resolve()
    /** Bytes currently in the file, read once and then tracked. */
    this.size = undefined
    /** A write that failed is reported once, not once per attempt. */
    this.warned = false
  }

  /** The file this log appends to. */
  get path() {
    return diagnosticsPath(this.config)
  }

  /** The configured level: `off`, `failures`, or `all`. */
  get level() {
    return this.config?.diagnostics ?? 'failures'
  }

  /** Whether anything is recorded at all. */
  get enabled() {
    return this.level !== 'off'
  }

  /** Whether successful attempts are recorded too. */
  get verbose() {
    return this.level === 'all'
  }

  /** The rotation threshold in bytes. */
  get maxBytes() {
    return this.deps.maxBytes ?? MAX_LOG_BYTES
  }

  /** How many rotated files stay beside the live one. */
  get keptRotations() {
    return this.deps.keptRotations ?? KEPT_ROTATIONS
  }

  /**
   * Whether the configured level records this entry.
   *
   * @param {object} entry - one attempt's record.
   * @returns {boolean} true when the entry belongs in the file.
   */
  accepts(entry) {
    if (!this.enabled) return false
    return this.verbose || entry?.outcome === 'error'
  }

  /**
   * Queue one record.
   *
   * Returns immediately and never throws: the caller is a request path, and the
   * log is evidence about that request rather than part of it.
   *
   * @param {object} entry - one attempt's record, as plain data.
   * @returns {void}
   */
  record(entry) {
    if (!this.accepts(entry)) return
    const line = `${JSON.stringify(entry)}\n`
    this.queue = this.queue.then(() => this.#append(line)).catch(() => {})
  }

  /**
   * Wait for the queued records to reach the disk.
   *
   * Called when the plugin unloads, so a reload does not drop the tail of the
   * log — the record of the failure that prompted the reload is often the last
   * one written.
   *
   * @returns {Promise<void>} resolves once every queued append has settled.
   */
  async flush() {
    await this.queue
  }

  /**
   * Append one line, rotating first when it would cross the threshold.
   *
   * @param {string} line - one serialized record, newline included.
   * @returns {Promise<void>} resolves when written, or when writing was refused.
   */
  async #append(line) {
    const bytes = Buffer.byteLength(line)
    try {
      await mkdir(dirname(this.path), { recursive: true })
      if (this.size === undefined) this.size = await this.#measure()
      // `size > 0` keeps a single oversized record from rotating an empty file
      // into `.1` only to write the same record again at full size.
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        await this.#rotate()
        this.size = 0
      }
      await appendFile(this.path, line, 'utf8')
      this.size += bytes
      this.warned = false
    } catch (error) {
      if (!this.warned) {
        this.warned = true
        this.deps.logger?.warn?.(
          'dsh-llm-opencode-go: could not write the diagnostics log at %s: %s',
          this.path,
          error?.message ?? String(error),
        )
      }
    }
  }

  /**
   * The current file's size, or zero when it does not exist yet.
   *
   * @returns {Promise<number>} the size in bytes.
   */
  async #measure() {
    try {
      return (await stat(this.path)).size
    } catch {
      return 0
    }
  }

  /**
   * Shift the file into its first rotation slot, dropping the oldest.
   *
   * @returns {Promise<void>} resolves when the old files have been moved.
   */
  async #rotate() {
    for (let index = this.keptRotations; index >= 1; index -= 1) {
      const to = `${this.path}.${index}`
      const from = index === 1 ? this.path : `${this.path}.${index - 1}`
      if (index === this.keptRotations) await rm(to, { force: true }).catch(() => {})
      await rename(from, to).catch(() => {})
    }
  }
}
