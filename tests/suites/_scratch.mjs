/**
 * A scratch area for the on-disk files a suite writes.
 *
 * `ModelCache` is a real file in a real directory, so the cases that measure
 * what discovery fetched have to know that the file they open is the one this
 * run wrote. Two things make that true, and both are needed:
 *
 *   - **The name is minted per run.** The process id was the only thing keeping
 *     two runs apart, and pids are recycled: a later run that drew a used id
 *     opened the earlier run's file at the same path, found a cache entry still
 *     inside its lifetime, and answered discovery from it — so a case that
 *     counted requests measured nothing, and failed three assertions away from
 *     the cause. The token built here carries the id, the start time, and four
 *     random bytes, so a leftover can never be the file this run opens, even
 *     when a run dies before its own cleanup.
 *   - **The files go away when the case ends.** One dead cache file per case per
 *     run is how the scratch tree reached thousands of them, and every one was a
 *     loaded gun for the next run that reused a pid.
 *
 * So each case gets a directory of its own under `.test-cache/`, deleted when
 * that case ends — passed or failed — and the token in the name makes anything a
 * crash leaves behind inert rather than loadable.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The checkout root, so the scratch tree lives in the directory `.gitignore` names. */
const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))

/**
 * One scratch area, owned by one suite.
 *
 * A suite takes one of these and hands every case's files their paths from it, so
 * that "which of these files is mine" has an answer that does not depend on the
 * machine's history.
 *
 * @returns {{path: (label?: string) => string, withCleanup: (cases: readonly object[]) => object[]}} the area.
 */
export function createScratch() {
  const root = join(ROOT, '.test-cache')
  const token = `${String(process.pid)}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  /** Directories to remove: the running case's, plus any whose removal failed. */
  const directories = new Set()
  let current
  let caseNumber = 0
  let fileNumber = 0

  /** The running case's own directory, created the first time the case asks for one. */
  const forCase = () => {
    if (current === undefined) {
      caseNumber += 1
      current = join(root, `${token}-${String(caseNumber)}`)
      mkdirSync(current, { recursive: true })
      directories.add(current)
    }
    return current
  }

  /**
   * Remove one directory, forgiving a file that is still held open.
   *
   * A scratch file that will not go away is not a failure of the code under test,
   * and failing the suite over it would make the run flaky for a reason the plugin
   * cannot fix. The token in the name is what keeps such a survivor from ever
   * being read; removing it is only tidiness.
   */
  const discard = (path) => {
    directories.delete(path)
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Left for the exit pass below, and inert either way.
    }
  }

  // A case can leave work running: the startup health check is fire-and-forget, so
  // it may still be writing when the case that triggered it ends. Whatever is left
  // when the process exits is removed here.
  process.on('exit', () => {
    for (const path of directories) {
      try {
        rmSync(path, { recursive: true, force: true })
      } catch {
        // Nothing left to try, and nothing that matters: the name is unreachable.
      }
    }
  })

  return {
    /**
     * A path for one file, unique across cases, runs, and leftovers.
     *
     * @param {string} [label] - what the file is, so the tree reads as a list of names.
     * @returns {string} an absolute path that does not exist yet.
     */
    path(label = 'cache') {
      fileNumber += 1
      return join(forCase(), `${label}-${String(fileNumber)}.json`)
    },
    /**
     * Wrap a suite's cases so each one's directory is removed when it ends.
     *
     * @param {readonly object[]} cases - the suite's own cases, in order.
     * @returns {object[]} the same cases, each cleaning up after itself.
     */
    withCleanup(cases) {
      return cases.map((testCase) => ({
        ...testCase,
        async run() {
          try {
            return await testCase.run()
          } finally {
            const path = current
            current = undefined
            fileNumber = 0
            if (path !== undefined) discard(path)
          }
        },
      }))
    },
  }
}
