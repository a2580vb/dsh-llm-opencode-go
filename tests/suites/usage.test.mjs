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
import { mapOpenAiUsage } from '../../lib/protocol/shared.js'
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
      name: 'a cached prompt is not counted twice, whichever shape reported it',
      run() {
        // The two families disagree about what their prompt figure counts, and
        // the harness resolves it by defining `inputTokens` as the uncached
        // input -- its own token meter reads the field under the name
        // `uncachedInputTokens`. A mapper that passed the OpenAI prompt count
        // through and then added the cached part on top counted those tokens
        // twice, which inflated both the input column and the total.
        const openai = mapOpenAiUsage({
          prompt_tokens: 369,
          completion_tokens: 63,
          prompt_tokens_details: { cached_tokens: 256 },
        })
        is(openai.inputTokens, 113, '369 prompt tokens less the 256 served from cache')
        is(openai.cacheReadTokens, 256)
        is(openai.totalTokens, 432, 'uncached + output + read, which is what the service would have said')

        // With the service's own total present, that figure is authoritative.
        const stated = mapOpenAiUsage({
          prompt_tokens: 369,
          completion_tokens: 63,
          total_tokens: 432,
          prompt_tokens_details: { cached_tokens: 256 },
        })
        is(stated.totalTokens, 432)
        is(stated.inputTokens, 113, 'and the input column means the same thing either way')

        // The Anthropic family already reports the uncached part alone, so
        // nothing is subtracted and the four parts add up as they are.
        const anthropic = mapOpenAiUsage({
          input_tokens: 4,
          output_tokens: 15,
          cache_read_input_tokens: 2048,
          cache_creation_input_tokens: 1024,
        })
        is(anthropic.inputTokens, 4, 'left alone: this shape never folded the cache in')
        is(anthropic.totalTokens, 4 + 15 + 2048 + 1024)

        // Responses-style details fold the write in as well as the read.
        const responses = mapOpenAiUsage({
          input_tokens: 200,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
        })
        is(responses.inputTokens, 120, '200 less both the read and the write')
        is(responses.totalTokens, 120 + 10 + 50 + 30)
      },
    },
    {
      name: 'a cache figure is reported when the provider named it, zero included',
      run() {
        // "The service says nothing was cached" and "the service did not say"
        // are different facts, and the page shows a hit rate for the first and
        // a dash for the second. So the key's presence carries the distinction
        // rather than its value.
        const explicitZero = mapOpenAiUsage({
          input_tokens: 168,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        })
        is('cacheReadTokens' in explicitZero, true, 'a reported zero is still a report')
        is('cacheWriteTokens' in explicitZero, true)
        is(explicitZero.cacheReadTokens, 0)

        const silent = mapOpenAiUsage({ prompt_tokens: 100, completion_tokens: 10 })
        is('cacheReadTokens' in silent, false, 'silence is not a zero')
        is('cacheWriteTokens' in silent, false)

        // An empty detail object is OpenAI saying it has no breakdown to give.
        const emptyDetails = mapOpenAiUsage({
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_tokens_details: {},
        })
        is(emptyDetails.inputTokens, 100, 'nothing to subtract')
        is(emptyDetails.totalTokens, 110)
        is('cacheReadTokens' in emptyDetails, false)
      },
    },
    {
      name: 'a field a newer build added is zero, not NaN, in an older file',
      async run() {
        // The counters gained `cacheReported`, and a file written before it
        // existed has no such member. `undefined + 0` is NaN, which would then
        // be written back and poison every later read, so an absent field has to
        // mean zero here exactly as it does when merging.
        const dir = await scratch()
        try {
          const path = join(dir, 'usage.json')
          await writeFile(path, JSON.stringify({
            version: 1,
            updatedAt: 0,
            days: {
              [dayKey(Date.now())]: {
                // No cacheReported: the shape an older build wrote.
                'glm-5.3': { requests: 2, failures: 0, inputTokens: 300, outputTokens: 40, totalTokens: 340, cacheReadTokens: 0, cacheWriteTokens: 0 },
              },
            },
          }), 'utf8')
          const store = new UsageStore({ usagePath: path }, { flushDelayMs: 0 })
          store.record({ model: 'glm-5.3', ok: true, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
          await store.flush()
          const written = JSON.parse(await readFile(path, 'utf8'))
          const row = written.days[dayKey(Date.now())]['glm-5.3']
          is(row.requests, 3, 'the file history and the new call both survive')
          is(row.inputTokens, 310)
          // The decisive one: a NaN here would make the whole file unreadable to
          // anything that parses it as numbers.
          is(Number.isFinite(row.cacheReported), true, `cacheReported is ${String(row.cacheReported)}`)
          is(row.cacheReported, 0, 'the call carried no cache figure, so it counts none')
          is(JSON.stringify(written).includes('null'), false, 'no NaN serialised as null')
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      },
    },
    {
      name: 'the first call after a restart is added to the history, not dropped for it',
      async run() {
        // `flush` reads the file through `load`, and recording never waits for
        // that read. A load that assigned the file's map over the in-memory one
        // therefore discarded everything this activation had counted before its
        // first write -- always the first call after a restart, and often the
        // one that primes the cache, so the cache figures went with it.
        const dir = await scratch()
        try {
          const path = join(dir, 'usage.json')
          const day = dayKey(Date.now())
          await writeFile(path, JSON.stringify({
            version: 1,
            updatedAt: 0,
            days: { [day]: { 'glm-5.3': { requests: 5, failures: 0, inputTokens: 500, outputTokens: 50, totalTokens: 550, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
          }), 'utf8')

          // A fresh activation: no read yet, one call, then the ordinary flush.
          const store = new UsageStore({ usagePath: path }, { flushDelayMs: 0 })
          store.record({ model: 'glm-5.3', ok: true, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 0 } })
          await store.flush()

          const row = JSON.parse(await readFile(path, 'utf8')).days[day]['glm-5.3']
          is(row.requests, 6, 'the five in the file plus the one just counted')
          is(row.inputTokens, 600)
          is(row.cacheReadTokens, 40, 'and the cache figure the new call carried')
          is(row.cacheReported, 1, 'the older rows carry no cache figure, so they count none')

          // The second flush of the same activation must not add the history in
          // again: the `loaded` guard is the only thing standing between a merge
          // and a double count, so it is worth pinning.
          store.record({ model: 'glm-5.3', ok: true, usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } })
          await store.flush()
          const again = JSON.parse(await readFile(path, 'utf8')).days[day]['glm-5.3']
          is(again.requests, 7, 'the file was not folded in a second time')
          is(again.inputTokens, 610)
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      },
    },
    {
      name: 'a call that reported a cache figure is counted as reported',
      run() {
        const store = new UsageStore({ usagePath: 'unused' }, { flushDelayMs: 0 })
        store.record({ model: 'a', ok: true, usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } })
        store.record({ model: 'a', ok: true, usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0 } })
        const day = dayKey(Date.now())
        is(store.days[day].a.cacheReported, 1, 'only the second call said anything about cache')
        is(store.days[day].a.cacheReadTokens, 0)
        // A total the provider did not state still adds up, cache included.
        store.record({ model: 'a', ok: true, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } })
        is(store.days[day].a.totalTokens, 11 + 11 + 160)
      },
    },
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
