/**
 * The configuration page, rendered and driven.
 *
 * The bundle-level suite next door checks the wiring a browser would only
 * complain about at runtime; this one goes further and actually runs the page:
 * it renders the component the slot receives, clicks its controls, and reads
 * what a person would see. A page that fetches the wrong endpoint, forgets to
 * re-read after a write, or reports a failure in the Host's vocabulary fails
 * here rather than in someone's browser.
 */

import { buttons, find, nodes, renderPage, rows, tables, text } from './_client-harness.mjs'
import { equal, is, ok } from '../helpers.mjs'

/** The catalog the page reads, small enough to reason about. */
const CATALOG = {
  ok: true,
  source: 'discover',
  fetchedAt: 1_767_225_600_000,
  counts: { total: 3, listed: 2, hidden: 1, hiddenByTraining: 0, variants: 1 },
  models: [
    {
      id: 'glm-5.3', name: 'GLM 5.3', hidden: false, hiddenReason: undefined, trainingGated: false,
      protocols: ['chat-completions'], reasoning: true, efforts: ['low', 'high'], defaultEffort: 'low', variants: [],
    },
    { id: 'glm-5.3@fast', name: 'GLM 5.3 (fast)', hidden: false, hiddenReason: undefined, trainingGated: false, protocols: ['chat-completions'], variant: { model: 'glm-5.3', name: 'fast' } },
    { id: 'space-bunny-free', name: 'Space Bunny Free', hidden: true, hiddenReason: 'configured', trainingGated: false, protocols: ['chat-completions'] },
  ],
  hidden: ['space-bunny-free'],
  variants: [{ model: 'glm-5.3', name: 'fast', id: 'glm-5.3@fast' }],
  variantsWithoutModel: [],
}
const STATE = {
  ok: true,
  route: { provider: 'opencode-go', baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY' },
  credential: { configured: true, source: 'store', writable: true, removable: true },
  environment: { key: 'OPENCODE_GO_API_KEY', present: false },
  config: {
    editable: true,
    fields: ['apiKeyEnv', 'hiddenModels', 'modelVariants', 'freshConnectionOnLargeBody', 'timeoutMs', 'streamIdleTimeoutMs', 'retryPolicy', 'showQuotaCapsule', 'showRetiredModels', 'subscriptionMinIntervalSeconds', 'subscriptionMaxIntervalSeconds', 'usageNumberFormat'],
    // What the row resolves to, which is what the schedule and transport
    // sections edit. The real bridge always reports these, so a fixture without
    // them would test a page nobody is served.
    values: {
      subscriptionMinIntervalSeconds: 30,
      subscriptionMaxIntervalSeconds: 1_800,
      usageNumberFormat: 'compact',
      freshConnectionOnLargeBody: true,
      timeoutMs: 180_000,
      streamIdleTimeoutMs: 90_000,
      showQuotaCapsule: true,
      showRetiredModels: true,
      retryPolicy: {
        mode: 'normal',
        maxRetries: 5,
        retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
        initialDelayMs: 500,
        maxDelayMs: 10_000,
        jitterRatio: 0.1,
      },
    },
    override: {},
  },
}

/**
 * A usage table with one model's calls.
 *
 * The counters carry a cache read so the hit rate has something to divide: the
 * prompt is 400 uncached + 100 cached = 500, which is a 20% hit rate. The
 * per-model and per-day rows carry the cache figures too, because a cache you
 * cannot attribute to a model or a day is a number without a use.
 */
const CACHED = { requests: 4, failures: 1, inputTokens: 400, outputTokens: 100, totalTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 20, cacheReported: 4 }
const USAGE = {
  ok: true,
  window: 7,
  numberFormat: 'compact',
  today: '2026-01-15',
  windows: [1, 7, 30, 'all'],
  days: [{ day: '2026-01-15', counters: { ...CACHED } }],
  historyDays: [{ day: '2026-01-15', counters: { ...CACHED } }],
  models: [{ model: 'glm-5.3', counters: { ...CACHED } }],
  totals: { ...CACHED },
  firstDay: '2026-01-15',
  retentionDays: null,
  retention: ['2026-01-15'],
}

/** The subscription's own quota, as the service meters it. */
const SUBSCRIPTION = {
  ok: true,
  cached: true,
  fetchedAt: 1768516800000,
  windows: [
    { name: 'rolling', status: 'ok', percent: 8, resetsAt: '2026-01-16T00:00:00.000Z' },
    { name: 'weekly', status: 'ok', percent: 42, resetsAt: '2026-01-19T00:00:00.000Z' },
    { name: 'monthly', status: 'ok', percent: 91, resetsAt: '2026-02-01T00:00:00.000Z' },
  ],
}

/**
 * A Host that answers from one table of endpoints, recording every request.
 *
 * A configuration write is remembered, because the real bridge persists an
 * override and reports it on the next state read: a fixture that kept answering
 * its original table would make every save look like a row that never reloaded.
 * A case that wants to simulate exactly that wraps this fixture and answers the
 * state read itself.
 */
function host(overrides = {}) {
  const values = structuredClone(STATE.config.values)
  return async (path, init) => {
    const [name, query] = String(path).split('?')
    if (name === 'opencode-go/state') {
      const state = structuredClone(STATE)
      state.config.values = structuredClone(values)
      return { body: state, ...overrides.state }
    }
    if (name === 'opencode-go/models') return { body: CATALOG, ...overrides.models }
    if (name === 'opencode-go/usage') {
      const days = Number(new URLSearchParams(query).get('days'))
      return { body: { ...USAGE, window: days }, ...overrides.usage }
    }
    if (name === 'opencode-go/config') {
      if (init?.method === 'POST') Object.assign(values, JSON.parse(init.body).set)
      return { body: { ok: true, config: { override: {} } }, ...overrides.config }
    }
    if (name === 'opencode-go/credential') return { body: { ok: true }, ...overrides.credential }
    if (name === 'opencode-go/refresh') return { body: { ok: true, discovered: 3, added: [], removed: [], catalog: CATALOG }, ...overrides.refresh }
    if (name === 'opencode-go/subscription') {
      return { body: { ...SUBSCRIPTION, minIntervalSeconds: 30, maxIntervalSeconds: 1_800, cached: query === 'refresh=1' ? false : true }, ...overrides.subscription }
    }
    // The probe the page's schedule asks instead of reading: in memory on the
    // Host, and false unless a case says something was spent.
    if (name === 'opencode-go/activity') {
      return { body: { ok: true, activity: false, minIntervalSeconds: 30, maxIntervalSeconds: 1_800 }, ...overrides.activity }
    }
    throw new Error(`the page called an endpoint the Host does not serve: ${name}`)
  }
}

/**
 * A Host whose configuration write is remembered.
 *
 * The real bridge persists an override and reports it on the next state read; a
 * fixture that kept answering its original table would let a page write a value
 * and then read the old one back, which is not what the bridge does — and a case
 * that checks a toggle sticks needs the value to stick. The fixture is cloned
 * per case, so one case's write never reaches another's. `refuse` answers true
 * to make the next configuration write fail.
 *
 * @param {object} [options] - how the Host behaves.
 * @param {object} [options.values] - configuration values to start from.
 * @param {() => boolean} [options.refuse] - whether the next write is refused.
 * @returns {{state: object, fetch: (path: string, init?: object) => Promise<object>}} the Host.
 */
function statefulHost({ values = {}, refuse = () => false } = {}) {
  const state = structuredClone(STATE)
  Object.assign(state.config.values, values)
  const base = host()
  return {
    state,
    fetch: async (path, init) => {
      const answer = await base(path, init)
      // A bridge answer is JSON over the wire, so every read is a fresh object
      // graph; handing back the same mutable table would let a component's
      // `useMemo` over it miss the write the page just made.
      if (String(path) === 'opencode-go/state') return { ...answer, body: structuredClone(state) }
      if (String(path) === 'opencode-go/config' && init?.method === 'POST') {
        if (refuse()) return { status: 400, body: { ok: false, message: 'the setting is read-only' } }
        Object.assign(state.config.values, JSON.parse(init.body).set)
      }
      return answer
    },
  }
}

/** The usage requests the page made, as window numbers or `all`. */
const windowsAsked = (calls) => calls
  .filter((call) => call.path.startsWith('opencode-go/usage'))
  .map((call) => {
    const days = new URLSearchParams(String(call.path).split('?')[1]).get('days')
    return days === 'all' ? days : Number(days)
  })

/** The button whose label is `label`. */
const button = (tree, label) => {
  const match = nodes(tree).find(({ node }) => node.type === 'button' && text(node).trim() === label)
  return match?.node
}

/** The preference group that contains a particular option. */
const choiceGroup = (label) => {
  if (['Full numbers', 'Show units'].includes(label)) return 'Number format'
  if (['10 per page', '30 per page', '100 per page'].includes(label)) return 'Days per page'
  return 'Range'
}

/** The DSH-style menu trigger for the group containing `label`. */
const choice = (tree, label) => find(tree, (node) => node.type === 'button'
  && node.props['aria-haspopup'] === 'menu' && node.props['aria-label'] === choiceGroup(label))

/** Open a preference menu and choose one of its rows. */
const choose = async (surface, label) => {
  await surface.click((node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu'
    && node.props['aria-label'] === choiceGroup(label))
  return surface.click((node) => node.type === 'button' && node.props.role === 'menuitem' && text(node).trim() === label)
}

/** The group carrying one heading, scoped so two groups with a Save cannot clash. */
function group(tree, heading) {
  return find(tree, (node) => node.type === 'section' && text(node).includes(heading))
}

/** The schedule group, which saves when its fields lose focus. */
function scheduleSection(tree) {
  const section = group(tree, 'Quota refresh')
  ok(section !== undefined, 'the schedule section rendered')
  return section
}

/** The schedule's two boxes, as `{ label, value }`, in the order they appear. */
const scheduleBoxes = (section) => nodes(section)
  .filter(({ node }) => node.type === 'input' && node.props.type === 'number')
  .map(({ node }) => ({ label: node.props['aria-label'], value: node.props.value }))

/** The transport group, also committed by leaving its fields. */
function transportSection(tree) {
  const section = group(tree, 'Transport and retries')
  ok(section !== undefined, 'the transport section rendered')
  return section
}

/** The transport section's number boxes, as `{ label, value }`, in order. */
const transportBoxes = (section) => nodes(section)
  .filter(({ node }) => node.type === 'input' && node.props.type === 'number')
  .map(({ node }) => ({ label: node.props['aria-label'], value: node.props.value }))

/** The large-body switch: a button whose checked state is its aria state. */
const transportSwitch = (section) => nodes(section)
  .find(({ node }) => node.type === 'button' && node.props.role === 'switch')?.node

/** The capsule display group: the one switch that hides the sidebar foot. */
function capsuleSection(tree) {
  const section = group(tree, 'Sidebar capsule')
  ok(section !== undefined, 'the capsule section rendered')
  return section
}

/** The capsule display switch, found the same way as the transport row's. */
const capsuleSwitch = (section) => nodes(section)
  .find(({ node }) => node.type === 'button' && node.props.role === 'switch')?.node

/** The models group, the one card that commits a draft with a Save press. */
function modelsSection(tree) {
  const section = group(tree, 'Choose which models appear')
  ok(section !== undefined, 'the models section rendered')
  return section
}

/** The usage and history group: the quota panel and this route's counters. */
function usageSection(tree) {
  const section = group(tree, 'Usage and history')
  ok(section !== undefined, 'the usage section rendered')
  return section
}

/** A counters block whose totals are all zero. */
const NO_CALLS = {
  requests: 0,
  failures: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheReported: 0,
}

/** The variants editor nested in the models card. */
function variantsSection(tree) {
  const section = group(tree, 'A variant fixes a model')
  ok(section !== undefined, 'the variants section rendered')
  return section
}

/** Click a control found in one group, without matching its twin elsewhere. */
async function clickIn(page, root, predicate) {
  const node = find(root, predicate)
  ok(node !== undefined, 'the control is on screen')
  return page.dispatch('onClick', (candidate) => candidate === node)
}

/** Open a selector and press one of its options. */
async function pick(page, label, option) {
  await page.click((node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu'
    && node.props['aria-label'] === label)
  return page.click((node) => node.type === 'button' && node.props?.role === 'menuitem'
    && text(node).trim() === option)
}

/** Leave a field, which is what commits a scalar setting. */
async function blurIn(page, label) {
  return page.dispatch('onBlur', (node) => node.type === 'input' && node.props['aria-label'] === label)
}

/**
 * A minimal DOM node: enough of one to be searched, climbed, and clicked.
 *
 * Only what the bundle actually reaches for is here. A stand-in that pretended
 * to be a browser would be a second thing to keep true; this one is a tree, a
 * `textContent`, and the two attributes this plugin and the shell agree on.
 */
function domNode(tag, { text = '', attributes = {}, onClick } = {}) {
  const node = {
    tag,
    textContent: text,
    attributes,
    children: [],
    parentElement: null,
    getAttribute: (name) => (name in node.attributes ? node.attributes[name] : null),
    click: () => onClick?.(),
    append(child) {
      child.parentElement = node
      node.children.push(child)
      return child
    },
    querySelectorAll: (selector) => descendants(node).filter((candidate) => matches(candidate, selector)),
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    },
  }
  return node
}

/** Every node under one, depth first. */
function descendants(root) {
  const found = []
  const walk = (node) => {
    for (const child of node.children) {
      found.push(child)
      walk(child)
    }
  }
  walk(root)
  return found
}

/**
 * Whether one node answers a selector.
 *
 * A tiny grammar instead of the four selectors this plugin happens to use
 * today: `tag` and any number of `[name]` / `[name="value"]` parts, plus the
 * descendant form `nav button` the shell's nav rows are found with. Anything
 * else throws, so a selector this stand-in cannot model is a loud failure rather
 * than a silent mismatch.
 */
function parseSelector(selector) {
  if (selector === 'nav button') return { descendant: true, tag: 'button', parentTag: 'nav', attributes: [] }
  const match = /^([a-z]*)((?:\[[^\]]+\])*)$/.exec(selector)
  if (match === null) throw new Error(`the stand-in document cannot model the selector "${selector}"`)
  const attributes = [...match[2].matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)]
    .map((part) => ({ name: part[1], value: part[2] }))
  if (attributes.length === 0 && match[1] === '') {
    throw new Error(`the stand-in document cannot model the selector "${selector}"`)
  }
  return { descendant: false, tag: match[1] === '' ? undefined : match[1], attributes }
}

/** Whether one node answers a selector, per {@link parseSelector}. */
function matches(node, selector) {
  const parsed = typeof selector === 'string' ? parseSelector(selector) : selector
  if (parsed.descendant) {
    return node.tag === parsed.tag && node.parentElement?.tag === parsed.parentTag
  }
  if (parsed.tag !== undefined && node.tag !== parsed.tag) return false
  return parsed.attributes.every(({ name, value }) => (
    name in node.attributes && (value === undefined || node.attributes[name] === value)
  ))
}

/**
 * A stand-in for the shell's own Settings control and the dialog it mounts.
 *
 * This is the whole reason the entry can reach the page in one step: the dialog
 * has no service behind it, so the only honest way in is the control a reader
 * presses. Both shapes the shell can have are modelled, because they need
 * different numbers of presses:
 *
 *  - `launcher: false` — the sidebar renders the shell's own trigger, which
 *    carries the shortcut itself, so it is on screen and one press opens the
 *    dialog;
 *  - `launcher: true` — the account package has taken the launcher seat, so the
 *    trigger is a menu button and the *Settings* row is not in the DOM until the
 *    menu is open. That row is the one carrying the shortcut.
 *
 * The layout mirrors the shell's: the capsule and the launcher/trigger are
 * siblings inside the sidebar's foot, which is what lets the plugin climb from
 * its own capsule instead of knowing a class name.
 *
 * @param {object} input - how the shell behaves.
 * @param {string[]} input.pressed - collects the nav rows that were pressed.
 * @param {boolean} [input.launcher] - whether the account launcher replaces the trigger.
 * @param {boolean} [input.trigger] - whether the shell renders an opener at all.
 * @param {boolean} [input.opens] - whether the opener actually opens the dialog.
 * @param {string} [input.shortcut] - the aria the shell publishes for `settings.open`.
 * @param {string} [input.rowLabel] - the label the shell projects onto this plugin's row.
 */
function settingsShell({
  pressed,
  launcher = false,
  trigger = true,
  opens = true,
  shortcut = 'Ctrl+,',
  rowLabel = 'OpenCode Go',
  menuRowsBeforeSettings = 0,
}) {
  const capsule = domNode('div', { attributes: { 'data-opencode-go-capsule': '' } })
  const footerActions = domNode('div').append(capsule)
  const settingsArea = domNode('div')
  const opened = () => {
    if (opens) dialog.parentElement = document.body
  }
  let clicks = 0
  let menuClicks = 0
  let menuItems = []
  if (trigger && !launcher) {
    settingsArea.append(domNode('button', {
      attributes: { 'aria-haspopup': 'dialog', 'aria-keyshortcuts': shortcut },
      onClick: () => {
        clicks += 1
        opened()
      },
    }))
  }
  if (trigger && launcher) {
    settingsArea.append(domNode('button', {
      attributes: { 'aria-haspopup': 'menu', 'aria-label': 'Account menu' },
      onClick: () => {
        menuClicks += 1
        // The menu's rows mount into a portal with the list, so they are only
        // in the document while it is open — which is why the item cannot be
        // the first thing pressed.
        if (menuItems.length === 0) {
          // The launcher seat is a public extension point: whatever package
          // takes it brings its own rows, and only the shell's *Settings* row
          // carries the shortcut. `menuRowsBeforeSettings` models a seat whose
          // rows come before it, which is what makes the position useless and
          // the shortcut the thing that identifies the row.
          for (let index = 0; index < menuRowsBeforeSettings; index += 1) {
            menuItems.push(domNode('button', {
              attributes: { role: 'menuitem' },
              text: `Another row ${index + 1}`,
              onClick: () => pressed.push('other'),
            }))
          }
          menuItems.push(domNode('button', {
            attributes: { role: 'menuitem', 'aria-keyshortcuts': shortcut },
            text: 'Settings',
            onClick: () => {
              clicks += 1
              opened()
            },
          }))
          for (const item of menuItems) document.body.append(item)
        }
      },
    }))
  }
  const nav = domNode('nav')
  // The shell's own pages come first, so pressing the wrong row is a real
  // mistake rather than a harmless one: this plugin's row is found by its label,
  // not by being the first button in the ledger.
  nav.append(domNode('button', { text: 'General', onClick: () => pressed.push('general') }))
  nav.append(domNode('button', {
    text: `  ${rowLabel}  `,
    onClick: () => pressed.push('row'),
  }))
  const dialog = domNode('div', { attributes: { 'data-shortcut-modal': 'settings' } })
  dialog.append(nav)
  const document = {
    body: domNode('body'),
    querySelectorAll: (selector) => descendants(document.body).filter((node) => matches(node, selector)),
    querySelector(selector) {
      if (selector === '[data-shortcut-modal="settings"]') {
        return dialog.parentElement === null ? null : dialog
      }
      return this.querySelectorAll(selector)[0] ?? null
    },
  }
  document.body.append(domNode('div').append(footerActions))
  document.body.append(settingsArea)
  return {
    document,
    triggered: () => clicks,
    menuOpened: () => menuClicks,
    dialogOpen: () => dialog.parentElement !== null,
  }
}

/** The quota bars of one surface, as the share each one shows as spent. */
const bars = (tree) => nodes(tree)
  .filter(({ node }) => node.props?.role === 'progressbar')
  .map(({ node }) => node.props['aria-valuenow'])

/** What the capsule prints, window by window. */
const figures = (tree) => nodes(tree)
  .filter(({ node }) => node.props?.style?.fontVariantNumeric === 'tabular-nums')
  .map(({ node }) => text(node))

/**
 * The calls figure of the first counters table inside a section.
 *
 * The three surfaces that draw the counters frame them differently, so a case
 * finds the block by a word its heading carries and reads the totals row.
 */
const countersTotal = (tree, sectionText) => {
  const section = find(tree, (node) => node.type === 'section' && text(node).includes(sectionText))
  const [totals] = tables(section)
  return rows(totals)[1]?.[1]
}

export default {
  name: 'client page',
  cases: [
    {
      name: 'opening the page reads every endpoint it needs, the subscription included',
      async run() {
        const page = await renderPage({ fetch: host() })
        await page.open()
        // Every endpoint, and the order they start in: the quota's read is armed
        // by the hook that draws it, so it leaves before the page's own effect
        // — and the counters are read by their section, which is drawn only once
        // the page knows it has a row to configure.
        equal(page.calls.map((call) => call.path.split('?')[0]), [
          // The provider's own quota is read once on open. It is not forced,
          // so opening the page does not spend a request inside the cache
          // window the Host keeps for it.
          'opencode-go/subscription',
          'opencode-go/state',
          'opencode-go/models',
          'opencode-go/usage',
        ])
        // The window is explicit and is the default one, so the page never
        // depends on the Host guessing what it meant.
        equal(windowsAsked(page.calls), [7])
        is(page.calls.some((call) => call.path.includes('refresh=1')), false)
      },
    },
    {
      name: 'a bridge that cannot be reached fails the page instead of hanging it',
      async run() {
        // A rejected fetch has no status to report: the page shows the transport
        // sentence and a retry, and no read is left as an unhandled rejection.
        let reachable = false
        const base = host()
        const page = await renderPage({
          fetch: async (path, init) => {
            if (!reachable) throw new Error('fetch failed')
            return base(path, init)
          },
        })
        const rejections = []
        const onRejection = (reason) => rejections.push(reason)
        process.on('unhandledRejection', onRejection)
        let failed
        try {
          failed = await page.open()
          await new Promise((resolve) => setImmediate(resolve))
        } finally {
          process.off('unhandledRejection', onRejection)
        }
        equal(rejections.map((reason) => String(reason?.message ?? reason)), [], 'no read is left unhandled')
        ok(text(failed).includes('Could not read the plugin state: Could not reach the local bridge'), text(failed))
        is(text(failed).includes('Loading'), false, 'the page is not left on Loading')
        is(text(failed).includes('HTTP'), false, 'no status is invented for a transport failure')
        ok(buttons(failed).includes('Retry'), 'the failed read offers a retry')

        reachable = true
        const recovered = await page.click((node) => node.type === 'button' && text(node).trim() === 'Retry')
        ok(text(recovered).includes('Choose which models appear'), 'the retry reads the page once the bridge answers')
      },
    },
    {
      name: 'the ways a state read can fail are named apart from one another',
      async run() {
        // An HTTP failure, a Host refusal on an HTTP 200, a malformed envelope,
        // and a transport rejection are four different facts. Each one leaves a
        // retryable error state, and only the HTTP failure prints a status.
        const cases = [
          ['an HTTP failure', { status: 500, body: { ok: false, error: 'internal' } },
            'Could not read the plugin state: Request failed (HTTP 500).'],
          ['an HTTP failure with a message', { status: 500, body: { ok: false, message: 'the profile is unreadable' } },
            'Could not read the plugin state: the profile is unreadable'],
          ['a Host refusal on HTTP 200', { body: { ok: false } },
            'Could not read the plugin state: The local bridge reported a failure.'],
          ['a malformed answer', { body: { ok: true } },
            'Could not read the plugin state: The local bridge returned an unrecognized response.'],
          ['a malformed route container', { body: { ok: true, route: [], config: {} } },
            'Could not read the plugin state: The local bridge returned an unrecognized response.'],
        ]
        for (const [label, answer, expected] of cases) {
          const page = await renderPage({
            fetch: async (path, init) => {
              if (String(path) === 'opencode-go/state') return answer
              return host()(path, init)
            },
          })
          const tree = await page.open()
          ok(text(tree).includes(expected), `${label}: ${text(tree).slice(0, 200)}`)
          is(text(tree).includes('Loading'), false, `${label}: the read settled`)
          ok(buttons(tree).includes('Retry'), `${label}: a retry is offered`)
        }
      },
    },
    {
      name: 'the usage tables carry the figures, with the window that is showing',
      async run() {
        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        const section = find(tree, (node) => node.type === 'section' && text(node).includes('Usage'))
        ok(section !== undefined, 'the usage section rendered')

        // The quota is one bar per window rather than a table: it is a share of
        // a whole, and a share reads as a length before it reads as a number.
        // The tables left are the counters this plugin kept itself.
        const bars = nodes(section).filter(({ node }) => node.props?.role === 'progressbar')
        equal(bars.map(({ node }) => node.props['aria-valuenow']), [8, 42, 91])

        const [totalsTable, modelTable, dayTable] = tables(section)
        // All three tables share one column set, so a reader who has learned one
        // has learned the rest -- including the cache columns, which used to
        // appear only on the totals row.
        const columns = [
          'Total', 'Calls', 'Failed', 'Uncached input', 'Output tokens',
          'Cache read', 'Cache write', 'Hit rate', 'Total tokens',
        ]
        const totals = rows(totalsTable)
        equal(totals[0], columns)
        equal(totals[1], ['Total', '4', '1', '400', '100', '100', '20', '20%', '500'], totals[1].join(','))
        const byModel = rows(modelTable)
        equal(byModel[0], ['Model', ...columns.slice(1)])
        equal(byModel[1], ['glm-5.3', '4', '1', '400', '100', '100', '20', '20%', '500'], byModel[1].join(','))
        const byDay = rows(dayTable)
        equal(byDay[0], ['Day', ...columns.slice(1)])
        equal(byDay[1], ['2026-01-15', '4', '1', '400', '100', '100', '20', '20%', '500'], byDay[1].join(','))

        // The range uses the DSH menu trigger and a rounded, right-aligned menu.
        const range = choice(tree, '30 days')
        is(range.props.value, '7')
        is(range.props['aria-label'], 'Range')
        is(range.props.style.background, 'var(--dsw-alias-bg-module-platform)')
        const opened = await page.click((node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu'
          && node.props['aria-label'] === 'Range')
        const menu = find(opened, (node) => node.props?.role === 'menu' && node.props['aria-label'] === 'Range')
        is(menu.props.style.borderRadius, 'var(--dsw-radius-lg)')
        is(menu.props.style.right, 0)
        equal(nodes(menu).filter(({ node }) => node.props?.role === 'menuitem').map(({ node }) => text(node).trim()),
          ['Today', '7 days', '30 days', 'All history'])
      },
    },
    {
      name: 'token figures default to units and the chosen number format is persisted',
      async run() {
        const large = {
          requests: 4,
          failures: 1,
          inputTokens: 1_250_000,
          outputTokens: 2_500_000_000_000,
          cacheReadTokens: 1_200,
          cacheWriteTokens: 1_500_000_000,
          cacheReported: 4,
          totalTokens: 2_501_501_251_200,
        }
        let savedFormat = 'compact'
        const base = host({
          usage: {
            body: {
              ...USAGE,
              totals: large,
              models: [{ model: 'glm-5.3', counters: large }],
              days: [{ day: '2026-01-15', counters: large }],
            },
          },
        })
        const fetch = async (path, init) => {
          if (path === 'opencode-go/config' && init?.method === 'POST') {
            savedFormat = JSON.parse(init.body).set.usageNumberFormat
          }
          const answer = await base(path, init)
          if (String(path).startsWith('opencode-go/usage')) {
            return { ...answer, body: { ...answer.body, numberFormat: savedFormat } }
          }
          return answer
        }
        const usageSection = (root) => find(root, (node) => node.type === 'section' && text(node).includes('Usage'))
        const compactRow = ['Total', '4', '1', '1.25M', '2.5T', '1.2K', '1.5B', '0%', '2.5T']
        const fullRow = ['Total', '4', '1', '1250000', '2500000000000', '1200', '1500000000', '0%', '2501501251200']
        const page = await renderPage({ fetch })
        const tree = await page.open()
        equal(rows(tables(usageSection(tree))[0])[1], compactRow, 'units are the default')
        is(choice(tree, 'Show units').props.value, 'true')

        const fullValue = nodes(tables(usageSection(tree))[0]).find(({ node }) => node.type === 'span'
          && text(node) === '2.5T' && node.props.title === '2501501251200')
        ok(fullValue !== undefined, 'the shortened total carries its full value as a tooltip')
        is(fullValue.node.props['aria-label'], '2501501251200', 'and as its accessible name')

        const fullTree = await choose(page, 'Full numbers')
        equal(rows(tables(usageSection(fullTree))[0])[1], fullRow)
        is(choice(fullTree, 'Show units').props.value, 'false')
        const writes = page.calls.filter((call) => call.path === 'opencode-go/config')
        equal(writes.map((call) => JSON.parse(call.init.body).set), [{ usageNumberFormat: 'full' }])
        equal(windowsAsked(page.calls), [7], 'changing the format does not re-read the counters')

        const reopened = await renderPage({ fetch })
        const reopenedTree = await reopened.open()
        equal(rows(tables(usageSection(reopenedTree))[0])[1], fullRow, 'the saved format survives reopening')
        const shortenedTree = await choose(reopened, 'Show units')
        equal(rows(tables(usageSection(shortenedTree))[0])[1], compactRow)
        is(savedFormat, 'compact')

        const failing = await renderPage({
          fetch: async (path, init) => {
            if (path === 'opencode-go/config') {
              return { status: 400, body: { ok: false, message: 'the setting is read-only' } }
            }
            return base(path, init)
          },
        })
        await failing.open()
        const failedTree = await choose(failing, 'Full numbers')
        is(choice(failedTree, 'Show units').props.value, 'true', 'a failed write rolls the display back')
        ok(text(failedTree).includes('Could not save the number format: the setting is read-only'), text(failedTree))
      },
    },
    {
      name: 'each window is a bar whose two segments are the spent and the remaining share',
      async run() {
        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        const section = find(tree, (node) => node.type === 'section' && text(node).includes('Usage'))

        // The bar is the track; its label, figures, and reset time are the row
        // around it, which is what a reader actually reads.
        const bars = nodes(section)
          .filter(({ node }) => node.props?.role === 'progressbar')
          .map(({ node, path }) => ({ track: node, row: path[path.length - 1] }))
        equal(bars.length, 3, 'one bar per metered window')
        equal(bars.map(({ track }) => track.props['aria-label']), ['Rolling', 'Weekly', 'Monthly'])
        equal(bars.map(({ track }) => track.props['aria-valuenow']), [8, 42, 91])

        for (const { track, row } of bars) {
          const used = track.props['aria-valuenow']
          const [spent, remaining] = track.children
          // The two segments are complements, so the bar cannot claim a share
          // was both spent and kept: it is `used` from the left, the rest after.
          is(spent.props.style.width, `${used}%`, 'the spent share is the value')
          is(remaining.props.style.width, `${100 - used}%`, 'and the remainder is the rest')
          // Both colours come from theme tokens, never from a literal, so the
          // bar follows the theme it happens to be rendered in.
          for (const [name, segment] of [['spent', spent], ['remaining', remaining]]) {
            const colour = String(segment.props.style.background)
            ok(colour.includes('var(--dsw-alias-'), `${name} is a theme token: ${colour}`)
            ok(!/#[0-9a-f]{3,6}\b|rgba?\(/i.test(colour), `${name} is not a literal colour: ${colour}`)
          }
          ok(String(spent.props.style.background).includes('state-idle'), 'spent is the theme grey')
          ok(String(remaining.props.style.background).includes('state-success'), 'remaining is the theme green')
          // A bar whose meaning is its hue needs a text equivalent, or it says
          // nothing to a reader who cannot see it.
          const spoken = String(track.props['aria-valuetext'])
          ok(
            spoken.includes(`${String(used)}% used`) && spoken.includes(`${String(100 - used)}% left`),
            spoken,
          )
          // And the visible figures say the same thing, because most readers
          // will read these rather than the bar.
          const said = text(row).replace(/\s+/g, ' ')
          ok(said.includes(`${String(used)}% used`) && said.includes(`${String(100 - used)}% left`), said)
        }

        // The window a reader is closest to losing is the one worth noticing,
        // so its figure carries the warning colour rather than the ordinary one.
        const figure = (row, value) => nodes(row).find(({ node }) => node.type === 'span' && text(node) === value)
        const warning = figure(bars[2].row, '91% used')
        ok(warning !== undefined, 'the figure behind the bar is rendered')
        is(warning.node.props?.style?.color, 'var(--dsw-alias-state-warn-primary)')
        const ordinary = figure(bars[0].row, '8% used')
        ok(ordinary !== undefined, 'the figure of an ordinary window is rendered too')
        is(ordinary.node.props?.style?.color, undefined, 'and it is not coloured')

        // The legend names the two colours, so grey and green do not have to be
        // guessed at.
        ok(text(section).replace(/\s+/g, ' ').includes('Used Remaining'), 'the legend names both shares')

        // A refresh is the only thing that spends a request on the provider,
        // and it says so in the query rather than relying on the Host.
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Re-read quota')
        const subscriptions = page.calls.filter((call) => call.path.startsWith('opencode-go/subscription'))
        is(subscriptions.length, 2)
        is(subscriptions[1].path.includes('refresh=1'), true, subscriptions[1].path)
      },
    },
    {
      name: 'a gateway without the quota endpoint says so without losing the local counters',
      async run() {
        const page = await renderPage({
          fetch: host({ subscription: { body: { ok: false, reason: 'unsupported' } } }),
        })
        const tree = await page.open()
        const section = find(tree, (node) => node.type === 'section' && text(node).includes('Usage'))
        ok(
          text(section).includes('this service or gateway does not serve it'),
          text(section).slice(0, 400),
        )
        // The counters the plugin kept itself are still the answer to what this
        // route spent, so they stay on screen.
        ok(text(section).includes('2026-01-15'), 'the per-day table is still rendered')
        const [totalsTable] = tables(section)
        equal(rows(totalsTable)[1][1], '4')
      },
    },
    {
      name: 'choosing a window reads that window and keeps it showing',
      async run() {
        const page = await renderPage({ fetch: host() })
        await page.open()
        await choose(page, '30 days')
        equal(windowsAsked(page.calls), [7, 30])
        // The table itself follows the window it was read for, rather than
        // whatever the Host answered first.
        const section = find(page.tree(), (node) => node.type === 'section' && text(node).includes('Usage'))
        ok(text(section).includes('2026-01-15'), 'the table is still on screen')
        is(choice(page.tree(), '30 days').props.value, '30')
      },
    },
    {
      name: 'all history asks for every recorded day rather than a numeric window',
      async run() {
        const historyDays = [
          { day: '2025-11-01', counters: { ...CACHED, requests: 2, totalTokens: 250 } },
          { day: '2026-01-15', counters: { ...CACHED } },
        ]
        const history = {
          ...USAGE,
          window: 'all',
          days: historyDays,
          historyDays,
        }
        const page = await renderPage({ fetch: host({ usage: { body: history } }) })
        await page.open()
        const tree = await choose(page, 'All history')
        equal(windowsAsked(page.calls), [7, 'all'])
        is(choice(tree, 'All history').props.value, 'all')
        const section = find(tree, (node) => node.type === 'section' && text(node).includes('Usage'))
        const dayRows = rows(tables(section)[2])
        equal(dayRows.map((row) => row[0]), ['Day', '2026-01-15', '2025-11-01'], 'newest days come first')

        // A new page on an older Host says why the option is absent rather than
        // promising a report that Host cannot serve.
        const legacy = await renderPage({ fetch: host({ usage: { body: { ...USAGE, windows: [1, 7, 30] } } }) })
        const legacyTree = await legacy.open()
        ok(text(legacyTree).includes('Restart DSH'), 'the older Host gets a restart explanation')
        const opened = await legacy.click((node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu'
          && node.props['aria-label'] === 'Range')
        const menu = find(opened, (node) => node.props?.role === 'menu' && node.props['aria-label'] === 'Range')
        equal(nodes(menu).filter(({ node }) => node.props?.role === 'menuitem').map(({ node }) => text(node).trim()),
          ['Today', '7 days', '30 days'])

        const days = Array.from({ length: 105 }, (_, index) => ({
          day: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
          counters: { ...CACHED },
        }))
        const expected = days.map((entry) => entry.day).reverse()
        const paged = await renderPage({
          fetch: host({ usage: { body: { ...USAGE, days: days.slice(-1), historyDays: days } } }),
        })
        let pagedTree = await paged.open()
        const dailyRows = (tree) => {
          const usage = find(tree, (node) => node.type === 'section' && text(node).includes('Usage'))
          return rows(tables(usage)[2]).slice(1).map((row) => row[0])
        }
        equal(dailyRows(pagedTree), expected.slice(0, 10), 'the first page is the newest ten days')
        is(choice(pagedTree, '10 per page').props.value, '10')
        ok(text(pagedTree).includes('Page 1 of 11'), text(pagedTree))
        is(button(pagedTree, 'Previous page').props.disabled, true)

        pagedTree = await paged.click((node) => node.type === 'button' && text(node).trim() === 'Next page')
        is(dailyRows(pagedTree)[0], expected[10])
        ok(text(pagedTree).includes('Page 2 of 11'), text(pagedTree))

        pagedTree = await choose(paged, '30 per page')
        equal(dailyRows(pagedTree).length, 30)
        is(dailyRows(pagedTree)[0], expected[0], 'changing the page size returns to the first page')
        ok(text(pagedTree).includes('Page 1 of 4'), text(pagedTree))
        pagedTree = await paged.click((node) => node.type === 'button' && text(node).trim() === 'Next page')
        is(dailyRows(pagedTree)[0], expected[30])

        pagedTree = await choose(paged, '100 per page')
        equal(dailyRows(pagedTree).length, 100)
        ok(text(pagedTree).includes('Page 1 of 2'), text(pagedTree))
        pagedTree = await paged.click((node) => node.type === 'button' && text(node).trim() === 'Next page')
        equal(dailyRows(pagedTree), expected.slice(100), 'the last page contains only the remaining days')
        is(button(pagedTree, 'Next page').props.disabled, true)
        pagedTree = await paged.click((node) => node.type === 'button' && text(node).trim() === 'Previous page')
        equal(dailyRows(pagedTree).length, 100)
        equal(windowsAsked(paged.calls), [7], 'pagination never re-reads the usage endpoint')
      },
    },
    {
      name: 'refreshing usage reads the window the reader chose, not the default',
      async run() {
        const page = await renderPage({ fetch: host() })
        await page.open()
        await choose(page, 'Today')
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Refresh usage')
        equal(windowsAsked(page.calls), [7, 1, 1])
        // Pressing the window already showing is the other way a reader
        // re-reads it, and the one the shared store cannot infer: the window
        // they are on is by definition not a dependency change.
        await choose(page, 'Today')
        equal(windowsAsked(page.calls), [7, 1, 1, 1])
      },
    },
    {
      name: 'a deployment that records no usage says so in the reader’s words',
      async run() {
        const page = await renderPage({ fetch: host({ usage: { status: 503, body: { ok: false, error: 'usage-unavailable' } } }) })
        const tree = await page.open()
        const section = find(tree, (node) => node.type === 'section' && text(node).includes('Usage'))
        ok(text(section).includes('This deployment does not record usage.'), text(section))
        // A missing table is reported where the table would be, not instead of
        // the rest of the page.
        ok(text(tree).includes('Models'), 'the other sections still render')
      },
    },
    {
      name: 'a failed read keeps the table it had and says what went wrong',
      async run() {
        let failNext = false
        const page = await renderPage({
          fetch: async (path, init) => {
            if (failNext && String(path).startsWith('opencode-go/usage')) {
              return { status: 500, body: { ok: false, error: 'usage-unavailable', message: 'the file is gone' } }
            }
            return host()(path, init)
          },
        })
        await page.open()
        failNext = true
        await choose(page, '30 days')
        const section = find(page.tree(), (node) => node.type === 'section' && text(node).includes('Usage'))
        ok(text(section).includes('Could not read usage: the file is gone'), text(section))
      },
    },
    {
      name: 'a range with no calls still lists the days that have them',
      async run() {
        // A quiet day beside a busy month is a table, not an empty page: the
        // selected range decides the totals, while the daily series is the
        // whole local history.
        const quietRange = {
          ...USAGE,
          window: 1,
          totals: { ...NO_CALLS },
          models: [],
          days: [],
          historyDays: [
            { day: '2025-11-01', counters: { ...CACHED, requests: 2 } },
            { day: '2026-01-14', counters: { ...CACHED, requests: 1 } },
          ],
        }
        const page = await renderPage({ fetch: host({ usage: { body: quietRange } }) })
        await page.open()
        const tree = await choose(page, 'Today')
        const section = usageSection(tree)
        is(text(section).includes('No calls were recorded in this range.'), false,
          'the daily history is not hidden by an empty range')
        const [totals, models, daily] = tables(section)
        equal(rows(totals)[1][1], '0', 'the selected range is still the empty one')
        equal(rows(models).length, 1, 'no per-model row for an empty range')
        equal(rows(daily).slice(1).map((row) => row[0]), ['2026-01-14', '2025-11-01'],
          'the recorded days are listed newest first')
      },
    },
    {
      name: 'only a range and a history that are both empty read as no calls',
      async run() {
        const nothing = {
          ...USAGE,
          totals: { ...NO_CALLS },
          models: [],
          days: [],
          historyDays: [],
        }
        const page = await renderPage({ fetch: host({ usage: { body: nothing } }) })
        const tree = await page.open()
        const section = usageSection(tree)
        ok(text(section).includes('No calls were recorded in this range.'), text(section))
        equal(tables(section).length, 0, 'there is no table to draw')
      },
    },
    {
      name: 'the models section offers the whole catalog and the fetch control',
      async run() {
        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        ok(text(tree).includes('glm-5.3'), 'a listed model')
        ok(text(tree).includes('space-bunny-free'), 'a hidden model is still shown, so it can be brought back')
        const fetched = await page.click((node) => node.type === 'button' && text(node).trim() === 'Fetch available models')
        equal(page.calls.filter((call) => call.path === 'opencode-go/refresh').length, 1)
        ok(text(fetched).includes('Re-read 3 models'), text(fetched).slice(-200))
      },
    },
    {
      name: 'a model list that cannot be read is a read failure, not an empty catalog',
      async run() {
        // The list is loading, readable, or unreadable; only a readable empty
        // catalog is called empty. A failed first read says what failed and
        // offers the retry, and the variants area does not claim to be loading
        // behind it.
        const cases = [
          ['an HTTP failure', { status: 503, body: { ok: false, error: 'catalog-unavailable', message: 'the catalog file is gone' } },
            'Could not read the model list: the catalog file is gone'],
          ['a Host refusal on HTTP 200', { body: { ok: false } },
            'Could not read the model list: The local bridge reported a failure.'],
          ['a malformed answer', { body: { ok: true } },
            'Could not read the model list: The local bridge returned an unrecognized response.'],
          ['a malformed model row', { body: { ok: true, models: [{}] } },
            'Could not read the model list: The local bridge returned an unrecognized response.'],
          ['a model row without a protocol list', { body: { ok: true, models: [{ id: 'glm-5.3' }] } },
            'Could not read the model list: The local bridge returned an unrecognized response.'],
          ['a model row whose id is not a string', { body: { ok: true, models: [{ id: 7, protocols: ['chat-completions'] }] } },
            'Could not read the model list: The local bridge returned an unrecognized response.'],
          ['a transport rejection', 'throw', 'Could not read the model list: Could not reach the local bridge'],
        ]
        for (const [label, answer, expected] of cases) {
          const page = await renderPage({
            fetch: async (path, init) => {
              if (String(path) === 'opencode-go/models') {
                if (answer === 'throw') throw new Error('fetch failed')
                return answer
              }
              return host()(path, init)
            },
          })
          const tree = await page.open()
          const section = modelsSection(tree)
          ok(text(section).includes(expected), `${label}: ${text(section).slice(0, 240)}`)
          is(text(section).includes('The model catalog is empty.'), false, `${label}: not called empty`)
          is(text(section).includes('Loading'), false, `${label}: not left loading`)
          ok(buttons(section).includes('Retry'), `${label}: the failure offers a retry`)
        }
      },
    },
    {
      name: 'a failed model re-read keeps the table it had and recovers on retry',
      async run() {
        let failModels = false
        const base = host()
        const page = await renderPage({
          fetch: async (path, init) => {
            if (failModels && String(path) === 'opencode-go/models') throw new Error('fetch failed')
            return base(path, init)
          },
        })
        const opened = await page.open()
        ok(text(opened).includes('glm-5.3'), 'the first read shows the catalog')

        failModels = true
        const failed = await page.click((node) => node.type === 'button' && text(node).trim() === 'Refresh page list')
        const section = modelsSection(failed)
        ok(text(section).includes('Could not read the model list: Could not reach the local bridge'),
          text(section).slice(0, 240))
        ok(text(section).includes('glm-5.3'), 'the table the reader had is kept')
        is(text(section).includes('The model catalog is empty.'), false,
          'a failed re-read is not an empty catalog')
        ok(buttons(section).includes('Retry'), 'the retry sits beside the failure')

        failModels = false
        const recovered = await clickIn(page, section, (node) => node.type === 'button' && text(node).trim() === 'Retry')
        const recoveredSection = modelsSection(recovered)
        is(text(recoveredSection).includes('Could not read the model list'), false, 'the retry clears the failure')
        ok(text(recoveredSection).includes('glm-5.3'), 'and the list is back')
      },
    },
    {
      name: 'a malformed model re-read keeps the table it had',
      async run() {
        // A row missing the fields the list reads is not an empty catalog and
        // not a reason to discard the rows already on screen: the read fails,
        // the old table stays, and the retry sits beside the failure.
        let malformed = false
        const base = host()
        const page = await renderPage({
          fetch: async (path, init) => {
            if (malformed && String(path) === 'opencode-go/models') {
              return { body: { ok: true, models: [{ id: 'glm-5.3' }] } }
            }
            return base(path, init)
          },
        })
        const opened = await page.open()
        ok(text(opened).includes('glm-5.3'), 'the first read shows the catalog')

        malformed = true
        const failed = await page.click((node) => node.type === 'button' && text(node).trim() === 'Refresh page list')
        const section = modelsSection(failed)
        ok(text(section).includes('Could not read the model list: The local bridge returned an unrecognized response.'),
          text(section).slice(0, 240))
        ok(text(section).includes('glm-5.3'), 'the table the reader had is kept')
        is(text(section).includes('The model catalog is empty.'), false,
          'a malformed re-read is not an empty catalog')
        is(text(section).includes('Loading'), false, 'the malformed read settled')
        ok(buttons(section).includes('Retry'), 'the failure offers a retry')
      },
    },
    {
      name: 'a refresh whose catalog rows are malformed reports a failure and keeps the table',
      async run() {
        // The refresh answer embeds the catalog directly, so its rows have to be
        // checked before they replace what is on screen; an unusable row is a
        // failure notice, not an exception during the next render.
        const base = host()
        let catalog = { ...CATALOG, models: [{ id: 'glm-5.3' }] }
        const page = await renderPage({
          fetch: async (path, init) => {
            if (String(path) === 'opencode-go/refresh') {
              return {
                body: {
                  ok: true,
                  discovered: 4,
                  added: [],
                  removed: [],
                  catalog,
                },
              }
            }
            return base(path, init)
          },
        })
        await page.open()
        const refreshed = await page.click((node) => node.type === 'button' && text(node).trim() === 'Fetch available models')
        const section = modelsSection(refreshed)
        ok(text(section).includes('Could not read the model list: The local bridge returned an unrecognized response.'),
          text(section).slice(0, 240))
        is(text(section).includes('Re-read'), false, 'the malformed catalog is not reported as a successful fetch')
        ok(text(section).includes('glm-5.3'), 'the table the reader had is kept')

        catalog = undefined
        const missing = await page.click((node) => node.type === 'button' && text(node).trim() === 'Fetch available models')
        const missingSection = modelsSection(missing)
        ok(text(missingSection).includes('Could not read the model list: The local bridge returned an unrecognized response.'),
          'a success envelope without a catalog is malformed too')
        is(text(missingSection).includes('Re-read'), false, 'the missing catalog is not reported as a successful fetch')
        ok(text(missingSection).includes('glm-5.3'), 'the missing catalog does not clear the old table')
      },
    },
    {
      name: 'a successful page-list read clears a failed fetch notice',
      async run() {
        // The fetch notice belongs to the last fetch, not to the list: once a
        // page-list read succeeds, the old failure is no longer true.
        const page = await renderPage({
          fetch: host({
            refresh: { status: 503, body: { ok: false, message: 'the provider is unavailable' } },
          }),
        })
        await page.open()
        const failed = await page.click((node) => node.type === 'button' && text(node).trim() === 'Fetch available models')
        ok(text(failed).includes('Could not read the model list: the provider is unavailable'),
          text(failed).slice(-240))

        const recovered = await page.click((node) => node.type === 'button' && text(node).trim() === 'Refresh page list')
        is(text(recovered).includes('the provider is unavailable'), false, 'the old failure is gone')
        ok(text(recovered).includes('glm-5.3'), 'the successful read is shown')
      },
    },
    {
      name: 'a model list still on its way is loading, not empty',
      async run() {
        // The third state is not an empty catalog: an answer that has not
        // arrived is loading, and only a readable list gets drawn.
        let release
        const gate = new Promise((resolve) => {
          release = resolve
        })
        const base = host()
        const page = await renderPage({
          fetch: async (path, init) => {
            if (String(path) === 'opencode-go/models') await gate
            return base(path, init)
          },
        })
        const waiting = await page.open()
        const waitingSection = modelsSection(waiting)
        ok(text(waitingSection).includes('Loading'), 'the list says it is loading')
        is(text(waitingSection).includes('The model catalog is empty.'), false, 'and is not called empty')

        release()
        await page.update()
        const settled = modelsSection(page.tree())
        is(text(settled).includes('Loading'), false, 'the list settles when the answer arrives')
        ok(text(settled).includes('glm-5.3'), 'and draws the catalog it read')
      },
    },
    {
      name: 'a retired model is shown as history, never as a choice',
      async run() {
        const retired = {
          ...CATALOG,
          counts: { total: 4, listed: 2, hidden: 1, hiddenByTraining: 0, retired: 1, variants: 1 },
          models: [...CATALOG.models, {
            id: 'deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            hidden: true,
            hiddenReason: 'retired',
            retired: true,
            replacement: 'deepseek-v4.1-flash',
            trainingGated: false,
            protocols: ['chat-completions', 'responses', 'anthropic'],
          }],
          hidden: ['space-bunny-free', 'deepseek-v4-flash'],
        }
        const page = await renderPage({ fetch: host({ models: { body: retired } }) })
        const tree = await page.open()
        ok(text(tree).includes('deepseek-v4-flash'), 'the retired model stays visible as history')
        const tag = nodes(tree).find(({ node }) => node.type === 'span'
          && text(node).trim() === 'retired → deepseek-v4.1-flash')
        ok(tag !== undefined, 'the row names what the service says to use instead')
        ok(String(tag.node.props.style.color).includes('state-warn'), `the tag warns: ${String(tag.node.props.style.color)}`)
        const row = nodes(tree).find(({ node }) => node.type === 'input' && node.props.type === 'checkbox'
          && String(node.props['aria-label']).startsWith('deepseek-v4-flash:'))
        ok(row !== undefined, 'the row has its own checkbox')
        is(row.node.props.disabled, true, 'a retired row is not a decision')
        is(row.node.props.checked, false, 'and it is never shown as offered')
        // "Show all" brings the offerable models back but keeps the historical
        // hidden id: this configuration is append-only as well.
        const shown = await page.click((node) => node.type === 'button' && text(node).trim() === 'Show all')
        const models = modelsSection(shown)
        await clickIn(page, models, (node) => node.type === 'button' && text(node).trim() === 'Save')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body).set.hiddenModels, ['deepseek-v4-flash'])
      },
    },
    {
      name: 'a model that trains on the conversation says so, in warning colour',
      async run() {

        // The gate is a data-policy fact about the conversation rather than a
        // property of the model, so the tag says so and wears the warning tone.
        const gated = {
          ...CATALOG,
          counts: { ...CATALOG.counts, total: 4, listed: 3 },
          models: [...CATALOG.models, {
            id: 'muse-spark-1.3-contributor',
            name: 'Muse Spark 1.3 Contributor',
            hidden: false,
            trainingGated: true,
            protocols: ['anthropic-messages'],
          }],
        }
        const page = await renderPage({ fetch: host({ models: { body: gated } }) })
        const tree = await page.open()
        const badge = nodes(tree).find(({ node }) => node.type === 'span' && text(node).trim() === 'Trains')
        ok(badge !== undefined, 'the gated model is tagged')
        ok(text(badge.path[badge.path.length - 1]).includes('muse-spark-1.3-contributor'), 'on its own row')
        const style = badge.node.props.style
        ok(String(style.color).includes('state-warn'), `the tag warns: ${String(style.color)}`)
        ok(String(style.background).includes('color-mix'), 'the fill is a pale warning')

        // The model's own facts keep the neutral tones beside it.
        const hidden = nodes(tree).find(({ node }) => node.type === 'span' && text(node).trim() === 'Hidden')
        ok(hidden !== undefined, 'the hidden tag is still rendered')
        is(hidden.node.props.style.color, 'var(--dsw-alias-label-secondary)')

        const zh = await renderPage({ fetch: host({ models: { body: gated } }), locale: 'zh' })
        ok(text(await zh.open()).includes('用于训练'), 'the Chinese tag is translated')
      },
    },
    {
      name: 'hiding models writes the visibility list and re-reads the row',
      async run() {

        const page = await renderPage({ fetch: host() })
        await page.open()
        // Two models are offered (one is already hidden), so hiding the listing
        // is a draft the reader can still change their mind about.
        const hidden = await page.click((node) => node.type === 'button' && text(node).trim() === 'Hide all')
        const models = modelsSection(hidden)
        const save = nodes(models).find(({ node }) => node.type === 'button' && text(node).trim() === 'Save')?.node
        is(save.props.disabled, false, 'a changed draft can be saved')
        const afterSave = await clickIn(page, models, (node) => node.type === 'button' && text(node).trim() === 'Save')

        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body), {
          set: {
            hiddenModels: ['glm-5.3', 'glm-5.3@fast', 'space-bunny-free'],
            modelVariants: [{ model: 'glm-5.3', name: 'fast' }],
          },
        })
        // The write reloads the plugin row, so the page reads the catalog back
        // before telling the reader it worked.
        const after = page.calls.slice(page.calls.indexOf(written)).map((call) => call.path)
        ok(after.includes('opencode-go/models'), after.join(','))
        is(after[after.length - 1], 'opencode-go/state', 'the state is re-read last')
        ok(text(afterSave).includes('Saved.'), 'the reader is told it worked')
      },
    },
    {
      name: 'the quota schedule is editable, and shows the intervals the Host resolved',
      async run() {

        const page = await renderPage({ fetch: host() })
        const section = scheduleSection(await page.open())
        ok(text(section).includes('Now: 30s shortest, 1800s longest.'), text(section).slice(0, 120))
        equal(scheduleBoxes(section), [
          { label: 'Shortest interval (seconds)', value: 30 },
          { label: 'Longest interval (seconds)', value: 1_800 },
        ])
        equal(page.calls.filter((call) => call.path === 'opencode-go/config').length, 0, 'nothing is written until a field is left')
      },
    },
    {
      name: 'saving the schedule sends both intervals in one request',
      async run() {

        // One setting, so one write: two requests would leave a moment where the
        // profile holds a floor above its ceiling.
        const page = await renderPage({ fetch: host() })
        await page.open()
        await page.change((node) => node.props['aria-label'] === 'Shortest interval (seconds)', 120)
        await page.change((node) => node.props['aria-label'] === 'Longest interval (seconds)', 900)
        await blurIn(page, 'Longest interval (seconds)')

        const writes = page.calls.filter((call) => call.path === 'opencode-go/config')
        equal(writes.length, 1, 'one request, not one per field')
        equal(JSON.parse(writes[0].init.body), {
          set: { subscriptionMinIntervalSeconds: 120, subscriptionMaxIntervalSeconds: 900 },
        })
        const after = page.calls.slice(page.calls.indexOf(writes[0])).map((call) => call.path)
        is(after[after.length - 1], 'opencode-go/state')
        ok(text(scheduleSection(await page.tree())).includes('Saved.'))
      },
    },
    {
      name: 'a floor above its ceiling is refused on screen, before anything is written',
      async run() {

        const page = await renderPage({ fetch: host() })
        await page.open()
        await page.change((node) => node.props['aria-label'] === 'Shortest interval (seconds)', 3_600)
        await page.change((node) => node.props['aria-label'] === 'Longest interval (seconds)', 300)
        await blurIn(page, 'Shortest interval (seconds)')

        const section = scheduleSection(await page.tree())
        ok(text(section).includes('The shortest interval cannot be longer than the longest.'), 'the pair is explained')
        equal(page.calls.filter((call) => call.path === 'opencode-go/config').length, 0, 'no request was made')

        await page.change((node) => node.props['aria-label'] === 'Longest interval (seconds)', 7_200)
        await blurIn(page, 'Longest interval (seconds)')
        const fixed = scheduleSection(await page.tree())
        is(text(fixed).includes('The shortest interval cannot be longer than the longest.'), false)
        equal(page.calls.filter((call) => call.path === 'opencode-go/config').length, 1, 'the fixed pair is written')
      },
    },
    {
      name: 'an emptied interval box cannot be saved',
      async run() {

        const page = await renderPage({ fetch: host() })
        await page.open()
        await page.change((node) => node.props['aria-label'] === 'Shortest interval (seconds)', '')
        await blurIn(page, 'Shortest interval (seconds)')
        equal(page.calls.filter((call) => call.path === 'opencode-go/config').length, 0, 'an incomplete pair is not written')
      },
    },
    {
      name: 'a row that reports no intervals says so rather than waiting on them',
      async run() {

        const stale = { ...STATE, config: { ...STATE.config, values: {} } }
        const page = await renderPage({ fetch: host({ state: { body: stale } }) })
        const section = scheduleSection(await page.open())
        ok(text(section).includes('the running plugin is older than this page'), text(section).slice(0, 160))
        is(text(section).includes('Loading'), false, 'and it is not still loading')
        equal(scheduleBoxes(section), [
          { label: 'Shortest interval (seconds)', value: '' },
          { label: 'Longest interval (seconds)', value: '' },
        ])
        equal(page.calls.filter((call) => call.path === 'opencode-go/config').length, 0, 'and nothing was sent')
      },
    },
    {
      name: 'transport and retry settings are editable, and saving writes them together',
      async run() {

        const page = await renderPage({ fetch: host() })
        const section = transportSection(await page.open())
        equal(transportBoxes(section), [
          { label: 'Request timeout (seconds)', value: 180 },
          { label: 'Stream idle timeout (seconds)', value: 90 },
          { label: 'Retry limit', value: 5 },
          { label: 'First retry delay (milliseconds)', value: 500 },
          { label: 'Longest retry delay (milliseconds)', value: 10_000 },
        ])
        is(transportSwitch(section).props['aria-checked'], true, 'the large-body switch shows what the row resolved')

        await page.change((node) => node.props['aria-label'] === 'Request timeout (seconds)', 240)
        await blurIn(page, 'Request timeout (seconds)')
        const writes = page.calls.filter((call) => call.path === 'opencode-go/config')
        equal(writes.length, 1, 'one write for the field that was left')
        equal(JSON.parse(writes[0].init.body), {
          set: {
            freshConnectionOnLargeBody: true,
            timeoutMs: 240_000,
            streamIdleTimeoutMs: 90_000,
            retryPolicy: {
              mode: 'normal',
              maxRetries: 5,
              retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
              initialDelayMs: 500,
              maxDelayMs: 10_000,
              jitterRatio: 0.1,
            },
          },
        })
        const after = page.calls.slice(page.calls.indexOf(writes[0])).map((call) => call.path)
        is(after[after.length - 1], 'opencode-go/state')
        ok(text(transportSection(await page.tree())).includes('Saved.'))
      },
    },
    {
      name: 'a first retry delay longer than the longest one is refused on screen',
      async run() {

        const page = await renderPage({ fetch: host() })
        await page.open()
        await page.change((node) => node.props['aria-label'] === 'First retry delay (milliseconds)', 20_000)
        await blurIn(page, 'First retry delay (milliseconds)')
        const section = transportSection(await page.tree())
        ok(text(section).includes('The first retry delay cannot be longer than the longest retry delay.'))
        equal(page.calls.filter((call) => call.path === 'opencode-go/config').length, 0, 'no request was made')
      },
    },
    {
      name: 'a hidden id the catalog does not list survives an unrelated save',
      async run() {

        const page = await renderPage({
          fetch: host({ models: { body: { ...CATALOG, hidden: [...CATALOG.hidden, 'not-published-yet'] } } }),
        })
        await page.open()
        await page.change((node) => node.props.type === 'checkbox' && node.props['aria-label'] === 'glm-5.3: Listed', false)
        await clickIn(page, modelsSection(await page.tree()), (node) => node.type === 'button' && text(node).trim() === 'Save')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        const hidden = JSON.parse(written.init.body).set.hiddenModels
        ok(hidden.includes('not-published-yet'), hidden.join(','))
        ok(hidden.includes('glm-5.3'), hidden.join(','))
      },
    },
    {
      name: 'a variant is built in the form and saved as it was filled in',
      async run() {

        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        await page.open()
        const byLabel = (label) => (node) => node.props['aria-label'] === label
        await pick(page, 'Model', 'GLM 5.3 · glm-5.3')
        await page.change(byLabel('Variant name'), 'fast')
        await pick(page, 'Preferred protocol', 'chat-completions')
        await pick(page, 'Reasoning level', 'low')
        const draft = await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        ok(text(draft).includes('glm-5.3@fast'), 'the draft entry names the id it will be offered under')
        await page.change(byLabel('glm-5.3@fast Context window'), '200000')
        await page.change(byLabel('glm-5.3@fast Max output tokens'), '32768')
        await clickIn(page, modelsSection(await page.tree()), (node) => node.type === 'button' && text(node).trim() === 'Save')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body), {
          set: {
            hiddenModels: ['space-bunny-free'],
            modelVariants: [{
              model: 'glm-5.3',
              name: 'fast',
              protocol: 'chat-completions',
              effort: 'low',
              contextWindow: 200_000,
              maxTokens: 32_768,
            }],
          },
        })
      },
    },
    {
      name: 'editing a saved variant writes the config shape, not the snapshot it read',
      async run() {

        const page = await renderPage({ fetch: host() })
        await page.open()
        await page.click((node) => node.type === 'button' && node.props['aria-label'] === 'Edit variant glm-5.3@fast')
        await page.change((node) => node.props['aria-label'] === 'glm-5.3@fast Context window', '200000')
        await clickIn(page, modelsSection(await page.tree()), (node) => node.type === 'button' && text(node).trim() === 'Save')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body), {
          set: {
            hiddenModels: ['space-bunny-free'],
            modelVariants: [{ model: 'glm-5.3', name: 'fast', contextWindow: 200_000 }],
          },
        })
      },
    },
    {
      name: 'a variant row keeps its fields behind an edit control, and open while it is renamed',
      async run() {

        const page = await renderPage({ fetch: host() })
        await page.open()
        const row = () => variantsSection(page.tree())
        const owned = (id) => nodes(row())
          .map(({ node }) => node.props?.['aria-label'])
          .filter((label) => typeof label === 'string' && label.startsWith(`${id} `))
          .sort()
        const control = (label) => nodes(row()).find(({ node }) => (
          node.type === 'button' && node.props?.['aria-label'] === label
        ))?.node

        equal(owned('glm-5.3@fast'), [], 'the declared row starts with no fields on screen')
        ok(control('Edit variant glm-5.3@fast') !== undefined, 'and offers the control that opens it')
        is(control('Edit variant glm-5.3@fast').props['aria-expanded'], false)

        await page.click((node) => node.type === 'button' && node.props['aria-label'] === 'Edit variant glm-5.3@fast')
        equal(owned('glm-5.3@fast'), [
          'glm-5.3@fast Context window',
          'glm-5.3@fast Display name',
          'glm-5.3@fast Max output tokens',
          'glm-5.3@fast Preferred protocol',
          'glm-5.3@fast Reasoning level',
          'glm-5.3@fast Variant name',
        ].sort(), 'the six fields appeared for the row that asked for them')
        ok(control('Finish editing variant glm-5.3@fast') !== undefined, 'the control now offers the way back')
        is(control('Finish editing variant glm-5.3@fast').props['aria-expanded'], true)

        await page.change((node) => node.props['aria-label'] === 'glm-5.3@fast Variant name', 'fastest')
        ok(owned('glm-5.3@fastest').length > 0, 'the row is still open, under its new name')

        await page.click((node) => node.type === 'button' && node.props['aria-label'] === 'Finish editing variant glm-5.3@fastest')
        equal(owned('glm-5.3@fastest'), [], 'the second press puts the fields away again')
      },
    },
    {
      name: 'a variant added from the form arrives with its fields open',
      async run() {
        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        await page.open()
        await pick(page, 'Model', 'GLM 5.3 · glm-5.3')
        await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'Variant name', 'slow')
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        // The row lands where the reader is looking, so the cap and window it
        // was just created to carry are one keystroke away rather than a click.
        for (const field of ['Context window', 'Max output tokens']) {
          ok(
            nodes(page.tree()).some(({ node }) => node.props?.['aria-label'] === `glm-5.3@slow ${field}`),
            `the new row is open, with its ${field} field`,
          )
        }
      },
    },
    {
      name: 'the add form keeps its fields together, with the name rules under them',
      async run() {

        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        await page.open()
        await pick(page, 'Model', 'GLM 5.3 · glm-5.3')

        const section = variantsSection(await page.tree())
        const flat = nodes(section).map(({ node }) => node)
        const at = (predicate) => flat.findIndex(predicate)
        const field = (label) => at((node) => (node.type === 'input'
          || (node.type === 'button' && node.props?.['aria-haspopup'] === 'menu'))
          && node.props?.['aria-label'] === label)
        const note = (opening) => at((node) => node.type === 'p' && text(node).startsWith(opening))
        const fields = ['Model', 'Variant name', 'Display name', 'Preferred protocol', 'Reasoning level'].map(field)
        const control = at((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        ok(fields.every((index) => index >= 0), 'every field of the add form is on screen')
        ok(control >= 0, 'and the control that submits it')
        for (const [what, index] of [
          ['the note about a blank name', note('Leave blank to use')],
          ['the name rule', note('Letters, digits, dot, and dash only.')],
        ]) {
          ok(index >= 0, `${what} is on screen`)
          ok([...fields, control].every((position) => position < index), `${what} sits under the whole form`)
        }
      },
    },
    {
      name: 'a variant name left blank takes the default the placeholder showed',
      async run() {

        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        await page.open()
        const nameBox = () => nodes(page.tree())
          .find(({ node }) => node.type === 'input' && node.props['aria-label'] === 'Variant name')?.node
        await pick(page, 'Model', 'GLM 5.3 · glm-5.3')
        await pick(page, 'Reasoning level', 'high')
        is(nameBox().props.placeholder, 'high', 'the placeholder names the default before it is used')
        ok(text(page.tree()).includes('glm-5.3@high'), 'the full default id is on screen')

        await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        ok(nodes(page.tree()).some(({ node }) => node.type === 'span' && text(node) === 'glm-5.3@high'), 'the entry took the default name')
        await clickIn(page, modelsSection(await page.tree()), (node) => node.type === 'button' && text(node).trim() === 'Save')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body).set.modelVariants, [{ model: 'glm-5.3', name: 'high', effort: 'high' }])
      },
    },
    {
      name: 'a variant that names no level falls back to the protocol, then to a plain word',
      async run() {

        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        await page.open()
        const nameBox = () => nodes(page.tree())
          .find(({ node }) => node.type === 'input' && node.props['aria-label'] === 'Variant name')?.node
        ok(text(page.tree()).includes('<model>@<reasoning level>'), 'the generic form is named')
        await pick(page, 'Model', 'GLM 5.3 · glm-5.3')
        is(nameBox().props.placeholder, 'default', 'a variant that restates nothing is called "default"')
        await pick(page, 'Preferred protocol', 'chat-completions')
        is(nameBox().props.placeholder, 'chat-completions', 'a protocol the variant sets names it instead')
        await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'Variant name', 'chatty')
        is(nameBox().props.value, 'chatty')
      },
    },
    {
      name: 'the variant list can be added to and removed from, by name',
      async run() {

        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        const section = variantsSection(tree)
        const ids = () => nodes(variantsSection(page.tree()))
          .filter(({ node }) => node.type === 'span' && node.props.style?.color === 'var(--dsw-alias-label-tertiary)')
          .map(({ node }) => text(node))
          .filter((value) => /^\S+@\S+$/.test(value) && !value.includes('<model>'))
        equal(ids(), ['glm-5.3@fast'], 'the declared variant is in the list')
        ok(text(section).includes('1 added'), 'the list says how many it holds')

        await pick(page, 'Model', 'GLM 5.3 · glm-5.3')
        await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'Variant name', 'slow')
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        equal(ids(), ['glm-5.3@fast', 'glm-5.3@slow'])
        ok(text(variantsSection(page.tree())).includes('2 added'))

        await page.click((node) => node.type === 'button' && node.props['aria-label'] === 'Delete variant glm-5.3@fast')
        equal(ids(), ['glm-5.3@slow'])
        await clickIn(page, modelsSection(await page.tree()), (node) => node.type === 'button' && text(node).trim() === 'Save')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body).set.modelVariants, [{ model: 'glm-5.3', name: 'slow' }])
      },
    },
    {
      name: 'a name edited in the list is written, and one that collides is refused before saving',
      async run() {

        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        await page.open()
        const add = async (name) => {
          await pick(page, 'Model', 'GLM 5.3 · glm-5.3')
          await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'Variant name', name)
          await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        }
        await add('one')
        await add('two')
        await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'glm-5.3@two Variant name', 'one')
        const save = () => nodes(modelsSection(page.tree()))
          .find(({ node }) => node.type === 'button' && text(node).trim() === 'Save')?.node
        is(save().props.disabled, true, 'Save is inert while a name collides')
        ok(text(page.tree()).includes('Variant "glm-5.3@one" already exists.'), 'the collision is named by the id it would create')

        await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'glm-5.3@one Variant name', 'three')
        is(save().props.disabled, false)
        await clickIn(page, modelsSection(await page.tree()), (node) => node.type === 'button' && text(node).trim() === 'Save')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body).set.modelVariants, [
          { model: 'glm-5.3', name: 'three' },
          { model: 'glm-5.3', name: 'one' },
        ])
      },
    },
    {
      name: 'adding a variant that already exists is refused, not written twice',
      async run() {

        const page = await renderPage({ fetch: host() })
        await page.open()
        const byLabel = (label) => (node) => node.props['aria-label'] === label
        await pick(page, 'Model', 'GLM 5.3 · glm-5.3')
        await page.change(byLabel('Variant name'), 'fast')
        const tree = await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        ok(text(tree).includes('Variant "glm-5.3@fast" already exists.'), text(tree).slice(-300))
        const save = nodes(modelsSection(tree)).find(({ node }) => node.type === 'button' && text(node).trim() === 'Save')?.node
        is(save.props.disabled, true)
        equal(page.calls.filter((call) => call.path === 'opencode-go/config').length, 0, 'nothing was written')
      },
    },
    {
      name: 'a contradiction is refused before anything is written',
      async run() {
        const page = await renderPage({ fetch: host() })
        await page.open()
        const byLabel = (label) => (node) => node.props['aria-label'] === label
        await page.change(byLabel('Variant name'), 'fast')
        const tree = await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        ok(text(tree).includes('Pick a model first.'), 'the form says what is missing')
        equal(page.calls.filter((call) => call.path === 'opencode-go/config').length, 0, 'nothing was written')
      },
    },
    {
      name: 'saving a key writes it to the credential store and clears the field',
      async run() {

        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        const field = (node) => node.props.type === 'password'
        await page.change(field, 'sk-a-secret-value')
        await clickIn(page, group(await page.tree(), 'API key'), (node) => node.type === 'button' && text(node).trim() === 'Save')
        const written = page.calls.find((call) => call.path === 'opencode-go/credential')
        is(written.init.method, 'POST')
        equal(JSON.parse(written.init.body), { value: 'sk-a-secret-value' })
        is(find(page.tree(), field).props.value, '', 'the field is emptied, so the key is not left in the page')
        ok(text(page.tree()).includes('Saved.'), 'the reader is told it worked')
      },
    },
    {
      name: 'a key the launching environment supplies explains itself and offers no clear button',
      async run() {

        const page = await renderPage({
          fetch: host({
            state: {
              body: {
                ...STATE,
                credential: {
                  configured: true, source: 'env', writable: false, removable: false,
                  blockedBy: 'launching-environment', reference: 'OPENCODE_GO_API_KEY',
                  environment: { variable: 'OPENCODE_GO_API_KEY', present: true, source: 'process', path: null },
                },
                environment: { variable: 'OPENCODE_GO_API_KEY', present: true, source: 'process', path: null },
              },
            },
          }),
        })
        const tree = await page.open()
        const section = group(tree, 'API key')
        const shown = text(section)
        ok(shown.includes('launching environment variable OPENCODE_GO_API_KEY'), shown.slice(0, 300))
        ok(shown.includes('point Credential reference below at another name'), 'and the way out of it')
        // A control that cannot work is not rendered at all.
        is(nodes(section).some(({ node }) => node.type === 'button' && text(node).trim() === 'Clear key'), false, 'no Clear key')
        const field = nodes(section).find(({ node }) => node.type === 'input' && node.props.type === 'password')
        is(field.node.props.disabled, true, 'the key field is inert while a store would be shadowed')
        const save = nodes(section).find(({ node }) => node.type === 'button' && text(node).trim() === 'Save')
        is(save.node.props.disabled, true)
      },
    },
    {
      name: 'the credential reference can be pointed at another name, which is the way out',
      async run() {

        const page = await renderPage({
          fetch: host({
            state: {
              body: {
                ...STATE,
                route: { ...STATE.route, apiKeyEnv: 'OPENCODE_GO_API_KEY' },
                credential: {
                  configured: true, source: 'env', writable: false, removable: false,
                  blockedBy: 'launching-environment', reference: 'OPENCODE_GO_API_KEY',
                  environment: { variable: 'OPENCODE_GO_API_KEY', present: true, source: 'process', path: null },
                },
              },
            },
          }),
        })
        const tree = await page.open()
        const box = nodes(tree).find(({ node }) => node.type === 'input' && node.props['aria-label'] === 'Credential reference')
        ok(box !== undefined, 'the credential reference is an editable field')
        is(box.node.props.value, 'OPENCODE_GO_API_KEY', 'the reference starts at the name in use')
        await page.change((node) => node.props['aria-label'] === 'Credential reference', 'OPENCODE_GO_HOME_KEY')
        await blurIn(page, 'Credential reference')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body), { set: { apiKeyEnv: 'OPENCODE_GO_HOME_KEY' } })
      },
    },
    {
      name: 'a gateway that rejects the key says so without a Save button that would work',
      async run() {

        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        await page.change((node) => node.props.type === 'password', 'sk-wrong')
        await clickIn(page, group(await page.tree(), 'API key'), (node) => node.type === 'button' && text(node).trim() === 'Save')
        ok(text(page.tree()).includes('Saved.'))

        const refused = await renderPage({
          fetch: host({ credential: { body: { ok: false, message: 'the credential store refused it' } } }),
        })
        const refusedTree = await refused.open()
        await refused.change((node) => node.props.type === 'password', 'sk-wrong')
        await clickIn(refused, group(await refused.tree(), 'API key'), (node) => node.type === 'button' && text(node).trim() === 'Save')
        ok(text(refused.tree()).includes('the credential store refused it'), text(refused.tree()).slice(0, 300))
      },
    },
    {
      name: 'a key save that cannot reach the bridge says so instead of inventing a status',
      async run() {
        const base = host()
        let broke = false
        const page = await renderPage({
          fetch: async (path, init) => {
            if (broke && String(path) === 'opencode-go/credential') throw new Error('fetch failed')
            return base(path, init)
          },
        })
        await page.open()
        await page.change((node) => node.type === 'input' && node.props.type === 'password', 'sk-a-secret-value')
        broke = true
        const after = await clickIn(page, group(await page.tree(), 'API key'),
          (node) => node.type === 'button' && text(node).trim() === 'Save')
        const section = group(after, 'API key')
        ok(text(section).includes('Could not reach the local bridge'), text(section).slice(0, 240))
        is(text(section).includes('HTTP'), false, 'no status is invented for a transport failure')
      },
    },
    {
      name: 'a deployment the page cannot write into says which part is missing, in words',
      async run() {
        // The report was "configuration is read-only: no profile entry for this
        // plugin was found", which names the symptom rather than what to do.
        // A composition with no editor at all is a different reason from one
        // whose editor cannot address this row, and both must read as English.
        const noEditor = await renderPage({
          fetch: host({ state: { body: { ...STATE, config: { editable: false, reason: 'no-config-editor' } } } }),
        })
        const noEditorText = text(await noEditor.open())
        ok(noEditorText.includes('Reason: no configuration editor'), noEditorText.slice(-220))
        ok(noEditorText.includes('still readable and usage is still recorded'), 'what still works is named')
        // The page is still usable for the parts that cannot write.
        ok(noEditorText.includes('Models'), 'the sections still render')

        const noRow = await renderPage({
          fetch: host({ state: { body: { ...STATE, config: { editable: false, reason: 'entry-not-found' } } } }),
        })
        const noRowText = text(await noRow.open())
        ok(noRowText.includes('Reason: no configuration row for this plugin'), noRowText.slice(-220))
        is(noRowText.includes('no configuration editor'), false, 'the wrong reason is not shown')
      },
    },
    {
      name: 'no control is ever sized along the wrong axis',
      async run() {

        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        const problems = []
        let checked = 0
        for (const { node, path } of nodes(tree)) {
          const dropdown = node.type === 'button' && node.props?.['aria-haspopup'] === 'menu'
          if (node.type !== 'input' && node.type !== 'textarea' && !dropdown) continue
          const style = node.props.style ?? {}
          const named = node.props['aria-label'] ?? node.props.type ?? node.type
          const toggle = node.type === 'input' && ['checkbox', 'radio', 'range', 'file'].includes(node.props.type)
          if (toggle) continue
          // The compact pills in the usage block are inline controls, not fields.
          if (dropdown && style.height === '28px') continue
          checked += 1
          // The nearest flex/grid ancestor is what turns a basis into a height;
          // a column further up does not size this control.
          const container = [...path].reverse().find((ancestor) => {
            const display = ancestor.props?.style?.display
            return display === 'flex' || display === 'grid'
          })
          const column = container?.props?.style?.flexDirection === 'column'
          const basis = typeof style.flex === 'string'
            ? style.flex.split(/\s+/).find((part) => /[\d.]/.test(part))
            : undefined
          if (column && basis !== undefined) problems.push(`${named}: flex "${style.flex}" inside a column container`)
          if (style.height !== '34px') problems.push(`${named}: height ${String(style.height)}`)
          if (style.boxSizing !== 'border-box') problems.push(`${named}: box-sizing ${String(style.boxSizing)}`)
        }
        equal(problems, [], problems.join(' · '))
        ok(checked > 6, `the page rendered the controls this checks (${String(checked)})`)
      },
    },
    {
      name: 'the variant form lays its labelled fields out in one band',
      async run() {

        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        const tree = await page.open()
        await pick(page, 'Model', 'GLM 5.3 · glm-5.3')
        const section = variantsSection(await page.tree())
        const controls = ['Model', 'Variant name', 'Display name', 'Preferred protocol', 'Reasoning level']
          .map((label) => nodes(section).find(({ node }) => (
            (node.type === 'input' || (node.type === 'button' && node.props?.['aria-haspopup'] === 'menu'))
            && node.props?.['aria-label'] === label
          ))?.node)
        ok(controls.every((node) => node !== undefined), 'every labelled field of the form rendered')
        for (const node of controls) equal(node.props.style.height, '34px', 'the fields share one height')
        // Each control is preceded by its own label line, the native field shape.
        for (const [index, label] of ['Model', 'Variant name', 'Display name', 'Preferred protocol', 'Reasoning level'].entries()) {
          const flat = nodes(section).map(({ node }) => node)
          const at = flat.indexOf(controls[index])
          ok(flat.slice(0, at).some((node) => (node.type === 'span' || node.type === 'label') && text(node) === label), `${label} has its label above it`)
        }
      },
    },
    {
      name: 'no placeholder is longer than the box it is shown in',
      async run() {
        // A placeholder that does not fit is not a hint, it is a cut-off
        // sentence: the reader sees "例如 fast（字母、数字、点、横线、下划" and learns
        // nothing about where the rest went. The boxes are a known width, so a
        // rough width estimate is enough to catch a placeholder that outgrew
        // its control -- which is how the rules ended up in the hint text
        // under the field instead.
        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        const problems = []
        let checked = 0
        for (const { node, path } of nodes(tree)) {
          if (node.type !== 'input' || typeof node.props.placeholder !== 'string') continue
          if (node.props.placeholder === '') continue
          checked += 1
          // The column that holds it gives the control its width.
          const column = [...path].reverse().find((ancestor) => ancestor.props?.style?.flexDirection === 'column')
          const declared = /\s0\s(\d+)px/.exec(column?.props?.style?.flex ?? '')?.[1]
          const width = declared === undefined ? 240 : Number(declared)
          // 14px text: ~14px for a wide glyph (CJK), ~7px otherwise, less
          // the control's own padding.
          const placeholder = node.props.placeholder
          const wide = [...placeholder].filter((char) => /[\u3000-\u9fff\uFF00-\uFFEF]/.test(char)).length
          const estimate = (placeholder.length - wide) * 7 + wide * 14
          const room = width - 24
          if (estimate > room) {
            problems.push(`"${placeholder}" needs ~${String(estimate)}px of ${String(room)}px`)
          }
        }
        equal(problems, [], problems.join(' · '))
        ok(checked >= 4, `the page rendered placeholders to check (${String(checked)})`)
      },
    },
    {
      name: 'a hit rate is a measured figure, and the page will not invent one',
      async run() {
        // Two services that behave differently and look identical in the raw
        // numbers: one reports "nothing was cached", the other reports no cache
        // figure at all. Only the first supports the claim "0% of your prompt
        // was cached", so only the first is allowed to show a percentage.
        const silent = { requests: 2, failures: 0, inputTokens: 300, outputTokens: 50, totalTokens: 350, cacheReadTokens: 0, cacheWriteTokens: 0, cacheReported: 0 }
        const explicitZero = { ...silent, cacheReported: 2 }
        const page = await renderPage({
          fetch: host({ usage: { body: { ...USAGE, totals: silent, models: [{ model: 'glm-5.3', counters: silent }], days: [{ day: '2026-01-15', counters: silent }] } } }),
        })
        const tree = await page.open()
        const section = find(tree, (node) => node.type === 'section' && text(node).includes('Usage'))
        const totals = rows(tables(section)[0])
        is(totals[1][7], '—', 'a service that said nothing does not get a 0%')
        // The convention that makes the arithmetic checkable is stated, not left
        // for the reader to infer from numbers that look inconsistent.
        const said = text(section).replace(/\s+/g, ' ')
        ok(said.includes('Hit rate = cache read ÷ (uncached input + cache read)'), 'the formula is on the page')
        ok(said.includes('shows "—".'), 'and so is what a missing figure looks like')
        is(said.includes('counts only the part of the prompt'), false, 'the column note is gone')

        // The same numbers, this time from a service that reported them as zero.
        const reported = await renderPage({
          fetch: host({ usage: { body: { ...USAGE, totals: explicitZero, models: [{ model: 'glm-5.3', counters: explicitZero }], days: [{ day: '2026-01-15', counters: explicitZero }] } } }),
        })
        const reportedTree = await reported.open()
        const reportedSection = find(reportedTree, (node) => node.type === 'section' && text(node).includes('Usage'))
        is(rows(tables(reportedSection)[0])[1][7], '0%', 'a reported zero is a measurement')
      },
    },
    {
      name: 'the panel and the settings tab carry the configuration page\'s usage copy',
      async run() {

        const page = await renderPage({ fetch: host() })
        const flat = (tree) => text(tree).replace(/\s+/g, ' ')
        const config = flat(await page.open())
        const panel = flat(await page.surface('main').open())
        const tab = flat(await page.surface('settings.plugins.tab').open())

        const shared = [
          'Calls and tokens recorded locally for this route; the provider\'s billing may differ.',
          'Totals and models follow the selected range; the daily table always covers all history.',
          'Hit rate = cache read ÷ (uncached input + cache read). A service that never reported a cache figure shows "—".',
          'Read at ',
        ]
        for (const sentence of shared) {
          for (const [where, surface] of [['the configuration page', config], ['the panel', panel], ['the settings tab', tab]]) {
            ok(surface.includes(sentence), `${where} carries "${sentence.slice(0, 48)}…"`)
          }
        }
        ok(config.includes('Ctrl/Cmd+U opens the usage panel.'), 'the configuration page names the shortcut')
      },
    },
    {
      name: 'the summary view asks the Host for nothing at all',
      async run() {
        const page = await renderPage({ fetch: host() })
        const tree = await page.open('summary')
        equal(page.calls.length, 0)
        is(text(tree), 'API key, models, and usage')
      },
    },
    {
      name: 'every control the page renders has a label a reader can read',
      async run() {
        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        const labels = buttons(tree)
        for (const label of ['Save', 'Clear key', 'Refresh page list', 'Fetch available models', 'Hide retired models', 'Refresh usage', 'Previous page', 'Next page']) {
          ok(labels.includes(label), `a "${label}" control is rendered: [${labels.join(', ')}]`)
        }
        const rangeTree = await page.click((node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu'
          && node.props['aria-label'] === 'Range')
        const formatTree = await page.click((node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu'
          && node.props['aria-label'] === 'Number format')
        const pageSizeTree = await page.click((node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu'
          && node.props['aria-label'] === 'Days per page')
        const options = [...nodes(rangeTree), ...nodes(formatTree), ...nodes(pageSizeTree)]
          .filter(({ node }) => node.props?.role === 'menuitem').map(({ node }) => text(node).trim())
        for (const label of ['Today', '7 days', '30 days', 'All history', 'Full numbers', 'Show units', '10 per page', '30 per page', '100 per page']) {
          ok(options.includes(label), `a "${label}" option is rendered: [${options.join(', ')}]`)
        }
      },
    },
    {
      name: 'the capsule display switch is a row on the page, and toggling it writes then reads back',
      async run() {
        // The switch is an ordinary setting applied on the spot: one press is
        // one write, and the page then reads the row back to show what the Host
        // persisted. The capsule section sits between the model list and the
        // quota schedule, which is where the settings page groups it.
        let refuseWrite = false
        const fixture = statefulHost({ refuse: () => refuseWrite })
        const page = await renderPage({ fetch: fixture.fetch })
        const tree = await page.open()
        const section = capsuleSection(tree)
        const control = capsuleSwitch(section)
        ok(control !== undefined, 'the capsule section renders its switch')
        is(control.props['aria-checked'], true, 'the switch shows what the row resolved: on')
        is(control.props['aria-label'], 'Show the usage capsule', 'the switch carries an accessible label')
        is(control.props.disabled, false)
        // The row sits between the model list and the quota schedule, which is
        // where the settings page groups the display of its own surfaces.
        const at = (predicate) => nodes(tree).findIndex(({ node }) => predicate(node))
        const sectionAt = at((node) => node === section)
        const modelsAt = at((node) => node.type === 'section' && text(node).includes('Choose which models appear'))
        const scheduleAt = at((node) => node.type === 'section' && text(node).includes('Quota refresh'))
        ok(sectionAt > modelsAt && sectionAt < scheduleAt,
          `the capsule row sits between models and the quota schedule (${String(modelsAt)}, ${String(sectionAt)}, ${String(scheduleAt)})`)

        const after = await clickIn(page, section, (node) => node.type === 'button'
          && node.props.role === 'switch' && node.props['aria-label'] === 'Show the usage capsule')
        const writes = page.calls.filter((call) => call.path === 'opencode-go/config')
        equal(writes.length, 1, 'one toggle is one write')
        equal(JSON.parse(writes[0].init.body), { set: { showQuotaCapsule: false } })
        const tail = page.calls.slice(page.calls.indexOf(writes[0])).map((call) => call.path)
        is(tail[tail.length - 1], 'opencode-go/state', 'and the row is re-read after the write')
        is(capsuleSwitch(capsuleSection(after)).props['aria-checked'], false, 'the switch shows the value it wrote')

        // A refused write puts the switch back where the persisted value was,
        // and says why — the optimistic move is not a lie left on screen.
        refuseWrite = true
        const reverted = await page.click((node) => node.type === 'button'
          && node.props.role === 'switch' && node.props['aria-label'] === 'Show the usage capsule')
        is(capsuleSwitch(capsuleSection(reverted)).props['aria-checked'], false, 'the refused write rolls the switch back')
        ok(text(capsuleSection(reverted)).includes('Could not save: the setting is read-only'),
          text(capsuleSection(reverted)).slice(0, 200))
      },
    },
    {
      name: 'a save whose row has not reloaded yet is reported as stale, not as saved',
      async run() {
        // The Loader reconciles a written row through the profile patch, so a
        // state read can land before the new value does. That is neither a
        // failed write nor a successful-looking one: the page re-reads once
        // more, and when the row still reports the old value it says the write
        // went through but could not be read back.
        const base = host()
        const before = structuredClone(STATE)
        let lagged = 0
        const page = await renderPage({
          fetch: async (path, init) => {
            if (String(path) === 'opencode-go/config' && init?.method === 'POST') {
              lagged = 2 // the row has not reloaded for this read and the retry
              return base(path, init)
            }
            if (String(path) === 'opencode-go/state' && lagged > 0) {
              lagged -= 1
              return { body: before }
            }
            return base(path, init)
          },
        })
        const tree = await page.open()
        const readsBefore = page.calls.filter((call) => call.path === 'opencode-go/state').length
        const after = await clickIn(page, capsuleSection(tree), (node) => node.type === 'button'
          && node.props.role === 'switch' && node.props['aria-label'] === 'Show the usage capsule')
        equal(page.calls.filter((call) => call.path === 'opencode-go/config').length, 1, 'the write happened once')
        const reads = page.calls.filter((call) => call.path === 'opencode-go/state').length
        equal(reads - readsBefore, 2, 'the row was re-read, once more after the beat')
        ok(text(capsuleSection(after)).includes('could not be read back'),
          text(capsuleSection(after)).slice(0, 240))
        is(capsuleSwitch(capsuleSection(after)).props['aria-checked'], false,
          'the switch keeps the value the reader chose while the row catches up')
      },
    },
    {
      name: 'the page\'s switch moves the sidebar capsule in the same tab, without a remount',
      async run() {
        // The switch is on the page and the thing it moves is in the foot: two
        // React trees over one fact, so the preference has to live outside both.
        // This case mounts both in one page and presses the switch, which is what
        // a reader does before opening anything else.
        const fixture = statefulHost()
        const page = await renderPage({ fetch: fixture.fetch })
        await page.open()
        const capsule = page.surface('sidebar.footer.action')
        const drawn = await capsule.open({ wide: true })
        ok(text(drawn).includes('92%'), 'the capsule is drawn while the switch is on')
        // The page had already read the endpoint the preference comes from, so
        // the foot learned it from that read rather than spending one of its own.
        equal(page.calls.filter((call) => call.path === 'opencode-go/state').length, 1,
          'one state read answered both surfaces')

        await page.click((node) => node.type === 'button'
          && node.props.role === 'switch' && node.props['aria-label'] === 'Show the usage capsule')
        is(capsule.tree(), null, 'the foot draws nothing while the switch is off')
        equal(nodes(capsule.tree()).length, 0, 'and there is no capsule node left in it')

        await page.click((node) => node.type === 'button'
          && node.props.role === 'switch' && node.props['aria-label'] === 'Show the usage capsule')
        ok(text(capsule.tree()).includes('92%'), 'and it is drawn again once the switch is back on')
        // Each turn wrote and read the row back; the capsule never read the
        // preference for itself, because the page's own reads answered it.
        equal(page.calls.filter((call) => call.path === 'opencode-go/state').length, 3,
          'the page read state on open and once per toggle, and the capsule added none')
      },
    },
    {
      name: 'a capsule whose row reports it off draws nothing and reads no quota',
      async run() {
        // A hidden capsule must not be an invisible one that still spends: the
        // quota read, the subscription hook, and the schedule all belong to the
        // body, which is not mounted at all while the preference is off.
        const off = {
          ...STATE,
          config: { ...STATE.config, values: { ...STATE.config.values, showQuotaCapsule: false } },
        }
        const page = await renderPage({ fetch: host({ state: { body: off } }) })
        const capsule = page.surface('sidebar.footer.action')
        const tree = await capsule.open({ wide: true })
        is(tree, null, 'a switched-off capsule draws nothing at all')
        equal(nodes(tree).length, 0, 'not even an empty row')
        equal(page.calls.map((call) => call.path), ['opencode-go/state'],
          'it reads the preference, and never the subscription quota')
      },
    },
    {
      name: 'a row that reports no capsule switch is inert, and the capsule stays by default',
      async run() {
        // A running plugin older than this page cannot report the switch. The
        // default is on, so the foot stays; the row says why it cannot be pressed
        // rather than showing an off state the reader could not change.
        const values = { ...STATE.config.values }
        delete values.showQuotaCapsule
        const stale = { ...STATE, config: { ...STATE.config, values } }
        const page = await renderPage({ fetch: host({ state: { body: stale } }) })
        const tree = await page.open()
        const section = capsuleSection(tree)
        ok(text(section).includes('This row does not report the capsule switch'), text(section).slice(0, 180))
        is(text(section).includes('Loading'), false, 'and it is not still loading')
        is(capsuleSwitch(section).props.disabled, true, 'the switch cannot be pressed while the row does not report it')

        const capsule = page.surface('sidebar.footer.action')
        const capsuleTree = await capsule.open({ wide: true })
        ok(text(capsuleTree).includes('92%'), 'the capsule stays, because its default is on')
        equal(page.calls.filter((call) => call.path === 'opencode-go/state').length, 1,
          'the page\'s read already answered both surfaces')
      },
    },
    {
      name: 'the sidebar capsule answers the quota question without a click, for every window',
      async run() {
        // The whole point of the capsule: the numbers are on screen in the
        // sidebar before anyone asks for them. All three windows, because they
        // fail on different clocks — a weekly window at 95% is the same bad news
        // arriving more slowly, and a single figure could not show it.
        const page = await renderPage({ fetch: host() })
        const capsule = page.surface('sidebar.footer.action')
        const tree = await capsule.open()
        equal(capsule.options.id, 'opencode-go-usage')
        is(typeof capsule.options.label, 'function')
        is(capsule.options.label(), 'OpenCode Go usage')
        // Left, not used — the ring states the same fact, and a figure whose
        // direction disagreed with its glyph would be worse than either alone.
        const visible = text(tree).replace(/\s+/g, ' ').trim()
        is(visible, '5H 92% Wk 58% Mo 9%')
        // One group per window, in a row rather than in stacked lines.
        const groups = nodes(tree).filter(({ node }) => node.props?.style?.gap === '4px')
        equal(groups.length, 3, 'one group per window')
        is(find(tree, (node) => node.type === 'button' && node.props.title !== undefined).props.style.flexDirection, undefined,
          'the row is horizontal, so it needs no direction of its own')

        // The visible text is abbreviated, so the accessible name is the one that
        // spells it out — and it has to contain every visible tag and figure, or a
        // speech user could not name the row they can see (WCAG 2.5.3).
        const row = find(tree, (node) => node.type === 'button' && node.props.title !== undefined)
        const name = String(row.props['aria-label'])
        for (const token of visible.split(' ')) {
          ok(name.includes(token), `the accessible name carries the visible "${token}": ${name}`)
        }
        for (const full of ['Rolling', 'Weekly', 'Monthly']) {
          ok(name.includes(full), `the accessible name also spells out "${full}"`)
        }
        ok(String(row.props.title).includes('click to see usage'), 'the tooltip says what a click does')

        // One read of the preference first — the foot does not know whether it
        // is shown until the row says so — then one read of the quota, not
        // forced: opening it must not spend a request inside the cache window
        // the Host keeps for the answer.
        equal(page.calls.map((call) => call.path), ['opencode-go/state', 'opencode-go/subscription'])
      },
    },
    {
      name: 'the capsule is drawn to the host foot\'s own measurements, rail variant included',
      async run() {
        // A footer row that picked its own height, radius, and type would read
        // as a foreign object in a column whose every other row is host-owned,
        // so the numbers are asserted rather than eyeballed.
        const page = await renderPage({ fetch: host() })
        const capsule = page.surface('sidebar.footer.action')
        const wide = await capsule.open({ wide: true })
        const row = find(wide, (node) => node.type === 'button' && node.props.title !== undefined)
        is(row.props.style.height, '42px')
        is(row.props.style.borderRadius, '12px')
        is(row.props.style.border, 'none')
        is(row.props.style.alignItems, 'center')
        // The three groups are spread across the row and separated by a hairline
        // each, rather than run together into one string of digits.
        is(row.props.style.justifyContent, 'space-between')
        equal(nodes(row).filter(({ node }) => node.props?.style?.width === '1px').length, 2, 'a divider between each pair')
        const figures = nodes(row).filter(({ node }) => node.props?.style?.fontVariantNumeric === 'tabular-nums')
        equal(figures.map(({ node }) => text(node)), ['92%', '58%', '9%'])
        // Pointer feedback: the row has to look like the control it is.
        is(typeof row.props.onPointerEnter, 'function')

        // On the rail there is no room for words, and three unnamed rings would be
        // three identical circles: it carries the rolling window alone, named for a
        // screen reader because there is no label left to read.
        const rail = await capsule.open({ wide: false })
        const railButtons = nodes(rail).filter(({ node }) => node.type === 'button')
        equal(railButtons.length, 1, 'no plugins page here, so the rail holds the ring alone')
        is(railButtons[0].node.props.style.width, '36px')
        is(railButtons[0].node.props.style.height, '36px')
        is(railButtons[0].node.props.style.borderRadius, '50%')
        ok(String(railButtons[0].node.props['aria-label']).includes('Rolling'), 'the rail names the window it shows')
        is(text(rail).trim(), '', 'the rail draws no words')

        // Where the plugins page does exist the rail stacks both circles, the
        // way the host's rail stacks its own footer actions.
        const wired = await renderPage({ fetch: host() })
        wired.optional.set('pluginNavigation', { openBundle: () => {} })
        const wiredRail = await wired.surface('sidebar.footer.action').open({ wide: false })
        const stacked = nodes(wiredRail).filter(({ node }) => node.type === 'button')
        equal(stacked.length, 2)
        is(stacked[1].node.props['aria-label'], 'Open the plugin configuration page')
        ok(String(stacked[0].node.props['aria-label']).includes('Rolling'), 'the rail still names the window it shows')
      },
    },
    {
      name: 'the capsule opens the usage panel, and shows no settings entry without a plugins page',
      async run() {
        const page = await renderPage({ fetch: host() })
        const capsule = page.surface('sidebar.footer.action')
        const tree = await capsule.open()
        // This deployment has no plugins page, so the gear is absent rather
        // than present and inert.
        is(nodes(tree).filter(({ node }) => node.type === 'button').length, 1)
        // The shell supplies the opener; without it the capsule is still the
        // quota readout, which is what it is for.
        is(find(tree, (node) => node.type === 'button').props.onClick() === undefined, true)

        const wired = await renderPage({ fetch: host() })
        const opened = []
        wired.optional.set('layout', { selectPanel: (id) => opened.push(id) })
        const capsuleWired = wired.surface('sidebar.footer.action')
        await capsuleWired.open()
        await capsuleWired.click((node) => node.type === 'button' && node.props.title?.includes('click to see usage') === true)
        equal(opened, ['opencode-go-usage'])
      },
    },
    {
      name: 'the usage panel carries the quota first and the counters under it',
      async run() {
        const page = await renderPage({ fetch: host() })
        const panel = page.surface('main')
        const tree = await panel.open()
        equal(panel.options.key, 'opencode-go-usage')

        // The same quota the configuration page shows, read from the same
        // endpoint — and read on open, because the panel exists to answer this.
        const bars = nodes(tree).filter(({ node }) => node.props?.role === 'progressbar')
        equal(bars.map(({ node }) => node.props['aria-valuenow']), [8, 42, 91])
        equal(page.calls.map((call) => call.path.split('?')[0]), ['opencode-go/subscription', 'opencode-go/usage'])
        ok(text(tree).includes('Rolling'), 'the shortest window is named as the service names it')
        ok(text(tree).includes('Resets'), 'each window says when it resets')
        ok(!text(tree).includes('the service refused this key'), 'a working quota is not reported as a failure')

        // The counters are the configuration page's own tables, in a lighter
        // frame: every figure a reader came for is here.
        ok(text(tree).includes('glm-5.3'), 'the per-model row is on the panel')
        ok(text(tree).includes('20%'), 'the hit rate is computed, not echoed')
        ok(text(tree).includes('This route\'s counters'), 'the local counters are their own section')
      },
    },
    {
      name: 'the panel says why there is no quota, without losing the counters',
      async run() {
        const page = await renderPage({ fetch: host({ subscription: { body: { ok: false, reason: 'unsupported' } } }) })
        const panel = page.surface('main')
        const tree = await panel.open()
        ok(text(tree).includes('this service or gateway does not serve it'), text(tree).slice(0, 200))
        // A deployment whose gateway does not meter a plan still knows what this
        // route spent, so the counters stay.
        ok(text(tree).includes('glm-5.3'), 'the counters survived the missing quota')
      },
    },
    {
      name: 'the panel re-reads the quota only when asked to',
      async run() {
        const page = await renderPage({ fetch: host() })
        const panel = page.surface('main')
        await panel.open()
        await panel.click((node) => node.type === 'button' && text(node).trim() === 'Re-read quota')
        const subscriptions = page.calls.filter((call) => call.path.startsWith('opencode-go/subscription'))
        equal(subscriptions.map((call) => call.path), ['opencode-go/subscription', 'opencode-go/subscription?refresh=1'])
      },
    },
    {
      name: 'one re-read moves the numbers on every surface that draws the quota',
      async run() {
        // Four surfaces draw one limit, and they are four separate React trees,
        // so the answer has to live outside all of them. Held inside each of
        // them, the panel's *Re-read quota* left the capsule at the numbers it
        // had read when it mounted: two figures for one plan, differing by
        // however much the plan moved while the session ran — and the capsule is
        // the one a reader watches while it works.
        const moved = {
          ...SUBSCRIPTION,
          cached: false,
          windows: [
            { name: 'rolling', status: 'ok', percent: 30, resetsAt: '2026-01-16T00:00:00.000Z' },
            { name: 'weekly', status: 'ok', percent: 50, resetsAt: '2026-01-19T00:00:00.000Z' },
            { name: 'monthly', status: 'ok', percent: 60, resetsAt: '2026-02-01T00:00:00.000Z' },
          ],
        }
        const base = host()
        const page = await renderPage({
          fetch: async (path, init) => {
            const answer = await base(path, init)
            return String(path).includes('refresh=1') ? { ...answer, body: moved } : answer
          },
        })

        await page.open()
        const capsule = page.surface('sidebar.footer.action')
        await capsule.open({ wide: true })
        const tab = page.surface('settings.plugins.tab')
        await tab.open()
        const panel = page.surface('main')
        await panel.open()

        // Every surface starts on the one answer, whichever of them read it.
        equal(bars(page.tree()), [8, 42, 91], 'the configuration page')
        equal(bars(tab.tree()), [8, 42, 91], 'the settings tab')
        equal(bars(panel.tree()), [8, 42, 91], 'the panel')
        equal(figures(capsule.tree()), ['92%', '58%', '9%'], 'the capsule')

        // Then a reader asks the panel for a fresh answer, and the surfaces they
        // never touched move with it.
        await panel.click((node) => node.type === 'button' && text(node).trim() === 'Re-read quota')

        equal(bars(panel.tree()), [30, 50, 60], 'the panel that was asked')
        equal(bars(page.tree()), [30, 50, 60], 'the configuration page')
        equal(bars(tab.tree()), [30, 50, 60], 'the settings tab')
        equal(figures(capsule.tree()), ['70%', '50%', '40%'], 'and the capsule, without being touched')

        // One surface asked the service, once: the re-read is forced, and no
        // mount in this case spent a second request on the same answer.
        const asked = page.calls
          .filter((call) => call.path.startsWith('opencode-go/subscription'))
          .map((call) => call.path)
        equal(asked.filter((path) => path.includes('refresh=1')), ['opencode-go/subscription?refresh=1'])
        equal(asked.length, 5, 'four mounts and the one re-read')
      },
    },
    {
      name: 'surfaces that mount together share the one read in flight',
      async run() {
        // The shell decides when the sidebar and a panel appear, and it can
        // render them without a beat between them. One answer is enough for
        // both: the read is held open here until the test releases it, which is
        // what a slow service looks like to a burst of mounts.
        let release
        const gate = new Promise((resolve) => {
          release = resolve
        })
        const base = host()
        const page = await renderPage({
          fetch: async (path, init) => {
            if (String(path).startsWith('opencode-go/subscription')) await gate
            return base(path, init)
          },
        })

        const capsule = page.surface('sidebar.footer.action')
        await capsule.open({ wide: true })
        const panel = page.surface('main')
        await panel.open()
        const asked = () => page.calls.filter((call) => call.path.startsWith('opencode-go/subscription'))

        equal(asked().length, 1, 'one request for a whole burst of mounts')
        ok(text(panel.tree()).includes('Reading the subscription quota'), 'and the surfaces say they are waiting')

        release()
        await page.update()

        equal(asked().length, 1, 'the answer already on its way is the one both surfaces show')
        equal(bars(panel.tree()), [8, 42, 91])
        equal(figures(capsule.tree()), ['92%', '58%', '9%'])
      },
    },
    {
      name: 'one read of a window is the table every surface showing it draws',
      async run() {
        // The counters are drawn by three surfaces in three separate React trees,
        // and each of them used to hold its own copy: *Refresh usage* on the panel
        // moved the panel and left the page and the settings tab on the numbers
        // they had read when they mounted. What is shared is the answer for a
        // window, whichever surface asked for it.
        let reads = 0
        const base = host()
        const page = await renderPage({
          fetch: async (path, init) => {
            const answer = await base(path, init)
            if (!String(path).startsWith('opencode-go/usage')) return answer
            // A distinguishable figure per read, so a stale table is visible.
            reads += 1
            return { ...answer, body: { ...answer.body, totals: { ...answer.body.totals, requests: reads * 10 } } }
          },
        })
        const panel = page.surface('main')
        const tab = page.surface('settings.plugins.tab')
        await page.open()
        await panel.open()
        await tab.open()

        const shown = () => [
          countersTotal(page.tree(), 'Usage'),
          countersTotal(panel.tree(), 'counters'),
          countersTotal(tab.tree(), 'counters'),
        ]

        // Three mounts, three reads, one answer: the last read is what all three
        // are showing, so no two surfaces disagree before anything is pressed.
        equal(reads, 3)
        equal(shown(), ['30', '30', '30'])

        await panel.click((node) => node.type === 'button' && text(node).trim() === 'Refresh usage')

        equal(reads, 4)
        equal(shown(), ['40', '40', '40'])
      },
    },
    {
      name: 'the window a reader opens belongs to the surface, not to the page',
      async run() {
        // A window is a question, not a fact: the reader who opens 30 days on the
        // panel has asked something the settings tab is not asking, so the two
        // tables are different answers rather than two copies of one. Sharing the
        // answer must not flatten that.
        const page = await renderPage({ fetch: host() })
        const panel = page.surface('main')
        const tab = page.surface('settings.plugins.tab')
        await page.open()
        await panel.open()
        await tab.open()

        await choose(panel, '30 days')

        equal(windowsAsked(page.calls), [7, 7, 7, 30], 'the panel asked for its own window')
        is(choice(panel.tree(), '30 days').props.value, '30')
        // The other two surfaces are still on 7 days, and still say so.
        for (const [where, tree] of [['the configuration page', page.tree()], ['the settings tab', tab.tree()]]) {
          is(choice(tree, '7 days').props.value, '7', where)
        }
      },
    },
    {
      name: 'two surfaces opening the same window at once share the one read',
      async run() {
        // A busy session can switch surfaces within one beat, and the counters are
        // the same report for both. The read is held open here until the test
        // releases it, which is what a slow bridge looks like to a burst.
        let release
        const gate = new Promise((resolve) => {
          release = resolve
        })
        const base = host()
        const page = await renderPage({
          fetch: async (path, init) => {
            if (String(path).startsWith('opencode-go/usage')) await gate
            return base(path, init)
          },
        })
        const panel = page.surface('main')
        await panel.open()
        const tab = page.surface('settings.plugins.tab')
        await tab.open()
        const asked = () => page.calls.filter((call) => call.path.startsWith('opencode-go/usage')).length

        equal(asked(), 1, 'one request for both surfaces')
        ok(text(panel.tree()).includes('Loading'), 'and the surfaces say they are waiting')
        ok(text(tab.tree()).includes('Loading'), 'the second one included')

        release()
        await page.update()

        equal(asked(), 1, 'the answer already on its way is the one both show')
        equal(countersTotal(panel.tree(), 'counters'), '4')
        equal(countersTotal(tab.tree(), 'counters'), '4')
      },
    },
    {
      name: 'a quiet page waits out the ceiling, and an active one the floor',
      async run() {
        // The schedule is the reason this store exists, and it is the one thing no
        // single render can show: a page on a fixed timer spends round trips on an
        // answer that has not moved, while a page that reads once goes stale while
        // the session runs. Every floor the page asks a question that costs
        // nothing — has anything been spent? — and reads the quota only when the
        // answer is yes, or when the answer on file has reached the ceiling.
        let spent = false
        const base = host()
        // The Host stamps each answer with its own clock, as it does in life; the
        // fixture's fixed stamp sits in this clock's future, and an answer that
        // never ages would make the ceiling untestable.
        let page
        page = await renderPage({
          fetch: async (path, init) => {
            if (String(path) === 'opencode-go/activity') {
              return { body: { ok: true, activity: spent, minIntervalSeconds: 30, maxIntervalSeconds: 1_800 } }
            }
            const answer = await base(path, init)
            if (String(path).startsWith('opencode-go/subscription')) {
              return { ...answer, body: { ...answer.body, fetchedAt: page.clock.value } }
            }
            return answer
          },
        })
        const reads = () => page.calls.filter((call) => call.path === 'opencode-go/subscription').length
        const checks = () => page.calls.filter((call) => call.path === 'opencode-go/activity').length
        await page.surface('sidebar.footer.action').open({ wide: true })
        equal(reads(), 1, 'mounting reads once')

        // Nothing has been spent: the checks run on the floor, but the answer is
        // trusted, so a minute of an idle session costs no quota reads at all.
        await page.advance(60_000)
        is(checks() >= 1, true, `the page does check on the floor: ${String(checks())}`)
        equal(reads(), 1, 'and an idle page does not read the quota')

        // Past the ceiling, the answer is old enough to distrust whatever the
        // route has been doing, and that is the read the ceiling is for.
        await page.advance(1_800_000)
        is(reads() >= 2, true, `the ceiling is where a quiet answer is checked again: ${String(reads())}`)
      },
    },
    {
      name: 'a check that finds activity reads at the floor, not before',
      async run() {
        // A running session finishes calls every few seconds, and the whole point
        // of the floor is that none of them becomes a read of its own.
        let spent = false
        const base = host()
        const page = await renderPage({
          fetch: async (path, init) => {
            if (String(path) === 'opencode-go/activity') {
              return { body: { ok: true, activity: spent, minIntervalSeconds: 30, maxIntervalSeconds: 1_800 } }
            }
            return base(path, init)
          },
        })
        const reads = () => page.calls.filter((call) => call.path === 'opencode-go/subscription').length
        await page.surface('sidebar.footer.action').open({ wide: true })
        equal(reads(), 1)

        spent = true
        await page.advance(29_000)
        equal(reads(), 1, 'the floor is not crossed early')
        await page.advance(2_000)
        equal(reads(), 2, 'and once it is, a page that knows the plan moved reads')

        // Ten minutes of a busy session at a 30-second floor: one read per floor
        // and no more, which is the bound the floor exists to state.
        await page.advance(600_000)
        const total = reads()
        is(total <= 23, true, `one read per floor, not a burst: ${String(total)} in ten minutes`)
        is(total >= 20, true, `and it does keep reading: ${String(total)}`)
      },
    },
    {
      name: 'an activity probe that cannot answer makes the page re-read the quota',
      async run() {
        // The probe is the cheap reason not to read; losing it is a reason to
        // read, not a licence to trust the answer on file. HTTP errors, a Host
        // `{ok:false}`, a malformed body, and a transport rejection all have to
        // land on the conservative side.
        const cases = [
          ['an HTTP failure', { status: 500, body: { ok: false, error: 'internal' } }],
          ['a Host refusal on HTTP 200', { body: { ok: false } }],
          ['a malformed answer', { body: { ok: true } }],
          ['a transport rejection', 'throw'],
        ]
        for (const [label, answer] of cases) {
          const base = host()
          const page = await renderPage({
            fetch: async (path, init) => {
              if (String(path) === 'opencode-go/activity') {
                if (answer === 'throw') throw new Error('fetch failed')
                return answer
              }
              return base(path, init)
            },
          })
          await page.surface('sidebar.footer.action').open({ wide: true })
          const reads = () => page.calls.filter((call) => call.path === 'opencode-go/subscription').length
          equal(reads(), 1, `${label}: mounting read the quota once`)
          await page.advance(31_000)
          equal(reads(), 2, `${label}: the floor re-read instead of trusting the probe`)
        }
      },
    },
    {
      name: 'the schedule runs only while a surface is showing the quota',
      async run() {
        // A closed panel is not a reason to spend a round trip, and the capsule is
        // not always in the sidebar. The store counts its mounted surfaces, so the
        // clock stops with the last of them and starts again with the next.
        const page = await renderPage({ fetch: host() })
        const capsule = page.surface('sidebar.footer.action')
        await capsule.open({ wide: true })
        const reads = () => page.calls.filter((call) => call.path.startsWith('opencode-go/')).length

        const atMount = reads()
        equal(page.calls.filter((call) => call.path === 'opencode-go/subscription').length, 1)
        // The effect that arms the clock is the one that unmounts it again: this
        // is what a surface going away looks like to the store.
        await capsule.close()
        await page.advance(3_600_000)
        equal(reads(), atMount, 'an hour with nothing on screen costs nothing')

        const tree = await capsule.open({ wide: true })
        equal(page.calls.filter((call) => call.path === 'opencode-go/subscription').length, 2, 'and the next surface reads on arrival')
        is(figures(tree).join(' ').includes('92%'), true, 'showing the answer it just read')
      },
    },
    {
      name: 'the re-read control sits with the quota label, once per surface',
      async run() {
        // The same action used to be drawn twice on the panel — once in the
        // header and once inside the quota block — which reads as two different
        // actions. It belongs with the label it acts on, and there is one of it.
        const page = await renderPage({ fetch: host() })
        const trees = [
          ['the configuration page', await page.open()],
          ['the usage panel', await page.surface('main').open()],
          ['the settings tab', await page.surface('settings.plugins.tab').open()],
        ]
        for (const [where, tree] of trees) {
          const reRead = nodes(tree)
            .filter(({ node }) => node.type === 'button' && text(node).trim() === 'Re-read quota')
          equal(reRead.length, 1, `${where}: one re-read control`)
          // Siblings, not merely both present: the row is the label's own, so a
          // reader finds the control where the block is named.
          const row = reRead[0].path[reRead[0].path.length - 1]
          ok(
            (row.children ?? []).some((child) => text(child).trim() === 'Subscription quota'),
            `${where}: the control shares its row with the quota label`,
          )
        }
      },
    },
    {
      name: 'the panel offers a way through to the plugin configuration, and only where it exists',
      async run() {
        const page = await renderPage({ fetch: host() })
        const bare = page.surface('main')
        const bareTree = await bare.open()
        is(nodes(bareTree).filter(({ node }) => text(node).trim() === 'Plugin settings').length, 0)
        ok(text(bareTree).includes('This deployment offers no way to open the configuration page'), 'the panel says why there is no entry')

        const wired = await renderPage({ fetch: host() })
        const opened = []
        wired.optional.set('pluginNavigation', { openBundle: (name) => opened.push(name) })
        const panel = wired.surface('main')
        const tree = await panel.open()
        await panel.click((node) => node.type === 'button' && text(node).trim() === 'Plugin settings')
        equal(opened, ['dsh-llm-opencode-go'])
        // The capsule carries the same entry, so the reader who sees the number
        // can reach the page that configures it without a detour.
        const capsule = wired.surface('sidebar.footer.action')
        const capsuleTree = await capsule.open()
        await capsule.click((node) => node.type === 'button' && node.props['aria-label'] === 'Open the plugin configuration page')
        equal(opened, ['dsh-llm-opencode-go', 'dsh-llm-opencode-go'])
        is(text(tree).includes('Plugins →'), false, 'the entry no longer spells out the path in prose')
      },
    },
    {
      name: 'the settings entry opens the settings dialog on this plugin\'s own row',
      async run() {
        // The page lives in the shell's settings dialog, and that dialog has no
        // service behind it: its state is a slot store only the shell renders,
        // and its `settings.open` command is reachable only through the shell's
        // keyboard layer. So the entry presses what a reader presses — the
        // control that opens the dialog, then this plugin's own nav row — rather
        // than dropping the reader on the Plugins page to find the row there.
        const pressed = []
        const opened = []
        const shell = settingsShell({ pressed })
        const page = await renderPage({ fetch: host(), document: shell.document })
        page.optional.set('pluginNavigation', { openBundle: (name) => opened.push(name) })

        const panel = page.surface('main')
        await panel.open()
        await panel.click((node) => node.type === 'button' && text(node).trim() === 'Plugin settings')

        equal(shell.triggered(), 1, 'the shell\'s own Settings control is what opens the dialog')
        equal(pressed, ['row'], 'and the row this plugin contributes is what it presses')
        equal(opened, [], 'the Plugins page is not used when the dialog answers')
        is(shell.dialogOpen(), true, 'the dialog is left open on the page')

        // Pressing again with the dialog already up is one press, not two: it
        // must not try to open a second dialog, and must still land on the row.
        await panel.click((node) => node.type === 'button' && text(node).trim() === 'Plugin settings')
        equal(shell.triggered(), 1, 'a dialog already on screen is not opened twice')
        equal(pressed, ['row', 'row'])

        // The capsule carries the same entry, so the reader who is looking at
        // the numbers reaches the page that configures them the same way.
        const capsule = page.surface('sidebar.footer.action')
        await capsule.open()
        await capsule.click((node) => node.type === 'button' && node.props['aria-label'] === 'Open the plugin configuration page')
        equal(shell.triggered(), 1, 'the dialog is still the one already on screen')
        equal(pressed, ['row', 'row', 'row'], 'and the gear lands on the row too')

        // The control is offered on the strength of the dialog alone, so a
        // deployment with no Plugins page still gets one.
        const withoutPage = await renderPage({ fetch: host(), document: settingsShell({ pressed: [] }).document })
        const barePanel = withoutPage.surface('main')
        const bareTree = await barePanel.open()
        ok(text(bareTree).includes('Plugin settings'), 'the settings dialog alone is enough to offer the entry')
      },
    },
    {
      name: 'a launcher that replaces the trigger still ends on this plugin\'s row',
      async run() {
        // The shape this deployment actually has: the account package occupies
        // the launcher seat, so the shell's own trigger is not rendered at all.
        // What is rendered is a menu button, and the *Settings* row that opens
        // the dialog does not exist until that menu is open — so this route is
        // one press more, and every press is still a reader's.
        const pressed = []
        const opened = []
        // One row before the shell's own, so a row found by position would be
        // the wrong one: only the shortcut says which row opens the dialog.
        const shell = settingsShell({ pressed, launcher: true, menuRowsBeforeSettings: 1 })
        const page = await renderPage({ fetch: host(), document: shell.document })
        page.optional.set('pluginNavigation', { openBundle: (name) => opened.push(name) })
        // The shell publishes the combination for `settings.open`, and that is
        // what identifies its *Settings* row inside the menu: the row is not in
        // the document before the menu is open, and its label is the shell's
        // copy, which this plugin never guesses.
        page.optional.set('shortcuts', { catalog: { getSnapshot: () => [{ id: 'settings.open', aria: 'Ctrl+,' }] } })
        const panel = page.surface('main')
        await panel.open()
        await panel.click((node) => node.type === 'button' && text(node).trim() === 'Plugin settings')

        equal(shell.menuOpened(), 1, 'the launcher menu is opened')
        equal(shell.triggered(), 1, 'its Settings row is what opens the dialog')
        equal(pressed, ['row'], 'and this plugin\'s row is what it presses')
        equal(opened, [], 'the Plugins page is not used when the dialog answers')
        is(shell.dialogOpen(), true, 'the dialog is left open on the page')
      },
    },
    {
      name: 'a launcher whose menu cannot be read falls back rather than guessing a row',
      async run() {
        // Without the published combination there is no way to tell the shell's
        // *Settings* row from its *Contact* or *Sign out* rows, and pressing a
        // guess is worse than not pressing: the reader would be signed out by a
        // gear. So this refuses to guess and takes the page that is an API.
        const pressed = []
        const opened = []
        const shell = settingsShell({ pressed, launcher: true })
        const page = await renderPage({ fetch: host(), document: shell.document })
        page.optional.set('pluginNavigation', { openBundle: (name) => opened.push(name) })
        const panel = page.surface('main')
        await panel.open()
        await panel.click((node) => node.type === 'button' && text(node).trim() === 'Plugin settings')
        equal(shell.menuOpened(), 0, 'no menu is opened')
        equal(pressed, [], 'and no row is guessed at')
        equal(opened, ['dsh-llm-opencode-go'], 'the Plugins page is where the reader lands')
      },
    },
    {
      name: 'the settings entry falls back to the plugins page when the shell has no opener',
      async run() {
        // A deployment whose shell renders no control for the dialog — the entry
        // has nothing to press — must still land somewhere: the Plugins page is
        // the door the shell publishes as an API, and it hosts the same page.
        const opened = []
        const page = await renderPage({ fetch: host(), document: settingsShell({ pressed: [], trigger: false }).document })
        page.optional.set('pluginNavigation', { openBundle: (name) => opened.push(name) })
        const panel = page.surface('main')
        await panel.open()
        await panel.click((node) => node.type === 'button' && text(node).trim() === 'Plugin settings')
        equal(opened, ['dsh-llm-opencode-go'], 'the Plugins page is the fallback')
      },
    },
    {
      name: 'an opener that opens nothing falls back to the plugins page',
      async run() {
        // The other half of the same fallback: a control is there and pressed,
        // but the dialog never mounts. The wait for the row is a poll, so this
        // case lets the clock run and then insists the reader is not left with a
        // press that did nothing.
        const pressed = []
        const opened = []
        const shell = settingsShell({ pressed, opens: false })
        const page = await renderPage({ fetch: host(), document: shell.document })
        page.optional.set('pluginNavigation', { openBundle: (name) => opened.push(name) })
        const panel = page.surface('main')
        await panel.open()
        await panel.click((node) => node.type === 'button' && text(node).trim() === 'Plugin settings')
        equal(shell.triggered(), 1, 'the opener was pressed')
        equal(opened, [], 'and nothing is decided before the poll gives up')
        // The wait for the row is one macrotask per attempt, and the harness
        // settles a bounded number of those per pass, so the poll is walked the
        // way the browser's event loop would walk it: a few rounds past the
        // twenty attempts the entry makes.
        for (let round = 0; round < 10; round += 1) await page.update()
        is(shell.dialogOpen(), false, 'the dialog never opened')
        equal(opened, ['dsh-llm-opencode-go'], 'so the Plugins page is where the reader lands')
        equal(pressed, [], 'and no row was ever pressed')
      },
    },
    {
      name: 'the panel\'s title row is pinned, and it carries the way out',
      async run() {
        const page = await renderPage({ fetch: host() })
        const opened = []
        page.optional.set('layout', { selectPanel: (id) => opened.push(id) })
        const panel = page.surface('main')
        const tree = await panel.open()

        // The header is pinned — and pinned against the column that scrolls,
        // which is the only thing that can hold it: a sticky row in a box that
        // does not scroll sits exactly where it was put.
        const pinned = nodes(tree).find(({ node }) => node.props?.style?.position === 'sticky')
        ok(pinned !== undefined, 'the header row is pinned')
        is(pinned.node.props.style.top, 0)
        ok(pinned.path.some((ancestor) => ancestor.props?.style?.overflowY === 'auto'),
          'the row is pinned against the scrolling column, not against a still box')

        // Pinned means painted: the tables pass beneath the row, and a
        // transparent one would let them show through the title.
        ok(String(pinned.node.props.style.background).startsWith('var(--dsw-alias-'),
          `the row covers what it pins over, got ${String(pinned.node.props.style.background)}`)
        // The column's own headroom moved onto the row, so the title still has
        // its 28px once the row has taken hold against the scrollport's edge.
        is(pinned.node.props.style.paddingTop, '28px')
        const scroller = find(tree, (node) => node.props?.style?.overflowY === 'auto')
        is(scroller.props.style.padding, '0 clamp(24px, 4vw, 48px) 48px', 'and only onto the row')

        // The row is where the dismissal lives, and it leaves the panel the way
        // the shell spells leaving one: the Conversation is the null panel.
        const close = nodes(tree)
          .find(({ node }) => node.type === 'button' && node.props['aria-label'] === 'Close the panel')
        ok(close !== undefined, 'the row carries the dismissal')
        ok(close.path.some((ancestor) => ancestor.props?.style?.position === 'sticky'),
          'the dismissal travels with the pinned row')
        is(text(close.node).trim(), '', 'the × is drawn, not typed')
        equal(nodes(close.node).filter(({ node }) => node.type === 'line').length, 2, 'drawn as two strokes')
        await panel.click((node) => node.type === 'button' && node.props['aria-label'] === 'Close the panel')
        equal(opened, [null], 'the dismissal selects the Conversation')
      },
    },
    {
      name: 'the dismissal is offered only where the shell can dismiss a panel',
      async run() {
        // No panel controller, nothing to select: the panel keeps its title row
        // and loses the ×, the same rule the settings entry follows.
        const page = await renderPage({ fetch: host() })
        const tree = await page.surface('main').open()
        is(nodes(tree)
          .filter(({ node }) => node.type === 'button' && node.props['aria-label'] === 'Close the panel').length, 0)
        is(nodes(tree).filter(({ node }) => node.props?.style?.position === 'sticky').length, 1,
          'the title row is pinned whether or not it can be dismissed')
      },
    },
    {
      name: 'one ring per window, each sized by what that window has left',
      async run() {
        const page = await renderPage({ fetch: host() })
        const capsule = page.surface('sidebar.footer.action')
        const tree = await capsule.open({ wide: true })

        // Three rings, one per window — not three arcs sharing a circle. An arc
        // inside a shared glyph has no room for a name, which is the whole reason
        // the foot lists windows instead of drawing a single pie chart.
        const rings = nodes(tree).filter(({ node }) => node.type === 'svg')
        equal(rings.length, 3, 'one ring per window')
        for (const { node } of rings) {
          is(node.props.width, 12)
          is(node.props.height, 12)
          is(node.props.viewBox, '0 0 12 12')
          // A block box, not an inline one: an inline SVG sits on its line's text
          // baseline and rides high beside the label.
          is(node.props.style.display, 'block')
        }

        // One track and one arc per ring, and the arc is the share *left*: the
        // rolling window at 8% used draws nearly the whole circle, and the monthly
        // one at 91% draws a ninth.
        const circumference = 2 * Math.PI * (12 / 2 - 1.5)
        const arcs = nodes(tree).filter(({ node }) => node.type === 'circle' && node.props.strokeDasharray !== undefined)
        equal(arcs.length, 3, 'one arc per metered window')
        const drawn = arcs.map(({ node }) => Number(node.props.strokeDasharray.split(' ')[0]) / circumference)
        ok(drawn[0] > 0.85, `the rolling window is nearly full, got ${String(drawn[0])}`)
        ok(drawn[1] > 0.5 && drawn[1] < 0.65, `the weekly window is over half, got ${String(drawn[1])}`)
        ok(drawn[2] < 0.15, `the monthly window is nearly spent, got ${String(drawn[2])}`)
        for (const { node } of arcs) {
          is(node.props.transform, 'rotate(-90 6 6)', 'every arc starts at the top')
          is(String(node.props.stroke).startsWith('var(--dsw-alias-'), true, `a theme token, got ${String(node.props.stroke)}`)
        }
        // The colours follow the same thresholds the bars in the panel use: 91%
        // used is the warning state, not the error one, which is the state a
        // window holds only once it is actually spent.
        equal(arcs.map(({ node }) => node.props.stroke), [
          'var(--dsw-alias-state-success-primary)',
          'var(--dsw-alias-state-success-primary)',
          'var(--dsw-alias-state-warn-primary)',
        ])
        const tracks = nodes(tree).filter(({ node }) => node.type === 'circle' && node.props.stroke === 'var(--dsw-alias-state-idle-primary)')
        equal(tracks.length, 3, 'a track under each arc')

        // A spent window has nothing left to draw, so its ring keeps the track
        // and loses the arc: the same shape an unreported window takes, which is
        // why the figure beside each ring is what says which case it is.
        const spent = await renderPage({
          fetch: host({
            subscription: {
              body: {
                ...SUBSCRIPTION,
                windows: [{ name: 'rolling', status: 'ok', percent: 100, resetsAt: '2026-01-16T00:00:00.000Z' }],
              },
            },
          }),
        })
        const spentTree = await spent.surface('sidebar.footer.action').open({ wide: true })
        equal(nodes(spentTree).filter(({ node }) => node.type === 'circle' && node.props.strokeDasharray !== undefined).length, 0)
        equal(nodes(spentTree).filter(({ node }) => node.type === 'circle').length, 3, 'every window keeps its track')
        // The figure is on the span, not on the text node inside it: filtering the
        // text nodes and then asking them for a style finds nothing at all.
        const spentFigures = nodes(spentTree).filter(({ node }) => node.props?.style?.fontVariantNumeric === 'tabular-nums')
        equal(spentFigures.map(({ node }) => text(node)), ['0%', '—', '—'], 'a spent window says zero, an unreported one says nothing')
      },
    },
    {
      name: 'the capsule reports a service it could not reach instead of an empty ring',
      async run() {
        const page = await renderPage({ fetch: host({ subscription: { body: { ok: false, reason: 'unreachable' } } }) })
        const capsule = page.surface('sidebar.footer.action')
        const tree = await capsule.open({ wide: true })
        // Bare tracks, so the rings read as "not measured" rather than "nothing
        // left", and the figures say so rather than showing three zeroes.
        equal(nodes(tree).filter(({ node }) => node.type === 'circle' && node.props.strokeDasharray !== undefined).length, 0)
        equal(nodes(tree).filter(({ node }) => node.type === 'circle').length, 3)
        const figures = nodes(tree).filter(({ node }) => node.props?.style?.fontVariantNumeric === 'tabular-nums')
        equal(figures.map(({ node }) => text(node)), ['—', '—', '—'], 'the figures refuse to invent numbers')
        // The window tags stay: the reader can still see which windows exist.
        for (const tag of ['5H', 'Wk', 'Mo']) ok(text(tree).includes(tag), `${tag} is still named`)
      },
    },
    {
      name: 'the settings navigation carries the plugin\'s own configuration page',
      async run() {
        const page = await renderPage({ fetch: host() })
        const section = page.surface('settings.section')
        const tree = await section.open()

        // The same page the Plugins row renders, as a row of Settings' own
        // navigation. Every endpoint the configuration page needs is read here
        // too — a second component that fetched a subset would look right and
        // edit nothing.
        equal(section.options.label(), 'OpenCode Go')
        equal(page.calls.map((call) => call.path.split('?')[0]), [
          'opencode-go/subscription',
          'opencode-go/state',
          'opencode-go/models',
          'opencode-go/usage',
        ])

        // The fields are fields, not a readout: the reader who came to Settings
        // to configure this plugin can type here.
        const said = text(tree).replace(/\s+/g, ' ')
        for (const heading of ['Connection', 'API key', 'Models', 'Variants', 'Usage']) {
          ok(said.includes(heading), `the page carries its ${heading} section`)
        }
        ok(nodes(tree).some(({ node }) => node.type === 'input'), 'the API key field is editable here')
        ok(nodes(tree).filter(({ node }) => node.type === 'button').length > 0, 'and so are its controls')
      },
    },
    {
      name: 'the settings tab renders the panel sections on its own',
      async run() {
        const page = await renderPage({ fetch: host() })
        const tab = page.surface('settings.plugins.tab')
        const tree = await tab.open()
        equal(tab.options.label(), 'OpenCode Go usage')
        equal(page.calls.map((call) => call.path.split('?')[0]), ['opencode-go/subscription', 'opencode-go/usage'])
        equal(nodes(tree).filter(({ node }) => node.props?.role === 'progressbar').length, 3)
        ok(text(tree).includes('glm-5.3'), 'the tab carries the counters too')
      },
    },
    {
      name: 'the models toolbar actions share one button size',
      async run() {
        // Four secondary actions sit on one toolbar row. One of them used the
        // 36px button primitive and the other three the 28px one, so the row
        // read as two toolbars stapled together.
        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        const labels = ['Show all', 'Hide all', 'Fetch available models', 'Refresh page list', 'Hide retired models']
        const buttons = labels.map((label) => nodes(tree).find(({ node }) => node.type === 'button'
          && text(node).trim() === label)?.node)
        for (const [index, node] of buttons.entries()) {
          ok(node !== undefined, `the "${labels[index]}" action rendered`)
        }
        const box = ({ height, fontSize, padding }) => ({ height, fontSize, padding })
        const first = box(buttons[0].props.style)
        for (const button of buttons.slice(1)) {
          equal(box(button.props.style), first, 'every action uses the same button box')
        }
        is(first.height, '28px', 'and that box is the settings page small button')
        is(first.fontSize, '12px')
      },
    },
    {
      name: 'the retired rows can be hidden from the list, and the choice persists',
      async run() {
        // A retired model is history: the card shows its row by default, but a
        // reader who only wants the models the service still serves can keep
        // those rows out of the list. The choice is a persisted display
        // preference, so a reopened page reads it back.
        const retired = {
          id: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          hidden: true,
          hiddenReason: 'retired',
          retired: true,
          replacement: 'deepseek-v4.1-flash',
          trainingGated: false,
          protocols: ['chat-completions', 'responses', 'anthropic'],
        }
        const catalog = {
          ...CATALOG,
          counts: { total: 4, listed: 2, hidden: 1, hiddenByTraining: 0, retired: 1, variants: 1 },
          models: [...CATALOG.models, retired],
        }
        const fixture = statefulHost()
        const fetch = async (path, init) => (String(path) === 'opencode-go/models'
          ? { body: catalog }
          : fixture.fetch(path, init))
        const page = await renderPage({ fetch })
        const tree = await page.open()
        ok(text(tree).includes('deepseek-v4-flash'), 'the retired row is visible by default')
        const after = await page.click((node) => node.type === 'button'
          && text(node).trim() === 'Hide retired models')
        const writes = page.calls.filter((call) => call.path === 'opencode-go/config')
        equal(writes.length, 1, 'one press is one write')
        equal(JSON.parse(writes[0].init.body), { set: { showRetiredModels: false } })
        is(text(after).includes('deepseek-v4-flash'), false, 'the retired row leaves the list')
        ok(text(after).includes('Show retired models'), 'the control now offers the way back')
        // The Host echoed the write, so a fresh page reads the choice back.
        const reopened = await renderPage({ fetch })
        const reopenedTree = await reopened.open()
        is(text(reopenedTree).includes('deepseek-v4-flash'), false, 'the choice survives a reopen')
        ok(text(reopenedTree).includes('Show retired models'), 'and the control reflects it')
      },
    },
  ],
}
