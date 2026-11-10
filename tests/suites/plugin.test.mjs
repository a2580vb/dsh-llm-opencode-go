/**
 * The plugin body: registration through a fake Cordis context.
 *
 * `apply()` is the entry point the harness loader calls, so this suite drives
 * it directly rather than only testing the adapter class. It covers the two
 * things a deployment depends on but a unit test of the adapter cannot see:
 * that the route really reaches `ctx.llm.registerAdapter`, and that the
 * registration is tied to the plugin fiber so an unload releases it.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Config, resolveConfig } from '../../lib/config.js'
import { DiagnosticsLog } from '../../lib/diagnostics/log.js'
import { LlmError } from '../../lib/error/errors.js'
import { OpenCodeGoAdapter, apply, runHealthCheck } from '../../lib/index.js'
import { ModelCache } from '../../lib/model/cache.js'
import { UsageStore } from '../../lib/usage/store.js'
import { equal, is, ok } from '../helpers.mjs'
import { createScratch } from './_scratch.mjs'

/** The scratch area the health-check cases put their model cache in. */
const scratch = createScratch()

/**
 * A Cordis context stub recording what the plugin registered.
 *
 * `ctx.effect` mirrors the real one: a callback returning a disposer, which is
 * what ties a registration to the fiber. `ctx.inject` mirrors the real gate —
 * the child body runs only once every named service is provided, and it sees
 * those services as properties.
 */
function fakeContext() {
  const state = {
    registered: [],
    disposers: [],
    logs: [],
    services: new Map(),
    pendingInjects: [],
    routes: [],
  }
  const logger = {
    info: (...args) => state.logs.push({ level: 'info', args }),
    warn: (...args) => state.logs.push({ level: 'warn', args }),
    debug: () => {},
    error: (...args) => state.logs.push({ level: 'error', args }),
  }
  const ctx = {
    logger,
    get: (name) => state.services.get(name),
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') state.disposers.push(disposer)
      return () => disposer?.()
    },
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps ?? {})
      if (names.some((name) => !state.services.has(name))) {
        state.pendingInjects.push({ names, callback })
        return undefined
      }
      const child = Object.create(ctx)
      for (const name of names) child[name] = state.services.get(name)
      return callback(child)
    },
    llm: {
      registerAdapter: (providers, adapter) => {
        state.registered.push({ providers, adapter })
        return () => {
          state.registered = state.registered.filter((entry) => entry.adapter !== adapter)
        }
      },
    },
  }
  return { ctx, state }
}

/** A web-server stand-in recording the routes a plugin claims. */
function fakeWebServer(state) {
  return {
    register: (route) => {
      state.routes.push(route)
      return () => {
        state.routes = state.routes.filter((entry) => entry !== route)
      }
    },
  }
}

const CHAT_BODY = [
  'data: {"id":"r","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
  'data: {"id":"r","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
].join('\n\n') + '\n\n'

/** A fetch that answers `/models` and one completion. */
function fakeFetch() {
  const requests = []
  const implementation = async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(CHAT_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  implementation.requests = requests
  return implementation
}

/**
 * Wait for a log line the plugin writes in the background.
 *
 * The startup health check is fire-and-forget, so a case has to wait for its
 * line rather than assume a fixed delay is enough on every machine.
 *
 * @param {object[]} logs - the fake context's log entries.
 * @param {string} needle - what the line must include.
 * @returns {Promise<object | undefined>} the entry, or undefined after a timeout.
 */
async function waitForLogLine(logs, needle) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = logs.find((entry) => entry.args.map((arg) => String(arg)).join(' ').includes(needle))
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return undefined
}

/** A logger that keeps the lines a direct call writes. */
function recordingLogger() {
  const lines = []
  return {
    lines,
    info: (...args) => lines.push(args.map((arg) => String(arg)).join(' ')),
    warn: (...args) => lines.push(args.map((arg) => String(arg)).join(' ')),
    debug() {},
    error: (...args) => lines.push(args.map((arg) => String(arg)).join(' ')),
  }
}

/**
 * An adapter over a fake fetch, for the health-check cases.
 *
 * The fetch reaches both layers: the model cache for discovery and the adapter
 * for generation. A case that counts requests therefore sees every request the
 * health check really made, which is the fact an injected-only seam hid before.
 *
 * @param {object} input - the collaborators.
 * @param {object} input.config - the resolved configuration.
 * @param {typeof fetch} input.fetch - the request implementation.
 * @param {() => Promise<string>} input.resolveApiKey - the credential resolver.
 * @returns {{ adapter: OpenCodeGoAdapter, cache: ModelCache }} the adapter.
 */
function healthAdapter({ config, fetch, resolveApiKey }) {
  const logger = { info() {}, warn() {}, debug() {}, error() {} }
  const cache = new ModelCache(config, {
    authHeaders: async () => ({ authorization: `Bearer ${await resolveApiKey()}` }),
    logger,
    fetch,
  })
  const adapter = new OpenCodeGoAdapter({
    options: () => config,
    resolveApiKey,
    cache,
    attachments: () => undefined,
    logger,
    fetch,
  })
  return { adapter, cache }
}

/**
 * Drive one call to completion and return the failure it raised.
 *
 * The credential resolver throws before the first chunk, so the stream rejects
 * rather than settling into a `finish` chunk; this captures that rejection.
 */
async function captureStreamError(adapter) {
  try {
    for await (const chunk of adapter.stream({
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      void chunk
    }
  } catch (error) {
    return error
  }
  return undefined
}

export default {
  name: 'plugin',
  cases: scratch.withCleanup([
    {
      name: 'the exported Config satisfies the interface Cordis actually calls',
      run() {
        // Cordis does not read a schema object: it calls
        // `Config['~standard'].validate(raw)` and expects a synchronous
        // `{value}` or `{issues}`. A plain object here fails activation with
        // "Cannot read properties of undefined (reading 'validate')".
        ok(Config !== undefined, 'Config is exported')
        ok(Config['~standard'] !== undefined, 'Config has a ~standard property')
        is(typeof Config['~standard'].validate, 'function', '~standard.validate is a function')
        is(Config['~standard'].version, 1)
      },
    },
    {
      name: 'a valid row config passes the schema and is handed through unchanged',
      run() {
        const raw = { provider: 'opencode-go', apiKeyEnv: 'MY_KEY', timeoutMs: 1000 }
        const result = Config['~standard'].validate(raw)
        is('issues' in result, false, 'no issues')
        // Defaults belong to resolveConfig, so the schema must not invent any.
        is(result.value, raw, 'the same reference is returned')
      },
    },
    {
      name: 'an absent row config is valid, because every field has a default',
      run() {
        for (const raw of [undefined, null, {}]) {
          const result = Config['~standard'].validate(raw)
          is('issues' in result, false, `no issues for ${JSON.stringify(raw)}`)
        }
      },
    },
    {
      name: 'a malformed row config is reported as issues, never thrown',
      run() {
        const result = Config['~standard'].validate({
          apiKeyEnv: 'not a ref',
          timeoutMs: -1,
          sessionHeader: 'nonsense',
          protocolOverrides: { 'glm-5.3': 'grpc' },
        })
        ok(Array.isArray(result.issues), 'issues were returned')
        const text = result.issues.map((issue) => issue.message).join(' | ')
        for (const field of ['apiKeyEnv', 'timeoutMs', 'sessionHeader', 'protocolOverrides']) {
          ok(text.includes(field), `the issue text names ${field}: ${text}`)
        }
      },
    },
    {
      name: 'a wrong list container is reported as issues, never thrown',
      run() {
        // The loader validates before activation, so the schema itself is the
        // boundary for a hand-written row. Iterating a non-array value here
        // used to throw `... is not iterable` instead of naming the field.
        for (const field of ['models', 'hiddenModels', 'modelVariants']) {
          for (const value of [true, 7, {}, 'not-a-list']) {
            let result
            try {
              result = Config['~standard'].validate({ [field]: value })
            } catch (error) {
              throw new Error(`${field}: ${JSON.stringify(value)} made the validator throw: ${error?.message}`)
            }
            ok(Array.isArray(result.issues) && result.issues.length > 0, `${field}: ${JSON.stringify(value)} was refused`)
            ok(
              result.issues.some((issue) => String(issue.message).includes(field)),
              `${field}: the issue names the field`,
            )
          }
        }
      },
    },
    {
      name: 'a handwritten retry policy the page would refuse fails activation',
      run() {
        // The page and a hand-written YAML row are the same input: a policy
        // that one path accepts while the other persists it would be applied
        // unvalidated by the adapter's retry executor.
        const raw = { retryPolicy: { maxRetries: 'many' } }
        const issues = Config['~standard'].validate(raw).issues
        ok(Array.isArray(issues) && issues.length > 0, 'the schema refused the policy')
        ok(issues.some((issue) => String(issue.message).includes('maxRetries')), 'the issue names maxRetries')

        const { ctx } = fakeContext()
        let error
        try {
          apply(ctx, raw)
        } catch (thrown) {
          error = thrown
        }
        ok(error !== undefined, 'activation failed')
        ok(String(error.message).includes('maxRetries'), 'the failure names maxRetries')
      },
    },
    {
      name: 'a config that fails the schema also fails resolveConfig, by the same field',
      run() {
        const raw = { sessionHeader: 'nonsense' }
        const issues = Config['~standard'].validate(raw).issues
        ok(issues !== undefined && issues.length > 0, 'the schema objected')
        let thrown
        try {
          resolveConfig(raw)
        } catch (error) {
          thrown = error
        }
        ok(thrown !== undefined, 'resolveConfig objected too')
        ok(String(thrown.message).includes('sessionHeader'), 'both name the same field')
      },
    },
    {
      name: 'a valid row config survives both the schema and resolveConfig',
      run() {
        const raw = { provider: 'my-route', apiKeyEnv: 'MY_KEY', protocolOverrides: { 'glm-5.3': 'anthropic' } }
        const result = Config['~standard'].validate(raw)
        is('issues' in result, false)
        is(resolveConfig(result.value).provider, 'my-route')
      },
    },
    {
      name: 'apply registers exactly the configured route',
      run() {
        const { ctx, state } = fakeContext()
        apply(ctx, { provider: 'opencode-go' })
        is(state.registered.length, 1)
        equal(state.registered[0].providers, ['opencode-go'])
        is(state.registered[0].adapter.providerInfo('opencode-go').name, 'OpenCode Go')
      },
    },
    {
      name: 'a renamed route is the one registered',
      run() {
        const { ctx, state } = fakeContext()
        apply(ctx, { provider: 'opencode-go-native' })
        equal(state.registered[0].providers, ['opencode-go-native'])
      },
    },
    {
      name: 'the registration is released when the plugin unloads',
      run() {
        const { ctx, state } = fakeContext()
        apply(ctx, {})
        is(state.registered.length, 1)
        for (const dispose of state.disposers) dispose()
        is(state.registered.length, 0, 'the route was released')
      },
    },
    {
      name: 'an invalid row config throws during activation, naming the field',
      run() {
        const { ctx } = fakeContext()
        let error
        try {
          apply(ctx, { sessionHeader: 'nonsense' })
        } catch (thrown) {
          error = thrown
        }
        ok(error !== undefined, 'activation failed')
        ok(String(error.message).includes('sessionHeader'), 'the field is named')
      },
    },
    {
      name: 'the configuration page route is claimed on a deployment with a web server',
      run() {
        const { ctx, state } = fakeContext()
        state.services.set('webServer', fakeWebServer(state))
        apply(ctx, {})
        is(state.routes.length, 1, 'one route')
        is(state.routes[0].kind, 'prefix')
        is(state.routes[0].path, '/opencode-go')
        is(typeof state.routes[0].handler, 'function')
        ok(
          state.logs.some((entry) => entry.level === 'info'
            && entry.args.map(String).join(' ').includes('/opencode-go')),
          'the readiness of the page is logged',
        )
      },
    },
    {
      name: 'the page route waits for a late web server instead of failing activation',
      run() {
        const { ctx, state } = fakeContext()
        apply(ctx, {})
        is(state.routes.length, 0, 'nothing claimed yet')
        is(state.pendingInjects.length, 1, 'the injection is pending')
        // The route is claimed the moment the server appears, exactly as the
        // real injected child context does.
        state.services.set('webServer', fakeWebServer(state))
        for (const pending of state.pendingInjects.splice(0)) {
          const child = Object.create(ctx)
          for (const name of pending.names) child[name] = state.services.get(name)
          pending.callback(child)
        }
        is(state.routes.length, 1)
        is(state.routes[0].path, '/opencode-go')
      },
    },
    {
      name: 'unloading the plugin releases the page route',
      run() {
        const { ctx, state } = fakeContext()
        state.services.set('webServer', fakeWebServer(state))
        apply(ctx, {})
        is(state.routes.length, 1)
        for (const dispose of state.disposers) dispose()
        is(state.routes.length, 0, 'the route was released')
      },
    },
    {
      name: 'a disabled session header is warned about at startup',
      run() {
        const { ctx, state } = fakeContext()
        apply(ctx, { sessionHeader: 'off' })
        // Cordis logs through `util.format`-style placeholders, so the header
        // name can be in any argument; check the rendered line.
        ok(
          state.logs.some((entry) => entry.level === 'warn'
            && entry.args.map((arg) => String(arg)).join(' ').includes('x-opencode-session')),
          'the warning names the header',
        )
      },
    },
    {
      name: 'the startup log names the route, endpoint, credential reference, and source',
      run() {
        const { ctx, state } = fakeContext()
        apply(ctx, { provider: 'my-route', apiKeyEnv: 'MY_KEY' })
        const line = state.logs.find((entry) => entry.level === 'info' && String(entry.args[0]).includes('ready'))
        ok(line !== undefined, 'the readiness line was logged')
        const rendered = line.args.map((arg) => String(arg)).join(' ')
        ok(rendered.includes('my-route'), 'the route is named')
        ok(rendered.includes('MY_KEY'), 'the credential reference is named')
        ok(rendered.includes('opencode.ai/zen/go/v1'), 'the endpoint is named')
      },
    },
    {
      name: 'the credential reference, never the key, reaches the log',
      run() {
        const { ctx, state } = fakeContext()
        process.env.LEAK_CHECK_KEY = 'sk-must-not-appear'
        apply(ctx, { apiKeyEnv: 'LEAK_CHECK_KEY' })
        const everything = JSON.stringify(state.logs.map((entry) => entry.args.map(String)))
        ok(!everything.includes('sk-must-not-appear'), 'no part of the secret was logged')
        delete process.env.LEAK_CHECK_KEY
      },
    },
    {
      name: 'an unresolvable credential fails as MISSING_CREDENTIAL, not as a transport error',
      async run() {
        // The resolver runs before any network I/O, so this needs no fetch stub.
        // Its code must exist in CODES: `LlmError` rejects an undefined one, and
        // the failure used to resurface as TRANSPORT with a constructor message.
        const missing = `DSH_ABSENT_${Date.now()}`
        delete process.env[missing]
        const { ctx, state } = fakeContext()
        apply(ctx, { apiKeyEnv: missing, healthCheck: 'off' })
        const error = await captureStreamError(state.registered[0].adapter)
        is(error?.code, 'MISSING_CREDENTIAL')
        ok(String(error.message).includes(missing), 'the reference is named, never the value')
      },
    },
    {
      name: 'a credential no HTTP header can carry fails as INVALID_CREDENTIAL',
      async run() {
        const { ctx, state } = fakeContext()
        // A resolved credential carrying a newline cannot ride in a header; the
        // resolver names the setting to fix instead of letting fetch fail opaquely.
        ctx.get = (name) => (name === 'credentials'
          ? { resolve: async () => ({ value: 'oc_sk_line1\noc_sk_line2' }) }
          : undefined)
        apply(ctx, { apiKeyEnv: 'OPENCODE_GO_API_KEY', healthCheck: 'off' })
        const error = await captureStreamError(state.registered[0].adapter)
        is(error?.code, 'INVALID_CREDENTIAL')
        ok(!String(error.message).includes('oc_sk_line1'), 'no part of the secret is echoed')
      },
    },
    {
      name: 'the startup health check resolves the credential and says the catalog came from the service',
      async run() {
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: scratch.path('plugin'),
        })
        process.env.TEST_KEY = 'sk-test'
        const fetch = fakeFetch()
        const original = globalThis.fetch
        globalThis.fetch = fetch
        try {
          const { ctx, state } = fakeContext()
          apply(ctx, {
            baseURL: 'https://relay.test/v1',
            apiKeyEnv: 'TEST_KEY',
            modelsCachePath: config.modelsCachePath,
            healthCheck: 'startup',
          })
          const line = await waitForLogLine(state.logs, 'health check')
          ok(line !== undefined, 'the startup check logged its report')
          const report = JSON.parse(String(line.args[1]))
          is(report.ok, true)
          is(report.steps[0].step, 'credential', 'the credential is its own step')
          is(report.steps[0].ok, true)
          const models = report.steps.find((step) => step.step === 'models')
          is(models.ok, true)
          is(models.source, 'service', 'a cold directory was read from the service')
          is(models.serviceReached, true)
          ok(fetch.requests.some((request) => String(request.url).endsWith('/models')), 'GET /models was really sent')
        } finally {
          globalThis.fetch = original
          delete process.env.TEST_KEY
        }
      },
    },
    {
      name: 'a credential failure fails the health report even when no service read is needed',
      async run() {
        const missing = 'DSH_HEALTH_ABSENT_KEY'
        delete process.env[missing]
        const hotCache = scratch.path('health-cache')
        await mkdir(dirname(hotCache), { recursive: true })
        await writeFile(hotCache, JSON.stringify({
          version: 2,
          baseURL: 'https://relay.test/v1',
          fetchedAt: Date.now(),
          rows: [{ id: 'cached-model' }],
        }), 'utf8')
        const scenarios = [
          {
            source: 'config',
            config: resolveConfig({
              baseURL: 'https://relay.test/v1',
              apiKeyEnv: missing,
              modelSource: 'config',
              models: [{ id: 'configured-model' }],
              modelsCachePath: scratch.path('health-config'),
            }),
          },
          {
            source: 'cache',
            config: resolveConfig({
              baseURL: 'https://relay.test/v1',
              apiKeyEnv: missing,
              modelsCachePath: hotCache,
            }),
          },
        ]
        for (const scenario of scenarios) {
          const fetch = fakeFetch()
          const { adapter } = healthAdapter({
            config: scenario.config,
            fetch,
            resolveApiKey: async () => {
              throw new LlmError(
                `dsh-llm-opencode-go: no API key for provider route "opencode-go"; store ${missing}`,
                'MISSING_CREDENTIAL',
              )
            },
          })
          const report = await runHealthCheck(adapter, scenario.config, recordingLogger())
          is(report.ok, false, `${scenario.source}: the report fails`)
          is(report.steps[0].step, 'credential')
          is(report.steps[0].ok, false)
          is(report.steps[0].code, 'MISSING_CREDENTIAL')
          const models = report.steps.find((step) => step.step === 'models')
          is(models.source, scenario.source, `${scenario.source}: the catalog source is named`)
          is(models.serviceReached, false, `${scenario.source}: no service request is claimed`)
          is(fetch.requests.length, 0, `${scenario.source}: nothing is read from the service`)
        }
      },
    },
    {
      name: 'runHealthCheck reports the catalog it resolved from the service it reached',
      async run() {
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: scratch.path('health'),
        })
        process.env.TEST_KEY = 'sk-test'
        try {
          const fetch = fakeFetch()
          const { adapter } = healthAdapter({
            config,
            fetch,
            resolveApiKey: async () => 'sk-test',
          })
          const report = await runHealthCheck(adapter, config, recordingLogger())
          is(report.ok, true)
          is(report.steps[0].step, 'credential')
          is(report.steps[0].ok, true)
          const models = report.steps.find((step) => step.step === 'models')
          ok(models.count > 0, 'models were listed')
          is(models.source, 'service')
          is(models.serviceReached, true)
          // The fake fetch is the one the cache used. Injecting it into the
          // adapter alone leaves discovery on the real network, where the
          // built-in fallback makes the request count unobservable.
          is(fetch.requests.filter((request) => String(request.url).endsWith('/models')).length, 1)
        } finally {
          delete process.env.TEST_KEY
        }
      },
    },
    {
      name: 'a hot cache is reported as a cache, never as a service read',
      async run() {
        const path = scratch.path('hot-health')
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, JSON.stringify({
          version: 2,
          baseURL: 'https://relay.test/v1',
          fetchedAt: Date.now(),
          rows: [{ id: 'cached-model' }],
        }), 'utf8')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: path,
        })
        const fetch = fakeFetch()
        const { adapter } = healthAdapter({
          config,
          fetch,
          resolveApiKey: async () => 'sk-test',
        })
        const report = await runHealthCheck(adapter, config, recordingLogger())
        is(report.ok, true)
        const models = report.steps.find((step) => step.step === 'models')
        is(models.source, 'cache')
        is(models.serviceReached, false, 'a cache read is not a service read')
        is(fetch.requests.length, 0, 'the hot cache answered without a request')
      },
    },
    {
      name: 'the plugin disposer returns a promise that waits for both writes',
      async run() {
        const { ctx, state } = fakeContext()
        apply(ctx, { healthCheck: 'off' })
        const originalUsage = UsageStore.prototype.flush
        const originalDiagnostics = DiagnosticsLog.prototype.flush
        const started = []
        let release
        const gate = new Promise((resolve) => { release = resolve })
        UsageStore.prototype.flush = function flushUsage() {
          started.push('usage')
          return gate.then(() => originalUsage.call(this))
        }
        DiagnosticsLog.prototype.flush = function flushDiagnostics() {
          started.push('diagnostics')
          return gate.then(() => originalDiagnostics.call(this))
        }
        try {
          const dispose = state.disposers.at(-1)
          const pending = dispose()
          ok(pending !== undefined && typeof pending.then === 'function', 'the disposer returns its completion')
          equal(started.sort(), ['diagnostics', 'usage'], 'both flushes were started')
          let settled = false
          pending.then(() => { settled = true })
          await new Promise((resolve) => setTimeout(resolve, 0))
          is(settled, false, 'the completion waits for the flushes it started')
          release()
          await pending
          is(settled, true, 'the completion resolves once both writes settle')
        } finally {
          release()
          UsageStore.prototype.flush = originalUsage
          DiagnosticsLog.prototype.flush = originalDiagnostics
        }
      },
    },
  ]),
}
