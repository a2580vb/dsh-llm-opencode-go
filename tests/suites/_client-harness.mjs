/**
 * A page renderer for the client bundle, good enough to click through a page.
 *
 * The bundle is a plain function of props plus React hooks, so a ~80-line hook
 * runtime is enough to render it for real in Node: no browser, no build step,
 * and no DOM. What it does not do is pretend to be React — it renders one tree
 * and re-renders it when a setter or an effect changes something, which is
 * exactly as much as a test of the page's wiring needs.
 *
 * Walk the result with {@link find}, drive it with {@link click}, and read the
 * text the reader would see with {@link text}.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
export const CLIENT_SOURCE = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')

/** The shape `createElement` produces, so a tree is walked the same way. */
const FRAGMENT = Symbol('Fragment')

/**
 * A locale store with the one method callers use.
 *
 * The bundle binds its own namespace and translates through that, so the stub
 * has to carry registered dictionaries and fill `{placeholders}` the way the
 * locale service does — otherwise every key would read as its own name and a
 * test could not tell a translated page from an unregistered one.
 *
 * @returns {{register: (ns: string, dicts: object) => () => void, bind: (ns: string) => Function, t: (locale?: string) => Function}} the store.
 */
export function localeStore() {
  const dictionaries = new Map()
  const translate = (locale) => (ns, key, params) => {
    const template = dictionaries.get(ns)?.[locale]?.[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
  }
  return {
    register: (ns, dicts) => {
      dictionaries.set(ns, dicts)
      return () => {}
    },
    bind: (ns) => (key, params) => translate('en')(ns, key, params),
    /** A translator for one shipped locale, for a test that asserts copy. */
    t: (locale = 'en') => (key, params) => translate(locale)('opencodeGo', key, params),
  }
}

/**
 * One "page", rendered.
 *
 * The bundle computes everything — its components included — at module
 * evaluation time, and its components read the React hooks the browser's module
 * table handed it. So a test needs one module instance, one hook store, and one
 * React stub per surface: a second surface rendered against the first one's
 * hooks would silently write into the first one's store. Each registered slot
 * therefore gets its own instance of the bundle, and they all share the same
 * `fetch` recorder, so `calls` is the whole picture in order.
 *
 * This is a page renderer rather than React: it renders one tree and re-renders
 * it when a setter or an effect changes something, which is exactly as much as a
 * test of the page's wiring needs. Walk the result with {@link find}, drive it
 * with {@link click}, and read the text the reader would see with {@link text}.
 *
 * @param {object} options - how to build it.
 * @param {(path: string, init?: object) => Promise<object>} options.fetch - answers the page's own requests.
 * @param {string} [options.locale] - which shipped dictionary to translate with.
 */
export async function renderPage({ fetch: fetchImpl, locale = 'en' } = {}) {
  const calls = []
  const locales = localeStore()

  /** The module loader facade and the one fetch every instance shares. */
  const sandboxFor = (registrations) => ({
    window: { __ModuleLoader__: { load: (entry) => registrations.push(entry) } },
    fetch: async (path, init) => {
      calls.push({ path, init })
      const answer = await fetchImpl(path, init)
      return {
        status: answer.status ?? 200,
        ok: (answer.status ?? 200) < 400,
        json: async () => answer.body,
      }
    },
    // The page waits a beat after a write for the plugin row to reload. That
    // beat is a scheduling detail rather than something to assert, so in a test
    // it is instantaneous: the re-reads a save triggers still happen, in order,
    // without the suite sleeping through them.
    setTimeout: (callback) => setImmediate(callback),
    clearTimeout: () => {},
    console,
  })

  /**
   * Evaluate the bundle once and register its slots.
   *
   * @param {Map<string, object>} services - what `ctx.get` answers: the optional
   * shell services (the shortcut registry, the panel controller, the plugins
   * page's navigation). A test fills this in before calling if it wants one.
   * @returns {{plugin: object, context: object, registered: Map<string, object>}} the instance.
   */
  function instantiate(services) {
    const registrations = []
    vm.runInNewContext(`(function () { ${CLIENT_SOURCE} })()`, sandboxFor(registrations), { filename: 'lib/client.js' })

    const hooks = []
    const pending = []
    let cursor = 0
    let dirty = false

    const React = {
      // `children` land in `props.children` exactly as React puts them there,
      // whichever way they were passed: positionally (`h(Wrapper, p, child)`) or
      // in the config (`h('button', { children })`). A wrapper component that
      // forwards its children is an ordinary pattern, and a harness that kept
      // them only in the element would drop them on the floor.
      createElement: (type, elementProps, ...children) => {
        const config = elementProps ?? {}
        const passed = children.length > 0
          ? children
          : Array.isArray(config.children)
            ? config.children
            : config.children === undefined || config.children === null ? [] : [config.children]
        const list = passed.flat(Infinity).filter((child) => (
          child !== null && child !== undefined && child !== false && child !== true
        ))
        return {
          type,
          props: {
            ...config,
            children: list.length === 0 ? undefined : list.length === 1 ? list[0] : list,
          },
          children: list,
        }
      },
      Fragment: FRAGMENT,
      useState(initial) {
        const slot = hooks[cursor] ?? (hooks[cursor] = { value: typeof initial === 'function' ? initial() : initial })
        cursor += 1
        return [slot.value, (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next
          dirty = true
        }]
      },
      useRef(initial) {
        const slot = hooks[cursor] ?? (hooks[cursor] = { current: initial })
        cursor += 1
        return slot
      },
      useEffect(effect, deps) {
        const slot = hooks[cursor] ?? (hooks[cursor] = {})
        cursor += 1
        if (slot.deps === undefined || deps === undefined
          || deps.length !== slot.deps.length || deps.some((value, index) => !Object.is(value, slot.deps[index]))) {
          slot.deps = deps
          pending.push(() => {
            slot.cleanup?.()
            slot.cleanup = effect()
          })
        }
      },
      useCallback(callback, deps) {
        const slot = hooks[cursor] ?? (hooks[cursor] = {})
        cursor += 1
        if (slot.deps === undefined || deps === undefined
          || deps.length !== slot.deps.length || deps.some((value, index) => !Object.is(value, slot.deps[index]))) {
          slot.deps = deps
          slot.value = callback
        }
        return slot.value
      },
      useMemo(factory, deps) {
        const slot = hooks[cursor] ?? (hooks[cursor] = {})
        cursor += 1
        if (slot.deps === undefined || deps === undefined
          || deps.length !== slot.deps.length || deps.some((value, index) => !Object.is(value, slot.deps[index]))) {
          slot.deps = deps
          slot.value = factory()
        }
        return slot.value
      },
    }

    const plugin = registrations[0].factory((name) => {
      if (name === 'react') return React
      throw new Error(`the bundle required "${name}"`)
    })

    const registered = new Map()
    plugin.apply({
      effect: (callback) => {
        const disposer = callback()
        return () => disposer?.()
      },
      locale: locales,
      get: (key) => services.get(key),
      slots: {
        inject: (key, callback) => callback(),
        register: (options, component) => {
          registered.set(options.name, { options, component })
          return () => {}
        },
      },
    })
    return { plugin, registered, hooks, pending, getCursor: () => cursor, setCursor: (v) => { cursor = v }, isDirty: () => dirty, clearDirty: () => { dirty = false } }
  }

  /** Parse a bundle body for one surface, with its own slots and hook store. */
  const instanceFor = (name, services) => {
    const instance = instantiate(services)
    const entry = instance.registered.get(name)
    if (entry === undefined) throw new Error(`the bundle registered no "${name}" surface`)
    /** Render a node tree, remembering whether anything changed. */
    const expand = (node) => {
      if (node === null || node === undefined || node === false || node === true) return null
      if (Array.isArray(node)) return node.map(expand).filter((child) => child !== null)
      if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
      if (typeof node.type === 'function') {
        if (node.type === FRAGMENT) return expand(node.children)
        // `props.children` already carries what this element was given, so a
        // component is called with the props React would hand it.
        return expand(node.type(node.props))
      }
      return { type: node.type, props: node.props, children: node.children.map(expand).filter((child) => child !== null) }
    }
    let tree = null
    let props = {}
    /** Render, then let every effect and setter settle. */
    async function render() {
      for (let pass = 0; pass < 50; pass += 1) {
        instance.setCursor(0)
        tree = expand(entry.component(props))
        const effects = instance.pending.splice(0, instance.pending.length)
        for (const effect of effects) effect()
        await settle()
        if (!instance.isDirty() && effects.length === 0) break
        instance.clearDirty()
      }
      return tree
    }
    return {
      options: entry.options,
      component: entry.component,
      hooks: instance.hooks,
      tree: () => tree,
      /** Render with the props the shell would inject, plus `extra`. */
      async open(extra = {}) {
        // The shell composes a slot entry's props from its own `inject` payload
        // plus the framework seats; a surface that declares no `inject` simply
        // gets none of the former.
        const injected = typeof entry.options.inject === 'function' ? entry.options.inject() : {}
        props = { ...injected, ...extra, t: locales.t(locale) }
        instance.clearDirty()
        return render()
      },
      async update() {
        instance.clearDirty()
        return render()
      },
      async dispatch(handlerName, predicate, event = {}) {
        const node = find(tree, predicate, (candidate) => typeof candidate.props[handlerName] === 'function')
        if (node === undefined) throw new Error(`no node with ${handlerName} matched in "${name}"`)
        // A browser does not fire an event at a disabled control, so neither does
        // this: a test that presses one is asking for something a reader cannot
        // do, and it should hear about that rather than silently pass.
        if (node.props.disabled === true) {
          throw new Error(`the control matching the ${handlerName} predicate is disabled`)
        }
        node.props[handlerName]({ target: { value: node.props.value ?? '', checked: node.props.checked ?? false }, ...event })
        await settle()
        return render()
      },
      async click(predicate) {
        return this.dispatch('onClick', predicate)
      },
      async change(predicate, value) {
        const checked = typeof value === 'boolean' ? value : undefined
        return this.dispatch('onChange', predicate, checked === undefined ? { target: { value } } : { target: { checked, value: '' } })
      },
    }
  }

  /** Let the page's own promises finish. */
  async function settle() {
    for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  /**
   * What `ctx.get` answers, and when.
   *
   * A test fills this in before `open`/`surface`, because the bundle reads the
   * optional services while it registers: `pluginNavigation` and `layout` are
   * present or absent for the whole instance, exactly as they are in a
   * deployment.
   */
  const optional = new Map()
  const services = { get: (key) => optional.get(key) }

  /**
   * The surfaces the bundle registered, keyed by slot name.
   *
   * Every child slot the shell dispatches through `renderSlot` arrives here:
   * a registered options object and the component it renders, each with its own
   * module instance so no two share a hook store. The entry the page's own tests
   * drive is `plugins.row.config`.
   */
  const page = instanceFor('plugins.row.config', services)
  const surfaces = new Map([['plugins.row.config', page]])
  const names = [...instantiate(services).registered.keys()]
  for (const name of names) {
    if (name === 'plugins.row.config') continue
    surfaces.set(name, instanceFor(name, services))
  }

  const t = locales.t(locale)

  return {
    tree: () => page.tree(),
    calls,
    /** The registered surfaces, keyed by slot name. */
    surfaces,
    /** The optional services `ctx.get` answers: fill in before opening a surface. */
    optional,
    /** A driver for one registered slot, rendered on its own. */
    surface: (name) => {
      const driver = surfaces.get(name)
      if (driver === undefined) throw new Error(`the bundle registered no "${name}" surface`)
      return driver
    },
    /** Render the page with a translator and a view, as the Plugins page does. */
    async open(view = 'page') {
      return page.open({ view })
    },
    /** Re-render after something changed. */
    async update() {
      return page.update()
    },
    /** Fire one event at the first node matching `predicate`, then settle. */
    async dispatch(handlerName, predicate, event = {}) {
      return page.dispatch(handlerName, predicate, event)
    },
    /** Click the first node matching `predicate`. */
    async click(predicate) {
      return page.click(predicate)
    },
    /** Type into, or toggle, the first node matching `predicate`. */
    async change(predicate, value) {
      return page.change(predicate, value)
    },
  }
}

/**
 * Every node of an expanded tree, depth first, keeping each node's ancestors.
 *
 * @param {object} tree - an expanded tree from {@link renderPage}.
 * @returns {readonly {node: object, path: readonly object[]}[]} the matches.
 */
export function nodes(tree) {
  const found = []
  const walk = (node, path) => {
    if (node === null) return
    found.push({ node, path })
    for (const child of node.children ?? []) walk(child, [...path, node])
  }
  walk(tree, [])
  return found
}

/**
 * The first node whose props satisfy `predicate`.
 *
 * @param {object} tree - an expanded tree.
 * @param {(node: object) => boolean} predicate - what to match.
 * @param {(node: object) => boolean} [extra] - an additional requirement.
 * @returns {object | undefined} the match.
 */
export function find(tree, predicate, extra = () => true) {
  for (const { node } of nodes(tree)) {
    if (node.type !== undefined && predicate(node) && extra(node)) return node
  }
  return undefined
}

/** The text of a subtree, in the order a reader would read it. */
export function text(node) {
  if (node === null || node === undefined) return ''
  if (node.text !== undefined) return node.text
  return (node.children ?? []).map(text).join(' ')
}

/** Every button label in a subtree. */
export function buttons(node) {
  return nodes(node)
    .filter(({ node: candidate }) => candidate.type === 'button')
    .map(({ node: candidate }) => text(candidate).trim())
}

/** Every cell of the first table matching `predicate`, as rows of strings. */
export function rows(node, predicate = () => true) {
  const table = find(node, (candidate) => candidate.type === 'table' && predicate(candidate))
  if (table === undefined) return []
  return nodes(table)
    .filter(({ node: candidate }) => candidate.type === 'tr')
    .map(({ node: candidate }) => (candidate.children ?? [])
      .filter((child) => child.type === 'td' || child.type === 'th')
      .map((cell) => text(cell).trim()))
}

/** Every table in a subtree, in the order it was rendered. */
export function tables(node) {
  return nodes(node)
    .filter(({ node: candidate }) => candidate.type === 'table')
    .map(({ node: candidate }) => candidate)
}
