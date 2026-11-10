/**
 * The usage table: what the plugin counted, and the file it keeps it in.
 *
 * The store is the one place in this plugin that writes a fact about a call
 * *and* reads it back, so the cases here are about the properties a usage table
 * has to have: a day boundary a person recognises, complete per-day history,
 * damage that costs history rather than a request, and a write that fails
 * without failing the call it counted.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { UsageStore, dayKey, usagePath } from '../../lib/usage/store.js'
import { mapOpenAiUsage } from '../../lib/protocol/shared.js'
import { equal, is, ok } from '../helpers.mjs'

/** A directory per case, so one case's file never reaches another. */
async function scratch() {
  return mkdtemp(join(tmpdir(), 'oc-usage-'))
}

/**
 * A local wall-clock instant.
 *
 * Fixtures name the calendar day they mean, not a UTC offset: the same case has
 * to describe the same day in every time zone the suite runs under.
 */
function localTime(year, month, day, hour = 12, minute = 0) {
  return new Date(year, month, day, hour, minute, 0, 0).getTime()
}

/** Run one case in a named local timezone, then restore the runner's setting. */
async function withTimezone(zone, run) {
  const previous = process.env.TZ
  process.env.TZ = zone
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

/** A promise a case settles by hand, so an interleaving needs no sleep. */
function deferred() {
  let resolve
  const promise = new Promise((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** A store over its own file, with a clock the case controls. */
async function storeUnderTest({ now = localTime(2026, 0, 15), ...config } = {}) {
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

/**
 * The shared Object surface a usage dictionary must never write through.
 *
 * Comparing the own keys before and after catches both the prototype itself
 * gaining counter fields and the `constructor`/`toString` members being used as
 * records, which would leave NaN counters on those shared functions.
 */
function objectSurface() {
  return {
    prototype: Object.getOwnPropertyNames(Object.prototype).sort(),
    constructor: Object.getOwnPropertyNames(Object).sort(),
    toString: Object.getOwnPropertyNames(Object.prototype.toString).sort(),
  }
}

/** Assert that no lookup in the usage tables left a mark on a shared object. */
function assertObjectSurfaceIntact(before) {
  equal(Object.getOwnPropertyNames(Object.prototype).sort(), before.prototype,
    'Object.prototype gained no usage fields')
  equal(Object.getOwnPropertyNames(Object).sort(), before.constructor,
    'the Object constructor gained no usage fields')
  equal(Object.getOwnPropertyNames(Object.prototype.toString).sort(), before.toString,
    'Object.prototype.toString gained no usage fields')
  is(Object.prototype.requests, undefined, 'no request count on Object.prototype')
  is(Object.prototype.inputTokens, undefined, 'no token count on Object.prototype')
  is(Object.requests, undefined, 'no request count on the Object constructor')
  is(Object.prototype.toString.requests, undefined, 'no request count on toString')
}

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
      name: 'concurrent summaries share the one first read, and count what was recorded before it',
      async run() {
        // Two summaries start together on a store that has never read its file
        // (the page asks for a window and for all days in one request). The
        // second must wait for the same read instead of reporting the empty
        // table it saw while the first read was still in flight -- and `loaded`
        // may not claim the read is done until it is.
        const { directory } = await storeUnderTest()
        const path = join(directory, 'usage.json')
        const older = dayKey(localTime(2026, 0, 10))
        const today = dayKey(localTime(2026, 0, 15))
        const fileText = JSON.stringify({
          version: 1,
          updatedAt: 0,
          days: {
            [older]: {
              'glm-5.3': {
                requests: 5, failures: 0, inputTokens: 500, outputTokens: 50, totalTokens: 550, cacheReadTokens: 0, cacheWriteTokens: 0,
              },
            },
          },
        })
        await writeFile(path, fileText, 'utf8')
        const gate = deferred()
        let reads = 0
        const store = new UsageStore(
          { usagePath: path },
          {
            logger: { warn() {} },
            now: () => localTime(2026, 0, 15),
            flushDelayMs: 0,
            readFile: async () => {
              reads += 1
              await gate.promise
              return fileText
            },
          },
        )
        // Counted before the first read: the merge must add the file once,
        // not replace either side.
        store.record(call('glm-5.3', { inputTokens: 100, outputTokens: 10 }))

        const windowed = store.summary({ days: 1 })
        const complete = store.summary({ days: 'all' })
        is(store.loaded, false, 'the history is not marked read before the read finishes')
        is(reads, 1, 'the second summary joined the first read instead of starting another')
        is(store.load(), store.load(), 'both callers wait on the same in-flight read')
        gate.resolve()

        const [window, all] = await Promise.all([windowed, complete])
        is(store.loaded, true, 'the read is complete')
        is(window.window, 1)
        equal(window.days.map((entry) => entry.day), [today], 'the window holds only the call recorded before the read')
        is(window.totals.requests, 1)
        is(window.totals.inputTokens, 100)
        is(window.totals.totalTokens, 110)
        is(all.window, 'all')
        equal(all.days.map((entry) => entry.day), [older, today])
        is(all.totals.requests, 6, 'five on file plus the one counted before the read')
        is(all.totals.inputTokens, 600)
        is(all.totals.totalTokens, 660)
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
        equal(summary.days.map((entry) => entry.day), [dayKey(localTime(2026, 0, 15))])
        is(summary.window, 7)
        is(summary.firstDay, dayKey(localTime(2026, 0, 15)))
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
        const today = dayKey(localTime(2026, 0, 15))
        const yesterday = dayKey(localTime(2026, 0, 14))
        const threeDaysAgo = dayKey(localTime(2026, 0, 12))
        clock.value = localTime(2026, 0, 15)
        store.record(call('today', { inputTokens: 1 }))
        clock.value = localTime(2026, 0, 14)
        store.record(call('yesterday', { inputTokens: 1 }))
        clock.value = localTime(2026, 0, 12)
        store.record(call('three-days-ago', { inputTokens: 1 }))
        clock.value = localTime(2026, 0, 15)

        const week = await store.summary({ days: 7 })
        equal(week.models.map((entry) => entry.model).sort(), ['three-days-ago', 'today', 'yesterday'])
        equal(week.days.map((entry) => entry.day), [threeDaysAgo, yesterday, today])
        const todayReport = await store.summary({ days: 1 })
        equal(todayReport.models.map((entry) => entry.model), ['today'])
        // The series is ascending, so a reader sees days move forward.
        is(week.days[week.days.length - 1].day, today)
        is(week.days[0].day, threeDaysAgo)
        // A window is inclusive of today: `days: 3` reaches back two days.
        equal((await store.summary({ days: 3 })).days.map((entry) => entry.day), [yesterday, today])
        // The complete history is a separate report, not a large numeric window.
        const all = await store.summary({ days: 'all' })
        is(all.window, 'all')
        equal(all.days.map((entry) => entry.day), [threeDaysAgo, yesterday, today])
        is(all.totals.requests, 3)
      },
    },
    {
      name: 'a spring-forward day is not skipped by the numeric window',
      async run() {
        await withTimezone('America/New_York', async () => {
          // A local calendar day is not always 86_400_000 ms long: on a spring
          // DST change it is 23 hours. Stepping back by milliseconds from an
          // early hour of the following day lands on the day before the previous
          // one, silently dropping the transition day from the window. Pinning
          // the zone makes that proof run in the default UTC CI job too.
          const { store, clock } = await storeUnderTest()
          const recorded = [9, 8, 7, 6, 5, 4, 3, 2]
          for (const day of recorded) {
            clock.value = localTime(2026, 2, day)
            store.record(call(`spring-${day}`, { inputTokens: 1 }))
          }
          clock.value = localTime(2026, 2, 9, 0, 30)

          const week = await store.summary({ days: 7 })
          const expected = [3, 4, 5, 6, 7, 8, 9].map((day) => dayKey(localTime(2026, 2, day)))
          equal(week.days.map((entry) => entry.day), expected, 'all seven local days are in the window')
          is(week.totals.requests, 7)
          ok(week.days.some((entry) => entry.day === dayKey(localTime(2026, 2, 8))),
            'the 23-hour day is part of the window')
          is(week.days.some((entry) => entry.day === dayKey(localTime(2026, 2, 2))), false,
            'the day before the window is not folded in')

          // The complete history is unchanged: it is every recorded day.
          const all = await store.summary({ days: 'all' })
          is(all.window, 'all')
          is(all.days.length, 8)
          is(all.totals.requests, 8)
        })
      },
    },
    {
      name: 'a fall-back day appears once, and the window still reaches seven local days',
      async run() {
        await withTimezone('America/New_York', async () => {
          // On a fall DST change a local day is 25 hours, so two millisecond
          // steps can land on the same calendar day: the window then repeats it
          // and loses the oldest day it promised. Pinning the zone keeps this
          // proof active in the default UTC CI job too.
          const { store, clock } = await storeUnderTest()
          const octoberDays = [27, 28, 29, 30, 31].map((day) => localTime(2026, 9, day))
          const expectedInstants = [
            ...octoberDays,
            localTime(2026, 10, 1),
            localTime(2026, 10, 2),
          ]
          for (const at of [localTime(2026, 9, 26), ...expectedInstants]) {
            clock.value = at
            store.record(call(`fall-${dayKey(at)}`, { inputTokens: 1 }))
          }
          clock.value = localTime(2026, 10, 2, 23, 30)

          const week = await store.summary({ days: 7 })
          equal(week.days.map((entry) => entry.day), expectedInstants.map((at) => dayKey(at)))
          is(week.days.length, 7, 'the window still has seven days')
          is(new Set(week.days.map((entry) => entry.day)).size, 7, 'the repeated hour did not repeat a day')
          is(week.totals.requests, 7)
          is(week.days.some((entry) => entry.day === dayKey(localTime(2026, 9, 26))), false,
            'the oldest recorded day is outside the window')

          const all = await store.summary({ days: 'all' })
          is(all.days.length, 8)
          is(all.totals.requests, 8)
        })
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
        is((await store.summary({ days: 'all' })).window, 'all')
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
          { logger: { warn() {} }, now: () => localTime(2026, 0, 15), flushDelayMs: 0 },
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
      name: 'a call recorded while a write is in flight stays pending for the next flush',
      async run() {
        // `flush` serialises a snapshot, then awaits the write. A call counted
        // during that await belongs to a newer revision: the completed write
        // may not mark it written, or the next timer/unload flush would find
        // nothing dirty and the record would never reach disk.
        const { directory } = await storeUnderTest()
        const path = join(directory, 'usage.json')
        const day = dayKey(localTime(2026, 0, 15))
        const gate = deferred()
        const started = deferred()
        let gated = false
        const store = new UsageStore(
          { usagePath: path },
          {
            logger: { warn() {} },
            now: () => localTime(2026, 0, 15),
            flushDelayMs: 0,
            mkdir: async () => {},
            writeFile: async (file, text, encoding) => {
              if (!gated) {
                gated = true
                started.resolve()
                await gate.promise
              }
              await writeFile(file, text, encoding)
            },
          },
        )
        store.record(call('glm-5.3', { inputTokens: 10, outputTokens: 1 }))
        const first = store.flush()
        await started.promise
        store.record(call('glm-5.3', { inputTokens: 20, outputTokens: 2 }))
        is(store.dirty, true, 'the newer call is not written by the snapshot in flight')
        gate.resolve()

        is(await first, true, 'the first write completed')
        is(store.dirty, true, 'the older write did not clear the newer revision')
        const firstWrite = JSON.parse(await readFile(path, 'utf8'))
        is(firstWrite.days[day]['glm-5.3'].requests, 1, 'the first snapshot held only the first call')
        is(await store.flush(), true, 'the next flush persists the call made during the write')
        const final = JSON.parse(await readFile(path, 'utf8'))
        is(final.days[day]['glm-5.3'].requests, 2)
        is(final.days[day]['glm-5.3'].inputTokens, 30)
      },
    },
    {
      name: 'flush calls are serialised, so a snapshot written later cannot be overwritten by an older one',
      async run() {
        // Two flushes can overlap (a timer firing while an unload flush runs).
        // Each serialises at a different moment; without a write queue the
        // older snapshot can finish last and erase the newer call. The gated
        // write is released by hand, so the order is decided by the case.
        const { directory } = await storeUnderTest()
        const path = join(directory, 'usage.json')
        const day = dayKey(localTime(2026, 0, 15))
        const calls = []
        const firstStarted = deferred()
        const secondStarted = deferred()
        const store = new UsageStore(
          { usagePath: path },
          {
            logger: { warn() {} },
            now: () => localTime(2026, 0, 15),
            flushDelayMs: 0,
            mkdir: async () => {},
            writeFile: async (file, text, encoding) => {
              const gate = deferred()
              calls.push({ file, text, gate })
              if (calls.length === 1) firstStarted.resolve()
              if (calls.length === 2) secondStarted.resolve()
              await gate.promise
              await writeFile(file, text, encoding)
            },
          },
        )

        store.record(call('glm-5.3', { inputTokens: 10, outputTokens: 1 }))
        const first = store.flush()
        await firstStarted.promise

        store.record(call('glm-5.3', { inputTokens: 20, outputTokens: 2 }))
        const second = store.flush()
        // No sleep: one event-loop turn is enough for the second flush to reach
        // its write if it is not queued behind the first.
        await new Promise((resolve) => setImmediate(resolve))
        is(calls.length, 1, 'the second flush waited for the write in flight')

        calls[0].gate.resolve()
        is(await first, true)
        await secondStarted.promise
        is(calls.length, 2, 'the queued flush wrote once the first finished')
        const queued = JSON.parse(calls[1].text)
        is(queued.days[day]['glm-5.3'].requests, 2, 'the queued flush carries the newer call')
        calls[1].gate.resolve()
        is(await second, true)

        const final = JSON.parse(await readFile(path, 'utf8'))
        is(final.days[day]['glm-5.3'].requests, 2)
        is(final.days[day]['glm-5.3'].inputTokens, 30)
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
          { logger: { warn() {} }, now: () => localTime(2026, 0, 15), flushDelayMs: 0 },
        )
        is((await other.summary({ days: 1 })).totals.requests, 0, 'a version it cannot read is discarded')
      },
    },
    {
      name: 'the file and the all-history report keep days older than 30 days',
      async run() {
        const { store, clock, directory } = await storeUnderTest()
        clock.value = localTime(2026, 0, 1)
        store.record(call('old', { inputTokens: 1 }))
        await store.flush()
        clock.value = localTime(2026, 1, 15)
        store.record(call('recent', { inputTokens: 1 }))
        await store.flush()

        const raw = JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8'))
        equal(Object.keys(raw.days), [dayKey(localTime(2026, 0, 1)), dayKey(localTime(2026, 1, 15))])
        is((await store.summary({ days: 30 })).totals.requests, 1, 'the rolling window still selects recent days')
        const all = await store.summary({ days: 'all' })
        is(all.totals.requests, 2, 'the complete report includes both days')
        equal(all.models.map((entry) => entry.model).sort(), ['old', 'recent'])
        is(all.retentionDays, null, 'history has no age-based expiry')
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
          { logger: { warn: (...args) => logs.push(args.map(String).join(' ')) }, now: () => localTime(2026, 0, 15), flushDelayMs: 0 },
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
          { logger: { warn() {} }, now: () => localTime(2026, 0, 15), flushDelayMs: 50 },
        )
        delayed.record(call('glm-5.3', { inputTokens: 1 }))
        is(await readFile(join(directory, 'delayed.json'), 'utf8').then(() => true).catch(() => false), false)
        is(await delayed.flush(), true, 'the unload path writes it out')
        is(JSON.parse(await readFile(join(directory, 'delayed.json'), 'utf8')).days[dayKey(localTime(2026, 0, 15))]['glm-5.3'].requests, 1)
        void store
      },
    },
    {
      name: 'a model id that names an Object member is that day\'s own record',
      async run() {
        // Model ids reach the store from the harness, not from a list this
        // plugin controls. On a plain day map, `__proto__` resolved to
        // Object.prototype: the counters were written onto the global
        // prototype and no record was created, so the call disappeared from
        // every table. `constructor` and `toString` did the same to the Object
        // constructor and the shared toString function.
        const ids = ['__proto__', 'constructor', 'toString', 'not-in-catalog']
        const surface = objectSurface()
        const { store, clock, directory } = await storeUnderTest()
        let expectedInput = 0
        let expectedTotal = 0
        ids.forEach((id, index) => {
          const inputTokens = 10 + index
          const outputTokens = 1 + index
          expectedInput += inputTokens
          expectedTotal += inputTokens + outputTokens
          store.record(call(id, { inputTokens, outputTokens }))
        })

        const summary = await store.summary({ days: 1 })
        is(summary.totals.requests, ids.length, 'every id is a request')
        is(summary.totals.inputTokens, expectedInput)
        is(summary.totals.totalTokens, expectedTotal)
        is(summary.days.length, 1, 'one day holds them all')
        is(summary.days[0].counters.requests, ids.length, 'the day row has every id')
        is(summary.days[0].counters.inputTokens, expectedInput)
        equal(summary.models.map((entry) => entry.model).sort(), [...ids].sort())
        for (const entry of summary.models) {
          is(entry.counters.requests, 1, `${entry.model} has its own request count`)
          for (const [field, value] of Object.entries(entry.counters)) {
            ok(Number.isFinite(value), `${entry.model}.${field} is a number, got ${String(value)}`)
          }
        }

        const day = dayKey(clock.value)
        const models = store.days[day]
        for (const id of ids) {
          ok(Object.hasOwn(models, id), `${id} is an own key`)
          ok(Object.keys(models).includes(id), `${id} is enumerable`)
          is(models[id].requests, 1)
          is(models[id].inputTokens, 10 + ids.indexOf(id))
        }

        // The persisted shape keeps those names as ordinary JSON keys, and the
        // read-back path must count them again rather than lose them.
        is(await store.flush(), true)
        const raw = JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8'))
        for (const id of ids) ok(Object.hasOwn(raw.days[day], id), `${id} was written as its own key`)

        const resumed = new UsageStore(
          { usagePath: join(directory, 'usage.json') },
          { logger: { warn() {} }, now: () => clock.value, flushDelayMs: 0 },
        )
        const reloaded = await resumed.summary({ days: 1 })
        is(reloaded.totals.requests, ids.length, 'every id survives the reload')
        is(reloaded.totals.inputTokens, expectedInput)
        equal(reloaded.models.map((entry) => entry.model).sort(), [...ids].sort())

        assertObjectSurfaceIntact(surface)
      },
    },
    {
      name: 'untrusted day and model keys from the file are own records, not prototypes',
      async run() {
        // A JSON file can hold `__proto__` as an ordinary key, because JSON has
        // no prototypes. Copying such a day or model into a plain object with
        // bracket assignment invokes the inherited setter instead: the map's
        // prototype becomes the row and the key vanishes from Object.keys.
        const surface = objectSurface()
        const { clock, directory } = await storeUnderTest()
        const day = dayKey(clock.value)
        const path = join(directory, 'usage.json')
        const row = (inputTokens) => ({
          requests: 1,
          failures: 0,
          inputTokens,
          outputTokens: 0,
          totalTokens: inputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheReported: 0,
        })
        const models = Object.fromEntries([
          ['__proto__', row(7)],
          ['constructor', row(2)],
          ['toString', row(3)],
          ['glm-5.3', row(5)],
        ])
        const days = Object.fromEntries([
          [day, models],
          ['__proto__', Object.fromEntries([['shadow-day', row(11)]])],
        ])
        await writeFile(path, JSON.stringify({ version: 1, updatedAt: 0, days }), 'utf8')

        const store = new UsageStore(
          { usagePath: path },
          { logger: { warn() {} }, now: () => clock.value, flushDelayMs: 0 },
        )
        // Counted before the first read, so the file's special keys and the
        // in-memory one meet in the merge.
        store.record(call('__proto__', { inputTokens: 1 }))
        const summary = await store.summary({ days: 'all' })

        ok(Object.hasOwn(store.days, '__proto__'), 'the day named __proto__ is an own key')
        ok(Object.hasOwn(store.days[day], '__proto__'), 'the model named __proto__ is an own key')
        const daysPrototype = Object.getPrototypeOf(store.days)
        ok(daysPrototype === null || daysPrototype === Object.prototype,
          'the day table did not take a model map as its prototype')
        equal(Object.keys(store.days[day]).sort(),
          ['__proto__', 'constructor', 'glm-5.3', 'toString'])
        equal(summary.models.map((entry) => entry.model).sort(),
          ['__proto__', 'constructor', 'glm-5.3', 'shadow-day', 'toString'])
        is(summary.totals.requests, 6, 'four file rows, the merged __proto__ row, and the shadow day')
        is(summary.totals.inputTokens, 29)
        is(summary.totals.totalTokens, 29)
        equal(summary.days.map((entry) => entry.day), [day, '__proto__'])
        is(summary.days[0].counters.requests, 5, 'the normal day keeps the file rows and the new call')
        is(summary.days[0].counters.inputTokens, 18)
        is(summary.days[1].counters.requests, 1, 'the day named __proto__ is its own row')
        is(summary.days[1].counters.inputTokens, 11)
        for (const entry of summary.models) {
          for (const [field, value] of Object.entries(entry.counters)) {
            ok(Number.isFinite(value), `${entry.model}.${field} is a number, got ${String(value)}`)
          }
        }
        is(summary.models.find((entry) => entry.model === '__proto__').counters.inputTokens, 8,
          'the file row and the in-memory call add up')

        // Writing the merged table back must keep those names as JSON keys, not
        // serialise a prototype. A fresh store then reads the same numbers.
        is(await store.flush(), true)
        const raw = JSON.parse(await readFile(path, 'utf8'))
        ok(Object.hasOwn(raw.days, '__proto__'))
        ok(Object.hasOwn(raw.days[day], '__proto__'))
        const resumed = new UsageStore(
          { usagePath: path },
          { logger: { warn() {} }, now: () => clock.value, flushDelayMs: 0 },
        )
        const reloaded = await resumed.summary({ days: 'all' })
        is(reloaded.totals.requests, summary.totals.requests)
        is(reloaded.totals.inputTokens, summary.totals.inputTokens)
        equal(reloaded.models.map((entry) => entry.model).sort(),
          ['__proto__', 'constructor', 'glm-5.3', 'shadow-day', 'toString'])

        assertObjectSurfaceIntact(surface)
      },
    },
  ],
}
