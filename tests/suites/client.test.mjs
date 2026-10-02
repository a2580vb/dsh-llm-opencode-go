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
    useEffect: () => {},
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
  }
}

/** A client context stand-in recording the page's registrations. */
function fakeClientContext() {
  const state = { dictionaries: [], slotQueries: [], registrations: [], effects: [] }
  return {
    state,
    ctx: {
      effect: (callback) => {
        const disposer = callback()
        state.effects.push(disposer)
        return () => disposer?.()
      },
      locale: {
        register: (ns, dicts) => {
          state.dictionaries.push({ ns, dicts })
          return () => {}
        },
      },
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
        is(state.slotQueries.length, 1)
        is(state.slotQueries[0], 'plugins.row.config')
        is(state.registrations.length, 1)
        const options = state.registrations[0].options
        is(options.name, 'plugins.row.config')
        is(options.key, `${manifest.name}#${rowId}`)
        is(options.locale, 'opencodeGo')
        is(typeof state.registrations[0].component, 'function')
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
      name: 'every field the page writes is one the bridge manages',
      run() {
        const written = [...clientSource.matchAll(/saveField\('([^']+)'/g)].map((match) => match[1])
        ok(written.length >= 2, `the page writes its fields by name: ${written.join(', ')}`)
        for (const field of written) {
          ok(MANAGED_CONFIG_FIELDS.includes(field), `the bridge manages "${field}"`)
        }
        // Both shipped dictionaries must name every section the page renders,
        // so a translated page is never half-translated.
        for (const key of ['sectionKey', 'sectionModels', 'sectionVariants']) {
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
        const component = state.registrations[0].component
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
