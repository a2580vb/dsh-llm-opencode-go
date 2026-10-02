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
 * One page, rendered.
 *
 * @param {object} options - how to build it.
 * @param {(path: string, init?: object) => Promise<object>} options.fetch - answers the page's own requests.
 * @param {string} [options.locale] - which shipped dictionary to translate with.
 */
export async function renderPage({ fetch: fetchImpl, locale = 'en' } = {}) {
  const registrations = []
  const dictionaries = []
  const calls = []
  const sandbox = {
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
  }
  vm.runInNewContext(`(function () { ${CLIENT_SOURCE} })()`, sandbox, { filename: 'lib/client.js' })

  const hooks = []
  const pending = []
  let cursor = 0
  let dirty = false
  let props = {}

  const React = {
    createElement: (type, elementProps, ...children) => ({
      type,
      props: elementProps ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }),
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

  const slot = {
    register(options, component) {
      registered = { options, component }
      return () => {}
    },
  }
  let registered
  plugin.apply({
    effect: (callback) => {
      const disposer = callback()
      return () => disposer?.()
    },
    locale: { register: (ns, dicts) => dictionaries.push({ ns, dicts }) },
    slots: { inject: (key, callback) => callback(), register: slot.register },
  })
  if (registered === undefined) throw new Error('the bundle registered no page')

  /** The dictionary, with `{placeholders}` filled in the way the locale service does. */
  const dictionary = dictionaries[0]?.dicts?.[locale] ?? {}
  const t = (key, params) => {
    const template = dictionary[key]
    if (template === undefined) return key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
  }

  /**
   * Expand function components into the elements they render.
   *
   * The hook list is one flat array for the whole tree rather than one per
   * component: traversal order is stable for a stable tree, which is all these
   * tests need, and it keeps the runtime short enough to read.
   */
  function expand(node) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (Array.isArray(node)) return node.map(expand).filter((child) => child !== null)
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
    if (typeof node.type === 'function') {
      if (node.type === FRAGMENT) return expand(node.children)
      return expand(node.type(node.props))
    }
    return { type: node.type, props: node.props, children: node.children.map(expand).filter((child) => child !== null) }
  }

  let tree = null

  /** Render, then let every effect and setter settle. */
  async function render() {
    for (let pass = 0; pass < 50; pass += 1) {
      cursor = 0
      tree = expand(registered.component(props))
      const effects = pending.splice(0, pending.length)
      for (const effect of effects) effect()
      await settle()
      if (!dirty && effects.length === 0) break
      dirty = false
    }
    return tree
  }

  /** Let the page's own promises finish. */
  async function settle() {
    for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  return {
    tree: () => tree,
    calls,
    /** Render the page with a translator and a view, as the Plugins page does. */
    async open(view = 'page') {
      props = { view, t }
      dirty = false
      await render()
      return tree
    },
    /** Re-render after something changed. */
    async update() {
      dirty = false
      await render()
      return tree
    },
    /**
     * Fire one event at the first node matching `predicate`, then settle.
     *
     * `handlerName` is the prop that handles it (`onClick`, `onChange`), and
     * `event` is what the handler expects to read off the event.
     */
    async dispatch(handlerName, predicate, event = {}) {
      const node = find(tree, predicate, (candidate) => typeof candidate.props[handlerName] === 'function')
      if (node === undefined) throw new Error(`no node with ${handlerName} matched`)
      // A browser does not fire an event at a disabled control, so neither does
      // this: a test that presses one is asking for something a reader cannot
      // do, and it should hear about that rather than silently pass.
      if (node.props.disabled === true) {
        throw new Error(`the control matching the ${handlerName} predicate is disabled`)
      }
      node.props[handlerName]({ target: { value: node.props.value ?? '', checked: node.props.checked ?? false }, ...event })
      await settle()
      await render()
      return tree
    },
    /** Click the first node matching `predicate`. */
    async click(predicate) {
      return this.dispatch('onClick', predicate)
    },
    /** Type into, or toggle, the first node matching `predicate`. */
    async change(predicate, value) {
      const checked = typeof value === 'boolean' ? value : undefined
      return this.dispatch('onChange', predicate, checked === undefined ? { target: { value } } : { target: { checked, value: '' } })
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
