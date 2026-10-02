/**
 * The subscription's own quota: the one figure that is the provider's.
 *
 * `GET {baseURL}/usage` is not part of the published API — it is what the
 * console uses — so the cases here are mostly about the ways it can be absent.
 * A quota readout is an enhancement beside the plugin's own counters, and the
 * whole point is that no deployment loses the page because of it.
 *
 * The shape was read off the live service and is reproduced here verbatim:
 *
 *   { "usage": { "rolling": { "status": "ok", "percent": 8,
 *                             "resetsAt": "2026-10-02T23:41:02.184Z" },
 *                "weekly":  { … }, "monthly": { … } } }
 */

import {
  SUBSCRIPTION_CACHE_MS,
  SUBSCRIPTION_PATH,
  SubscriptionReader,
  parseSubscription,
} from '../../lib/usage/subscription.js'
import { equal, is, ok } from '../helpers.mjs'

/** One answer from the service, exactly as it arrives. */
const ANSWER = {
  usage: {
    rolling: { status: 'ok', percent: 8, resetsAt: '2026-10-02T23:41:02.184Z' },
    weekly: { status: 'ok', percent: 8, resetsAt: '2026-10-05T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 13, resetsAt: '2026-10-21T05:02:55.000Z' },
  },
}

const BASE_URL = 'https://opencode.ai/zen/go/v1'

/**
 * A reader over a recorded service.
 *
 * `script` maps the index of a request (from 0) to what the service answers, so
 * a case can describe a refusal without a socket; `script.default` is every
 * request the map does not name. Every request is recorded, so the cases can ask
 * what was sent and how often.
 */
function readerUnderTest({ script = {}, now = 1_000_000, ...config } = {}) {
  const clock = { value: now }
  const requests = []
  const logger = { warnings: [], warn: (...args) => logger.warnings.push(args.join(' ')) }
  const reader = new SubscriptionReader(
    { baseURL: BASE_URL, timeoutMs: 5_000, ...config },
    {
      logger,
      now: () => clock.value,
      authHeaders: async () => ({ authorization: 'Bearer oc_sk_test' }),
      fetch: async (url, init) => {
        requests.push({ url, init })
        const step = script[requests.length - 1] ?? script.default ?? { status: 200, body: ANSWER }
        if (step.throws !== undefined) throw new Error(step.throws)
        return {
          status: step.status ?? 200,
          ok: (step.status ?? 200) >= 200 && (step.status ?? 200) < 300,
          json: async () => {
            if (step.badBody === true) throw new Error('not json')
            return step.body ?? ANSWER
          },
        }
      },
    },
  )
  return { reader, clock, requests, logger }
}

export default {
  name: 'usage/subscription',
  cases: [
    {
      name: 'the three windows arrive in the order the plan metes them',
      async run() {
        const { reader } = readerUnderTest()
        const result = await reader.read()
        is(result.ok, true)
        equal(result.windows.map((window) => window.name), ['rolling', 'weekly', 'monthly'])
        equal(result.windows.map((window) => window.percent), [8, 8, 13])
        is(result.cached, false)
      },
    },
    {
      name: 'the reader asks the service at the endpoint under baseURL, once',
      async run() {
        const { reader, requests } = readerUnderTest()
        await reader.read()
        await reader.read()
        is(requests.length, 1, 'the second read is served from the cache')
        is(requests[0].url, `${BASE_URL}${SUBSCRIPTION_PATH}`)
        is(requests[0].init.method, 'GET')
        is(requests[0].init.headers.authorization, 'Bearer oc_sk_test')
      },
    },
    {
      name: 'a forced read bypasses the cache, and the window is configurable',
      async run() {
        const { reader, requests, clock } = readerUnderTest({ subscriptionCacheSeconds: 600 })
        await reader.read()
        // Inside the window: the cache answers.
        clock.value += 60_000
        const cached = await reader.read()
        is(cached.cached, true)
        is(requests.length, 1)
        // Forced: the service answers again.
        const forced = await reader.read({ force: true })
        is(forced.cached, false)
        is(requests.length, 2)
        // Past the window: even without forcing, the service answers.
        clock.value += 600_000
        await reader.read()
        is(requests.length, 3)
      },
    },
    {
      name: 'the default window is a minute, so opening the page twice is one read',
      async run() {
        const { reader, requests } = readerUnderTest()
        is(reader.lifetimeMs, SUBSCRIPTION_CACHE_MS)
        await reader.read()
        await reader.read()
        is(requests.length, 1)
      },
    },
    {
      name: 'two readers asking at once share the one request in flight',
      async run() {
        let release
        const gate = new Promise((resolve) => {
          release = resolve
        })
        let calls = 0
        const reader = new SubscriptionReader(
          { baseURL: BASE_URL, timeoutMs: 5_000 },
          {
            authHeaders: async () => ({ authorization: 'Bearer oc_sk_test' }),
            fetch: async () => {
              calls += 1
              await gate
              return { status: 200, ok: true, json: async () => ANSWER }
            },
          },
        )
        const first = reader.read()
        const second = reader.read()
        release()
        const [one, two] = await Promise.all([first, second])
        is(calls, 1, 'a burst of asks is one request')
        is(one.ok, true)
        is(two.ok, true)
      },
    },
    {
      name: 'a service that does not serve the endpoint says so, without a request failure',
      async run() {
        for (const status of [404, 405]) {
          const { reader, logger } = readerUnderTest({ script: { default: { status } } })
          const result = await reader.read()
          is(result.ok, false)
          is(result.reason, 'unsupported', `HTTP ${String(status)} reads as unsupported`)
          // A gateway that mirrors only the model surface is a normal
          // deployment, not something to warn about on every page load.
          equal(logger.warnings, [])
        }
      },
    },
    {
      name: 'a key the service rejects is named as such, and is not a warning',
      async run() {
        const { reader, logger } = readerUnderTest({ script: { default: { status: 401 } } })
        const result = await reader.read()
        is(result.ok, false)
        is(result.reason, 'unauthorized')
        equal(logger.warnings, [])
      },
    },
    {
      name: 'an unreachable service, a bad status, and unparseable JSON are separate reasons',
      async run() {
        const offline = readerUnderTest({ script: { default: { throws: 'connect ECONNREFUSED' } } })
        is((await offline.reader.read()).reason, 'unreachable')
        ok(offline.logger.warnings.length === 1, 'one warning per failed read')

        const broken = readerUnderTest({ script: { default: { status: 500 } } })
        const brokenResult = await broken.reader.read()
        is(brokenResult.reason, 'failed')
        ok(brokenResult.message.includes('500'), brokenResult.message)

        const garbage = readerUnderTest({ script: { default: { badBody: true } } })
        is((await garbage.reader.read()).reason, 'failed')
      },
    },
    {
      name: 'an answer with no windows is unsupported, not a table of zeroes',
      async run() {
        for (const body of [{}, { usage: {} }, { usage: null }, { usage: [] }, { usage: { rolling: 'soon' } }]) {
          const { reader } = readerUnderTest({ script: { default: { body } } })
          const result = await reader.read()
          is(result.ok, false, JSON.stringify(body))
          is(result.reason, 'unsupported')
        }
      },
    },
    {
      name: 'a failure is not cached, so the next read tries again',
      async run() {
        const { reader, requests } = readerUnderTest({
          script: { 0: { status: 500 }, default: { status: 200, body: ANSWER } },
        })
        is((await reader.read()).ok, false)
        const second = await reader.read()
        is(second.ok, true)
        is(requests.length, 2)
      },
    },
    {
      name: 'a failure never replaces the last good answer, and is not served as one',
      async run() {
        const { reader, clock, requests } = readerUnderTest({
          script: { 0: { status: 200, body: ANSWER }, default: { status: 500 } },
        })
        const first = await reader.read()
        equal(first.windows.map((window) => window.percent), [8, 8, 13])

        // Past the window, the service is asked again and fails. A quota
        // reading is a fact about right now, so a stale one is not silently
        // handed back as if it were current — the page says it could not read.
        clock.value += SUBSCRIPTION_CACHE_MS + 1
        is((await reader.read()).ok, false)
        is((await reader.read()).ok, false)
        is(requests.length, 3, 'each read past the window asks again')

        // A success replaces it, and the cache window starts over.
        const recovered = readerUnderTest({ script: { default: { status: 200, body: ANSWER } } })
        await recovered.reader.read()
        clock.value += 1_000
        is((await recovered.reader.read()).cached, true)
      },
    },
    {
      name: 'a missing credential is named rather than thrown',
      async run() {
        const reader = new SubscriptionReader(
          { baseURL: BASE_URL, timeoutMs: 5_000 },
          {
            authHeaders: async () => {
              throw new Error('no API key for provider route "opencode-go"')
            },
            fetch: async () => {
              throw new Error('the service must not be reached without a key')
            },
          },
        )
        const result = await reader.read()
        is(result.ok, false)
        is(result.reason, 'no-credential')
        ok(result.message.includes('no API key'), result.message)
      },
    },
    {
      name: 'the parser keeps a window the service adds and ignores what it cannot read',
      run() {
        const parsed = parseSubscription({
          usage: {
            monthly: { status: 'ok', percent: 13, resetsAt: '2026-10-21T05:02:55.000Z' },
            // A window this build does not know: shown, because the service
            // knows something this build does not.
            hourly: { status: 'limited', percent: 120, resetsAt: '2026-10-02T22:00:00.000Z' },
            // A window with no percentage is not a window.
            vague: { status: 'ok' },
          },
        })
        equal(parsed.windows.map((window) => window.name), ['monthly', 'hourly'])
        // A percentage is clamped: the table renders it, and 120% of a plan is
        // not a number a reader can act on differently from 100%.
        equal(parsed.windows.map((window) => window.percent), [13, 100])
        is(parsed.windows[1].status, 'limited')
      },
    },
    {
      name: 'a reader with no clock of its own uses the wall clock',
      async run() {
        const before = Date.now()
        const reader = new SubscriptionReader(
          { baseURL: BASE_URL, timeoutMs: 5_000 },
          { fetch: async () => ({ status: 200, ok: true, json: async () => ANSWER }) },
        )
        const result = await reader.read()
        is(result.ok, true)
        ok(result.fetchedAt >= before, 'the answer carries when it was fetched')
      },
    },
  ],
}
