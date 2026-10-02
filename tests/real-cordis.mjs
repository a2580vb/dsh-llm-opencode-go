/**
 * Mount the plugin on the harness's OWN cordis and prove it activates.
 *
 * This is the check the unit suite cannot make: cordis validates a plugin's
 * exported config through `Config['~standard'].validate()` before it starts the
 * plugin, and that call is exactly what a plain-object schema broke. Running
 * against the real library — the version this machine's DSH actually ships —
 * closes that gap.
 *
 * The harness's packages are extracted from `app.asar` into a temporary
 * directory on first run, because Electron's archive format is not a directory
 * a plain Node process can import from. Skips with a clear message when the
 * installation cannot be found, so `npm test` stays green elsewhere.
 *
 *   node tests/real-cordis.mjs
 *   DSH_ASAR=<path>   override the archive
 */

import { mkdirSync, openSync, readFileSync, readSync, closeSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dayKey } from '../lib/usage/store.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const ASAR = process.env.DSH_ASAR ?? 'E:\\dsh\\resources\\app.asar'
const CACHE = process.env.DSH_BUNDLE_CACHE ?? join(tmpdir(), 'dsh-opencode-go-real-cordis')

/** A Windows path as the file URL the ESM loader requires. */
const url = (path) => pathToFileURL(path).href

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

if (!existsSync(ASAR)) {
  console.log(`SKIP  no harness installation at ${ASAR}; set DSH_ASAR to run this suite`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Extract the harness's own packages so they can be imported.
// ---------------------------------------------------------------------------

/** Third-party packages the harness's own packages import by name. */
const EXTRA = ['schemastery', 'zod']

function extractBundledPackages() {
  const fd = openSync(ASAR, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(12)
  const headerBuf = Buffer.alloc(headerSize)
  readSync(fd, headerBuf, 0, headerSize, 16)
  const header = JSON.parse(headerBuf.toString('utf8'))
  const baseOffset = 16 + headerSize

  const SCOPED = 'dsh/node_modules/@deepseek-ai/'
  const files = []
  let packageCount = 0

  const walk = (node, path, owner) => {
    const hasManifest = node.files?.['package.json'] !== undefined
    let nextOwner = owner
    if (hasManifest) {
      const relative = path.startsWith(SCOPED) ? path.slice(SCOPED.length) : undefined
      if (relative !== undefined && relative.length > 0 && !relative.includes('/')) {
        nextOwner = relative
        packageCount += 1
      } else if (EXTRA.some((extra) => path === `dsh/node_modules/${extra}`)) {
        nextOwner = path.slice(path.lastIndexOf('/') + 1)
        packageCount += 1
      }
    }
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const cur = path ? `${path}/${name}` : name
      if (entry.files) {
        // A package's private dependencies must not take over its own files.
        if (name === 'node_modules' && nextOwner !== undefined) continue
        walk(entry, cur, nextOwner)
      } else if (nextOwner !== undefined && /\.(js|mjs|cjs|json|node)$/.test(cur)) {
        const offset = Number(entry.offset)
        // An entry with no offset is a directory marker, not content.
        if (Number.isFinite(offset) && entry.size > 0) {
          files.push({ path: cur, offset, size: entry.size })
        }
      }
    }
  }
  walk(header, '', undefined)

  for (const file of files) {
    const target = join(CACHE, file.path)
    if (existsSync(target)) continue
    const buf = Buffer.alloc(file.size)
    readSync(fd, buf, 0, file.size, baseOffset + file.offset)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, buf)
  }
  closeSync(fd)
  return { packageCount, fileCount: files.length }
}

const { packageCount, fileCount } = extractBundledPackages()
console.log(`extracted ${packageCount} harness packages (${fileCount} files) -> ${CACHE}\n`)

const BUNDLE = join(CACHE, 'dsh', 'node_modules')
const { Context } = await import(url(join(BUNDLE, '@deepseek-ai/cordis/lib/index.js')))
const LlmRuntime = (await import(url(join(BUNDLE, '@deepseek-ai/dsh-llm/lib/index.js')))).default
const { BlockAssembler } = await import(url(join(BUNDLE, '@deepseek-ai/dsh-llm/lib/index.js')))

/** A context with a logger that records what the plugin said. */
function makeContext() {
  const logs = []
  const ctx = new Context()
  ctx.logger = {
    info: (...args) => logs.push({ level: 'info', text: args.map(String).join(' ') }),
    warn: (...args) => logs.push({ level: 'warn', text: args.map(String).join(' ') }),
    debug: () => {},
    error: (...args) => logs.push({ level: 'error', text: args.map(String).join(' ') }),
  }
  return { ctx, logs }
}

/** Start the LLM runtime and the plugin on a fresh context. */
async function activate(config) {
  const { ctx, logs } = makeContext()
  ctx.plugin(LlmRuntime)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const fiber = ctx.plugin(pluginModule, config)
  await new Promise((resolve) => setTimeout(resolve, 300))
  return { ctx, logs, fiber }
}

/** A cache path unique per activation, so discovery never crosses cases. */
let cacheSeq = 0
const cachePath = () => {
  cacheSeq += 1
  return join(CACHE, 'models', `${cacheSeq}.json`)
}

const pluginModule = await import(url(join(PLUGIN, 'lib/index.js')))

// ---------------------------------------------------------------------------
// 1. The exported Config satisfies what cordis calls.
// ---------------------------------------------------------------------------
{
  const { Config } = pluginModule
  check(
    'the plugin exports a Config with ~standard.validate',
    Config !== undefined && typeof Config['~standard']?.validate === 'function',
  )
  const result = Config['~standard'].validate({ provider: 'opencode-go', apiKeyEnv: 'OC_KEY' })
  check('a valid row passes cordis-shaped validation', result.issues === undefined, JSON.stringify(result).slice(0, 120))
  const bad = Config['~standard'].validate({ timeoutMs: -1 })
  check('an invalid row reports issues rather than throwing', Array.isArray(bad.issues) && bad.issues.length > 0)
}

// ---------------------------------------------------------------------------
// 2. Cordis' own resolveConfig path, using the runtime it really uses.
// ---------------------------------------------------------------------------
{
  const { ctx } = makeContext()
  const runtime = { Config: pluginModule.Config, name: pluginModule.name }
  // This is the exact expression cordis evaluates internally.
  let value
  let error
  try {
    value = runtime.Config['~standard'].validate({ provider: 'opencode-go' })
  } catch (thrown) {
    error = thrown
  }
  check(
    "cordis' Config['~standard'].validate() no longer throws",
    error === undefined && value?.issues === undefined,
    error?.message,
  )
}

// ---------------------------------------------------------------------------
// 3. Activation on a real context with the real LLM runtime mounted.
// ---------------------------------------------------------------------------
{
  let activationError
  let logs
  let ctx
  try {
    // `ctx.plugin` is how the loader starts a plugin: config first, then apply.
    ({ ctx, logs } = await activate({
      provider: 'opencode-go',
      apiKeyEnv: 'OC_TEST_KEY',
      modelsCachePath: cachePath(),
    }))
  } catch (thrown) {
    activationError = thrown
  }

  check('the plugin activates without throwing', activationError === undefined, activationError?.message)

  const warnings = logs.filter((entry) => entry.level === 'warn' || entry.level === 'error')
  check(
    'activation produced no warning or error',
    warnings.length === 0,
    warnings.map((entry) => entry.text).join(' | '),
  )

  const ready = logs.find((entry) => entry.text.includes('ready at'))
  check('the readiness line was logged', ready !== undefined, ready?.text)

  // `listProviders()` returns detached metadata objects, not bare strings.
  const providers = ctx.llm.listProviders().map((info) => info.id)
  check(
    'the opencode-go route is registered on the real LLM runtime',
    providers.includes('opencode-go'),
    `providers=[${providers.join(',')}]`,
  )
  const described = ctx.llm.listProviders().find((info) => info.id === 'opencode-go')
  check('the route is described as OpenCode Go', described?.name === 'OpenCode Go', JSON.stringify(described))
}

// ---------------------------------------------------------------------------
// 4. The registered adapter resolves models through the real runtime.
// ---------------------------------------------------------------------------
{
  const { ctx } = await activate({
    provider: 'opencode-go',
    apiKeyEnv: 'OC_TEST_KEY',
    modelsCachePath: cachePath(),
  })

  const models = await ctx.llm.listModels('opencode-go')
  check('the harness lists the catalog through the adapter', models.length > 20, `${models.length} models`)

  const info = await ctx.llm.resolveModelInfo('opencode-go', 'gpt-5.6-luna')
  check(
    'the harness resolves one model through the adapter',
    info?.context?.contextWindow > 0,
    `contextWindow=${info?.context?.contextWindow} efforts=${info?.reasoning?.efforts?.map((e) => e.id).join('/')}`,
  )

  const config = await ctx.llm.resolveCallConfig({ provider: 'opencode-go', model: 'gpt-5.6-luna', reasoningEffort: 'high' })
  check('the harness validates a reasoning effort through the adapter', config.reasoningEffort === 'high')

  let rejected
  try {
    await ctx.llm.resolveCallConfig({ provider: 'opencode-go', model: 'gpt-5.6-luna', reasoningEffort: 'minimal' })
  } catch (error) {
    rejected = error
  }
  check(
    'an effort the Responses protocol cannot express is refused before I/O',
    rejected?.code === 'UNSUPPORTED_REASONING_EFFORT',
    `${rejected?.code}: ${rejected?.message}`,
  )
}

// ---------------------------------------------------------------------------
// 5. A full streaming call through the real runtime, with only the socket faked.
// ---------------------------------------------------------------------------
// The usage file is per run, like the discovery caches above. It used to be one
// fixed path under the shared bundle cache, and the case below asserted the file
// held exactly one call — which only ever held because a bug threw the recorded
// call away on the write that followed it, so the number could never grow. A
// path of its own is what makes "one call went through, one call was counted"
// an assertion about the plugin rather than about the machine's history.
const USAGE_RUN = `run-${String(Date.now())}-${String(process.pid)}`
const USAGE_PATH = join(CACHE, 'usage', `${USAGE_RUN}.json`)
{
  const { ctx, fiber } = await activate({
    provider: 'opencode-go',
    apiKeyEnv: 'OC_TEST_KEY',
    baseURL: 'https://relay.test/v1',
    modelsCachePath: cachePath(),
    usagePath: USAGE_PATH,
  })

  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const body = [
      'data: {"id":"r","choices":[{"index":0,"delta":{"content":"harness says hi"},"finish_reason":null}]}',
      'data: {"id":"r","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"id":"r","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  process.env.OC_TEST_KEY = 'sk-real-cordis-test'

  try {
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'opencode-go',
      model: 'glm-5.3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'real-cordis-session',
    })) {
      assembler.push(chunk)
    }
    const blocks = assembler.blocks()
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
    check('a streamed call completes through the real runtime', text === 'harness says hi', `text=${JSON.stringify(text)}`)
    check('the terminal finish is a stop', assembler.finish.kind === 'stop', assembler.finish.kind)
    check('usage reached the harness', assembler.usage?.totalTokens === 10, JSON.stringify(assembler.usage))

    const request = requests.find((entry) => !entry.url.endsWith('/models'))
    const headers = new Headers(request.init.headers)
    check(
      'the request carried the session affinity header',
      headers.get('x-opencode-session') === 'real-cordis-session',
      headers.get('x-opencode-session'),
    )
    check(
      'the request carried the plugin User-Agent',
      (headers.get('user-agent') ?? '').startsWith('dsh-opencode-go/'),
      headers.get('user-agent'),
    )
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.OC_TEST_KEY
  }

  // A call that never reaches disk is a table nobody can read, so the unload
  // path is checked here: the record was written on a debounce, and disposal is
  // the last chance to flush it.
  await fiber.dispose()
  // The disposer starts the write and does not wait for it, so give the file a
  // beat: a check that read it in the same tick would measure the scheduler.
  await new Promise((resolve) => setTimeout(resolve, 200))
  check(
    'the unload path writes the usage counters out',
    (() => {
      try {
        const raw = JSON.parse(readFileSync(USAGE_PATH, 'utf8'))
        const row = raw.days[dayKey(Date.now())]?.['glm-5.3']
        return row?.requests === 1 && row.totalTokens === 10
      } catch {
        return false
      }
    })(),
    USAGE_PATH,
  )
}

// ---------------------------------------------------------------------------
// 6. Unloading the plugin releases the route.
// ---------------------------------------------------------------------------
{
  const { ctx, fiber } = await activate({
    provider: 'opencode-go',
    apiKeyEnv: 'OC_TEST_KEY',
    modelsCachePath: cachePath(),
  })
  check('the route exists before unload', ctx.llm.listProviders().some((info) => info.id === 'opencode-go'))

  await fiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 200))
  check(
    'the route is released when the plugin unloads',
    !ctx.llm.listProviders().some((info) => info.id === 'opencode-go'),
    `providers=[${ctx.llm.listProviders().map((info) => info.id).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// 7. The settings-page route, over a real socket, on the real cordis.
// ---------------------------------------------------------------------------
{
  const http = await import('node:http')
  const routes = []
  const pathnameOf = (url) => new URL(url ?? '/', 'http://localhost').pathname
  const matches = (pathname, route) => pathname === route.path
    || (route.kind === 'prefix' && pathname.startsWith(`${route.path}/`))
  const server = http.createServer((request, response) => {
    const route = routes.find((entry) => matches(pathnameOf(request.url), entry))
    if (route === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    Promise.resolve(route.handler(request, response)).catch(() => {
      if (!response.headersSent) response.statusCode = 500
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  // The web server is composed by the application, so the suite provides the
  // same service shape the harness's own server has: a route registry with a
  // disposer per registration, backed here by a real node:http listener.
  const webServer = {
    host: '127.0.0.1',
    port,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }

  const { ctx, logs } = makeContext()
  ctx.plugin(LlmRuntime)
  ctx.plugin({
    name: 'suite-webserver',
    apply(child) {
      child.provide('webServer', webServer)
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 50))

  // A pre-populated discovery cache keeps this section off the network: the
  // catalog read the page triggers must not depend on a live service.
  const modelsPath = cachePath()
  mkdirSync(dirname(modelsPath), { recursive: true })
  writeFileSync(modelsPath, JSON.stringify({
    version: 1,
    baseURL: 'https://opencode.ai/zen/go/v1',
    fetchedAt: Date.now(),
    ids: [{ id: 'glm-5.3' }],
  }))

  const fiber = ctx.plugin(pluginModule, {
    provider: 'opencode-go',
    apiKeyEnv: 'OC_TEST_KEY',
    modelsCachePath: modelsPath,
    hiddenModels: ['glm-5.3'],
    modelVariants: [{ model: 'gpt-5.6-luna', name: 'chatty', protocol: 'chat-completions', effort: 'low' }],
    // The same usage file section 5's streamed call wrote to, so this section
    // reads back a call another activation made.
    usagePath: USAGE_PATH,
  })
  await new Promise((resolve) => setTimeout(resolve, 300))

  check(
    'the settings-page route was claimed on the injected web server',
    routes.length === 1 && routes[0].path === '/opencode-go' && routes[0].kind === 'prefix',
    routes.map((route) => `${route.kind}:${route.path}`).join(','),
  )
  check(
    'the settings page is announced at startup',
    logs.some((entry) => entry.text.includes('/opencode-go')),
  )

  try {
    const response = await fetch(`http://127.0.0.1:${port}/opencode-go/state`)
    const payload = await response.json()
    check('the page state is served over a real socket', response.status === 200 && payload.ok === true, JSON.stringify(payload).slice(0, 140))
    check(
      'the page state names the route, the endpoint, and the credential reference',
      payload.route?.provider === 'opencode-go'
        && payload.route?.apiKeyEnv === 'OC_TEST_KEY'
        && payload.route?.baseURL === 'https://opencode.ai/zen/go/v1',
      JSON.stringify(payload.route),
    )
    check(
      'a deployment without a credential store reports it instead of failing',
      // The harness's own `dsh-credentials` is mounted in this composition, so
      // the report is a real one rather than a null the page has to interpret.
      // What matters is that it never carries a value, that it says nothing is
      // configured while the reference resolves to nothing, and that its shape
      // is exactly the one the page's own fields name.
      payload.credential?.configured !== true
        && payload.credential?.writable !== true
        && payload.environment?.variable === 'OC_TEST_KEY'
        && Object.keys(payload.credential ?? {}).every(
          (key) => ['reference', 'configured', 'source', 'writable', 'removable', 'blockedBy', 'environment', 'error'].includes(key),
        )
        && !JSON.stringify(payload.credential).includes('oc_sk_'),
      JSON.stringify(payload.credential),
    )
    check(
      'the page state carries the catalog counts the adapter reports',
      payload.catalog?.counts?.listed >= 1,
      JSON.stringify(payload.catalog),
    )

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/opencode-go/config`)
    check('a method the endpoint does not serve is refused', wrongMethod.status === 405, String(wrongMethod.status))
    const unknown = await fetch(`http://127.0.0.1:${port}/opencode-go/absent`)
    check('an unknown path under the prefix is not answered as a page', unknown.status === 404, String(unknown.status))

    // The refresh control is the page's one call that reaches the provider.
    // The cache file is fresh, so the Host answers from the service: a failed
    // request is reported with the catalog kept, which is what an offline
    // machine must see rather than a page that lost its models.
    const refreshed = await fetch(`http://127.0.0.1:${port}/opencode-go/refresh`, { method: 'POST' })
    const refreshPayload = await refreshed.json()
    check(
      'the refresh endpoint answers with the catalog either way',
      refreshPayload.catalog?.models?.length >= 30,
      `ok=${refreshPayload.ok} error=${refreshPayload.error} models=${refreshPayload.catalog?.models?.length}`,
    )
    check(
      'a refresh that could not reach the service says so and reports no change',
      refreshPayload.ok === true
        || (refreshPayload.error === 'discovery-failed'
          && refreshPayload.catalog.counts.total >= 30
          && Array.isArray(refreshPayload.message) === false),
      JSON.stringify({ ok: refreshPayload.ok, error: refreshPayload.error }),
    )
    const refreshWrongMethod = await fetch(`http://127.0.0.1:${port}/opencode-go/refresh`)
    check('the refresh endpoint answers only POST', refreshWrongMethod.status === 405, String(refreshWrongMethod.status))

    // The row this page writes into. `configEditor.edit` refuses anything but
    // the exact object its own `entries()` returned, and it reads that row's
    // fields from `entry.options` — so the shape the page assumes is a fact
    // about this cordis version rather than about the plugin. The entry is
    // built here by the harness's own `Loader`, which is the only way to get
    // one: a bare `ctx.plugin()` has no Loader row at all.
    const { findEntry: locateRow } = await import(url(join(PLUGIN, 'lib/ui/bridge.js')))
    const { Loader } = await import(url(join(BUNDLE, '@deepseek-ai/cordis-plugin-loader/lib/index.js')))
    const loaderCtx = makeContext().ctx
    loaderCtx.plugin(Loader, { filename: join(CACHE, 'loader.yml') })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const loader = loaderCtx.get('loader')
    await loader.create({ id: 'opencode-go', name: 'dsh-opencode-go', config: { provider: 'opencode-go' } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    // `loader.entries()` is a generator; the editor's own `entries()` spreads it
    // into an array before filtering, which is the shape the bridge receives.
    const rows = [...loader.entries()]
    const loaded = rows.find((entry) => entry.options.id === 'opencode-go')
    check(
      'a real Loader row keeps its id and module name under `options`',
      loaded?.options?.id === 'opencode-go' && loaded?.options?.name === 'dsh-opencode-go',
      JSON.stringify({ id: loaded?.options?.id, name: loaded?.options?.name, top: Object.keys(loaded ?? {}).slice(0, 6) }),
    )
    check(
      'that row is found by its id, and by its module name when the id is not the route',
      locateRow(rows, 'opencode-go', loaded) === loaded
        && locateRow([loaded], 'some-other-id') === loaded
        && locateRow([{ options: { id: 'x', name: '@acme/other' } }], 'opencode-go') === undefined,
      `byId=${locateRow(rows, 'opencode-go', loaded) === loaded} byName=${locateRow([loaded], 'other') === loaded}`,
    )
    check(
      'a flat entry — the shape no Loader produces — is not mistaken for one',
      locateRow([{ id: 'opencode-go', name: 'dsh-opencode-go' }], 'opencode-go') === undefined,
    )

    // Usage is the one table only this plugin can produce: the harness reports
    // tokens to the caller, and nothing above the adapter knows which model a
    // token went to. Section 5 streamed a call through this route, so the table
    // this activation reads is another activation's record, loaded from disk.
    const usageResponse = await fetch(`http://127.0.0.1:${port}/opencode-go/usage?days=1`)
    const usageTable = await usageResponse.json()
    check(
      'the usage endpoint answers a table shaped for the window',
      usageResponse.status === 200
        && usageTable.ok === true
        && usageTable.window === 1
        && Array.isArray(usageTable.windows)
        && Array.isArray(usageTable.days),
      JSON.stringify({ window: usageTable.window, totals: usageTable.totals }),
    )
    check(
      'a call streamed earlier is in the table, with the tokens it reported',
      usageTable.totals.requests >= 1
        && usageTable.totals.totalTokens >= 10
        && usageTable.models.some((entry) => entry.model === 'glm-5.3' && entry.counters.totalTokens >= 10),
      JSON.stringify(usageTable.totals),
    )

    const catalog = await (await fetch(`http://127.0.0.1:${port}/opencode-go/models`)).json()
    check(
      'the catalog endpoint reports every model with its hidden reason',
      catalog.ok === true
        && catalog.hidden.includes('glm-5.3')
        && catalog.models.find((model) => model.id === 'glm-5.3')?.hiddenReason === 'configured'
        && catalog.models.find((model) => model.id === 'gpt-5.6-luna')?.hiddenReason === null,
      `hidden=[${catalog.hidden?.join(',')}] total=${catalog.counts?.total}`,
    )
    check(
      'the catalog endpoint counts what the runtime actually lists',
      catalog.counts.listed === catalog.models.filter((model) => !model.hidden).length
        && catalog.counts.total === catalog.models.length,
      JSON.stringify(catalog.counts),
    )
    // The page's promise and the runtime's behaviour are the same decision:
    // a model the page reports as hidden is one the harness does not offer,
    // and it stays callable.
    const listedThroughRuntime = await ctx.llm.listModels('opencode-go')
    check(
      'a hidden model is absent from the harness listing but still resolvable',
      !listedThroughRuntime.some((model) => model.id === 'glm-5.3')
        && (await ctx.llm.resolveModelInfo('opencode-go', 'glm-5.3'))?.id === 'glm-5.3',
      `listed=${listedThroughRuntime.length}`,
    )

    // A variant is a second entry for one model, and it has to work through
    // the same runtime a session uses: resolved by its own id, offered in the
    // listing, and called — while the wire still carries the base model.
    const variantInfo = await ctx.llm.resolveModelInfo('opencode-go', 'gpt-5.6-luna@chatty')
    check(
      'the harness resolves a variant as its own model',
      variantInfo?.id === 'gpt-5.6-luna@chatty'
        && variantInfo?.reasoning?.defaultEffort === 'low'
        && String(variantInfo?.description).includes('variant of gpt-5.6-luna'),
      `id=${variantInfo?.id} name=${variantInfo?.name} effort=${variantInfo?.reasoning?.defaultEffort}`,
    )
    check(
      'the variant is offered beside the model it varies',
      listedThroughRuntime.some((model) => model.id === 'gpt-5.6-luna@chatty')
        && listedThroughRuntime.some((model) => model.id === 'gpt-5.6-luna'),
      `variants=[${listedThroughRuntime.map((model) => model.id).filter((id) => id.includes('@')).join(',')}]`,
    )
  } finally {
    await fiber.dispose()
    await new Promise((resolve) => server.close(resolve))
  }
  check('unloading releases the settings-page route', routes.length === 0, `routes=${routes.length}`)
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} real-cordis checks passed`)
if (failed.length > 0) process.exitCode = 1
