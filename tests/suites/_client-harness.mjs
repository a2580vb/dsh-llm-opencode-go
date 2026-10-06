/**
 * A page renderer for the client bundle, good enough to click through a page.
 *
 * The bundle is a plain function of props plus React hooks, so a ~100-line hook
 * runtime is enough to render it for real in Node: no browser, no build step,
 * and no DOM. What it does not do is pretend to be React — it renders one tree
 * per surface and re-renders it when a setter or an effect changes something,
 * which is exactly as much as a test of the page's wiring needs.
 *
 * One bundle, many surfaces: the module is evaluated once and its factory
 * materialized once, the way the browser's module loader memoizes a package,
 * and each registered slot renders with its own hook store. That is what lets a
 * case see one surface's read reach another's — a harness that re-evaluated the
 * bundle per surface would give each of them a private copy of everything the
 * factory holds.
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
 * The bundle is evaluated once and its factory materialized once, as the
 * browser's module loader does per package, so the surfaces it registers share
 * whatever the factory built outside a component. Each registered slot then
 * gets its own hook store, which is what a component instance gets in React:
 * two surfaces rendered against one store would silently write into each
 * other's slots. They all share the same `fetch` recorder, so `calls` is the
 * whole picture in order, and one settle loop, so a change on one surface is
 * rendered everywhere before a case reads either of them.
 *
 * @param {object} options - how to build it.
 * @param {(path: string, init?: object) => Promise<object>} options.fetch - answers the page's own requests.
 * @param {string} [options.locale] - which shipped dictionary to translate with.
 * @param {object} [options.document] - the browser document, for the one thing the bundle reaches for it.
 */
export async function renderPage({ fetch: fetchImpl, locale = 'en', document } = {}) {
  const calls = []
  const locales = localeStore()

  /**
   * A clock the suite drives, because the page's behaviour is partly *when*.
   *
   * The bundle schedules two very different kinds of timer: a sub-second beat
   * after a write, which is a scheduling detail no case asserts, and intervals
   * measured in tens of seconds or minutes — the quota's own schedule — which
   * are the whole thing a case is checking. So delays up to
   * {@link IMMEDIATE_DELAY_MS} still run themselves, as they always have, and
   * anything longer waits for the case to move the clock with `advance`.
   */
  const clock = { value: Date.parse('2026-01-15T12:00:00.000Z'), nextId: 1, timers: new Map() }

  /** Delays at or under this many milliseconds still run on their own. */
  const IMMEDIATE_DELAY_MS = 1_000

  /** The `Date` the bundle sees: real behaviour, this clock's `now`. */
  class HarnessDate extends Date {
    static now() {
      return clock.value
    }
  }

  const runTimer = (id) => {
    const timer = clock.timers.get(id)
    if (timer === undefined) return
    clock.timers.delete(id)
    timer.callback(...timer.args)
  }

  /** Fire every timer due at or before the clock's current time. */
  const fireDue = () => {
    for (const [id, timer] of [...clock.timers].sort((left, right) => left[1].due - right[1].due)) {
      if (timer.due <= clock.value) runTimer(id)
    }
  }

  /** The module loader facade and the one fetch every surface shares. */
  const registrations = []
  const sandbox = {
    // Absent unless a case supplies one, exactly as it is in this process: the
    // bundle has to work with no DOM at all, and only the one entry that asks
    // the shell to open Settings ever looks for it.
    ...(document === undefined ? {} : { document }),
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
    setTimeout: (callback, delay = 0, ...args) => {
      if (delay <= IMMEDIATE_DELAY_MS) {
        setImmediate(callback, ...args)
        return 0
      }
      const id = clock.nextId
      clock.nextId += 1
      clock.timers.set(id, { callback, args, due: clock.value + delay })
      return id
    },
    // A no-op here is what a schedule cannot survive: the store rearms its own
    // interval on every answer, and a cancel it could not perform would leave the
    // previous one to fire into the new one.
    clearTimeout: (id) => {
      clock.timers.delete(id)
    },
    Date: HarnessDate,
    console,
  }
  vm.runInNewContext(`(function () { ${CLIENT_SOURCE} })()`, sandbox, { filename: 'lib/client.js' })

  /**
   * The hook store of the surface whose render is in flight.
   *
   * One store per surface, switched while that surface renders. A setter,
   * though, belongs to the surface that created it rather than to whoever
   * happens to be rendering when it fires — one surface's read publishes into
   * another's state, which is the whole point of a shared answer — so every
   * hook captures the store it came from.
   */
  let frame = undefined
  const rendering = () => {
    if (frame === undefined) throw new Error('a hook was called outside a render')
    return frame
  }

  /** Whether a hook's dependencies moved since the last render. */
  const changed = (before, now) => before === undefined || now === undefined
    || now.length !== before.length || now.some((value, index) => !Object.is(value, before[index]))

  /** Take the next slot of the rendering surface's hook store. */
  const slotFor = (initial) => {
    const store = rendering()
    const at = store.cursor
    store.cursor += 1
    const slot = store.hooks[at] ?? (store.hooks[at] = initial)
    return { store, slot }
  }

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
      const { store, slot } = slotFor({ value: typeof initial === 'function' ? initial() : initial })
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        store.dirty = true
      }]
    },
    useRef(initial) {
      return slotFor({ current: initial }).slot
    },
    useEffect(effect, deps) {
      const { store, slot } = slotFor({})
      if (changed(slot.deps, deps)) {
        slot.deps = deps
        store.pending.push(() => {
          slot.cleanup?.()
          slot.cleanup = effect()
        })
      }
    },
    useCallback(callback, deps) {
      const { slot } = slotFor({})
      if (changed(slot.deps, deps)) {
        slot.deps = deps
        slot.value = callback
      }
      return slot.value
    },
    useMemo(factory, deps) {
      const { slot } = slotFor({})
      if (changed(slot.deps, deps)) {
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

  /**
   * What `ctx.get` answers, and when.
   *
   * A test fills this in before `open`/`surface`, because the bundle reads the
   * optional services while it registers: `pluginNavigation` and `layout` are
   * present or absent for the whole page, exactly as they are in a deployment.
   */
  const optional = new Map()
  const services = { get: (key) => optional.get(key) }

  /** The slots the one materialized plugin registered, in registration order. */
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

  /** Render a node tree, one component at a time, as React would walk it. */
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

  /** Every surface a case can drive, in registration order. */
  const drivers = []

  /** Parse one registered slot into a surface with a hook store of its own. */
  const surfaceFor = (name) => {
    const entry = registered.get(name)
    if (entry === undefined) throw new Error(`the bundle registered no "${name}" surface`)
    const surface = {
      name,
      entry,
      store: { hooks: [], cursor: 0, pending: [], dirty: false },
      props: {},
      tree: null,
      started: false,
    }
    drivers.push(surface)
    return surface
  }

  /** Render one surface, then run the effects that render scheduled. */
  function renderSurface(surface) {
    frame = surface.store
    surface.store.cursor = 0
    surface.tree = expand(surface.entry.component(surface.props))
    frame = undefined
    const effects = surface.store.pending.splice(0, surface.store.pending.length)
    for (const effect of effects) effect()
  }

  /**
   * Render whatever changed, on every surface, until nothing is left pending.
   *
   * A setter on one surface — a listener answering another surface's read, for
   * one — only marks its own store dirty, so the loop looks at all of them
   * rather than at the one a case happens to be driving.
   */
  async function drain() {
    for (let pass = 0; pass < 50; pass += 1) {
      // The immediate work first: a timer a surface set inline, and the promise
      // chain it starts, both land before the next pass.
      fireDue()
      const working = drivers.filter((surface) => (
        surface.started && (surface.store.dirty || surface.store.pending.length > 0)
      ))
      for (const surface of working) {
        surface.store.dirty = false
        renderSurface(surface)
      }
      await settle()
      const pending = drivers.some((surface) => (
        surface.started && (surface.store.dirty || surface.store.pending.length > 0)
      ))
      if (working.length === 0 && !pending) break
    }
  }

  /**
   * Move the clock forward, running whatever the page scheduled on the way.
   *
   * The loop jumps to the next timer that is due rather than stepping: a schedule
   * whose intervals are tens of seconds would otherwise be walked a tick at a
   * time, and a case that advances half an hour would spend its life in this
   * function. Each firing happens *at* the time it was due, so a timer that
   * schedules its successor is walked one interval at a time and the count of
   * reads is exact rather than approximate.
   *
   * @param {number} milliseconds - how far to move.
   * @returns {Promise<void>} resolves once every surface has been re-rendered.
   */
  async function advance(milliseconds) {
    const target = clock.value + milliseconds
    for (let guard = 0; guard < 10_000; guard += 1) {
      const due = [...clock.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0]
      if (due === undefined) break
      const [id, timer] = due
      clock.value = Math.max(clock.value, timer.due)
      runTimer(id)
      await drain()
    }
    clock.value = target
    fireDue()
    await drain()
  }

  /** A case's handle on one surface: render it, drive it, read what it shows. */
  const driverFor = (surface) => ({
    options: surface.entry.options,
    component: surface.entry.component,
    hooks: surface.store.hooks,
    tree: () => surface.tree,
    /** Render with the props the shell would inject, plus `extra`. */
    async open(extra = {}) {
      // The shell composes a slot entry's props from its own `inject` payload
      // plus the framework seats; a surface that declares no `inject` simply
      // gets none of the former.
      const injected = typeof surface.entry.options.inject === 'function' ? surface.entry.options.inject() : {}
      surface.props = { ...injected, ...extra, t: locales.t(locale) }
      surface.started = true
      surface.store.dirty = false
      renderSurface(surface)
      await drain()
      return surface.tree
    },
    async update() {
      surface.store.dirty = false
      if (surface.started) renderSurface(surface)
      await drain()
      return surface.tree
    },
    /**
     * Take this surface off screen, running the effects that were cleaning up.
     *
     * A surface's unmount is where it stops holding whatever it was holding — the
     * quota's clock, for one — and a harness that could only mount would never
     * exercise that half of the pair. The hook store goes with it, as React's
     * does: a later `open` is a fresh mount with fresh state rather than a
     * resumed one, which is the difference between a panel being reopened and a
     * panel never having closed.
     */
    async close() {
      if (!surface.started) return surface.tree
      for (const slot of surface.store.hooks) {
        slot?.cleanup?.()
        if (slot !== undefined && slot !== null) delete slot.cleanup
      }
      surface.store.hooks.length = 0
      surface.store.pending.length = 0
      surface.store.dirty = false
      surface.started = false
      await drain()
      return surface.tree
    },
    async dispatch(handlerName, predicate, event = {}) {
      const node = find(surface.tree, predicate, (candidate) => typeof candidate.props[handlerName] === 'function')
      if (node === undefined) throw new Error(`no node with ${handlerName} matched in "${surface.name}"`)
      // A browser does not fire an event at a disabled control, so neither does
      // this: a test that presses one is asking for something a reader cannot
      // do, and it should hear about that rather than silently pass.
      if (node.props.disabled === true) {
        throw new Error(`the control matching the ${handlerName} predicate is disabled`)
      }
      node.props[handlerName]({ target: { value: node.props.value ?? '', checked: node.props.checked ?? false }, ...event })
      await drain()
      return surface.tree
    },
    async click(predicate) {
      return this.dispatch('onClick', predicate)
    },
    async change(predicate, value) {
      const checked = typeof value === 'boolean' ? value : undefined
      return this.dispatch('onChange', predicate, checked === undefined ? { target: { value } } : { target: { checked, value: '' } })
    },
  })

  /** Let the page's own promises finish. */
  async function settle() {
    for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  /**
   * The surfaces the bundle registered, keyed by slot name.
   *
   * Every child slot the shell dispatches through `renderSlot` arrives here:
   * a registered options object and the component it renders, each with its own
   * hook store so no two share cursors. The entry the page's own tests drive is
   * `plugins.row.config`.
   */
  const surfaces = new Map([...registered.keys()].map((name) => [name, driverFor(surfaceFor(name))]))
  const page = surfaces.get('plugins.row.config')

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
    /**
     * Move the page's clock forward, running what it scheduled on the way.
     *
     * This is how a case asks what the quota schedule *does*: the intervals are
     * tens of seconds to minutes, and nothing that long runs by itself.
     */
    advance,
    /** The page's clock, for a case that needs to read it. */
    clock,
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
