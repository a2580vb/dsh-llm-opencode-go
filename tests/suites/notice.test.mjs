/**
 * The upgrade notice: who is told that the default endpoints moved, and how a
 * reader stops being told.
 *
 * The two halves are here together on purpose. The record decides what counts
 * as an upgrade, and the notice decides whether one is worth showing, so a case
 * that changed one without the other would be testing half a rule. Everything
 * is a real file under the case's own scratch directory: the point is what the
 * next start reads, not what this object remembers.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { DEFAULT_BASE_URL, LEGACY_BASE_URL, resolveConfig } from '../../lib/config.js'
import {
  ENDPOINT_NOTICE_ID,
  INSTALL_STATE_FILENAME,
  InstallState,
  installStatePath,
} from '../../lib/notice/install.js'
import { createUpgradeNotice } from '../../lib/notice/upgrade.js'
import { equal, is, ok } from '../helpers.mjs'
import { createScratch } from './_scratch.mjs'

const scratch = createScratch()

/** The version these cases run as; a bump is the trigger, not the rule. */
const VERSION = '0.3.0-dev.1'

/** A logger that keeps what it was told, for the cases about failures. */
function loggerUnderTest() {
  const lines = []
  return {
    lines,
    info() {},
    debug() {},
    error() {},
    warn: (...args) => lines.push(args.join(' ')),
  }
}

/** One notice over one record, with the evidence a case names. */
function noticeUnderTest(file, { cache = false, version = VERSION, ...overrides } = {}) {
  const config = resolveConfig({
    baseURL: DEFAULT_BASE_URL,
    usagePath: file,
    ...overrides.config,
  })
  const logger = overrides.logger ?? loggerUnderTest()
  const notice = createUpgradeNotice({
    config,
    install: new InstallState(config, { logger }),
    version,
    cacheExists: () => cache === true,
  })
  return { notice, config, logger }
}

/** Put a record on disk as an earlier build would have left it. */
async function seed(file, state) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(installStatePath({ usagePath: file }), `${JSON.stringify(state)}\n`, 'utf8')
}

/** What the record says now, or undefined when there is no file. */
async function recordOf(file) {
  try {
    return JSON.parse(await readFile(installStatePath({ usagePath: file }), 'utf8'))
  } catch {
    return undefined
  }
}

export default {
  name: 'notice',
  cases: scratch.withCleanup([
    {
      name: 'the record sits beside the usage counters, not behind a field of its own',
      run() {
        ok(installStatePath(resolveConfig({})).endsWith(join('.dsh', 'cache', INSTALL_STATE_FILENAME)))
        const custom = resolveConfig({ usagePath: 'D:/elsewhere/usage.json' })
        is(installStatePath(custom), join('D:/elsewhere', INSTALL_STATE_FILENAME))
      },
    },
    {
      name: 'a fresh install is not told about a change it never saw',
      async run() {
        const file = scratch.path('fresh')
        const { notice } = noticeUnderTest(file, { cache: false })
        const view = await notice.current()
        is(view.show, false)
        // The version is recorded anyway: the next start has to be able to tell
        // this install from one that predates the record.
        const record = await recordOf(file)
        is(record.version, VERSION)
        equal(record.dismissed, [])
      },
    },
    {
      name: 'an install that already ran here is told once',
      async run() {
        const file = scratch.path('upgraded')
        const { notice } = noticeUnderTest(file, { cache: true })
        const view = await notice.current()
        is(view.show, true)
        is(view.id, ENDPOINT_NOTICE_ID)
        is(view.from, undefined, 'an install with no record cannot name the version it came from')
        is((await recordOf(file)).version, VERSION)
      },
    },
    {
      name: 'the next start of the same version stays quiet',
      async run() {
        const file = scratch.path('same-version')
        await seed(file, { version: VERSION, dismissed: [] })
        const { notice } = noticeUnderTest(file, { cache: true })
        is((await notice.current()).show, false)
      },
    },
    {
      name: 'an upgrade names the version it came from',
      async run() {
        const file = scratch.path('from-version')
        await seed(file, { version: '0.2.5', dismissed: [] })
        const { notice } = noticeUnderTest(file, { cache: true })
        const view = await notice.current()
        is(view.show, true)
        is(view.from, '0.2.5')
      },
    },
    {
      name: 'the legacy base keeps quiet, and still records the version',
      async run() {
        const file = scratch.path('legacy')
        const { notice } = noticeUnderTest(file, {
          cache: true,
          config: { baseURL: LEGACY_BASE_URL },
        })
        is((await notice.current()).show, false, 'its requests did not move')
        is((await recordOf(file)).version, VERSION)
      },
    },
    {
      name: 'closing it is final across versions',
      async run() {
        const file = scratch.path('dismiss')
        await seed(file, { version: '0.2.5', dismissed: [] })
        const first = noticeUnderTest(file, { cache: true })
        is((await first.notice.current()).show, true)
        is(await first.notice.dismiss(ENDPOINT_NOTICE_ID), true)

        const next = noticeUnderTest(file, { cache: true, version: '0.4.0' })
        is((await next.notice.current()).show, false, 'a version bump does not reopen it')
        equal((await recordOf(file)).dismissed, [ENDPOINT_NOTICE_ID])
      },
    },
    {
      name: 'an unknown notice is refused rather than recorded',
      async run() {
        const file = scratch.path('unknown')
        await seed(file, { version: VERSION, dismissed: [] })
        const { notice } = noticeUnderTest(file, { cache: true })
        await notice.current()
        is(await notice.dismiss('some-other-notice'), false)
        equal((await recordOf(file)).dismissed, [])
      },
    },
    {
      name: 'a dismissal that does not reach the disk is reported, and the notice stays',
      async run() {
        // A path under a regular file cannot be created, which is how a
        // read-only or otherwise broken deployment behaves here.
        const blocker = scratch.path('blocker')
        await writeFile(blocker, 'not a directory', 'utf8')
        const file = join(blocker, 'usage.json')
        const { notice, logger } = noticeUnderTest(file, { cache: true })
        is((await notice.current()).show, true)
        is(await notice.dismiss(ENDPOINT_NOTICE_ID), false)
        is((await notice.current()).show, true, 'a reader who cannot store it still sees it')
        ok(logger.lines.length > 0, `the reason was logged: ${logger.lines.join(' | ')}`)
      },
    },
    {
      name: 'a corrupt record costs the record, not the page',
      async run() {
        const file = scratch.path('corrupt')
        await mkdir(dirname(file), { recursive: true })
        await writeFile(installStatePath({ usagePath: file }), '{ not json', 'utf8')
        const { notice, logger } = noticeUnderTest(file, { cache: true })
        is((await notice.current()).show, true, 'the cache is still evidence this plugin ran here')
        ok(logger.lines.some((line) => line.includes('not valid JSON')), 'the file is named')
        is((await recordOf(file)).version, VERSION, 'a readable record replaces it')
      },
    },
    {
      name: 'a record written by another build keeps the dismissals it already had',
      async run() {
        const file = scratch.path('foreign')
        await seed(file, { version: '0.1.0', dismissed: [ENDPOINT_NOTICE_ID] })
        const { notice } = noticeUnderTest(file, { cache: true })
        is((await notice.current()).show, false)
        const record = await recordOf(file)
        is(record.version, VERSION, 'the version moves forward')
        equal(record.dismissed, [ENDPOINT_NOTICE_ID], 'what the reader closed stays closed')
      },
    },
  ]),
}
