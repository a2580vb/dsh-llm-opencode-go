/**
 * The one notice an upgrade is worth: the default inference endpoints changed.
 *
 * A request that used to post to `{baseURL}/chat/completions` now posts to the
 * per-API path under the documented base, and nothing on the page shows that a
 * deployment which pinned the legacy base is the only one unaffected. So the
 * notice is shown once, to the installs it can actually be news to:
 *
 *   - an install that ran an earlier version, never a fresh one;
 *   - an install that is on the per-API layout now, because a reader who kept
 *     the legacy base sees no change in where its requests go;
 *   - an install that has not closed it, and closing it is final.
 *
 * The decision is made once per plugin load and remembered in `install`; the
 * page asks for the answer rather than computing it, because only the Host sees
 * the install record and the configured base together.
 *
 * @module dsh-llm-opencode-go/notice/upgrade
 */

import { endpointLayout } from '../config.js'
import { ENDPOINT_NOTICE_ID } from './install.js'

/**
 * One upgrade notice's state machine, over one install record.
 */
export class UpgradeNotice {
  /**
   * @param {object} input - what the decision reads.
   * @param {object} input.config - the resolved plugin configuration.
   * @param {import('./install.js').InstallState} input.install - the install record.
   * @param {string} input.version - the version this process runs.
   * @param {() => boolean} input.cacheExists - whether an earlier build's model cache is on disk.
   */
  constructor({ config, install, version, cacheExists }) {
    this.config = config
    this.install = install
    this.version = version
    this.cacheExists = cacheExists
    this.id = ENDPOINT_NOTICE_ID
    this.decision = undefined
    this.view = Object.freeze({ id: this.id, show: false })
  }

  /** Decide once, and keep the answer for every later reader. */
  #decide() {
    return (async () => {
      const previous = await this.install.read()
      const dismissed = previous?.dismissed ?? []
      // A record from another build is an upgrade; no record at all is an
      // upgrade only when this plugin already left a cache here, which is what
      // keeps a fresh installation from being told about a change it never saw.
      const upgraded = previous?.version === undefined
        ? this.cacheExists() === true
        : previous.version !== this.version
      this.view = Object.freeze({
        id: this.id,
        show: upgraded
          && !dismissed.includes(this.id)
          // The legacy base keeps the unified layout, so its requests did not
          // move: there is nothing to announce to that deployment.
          && endpointLayout(this.config.baseURL) === 'split',
        ...(previous?.version === undefined ? {} : { from: previous.version }),
      })
      if (previous?.version !== this.version) {
        await this.install.write({ version: this.version, dismissed })
      }
      return this.view
    })()
  }

  /**
   * Start the decision without waiting for it.
   *
   * Called when the plugin loads, so the first page open already has an answer.
   * A failure is swallowed here: the notice is advice, and a page that cannot
   * be told about it still has to render.
   *
   * @returns {Promise<object>} the decided view.
   */
  begin() {
    this.decision ??= this.#decide().catch(() => this.view)
    return this.decision
  }

  /**
   * The decided view, waiting for the decision when the page arrives first.
   *
   * @returns {Promise<{id: string, show: boolean, from?: string}>} the view.
   */
  async current() {
    await this.begin()
    return this.view
  }

  /**
   * Record "do not show again".
   *
   * @param {string} id - the notice a reader closed; an unknown one is refused.
   * @returns {Promise<boolean>} whether the dismissal reached the disk.
   */
  async dismiss(id) {
    if (id !== this.id) return false
    await this.begin()
    const state = await this.install.read()
    const dismissed = new Set(state?.dismissed ?? [])
    dismissed.add(id)
    const stored = await this.install.write({ version: this.version, dismissed: [...dismissed] })
    // Only a stored dismissal hides the notice: a reader whose home is
    // read-only is told the dismissal did not take, rather than being promised
    // it will not come back and then seeing it again next start.
    if (stored === true) this.view = Object.freeze({ ...this.view, show: false })
    return stored
  }
}

/**
 * Build the upgrade notice over one configuration.
 *
 * @param {object} input - see {@link UpgradeNotice}.
 * @returns {UpgradeNotice} the notice.
 */
export function createUpgradeNotice(input) {
  return new UpgradeNotice(input)
}
