/**
 * Where this install was last seen, and which notices the reader closed.
 *
 * The page shows the endpoint notice once after an upgrade, and only for an
 * install that ran an earlier version: a fresh installation has nothing to be
 * told about. Two facts answer that, and neither needs a configuration field:
 *
 *   - the version this install last reported, rewritten beside the usage
 *     counters whenever the plugin starts;
 *   - on the first start of a build that knows this file, the models cache
 *     already on disk is the evidence that this plugin ran here before.
 *
 * A `dismissed` list keeps a reader's "do not show again" for good: it is read
 * before a notice is decided and never expires, so a later version cannot bring
 * back a notice the reader closed.
 *
 * Every failure here is a sentence in the log, never a thrown error: a notice
 * is advice, and a home directory that cannot be written must not cost a page.
 *
 * @module dsh-llm-opencode-go/notice/install
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { usagePath } from '../usage/store.js'

/** The file's name under the same directory as the usage counters. */
export const INSTALL_STATE_FILENAME = 'opencode-go-install.json'

/** The one notice this build knows: the default per-API endpoints. */
export const ENDPOINT_NOTICE_ID = 'endpoints-per-api'

/**
 * Where this install's record lives.
 *
 * It sits beside the usage counters rather than taking a path field of its own:
 * a deployment that redirected its counters has already said where its
 * per-install files belong, and one more setting would be one more thing to
 * explain for a file a reader never edits.
 *
 * @param {object} config - the resolved plugin configuration.
 * @returns {string} the absolute path of the install record.
 */
export function installStatePath(config) {
  return join(dirname(usagePath(config)), INSTALL_STATE_FILENAME)
}

/**
 * Read one state file's shape without trusting any of it.
 *
 * A file written by another build, hand-edited, or truncated is worth the same
 * as no file at all — except that `dismissed` is kept whenever it is readable,
 * because losing it is the one outcome a reader would notice.
 *
 * @param {unknown} value - the parsed JSON.
 * @returns {{version: string|undefined, dismissed: string[]}|undefined} the state, or undefined when it is not one.
 */
function normalize(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const version = typeof value.version === 'string' && value.version.trim() !== ''
    ? value.version.trim()
    : undefined
  const dismissed = Array.isArray(value.dismissed)
    ? [...new Set(value.dismissed.filter((id) => typeof id === 'string' && id !== ''))]
    : []
  return { version, dismissed }
}

/**
 * The install record on one deployment.
 *
 * One instance per plugin load: it caches nothing, and every read is the file
 * as it is now, so the page and the startup path cannot disagree about what was
 * dismissed.
 */
export class InstallState {
  /**
   * @param {object} config - the resolved plugin configuration.
   * @param {object} [deps] - the seams this store reads through.
   * @param {object} [deps.logger] - a Cordis-style logger.
   */
  constructor(config, deps = {}) {
    this.path = installStatePath(config)
    this.logger = deps.logger
    this.reported = false
  }

  /** Report one underlying failure, once, so a broken file does not fill the log. */
  #report(message, error) {
    if (this.reported === true) return
    this.reported = true
    this.logger?.warn?.(`dsh-llm-opencode-go: ${message}: %s`, error?.message ?? String(error))
  }

  /**
   * What this install last reported, or `undefined` when there is no record.
   *
   * A missing file is the normal first start and is not reported; an unreadable
   * or malformed one is reported once and treated as no record, which is what
   * makes the next start decide again rather than fail.
   *
   * @returns {Promise<{version: string|undefined, dismissed: string[]}|undefined>} the record.
   */
  async read() {
    let text
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      this.#report(`the install record at ${this.path} could not be read`, error)
      return undefined
    }
    try {
      return normalize(JSON.parse(text))
    } catch (error) {
      this.#report(`the install record at ${this.path} is not valid JSON`, error)
      return undefined
    }
  }

  /**
   * Replace the record, atomically, best effort.
   *
   * The write goes to a sibling first and is renamed into place, so a crash
   * cannot leave half a record for the next start to misread.
   *
   * @param {{version: string, dismissed: string[]}} state - the record to keep.
   * @returns {Promise<boolean>} whether the record reached the disk.
   */
  async write(state) {
    const temporary = `${this.path}.${String(process.pid)}.tmp`
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temporary, this.path)
      return true
    } catch (error) {
      this.#report(`the install record at ${this.path} could not be written`, error)
      return false
    }
  }
}
