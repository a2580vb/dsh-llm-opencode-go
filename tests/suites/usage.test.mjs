/**
 * The usage table: what the plugin counted, and the file it keeps it in.
 *
 * The store is the one place in this plugin that writes a fact about a call
 * *and* reads it back, so the cases here are about the properties a usage table
 * has to have: a day boundary a person recognises, a file that cannot grow
 * without limit, damage that costs history rather than a request, and a write
 * that fails without failing the call it counted.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RETENTION_DAYS, UsageStore, dayKey, usagePath } from '../../lib/usage/store.js'
import { equal, is, ok } from '../helpers.mjs'

/** A directory per case, so one case's file never reaches another. */
async function scratch() {
  return mkdtemp(join(tmpdir(), 'oc-usage-'))
}

/** A store over its own file, with a clock the case controls. */
async function storeUnderTest({ now = Date.UTC(2026, 0, 15, 12, 0, 0), ...config } = {}) {
  const directory = await scratch()
  const clock = { value: now }
  const logger = { warnings: [], warn: (...args) => logger.warnings.push(args.join(' ')) }
  const store = new UsageStore(
    { usagePath: join(directory, 'usage.json'), ...config },
    { logger, now: () => clock.value, flushDelayMs: 0 },
  )
  return { store, clock, logger, directory }
}

/** One successful call's record. */
const call = (model, usage, ok = true) => ({ model, usage, ok })

export default {
  name: 'usage/store',
  cases: [
    {
      name: 'the day key is the local calendar day, not a UTC one',
      run() {
        // 23:30 local on the 5th is the 5th, whatever the offset is from UTC:
        // the day a person spent the tokens is the day they will look under.
        const late = new Date(2026, 0, 5, 23, 30, 0)
        is(dayKey(late.getTime()), '2026-01-05')
        const early = new Date(2026, 0, 6, 0, 30, 0)
        is(dayKey(early.getTime()), '2026-01-06')
      },
    },
    {
      name: 'the default path sits beside the model cache',
      run() {
        is(usagePath({}), usagePath({}))
        ok(usagePath({}).endsWith(join('.dsh', 'cache', 'opencode-go-usage.json')), usagePath({}))
        is(usagePath({ usagePath: 'C:\\tmp\\u.json' }), 'C:\\tmp\\u.json')
      },
    },
    {
      name: 'one call is counted under its own model and day',
      async run() {
        const { store } = await storeUnderTest()
        store.record(call('glm-5.3', { inputTokens: 10, outputTokens: 4, totalTokens: 14 }))
        const summary = await store.summary({ days: 7 })
        is(summary.totals.requests, 1)
        is(summary.totals.inputTokens, 10)
        is(summary.totals.outputTokens, 4)
        is(summary.totals.totalTokens, 14)
        is(summary.totals.failures, 0)
        equal(summary.models.map((entry) => entry.model), ['glm-5.3'])
        // Only days that were counted appear: a table of empty rows is noise,
        // and the window is already stated by `window` and `days.length`.
        equal(summary.days.map((entry) => entry.day), [dayKey(Date.UTC(2026, 0, 15, 12, 0, 0))])
        is(summary.window, 7)
        is(summary.firstDay, dayKey(Date.UTC(2026, 0, 15, 12, 0, 0)))
      },
    },
    {
      name: 'a variant is counted under the id the harness asked for',
      async run() {
        const { store } = await storeUnderTest()
        store.record(call('glm-5.3@fast', { inputTokens: 1, outputTokens: 1 }))
        store.record(call('glm-5.3', { inputTokens: 1, outputTokens: 1 }))
        const summary = await store.summary({ days: 1 })
        // The alias is what a person selected, so it is what the table shows;
        // the two entries stay apart even though the wire saw one model.
        equal(summary.models.map((entry) => entry.model).sort(), ['glm-5.3', 'glm-5.3@fast'])
      },
    },
    {
      name: 'a failed call is counted as a failure, with whatever it spent',
      async run() {
        const { store } = await storeUnderTest()
        store.record(call('glm-5.3', { inputTokens: 7, outputTokens: 0 }, false))
        store.record(call('glm-5.3', { inputTokens: 3, outputTokens: 2 }, true))
        const summary = await store.summary({ days: 1 })
        is(summary.totals.requests, 2)
        is(summary.totals.failures, 1)
        is(summary.totals.inputTokens, 10)
        is(summary.totals.outputTokens, 2)
      },
    },
    {
      name: 'a missing total is the input plus the output, not zero',
      async run() {
        const { store } = await storeUnderTest()
        store.record(call('glm-5.3', { inputTokens: 5, outputTokens: 6 }))
        store.record(call('glm-5.3', undefined))
        const summary = await store.summary({ days: 1 })
        is(summary.totals.totalTokens, 11)
        is(summary.totals.requests, 2, 'a call with no figures still happened')
      },
    },
    {
      name: 'the window ends today and reaches back exactly its length',
      async run() {
        const { store, clock } = await storeUnderTest()
        clock.value = Date.UTC(2026, 0, 15, 12, 0, 0)
        store.record(call('today', { inputTokens: 1 }))
        clock.value = Date.UTC(2026, 0, 14, 12, 0, 0)
        store.record(call('yesterday', { inputTokens: 1 }))
        clock.value = Date.UTC(2026, 0, 12, 12, 0, 0)
        store.record(call('three-days-ago', { inputTokens: 1 }))
        clock.value = Date.UTC(2026, 0, 15, 12, 0, 0)

        const week = await store.summary({ days: 7 })
        equal(week.models.map((entry) => entry.model).sort(), ['three-days-ago', 'today', 'yesterday'])
        equal(week.days.map((entry) => entry.day), ['2026-01-12', '2026-01-14', '2026-01-15'])
        const today = await store.summary({ days: 1 })
        equal(today.models.map((entry) => entry.model), ['today'])
        // The series is ascending, so a reader sees days move forward.
        is(week.days[week.days.length - 1].day, '2026-01-15')
        is(week.days[0].day, '2026-01-12')
        // A window is inclusive of today: `days: 3` reaches back two days.
        equal((await store.summary({ days: 3 })).days.map((entry) => entry.day), ['2026-01-14', '2026-01-15'])
      },
    },
    {
      name: 'an unknown window falls back rather than returning everything',
      async run() {
        const { store } = await storeUnderTest()
        store.record(call('glm-5.3', { inputTokens: 1 }))
        is((await store.summary({})).window, 7)
        is((await store.summary({ days: 0 })).window, 7)
        is((await store.summary({ days: -3 })).window, 7)
        is((await store.summary({ days: 30 })).window, 30)
      },
    },
    {
      name: 'the counters survive a reload through the file',
      async run() {
        const { store, directory } = await storeUnderTest()
        store.record(call('glm-5.3', { inputTokens: 10, outputTokens: 4 }))
        is(await store.flush(), true, 'the file was written')

        const resumed = new UsageStore(
          { usagePath: join(directory, 'usage.json') },
          { logger: { warn() {} }, now: () => Date.UTC(2026, 0, 15, 12, 0, 0), flushDelayMs: 0 },
        )
        const summary = await resumed.summary({ days: 1 })
        is(summary.totals.requests, 1)
        is(summary.totals.totalTokens, 14)
        const raw = JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8'))
        is(raw.version, 1)
        ok(typeof raw.updatedAt === 'number')
      },
    },
    {
      name: 'nothing changed means no write, and a write clears the pending one',
      async run() {
        const { store, directory } = await storeUnderTest()
        is(await store.flush(), false, 'an untouched store writes nothing')
        store.record(call('glm-5.3', { inputTokens: 1 }))
        is(await store.flush(), true)
        is(await store.flush(), false, 'and a second flush is a no-op')
        await rm(directory, { recursive: true, force: true })
      },
    },
    {
      name: 'a corrupt or foreign file costs history, not the plugin',
      async run() {
        const { store, directory } = await storeUnderTest()
        const path = join(directory, 'usage.json')
        await writeFile(path, '{ this is not json', 'utf8')
        is((await store.summary({ days: 1 })).totals.requests, 0, 'it starts empty')
        store.record(call('glm-5.3', { inputTokens: 2 }))
        is(await store.flush(), true, 'and writes a readable file over it')

        await writeFile(path, JSON.stringify({ version: 99, days: { '2026-01-15': { old: {} } } }), 'utf8')
        const other = new UsageStore(
          { usagePath: path },
          { logger: { warn() {} }, now: () => Date.UTC(2026, 0, 15, 12, 0, 0), flushDelayMs: 0 },
        )
        is((await other.summary({ days: 1 })).totals.requests, 0, 'a version it cannot read is discarded')
      },
    },
    {
      name: 'days outside the retention window are dropped when the file is written',
      async run() {
        const { store, clock, directory } = await storeUnderTest()
        clock.value = Date.UTC(2026, 0, 1, 12, 0, 0)
        store.record(call('ancient', { inputTokens: 1 }))
        await store.flush()
        clock.value = Date.UTC(2026, 0, 1, 12, 0, 0) + (RETENTION_DAYS + 2) * 86_400_000
        store.record(call('recent', { inputTokens: 1 }))
        await store.flush()

        const raw = JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8'))
        equal(Object.keys(raw.days).length, 1, 'only the day inside the window is kept')
        ok(Object.keys(raw.days)[0] > '2026-01-01', Object.keys(raw.days)[0])
        // The old day is gone from the report too, which is the point: the file
        // cannot grow without limit, and neither does the table.
        is((await store.summary({ days: 30 })).totals.requests, 1)
      },
    },
    {
      name: 'a write that fails is reported once and never fails a call',
      async run() {
        const { directory } = await storeUnderTest()
        const logs = []
        // A regular file where a directory has to be: every write fails with
        // ENOTDIR, which is the shape of a read-only or full cache directory.
        const blocker = join(directory, 'blocker')
        await writeFile(blocker, 'not a directory', 'utf8')
        const store = new UsageStore(
          { usagePath: join(blocker, 'usage.json') },
          { logger: { warn: (...args) => logs.push(args.map(String).join(' ')) }, now: () => Date.UTC(2026, 0, 15), flushDelayMs: 0 },
        )
        store.record(call('glm-5.3', { inputTokens: 1 }))
        store.record(call('glm-5.3', { inputTokens: 1 }))
        is(await store.flush(), false)
        is(await store.flush(), false)
        ok(logs.length >= 1, 'the failure is reported')
        ok(logs.every((line) => line.includes('usage file')), logs.join(' | '))
        // The counters are still in memory: a report that could not be written
        // is still a report the page can show.
        is((await store.summary({ days: 1 })).totals.requests, 2)
      },
    },
    {
      name: 'a debounced store keeps counting until it is flushed',
      async run() {
        const { store, directory } = await storeUnderTest()
        const delayed = new UsageStore(
          { usagePath: join(directory, 'delayed.json') },
          { logger: { warn() {} }, now: () => Date.UTC(2026, 0, 15, 12, 0, 0), flushDelayMs: 50 },
        )
        delayed.record(call('glm-5.3', { inputTokens: 1 }))
        is(await readFile(join(directory, 'delayed.json'), 'utf8').then(() => true).catch(() => false), false)
        is(await delayed.flush(), true, 'the unload path writes it out')
        is(JSON.parse(await readFile(join(directory, 'delayed.json'), 'utf8')).days['2026-01-15']['glm-5.3'].requests, 1)
        void store
      },
    },
  ],
}
