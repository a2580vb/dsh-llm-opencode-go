/**
 * The browser half: the plugin's own configuration page.
 *
 * A Node process cannot render the page, but it can check the two contracts the
 * page's wiring depends on and that no browser would report as a failure until
 * a user opens it:
 *
 *   - the bundle registers the factory id, slot key, and dictionary the Plugins
 *     page dispatches, with both shipped locales complete;
 *   - the endpoints it calls are exactly the endpoints the Host bridge serves,
 *     and its slot key is the bundle patch's own `<package>#<row>` pair.
 *
 * The bundle is a classic script, so it is compiled and run in a `node:vm`
 * sandbox whose `window` is the module-loader facade — the same shape the
 * browser's boot script provides.
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { MANAGED_CONFIG_FIELDS, UI_ROUTES } from '../../lib/ui/bridge.js'
import { equal, includes, is, ok } from '../helpers.mjs'

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const clientSource = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')
const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')

/** Compile the bundle in a sandbox and return the factory it registered. */
function loadBundle() {
  const registrations = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          registrations.push(entry)
        },
      },
    },
  }
  vm.runInNewContext(`(function () { ${clientSource} })()`, sandbox, { filename: 'lib/client.js' })
  return { registrations, factory: registrations[0]?.factory, entry: registrations[0] }
}

/** A React stand-in: the bundle only needs `createElement` at wiring time. */
function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props, children })
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: () => [undefined, () => {}],
    useRef: () => ({ current: undefined }),
    useEffect: () => {},
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
  }
}

/** A locale stand-in: the bundle registers a dictionary and binds its namespace. */
function fakeLocale(state) {
  const dictionaries = new Map()
  return {
    register: (ns, dicts) => {
      state.dictionaries.push({ ns, dicts })
      dictionaries.set(ns, dicts)
      return () => {}
    },
    bind: (ns) => (key, params) => {
      const template = dictionaries.get(ns)?.en?.[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
    },
  }
}

/**
 * A client context stand-in recording the bundle's registrations.
 *
 * `services` answers `ctx.get`, which is how the bundle reaches the optional
 * shell services (the shortcut registry, the panel controller, the plugins
 * page's navigation). A test hands in a map to make one of them present, or
 * nothing at all to exercise the profile that lacks them.
 */
function fakeClientContext(services = new Map()) {
  const state = { dictionaries: [], slotQueries: [], registrations: [], effects: [], shortcuts: [] }
  return {
    state,
    ctx: {
      effect: (callback) => {
        const disposer = callback()
        state.effects.push(disposer)
        return () => disposer?.()
      },
      get: (key) => services.get(key),
      locale: fakeLocale(state),
      slots: {
        inject: (key, callback) => {
          state.slotQueries.push(key)
          callback()
          return () => {}
        },
        register: (options, component) => {
          state.registrations.push({ options, component })
          return () => {}
        },
      },
    },
  }
}

/** The registered entry for one slot, by the slot's own name. */
function entryFor(state, name) {
  return state.registrations.find((registration) => registration.options.name === name)
}

export default {
  name: 'client bundle',
  cases: [
    {
      name: 'the bundle registers one factory under the package name',
      run() {
        const { registrations, entry } = loadBundle()
        is(registrations.length, 1)
        is(entry.id, manifest.name)
        is(typeof entry.factory, 'function')
      },
    },
    {
      name: 'the manifest declares the client half the module system loads',
      run() {
        is(manifest.dsh?.client?.platform, 'web')
        is(manifest.dsh?.client?.immediately, true)
        is(manifest.exports['./client'], './lib/client.js')
      },
    },
    {
      name: 'the factory builds a plugin that asks for the services it uses',
      run() {
        const { factory } = loadBundle()
        const plugin = factory(fakeRequire())
        ok(plugin.inject.includes('slots'), 'slots')
        ok(plugin.inject.includes('locale'), 'locale')
        is(typeof plugin.apply, 'function')
      },
    },
    {
      name: 'the page registers into the row slot keyed by the bundle patch pair',
      run() {
        const rowId = /-\s*id:\s*(\S+)/.exec(patch)?.[1]
        ok(rowId !== undefined, 'the patch declares a row id')
        const { factory } = loadBundle()
        const { ctx, state } = fakeClientContext()
        factory(fakeRequire()).apply(ctx)
        ok(state.slotQueries.includes('plugins.row.config'), 'the row slot is filled')
        const entry = entryFor(state, 'plugins.row.config')
        is(entry.options.key, `${manifest.name}#${rowId}`)
        is(entry.options.locale, 'opencodeGo')
        is(typeof entry.component, 'function')
      },
    },
    {
      name: 'every entry the panel needs is registered, under one id',
      run() {
        // The quota row selects a central panel by id, and the main slot
        // dispatches on the same string. Two ids that drifted apart would give a
        // click that does nothing, which no type check and no build step would
        // report.
        const { factory } = loadBundle()
        const { ctx, state } = fakeClientContext()
        factory(fakeRequire()).apply(ctx)
        const capsule = entryFor(state, 'sidebar.footer.action')
        const panel = entryFor(state, 'main')
        ok(capsule !== undefined, 'the sidebar foot holds the capsule')
        ok(panel !== undefined, 'the central panel is registered')
        is(panel.options.key, capsule.options.id)
        is(typeof capsule.options.label, 'function')
        for (const entry of [capsule, panel]) {
          is(entry.options.locale, 'opencodeGo')
          is(typeof entry.component, 'function')
        }
        // The settings tab reuses the same sections rather than re-fetching
        // them, so it carries a component too.
        ok(entryFor(state, 'settings.plugins.tab') !== undefined, 'the settings tab is registered')
        // The sidebar keeps no row of ours: one number, one door. The panel is
        // reached from the capsule and from the keyboard instead.
        is(entryFor(state, 'sidebar.panellist'), undefined)
      },
    },
    {
      name: 'the settings navigation carries the plugin\'s page, under an id of its own',
      run() {
        // Settings renders one nav row per entry and dispatches by id, so an id
        // that collided with a shipped page would take over that page's cell
        // rather than add a row beside it.
        const { factory } = loadBundle()
        const { ctx, state } = fakeClientContext()
        factory(fakeRequire()).apply(ctx)
        const section = entryFor(state, 'settings.section')
        ok(section !== undefined, 'the plugin contributes a Settings page')
        is(section.options.id, 'opencode-go')
        is(section.options.locale, 'opencodeGo')
        ok(typeof section.options.label === 'function', 'it names itself through the shared dictionary')
        ok(typeof section.options.order === 'number', 'and takes a place in the navigation')

        // The configuration page is one component under both doors: the row on
        // the Plugins page and this nav row. A second copy of it is what would
        // let an edit reach only one of them.
        const row = entryFor(state, 'plugins.row.config')
        is(section.component, row.component,
          'the Settings page renders the page the Plugins row does, not a copy of it')
      },
    },
    {
      name: 'the shortcut is registered for every platform the shell accepts',
      run() {
        const { factory } = loadBundle()
        const registered = []
        const services = (commands) => new Map([['shortcuts', {
          register: (command) => {
            commands.push(command)
            return () => {}
          },
        }]])
        const commands = []
        const { ctx } = fakeClientContext(services(commands))
        factory(fakeRequire()).apply(ctx)
        is(commands.length, 1)
        const command = commands[0]
        is(command.id, 'opencode-go.usage')
        is(typeof command.label, 'function')
        ok(Array.isArray(command.regions) && command.regions.length > 0, 'the command names the regions it answers in')
        // The registry rejects reserved and browser-hostile bindings by throwing
        // for the whole registration, so each declared default is checked here
        // against the rules it enforces: a browser binding needs the primary
        // modifier plus `alt` or `shift`, and a desktop binding needs a modifier
        // at all.
        const profiles = Object.keys(command.defaults)
        ok(profiles.includes('desktop:macos') && profiles.includes('web:macos'), 'both runtimes are covered')
        for (const [profile, binding] of Object.entries(command.defaults)) {
          const modifiers = binding.modifiers ?? []
          ok(modifiers.length > 0, `${profile} carries a modifier`)
          ok(binding.code === 'KeyU', `${profile} binds the key this command documents`)
          if (!profile.startsWith('web:')) continue
          const shared = modifiers.filter((modifier) => modifier === 'primary' || modifier === 'alt' || modifier === 'shift')
          ok(shared.length === modifiers.length && shared.length >= 2,
            `${profile} is a binding the browser registry allows, got ${modifiers.join('+')}`)
          ok(!modifiers.includes('meta') || modifiers.includes('primary'), `${profile} spells the platform modifier as primary`)
        }

        // Pressing it navigates, and where the shell has no panel controller it
        // is blocked instead of throwing.
        const opened = []
        const withLayout = []
        const layoutCtx = fakeClientContext(new Map([
          ['shortcuts', { register: (command2) => { withLayout.push(command2); return () => {} } }],
          ['layout', { selectPanel: (id) => opened.push(id) }],
        ]))
        factory(fakeRequire()).apply(layoutCtx.ctx)
        is(withLayout.length, 1)
        const resolution = withLayout[0].resolve({ modal: null, region: 'page' })
        is(resolution.status, 'handled')
        equal(opened, [entryFor(layoutCtx.state, 'main').options.key])

        const withoutLayout = []
        const bareCtx = fakeClientContext(new Map([
          ['shortcuts', { register: (command2) => { withoutLayout.push(command2); return () => {} } }],
        ]))
        factory(fakeRequire()).apply(bareCtx.ctx)
        is(withoutLayout[0].resolve({ modal: null, region: 'page' }).status, 'blocked')
      },
    },
    {
      name: 'the settings entry is offered only where there is a route to the page',
      run() {
        // This process has no DOM, and this context has no `pluginNavigation`,
        // so neither route exists and the entry has to disappear rather than
        // point at nothing. (The other route — the settings dialog, which the
        // page reaches through the shell's own command — needs a document, and
        // is covered where a render harness can supply one.)
        const { factory } = loadBundle()
        const plugin = factory(fakeRequire())
        const bare = fakeClientContext()
        plugin.apply(bare.ctx)
        const barePanel = entryFor(bare.state, 'main')
        is(JSON.stringify(Object.keys(barePanel.options.inject()).sort()), JSON.stringify(['t']))

        const opened = []
        const withPage = fakeClientContext(new Map([['pluginNavigation', { openBundle: (name) => opened.push(name) }]]))
        plugin.apply(withPage.ctx)
        const panel = entryFor(withPage.state, 'main')
        const capsule = entryFor(withPage.state, 'sidebar.footer.action')
        for (const entry of [panel, capsule]) {
          const props = entry.options.inject()
          is(typeof props.openSettings, 'function')
          props.openSettings()
        }
        equal(opened, [manifest.name, manifest.name])
      },
    },
    {
      name: 'the panel capsule opens the panel rather than a copy of it',
      run() {
        const { factory } = loadBundle()
        const opened = []
        const layout = { selectPanel: (id) => opened.push(id) }
        const { ctx, state } = fakeClientContext(new Map([['layout', layout]]))
        factory(fakeRequire()).apply(ctx)
        const props = entryFor(state, 'sidebar.footer.action').options.inject()
        is(typeof props.openUsage, 'function')
        is(props.openUsage(), true)
        is(opened.length, 1)
        // The capsule and the icon must name the panel the main slot answers to.
        is(opened[0], entryFor(state, 'main').options.key)
      },
    },
    {
      name: 'the dictionary covers both shipped locales with the same keys',
      run() {
        const { factory } = loadBundle()
        const { ctx, state } = fakeClientContext()
        factory(fakeRequire()).apply(ctx)
        is(state.dictionaries.length, 1)
        const { ns, dicts } = state.dictionaries[0]
        is(ns, 'opencodeGo')
        const zh = Object.keys(dicts.zh ?? {}).sort()
        const en = Object.keys(dicts.en ?? {}).sort()
        ok(zh.length > 15, `a real dictionary, got ${zh.length} keys`)
        is(JSON.stringify(zh), JSON.stringify(en), 'both locales carry the same keys')
        ok(Object.values(dicts.zh).every((value) => typeof value === 'string' && value !== ''), 'no empty copy')
        ok(Object.values(dicts.en).every((value) => typeof value === 'string' && value !== ''), 'no empty copy')
      },
    },
    {
      name: 'no dictionary key is written but never read',
      run() {
        // A key nothing looks up is a small lie: it reads as a feature that
        // exists. The locales agree on their keys, so a key both of them carry
        // and no code names would otherwise pass every check here.
        const { factory } = loadBundle()
        const { ctx, state } = fakeClientContext()
        factory(fakeRequire()).apply(ctx)
        const { dicts } = state.dictionaries[0]
        // Everything outside the two dictionary literals is what could read a
        // key, so the literals themselves are cut out before the search.
        const zhStart = clientSource.indexOf('zh: {')
        const enStart = clientSource.indexOf('\n      en: {')
        const dictEnd = clientSource.indexOf('\n    }', enStart)
        const code = clientSource.slice(0, zhStart) + clientSource.slice(dictEnd)
        const dead = Object.keys(dicts.en).filter((key) => !new RegExp(`t\\('${key}'`).test(code))
        // Keys the page reaches through a computed name: the reason string is
        // built from a `reason`, and the two helpers below return key names.
        const computed = ['subscriptionReason', 'subscriptionWindow', 'saveField']
        const unexplained = dead.filter((key) => {
          const helper = key.replace(/^(subscriptionReason|subscriptionWindow).*$/, '$1')
          return !computed.includes(helper)
            // A key passed to `report`/`saveField` by name is read by t() there.
            && !new RegExp(`'${key}'`).test(code)
        })
        equal(unexplained, [], unexplained.join(', '))
        ok(Object.keys(dicts.en).length > 100, 'the dictionary is the real one')
      },
    },
    {
      name: 'every endpoint the page calls is served by the bridge',
      run() {
        // The two halves agree on the paths by construction: the page's own
        // table must name exactly the bridge's routes, under the same keys.
        const block = /const ROUTES = \{([\s\S]*?)\n\s*\}/.exec(clientSource)?.[1]
        ok(block !== undefined, 'the page declares its ROUTES table')
        const declared = {}
        for (const match of block.matchAll(/(\w+):\s*'([^']+)'/g)) declared[match[1]] = `/${match[2]}`
        equal(
          Object.entries(declared).sort(),
          Object.entries(UI_ROUTES).map(([key, path]) => [key, path]).sort(),
        )
        ok(!/\bfetch\(\s*['"`]/.test(clientSource), 'fetch is never called with a literal target')
        ok(!clientSource.includes('/api'), 'the page does not reach another host surface')
      },
    },
    {
      name: 'the managed fields are the ones the page offers to write',
      run() {
        // `MANAGED_CONFIG_FIELDS` is the lock on the write path: the bridge
        // refuses any other name, so a field added to the page and not to that
        // list is a control that answers `field-not-editable` — a broken button,
        // which is the one kind of bug a rendered page cannot show you.
        //
        // (The two that pair up are checked here too, because the schedule
        // reaches the write path as a single call rather than through
        // `saveField`, which is what the sibling case scans for.)
        for (const field of [...MANAGED_CONFIG_FIELDS]) {
          ok(clientSource.includes(field), `the page names the managed field "${field}"`)
        }
        // And the docs promise a reader can edit them, so a field that stops
        // being documented is a table that has quietly stopped describing the page.
        for (const file of ['docs/configuration.md', 'docs/configuration.zh-CN.md']) {
          const text = readFileSync(join(ROOT, file), 'utf8')
          for (const field of ['subscriptionMinIntervalSeconds', 'subscriptionMaxIntervalSeconds']) {
            ok(text.includes(field), `${file} names ${field} where it describes the page`)
          }
        }
      },
    },
    {
      name: 'the documented endpoints are the ones the bridge actually serves',
      run() {
        // The page's surface is documented for anyone reading it with `curl`,
        // and a table that drifts from the code is worse than no table: a
        // renamed route would be described as working while answering 404.
        for (const file of ['docs/configuration.md', 'docs/configuration.zh-CN.md']) {
          const text = readFileSync(join(ROOT, file), 'utf8')
          const documented = [...new Set([...text.matchAll(/\/opencode-go\/[a-z]+/g)].map((match) => match[0]))].sort()
          equal(documented, Object.values(UI_ROUTES).sort(), `${file} documents every route`)
          for (const route of Object.values(UI_ROUTES)) {
            ok(text.includes(`| \`${route}\` |`), `${file} documents ${route} in a table row`)
          }
        }
      },
    },
    {
      name: 'every field the page writes is one the bridge manages',
      run() {
        const written = [...clientSource.matchAll(/saveField\('([^']+)'/g)].map((match) => match[1])
        ok(written.length >= 2, `the page writes its fields by name: ${written.join(', ')}`)
        for (const field of written) {
          ok(MANAGED_CONFIG_FIELDS.includes(field), `the bridge manages "${field}"`)
        }
        // The schedule is the one section that writes two fields at once, so it
        // does not go through `saveField` and would be invisible to the scan
        // above — which is exactly the hole a scan for one pattern leaves.
        const paired = [...clientSource.matchAll(/subscription(?:Min|Max)IntervalSeconds: /g)]
        ok(paired.length >= 2, 'the schedule writes both intervals by name')
        for (const field of ['subscriptionMinIntervalSeconds', 'subscriptionMaxIntervalSeconds']) {
          ok(MANAGED_CONFIG_FIELDS.includes(field), `the bridge manages "${field}"`)
        }
        // Both shipped dictionaries must name every section the page renders,
        // so a translated page is never half-translated.
        for (const key of ['sectionKey', 'sectionModels', 'sectionVariants', 'sectionSchedule']) {
          ok(clientSource.includes(`${key}:`), `the dictionary has ${key}`)
        }
      },
    },
    {
      name: 'the summary view renders without fetching anything',
      run() {
        const { factory } = loadBundle()
        const { ctx, state } = fakeClientContext()
        factory(fakeRequire()).apply(ctx)
        const component = entryFor(state, 'plugins.row.config').component
        const calls = []
        const originalFetch = globalThis.fetch
        globalThis.fetch = (...args) => {
          calls.push(args)
          throw new Error('the summary view must not fetch')
        }
        try {
          const rendered = component({ view: 'summary', t: (key) => key })
          ok(rendered !== undefined && rendered !== null, 'the summary rendered')
        } finally {
          globalThis.fetch = originalFetch
        }
        is(calls.length, 0)
      },
    },
    {
      name: 'the page reads usage through the endpoint the Host serves',
      run() {
        includes(clientSource, 'usage: \'opencode-go/usage\'')
        // The window travels as a query parameter and is built from the
        // component's own state, so the page can only ever ask for a window it
        // offers. Which endpoints exist is checked above, where the bundle's
        // table is compared with the bridge's.
        includes(clientSource, '`${ROUTES.usage}?days=${String(days)}`')
        ok(!clientSource.includes('days=365'), 'no unbounded window is ever requested')
      },
    },
    {
      name: 'the bundle keeps no dependency outside the platform module table',
      run() {
        const requested = [...clientSource.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
        ok(requested.length > 0, 'the bundle requires React')
        for (const specifier of requested) {
          ok(specifier === 'react', `only the platform table is used, found "${specifier}"`)
        }
      },
    },
  ],
}

/** The `require` the browser module system hands a factory. */
function fakeRequire() {
  const react = fakeReact()
  return (specifier) => {
    if (specifier === 'react') return react
    throw new Error(`the client bundle requested "${specifier}", which is not a platform module`)
  }
}
