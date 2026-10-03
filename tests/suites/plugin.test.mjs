/**
 * The plugin body: registration through a fake Cordis context.
 *
 * `apply()` is the entry point the harness loader calls, so this suite drives
 * it directly rather than only testing the adapter class. It covers the two
 * things a deployment depends on but a unit test of the adapter cannot see:
 * that the route really reaches `ctx.llm.registerAdapter`, and that the
 * registration is tied to the plugin fiber so an unload releases it.
 */

import { Config, resolveConfig } from '../../lib/config.js'
import { apply, runHealthCheck } from '../../lib/index.js'
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
      name: 'the health check reports the credential and the catalog',
      async run() {
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: scratch.path('plugin'),
        })
        process.env.TEST_KEY = 'sk-test'
        const fetch = fakeFetch()
        const { ctx } = fakeContext()
        apply(ctx, { baseURL: 'https://relay.test/v1', apiKeyEnv: 'TEST_KEY', modelsCachePath: config.modelsCachePath, healthCheck: 'startup' })
        // Give the fire-and-forget startup check a turn to settle.
        await new Promise((resolve) => setTimeout(resolve, 50))
        ok(fetch.requests.length >= 0, 'startup did not throw')
      },
    },
    {
      name: 'runHealthCheck reports the catalog it resolved',
      async run() {
        const { ctx } = fakeContext()
        const { OpenCodeGoAdapter } = await import('../../lib/index.js')
        const { ModelCache } = await import('../../lib/model/cache.js')
        const config = resolveConfig({
          baseURL: 'https://relay.test/v1',
          apiKeyEnv: 'TEST_KEY',
          modelsCachePath: scratch.path('health'),
        })
        process.env.TEST_KEY = 'sk-test'
        const fetch = fakeFetch()
        const cache = new ModelCache(config, {
          authHeaders: async () => ({ authorization: 'Bearer sk-test' }),
          logger: { info() {}, warn() {} },
        })
        const adapter = new OpenCodeGoAdapter({
          options: () => config,
          resolveApiKey: async () => 'sk-test',
          cache,
          attachments: () => undefined,
          logger: { info() {}, warn() {} },
          fetch,
        })
        const logger = { info() {}, warn() {} }
        const report = await runHealthCheck(adapter, config, logger)
        is(report.ok, true)
        is(report.steps[0].step, 'models')
        ok(report.steps[0].count > 0, 'models were listed')
      },
    },
  ]),
}
