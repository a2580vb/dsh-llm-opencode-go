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
  credential: { configured: true, source: 'store', writable: true },
  environment: { key: 'OPENCODE_GO_API_KEY', present: false },
  config: { editable: true, fields: { hiddenModels: [], modelVariants: [] }, override: {} },
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
  today: '2026-01-15',
  windows: [1, 7, 30],
  days: [{ day: '2026-01-15', counters: { ...CACHED } }],
  models: [{ model: 'glm-5.3', counters: { ...CACHED } }],
  totals: { ...CACHED },
  firstDay: '2026-01-15',
  retentionDays: 30,
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

/** A Host that answers from one table of endpoints, recording every request. */function host(overrides = {}) {
  return async (path) => {
    const [name, query] = String(path).split('?')
    if (name === 'opencode-go/state') return { body: STATE, ...overrides.state }
    if (name === 'opencode-go/models') return { body: CATALOG, ...overrides.models }
    if (name === 'opencode-go/usage') {
      const days = Number(new URLSearchParams(query).get('days'))
      return { body: { ...USAGE, window: days }, ...overrides.usage }
    }
    if (name === 'opencode-go/config') return { body: { ok: true, config: { override: {} } }, ...overrides.config }
    if (name === 'opencode-go/credential') return { body: { ok: true }, ...overrides.credential }
    if (name === 'opencode-go/refresh') return { body: { ok: true, discovered: 3, added: [], removed: [], catalog: CATALOG }, ...overrides.refresh }
    if (name === 'opencode-go/subscription') return { body: { ...SUBSCRIPTION, cached: query === 'refresh=1' ? false : true }, ...overrides.subscription }
    throw new Error(`the page called an endpoint the Host does not serve: ${name}`)
  }
}

/** The usage requests the page made, as window numbers. */
const windowsAsked = (calls) => calls
  .filter((call) => call.path.startsWith('opencode-go/usage'))
  .map((call) => Number(new URLSearchParams(String(call.path).split('?')[1]).get('days')))

/** The button whose label is `label`. */
const button = (tree, label) => {
  const match = nodes(tree).find(({ node }) => node.type === 'button' && text(node).trim() === label)
  return match?.node
}

/** The quota bars of one surface, as the share each one shows as spent. */
const bars = (tree) => nodes(tree)
  .filter(({ node }) => node.props?.role === 'progressbar')
  .map(({ node }) => node.props['aria-valuenow'])

/** What the capsule prints, window by window. */
const figures = (tree) => nodes(tree)
  .filter(({ node }) => node.props?.style?.fontVariantNumeric === 'tabular-nums')
  .map(({ node }) => text(node))

export default {
  name: 'client page',
  cases: [
    {
      name: 'opening the page reads every endpoint it needs, the subscription included',
      async run() {
        const page = await renderPage({ fetch: host() })
        await page.open()
        equal(page.calls.map((call) => call.path.split('?')[0]), [
          'opencode-go/state',
          'opencode-go/models',
          'opencode-go/usage',
          // The provider's own quota is read once on open. It is not forced,
          // so opening the page does not spend a request inside the cache
          // window the Host keeps for it.
          'opencode-go/subscription',
        ])
        // The window is explicit and is the default one, so the page never
        // depends on the Host guessing what it meant.
        equal(windowsAsked(page.calls), [7])
        is(page.calls.some((call) => call.path.includes('refresh=1')), false)
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

        // The selected window is the one markable as current, so a reader can
        // tell what the numbers cover.
        const thirty = button(tree, '30 days')
        const seven = button(tree, '7 days')
        is(seven.props.style.background, 'var(--dsw-alias-brand-primary)')
        ok(thirty.props.style.background !== 'var(--dsw-alias-brand-primary)')
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
        await page.click((node) => node.type === 'button' && text(node).trim() === '30 days')
        equal(windowsAsked(page.calls), [7, 30])
        // The table itself follows the window it was read for, rather than
        // whatever the Host answered first.
        const section = find(page.tree(), (node) => node.type === 'section' && text(node).includes('Usage'))
        ok(text(section).includes('2026-01-15'), 'the table is still on screen')
        is(button(page.tree(), '30 days').props.style.background, 'var(--dsw-alias-brand-primary)')
        is(button(page.tree(), '7 days').props.style.background, 'var(--dsw-alias-bg-layer-2)')
      },
    },
    {
      name: 'refreshing usage reads the window the reader chose, not the default',
      async run() {
        const page = await renderPage({ fetch: host() })
        await page.open()
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Today')
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Refresh usage')
        equal(windowsAsked(page.calls), [7, 1, 1])
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
        ok(text(tree).includes('Model visibility'), 'the other sections still render')
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
        await page.click((node) => node.type === 'button' && text(node).trim() === '30 days')
        const section = find(page.tree(), (node) => node.type === 'section' && text(node).includes('Usage'))
        ok(text(section).includes('Could not read usage: the file is gone'), text(section))
      },
    },
    {
      name: 'the models section offers the whole catalog and the fetch control',
      async run() {
        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        ok(text(tree).includes('glm-5.3'), 'a listed model')
        ok(text(tree).includes('space-bunny-free'), 'a hidden model is still shown, so it can be brought back')
        const fetched = await page.click((node) => node.type === 'button' && text(node).trim() === 'Fetch the model list')
        equal(page.calls.filter((call) => call.path === 'opencode-go/refresh').length, 1)
        ok(text(fetched).includes('Re-read 3 models'), text(fetched).slice(-200))
      },
    },
    {
      name: 'a model that trains on the conversation says so, in warning colour',
      async run() {
        // The gate is a data-policy fact about the conversation rather than a
        // property of the model, so the badge says what becomes of the
        // conversation and wears the warning colour — not the neutral grey the
        // model's own facts wear beside it.
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

        const badge = nodes(tree)
          .find(({ node }) => node.type === 'span' && text(node).trim() === 'conversations used for training')
        ok(badge !== undefined, 'the gated model says what becomes of the conversation')
        ok(
          text(badge.path[badge.path.length - 1]).includes('muse-spark-1.3-contributor'),
          'and says it on that model\'s own row',
        )

        const style = badge.node.props.style
        ok(String(style.color).includes('state-warn'), `the badge warns: ${String(style.color)}`)
        // A tint rather than the full-strength colour: the badge sits in a row of
        // that model's own facts and must not shout them down.
        const fill = String(style.background)
        ok(fill.includes('color-mix') && fill.includes('state-warn'), `the fill is a pale warning: ${fill}`)
        for (const [name, value] of [['text', String(style.color)], ['fill', fill]]) {
          ok(!/#[0-9a-f]{3,6}\b|rgba?\(/i.test(value), `${name} is a theme token, not a literal: ${value}`)
        }

        // Only that one badge warns. Two warnings in one row are decoration, and
        // the facts about the model itself keep the neutral colour they had.
        const others = nodes(tree)
          .filter(({ node }) => node.type === 'span' && ['hidden', 'reasoning'].includes(text(node).trim()))
        equal(others.length, 2, 'the neutral badges are both still rendered')
        for (const { node } of others) {
          is(node.props.style.color, 'var(--dsw-alias-label-secondary)', 'a neutral badge kept its colour')
        }

        // The sentence the Chinese page shows, pinned by name: it is the one
        // that says the conversations go to training.
        const zh = await renderPage({ fetch: host({ models: { body: gated } }), locale: 'zh' })
        ok(text(await zh.open()).includes('模型对话会用于训练'), 'the Chinese badge says it in the reader\'s words')
      },
    },
    {
      name: 'hiding models writes the visibility list and re-reads the row',
      async run() {
        const page = await renderPage({ fetch: host() })
        await page.open()
        // Two models are offered (the third is already hidden), so hiding the
        // listing is a draft the reader can still change their mind about.
        const hidden = await page.click((node) => node.type === 'button' && text(node).trim() === 'Hide all')
        ok(text(hidden).includes('2 unsaved change(s)'), text(hidden).slice(0, 0))
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Save visibility')

        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body), {
          set: { hiddenModels: ['glm-5.3', 'glm-5.3@fast', 'space-bunny-free'] },
        })
        // The write reloads the plugin row, so the page reads the catalog back
        // before telling the reader it worked.
        const after = page.calls.slice(page.calls.indexOf(written)).map((call) => call.path)
        ok(after.includes('opencode-go/models'), after.join(','))
        is(after[after.length - 1], 'opencode-go/state', 'the state is re-read last, so the page shows what the Host resolved')
      },
    },
    {
      name: 'a hidden id the catalog does not list survives an unrelated save',
      async run() {
        // A deployment that hid a model OpenCode has not published yet must not
        // lose that line by opening the page and saving something else.
        const page = await renderPage({
          fetch: host({ models: { body: { ...CATALOG, hidden: [...CATALOG.hidden, 'not-published-yet'] } } }),
        })
        await page.open()
        await page.change((node) => node.props.type === 'checkbox' && node.props['aria-label'] === 'glm-5.3: Listed', false)
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Save visibility')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        const hidden = JSON.parse(written.init.body).set.hiddenModels
        ok(hidden.includes('not-published-yet'), hidden.join(','))
        ok(hidden.includes('glm-5.3'), hidden.join(','))
      },
    },
    {
      name: 'a variant is built in the form and saved as it was filled in',
      async run() {
        // Nothing declared yet, so this case is about adding one. A variant
        // combines all four settings the feature exists for -- protocol,
        // thinking level, context window, output cap -- so the case sets all
        // four and checks all four arrive.
        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        await page.open()
        const byLabel = (label) => (node) => node.props['aria-label'] === label
        await page.change(byLabel('Model'), 'glm-5.3')
        await page.change(byLabel('Variant name'), 'fast')
        await page.change(byLabel('Protocol first'), 'chat-completions')
        await page.change(byLabel('Default thinking level'), 'low')
        const draft = await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        ok(text(draft).includes('glm-5.3@fast'), 'the draft entry names the id it will be offered under')
        // The figures belong to the entry, so they are edited on the row the
        // form just added rather than in the form.
        await page.change(byLabel('glm-5.3@fast Context window'), '200000')
        await page.change(byLabel('glm-5.3@fast Output cap'), '32768')
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Save variants')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        // The form holds strings; the config holds what the schema declares,
        // and a name is part of an id a person types.
        equal(JSON.parse(written.init.body), {
          set: {
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
        // The row's fields are behind its edit control, so the reader opens it
        // before there is anything to type into.
        await page.click((node) => node.type === 'button' && node.props['aria-label'] === 'Edit variant glm-5.3@fast')
        // The Host reports a variant with an `id`, because that is what the
        // model list offers. Echoing it back on save would write a key the
        // config does not declare into the profile patch.
        await page.change((node) => node.props['aria-label'] === 'glm-5.3@fast Context window', '200000')
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Save variants')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body), {
          set: { modelVariants: [{ model: 'glm-5.3', name: 'fast', contextWindow: 200_000 }] },
        })
      },
    },
    {
      name: 'a variant row keeps its fields behind an edit control, and open while it is renamed',
      async run() {
        const page = await renderPage({ fetch: host() })
        await page.open()
        const row = () => find(page.tree(), (node) => node.type === 'section' && text(node).includes('Model variants'))
        // The fields a row owns are the ones labelled with its own id, which
        // keeps the add form's two boxes out of the count.
        const owned = (id) => nodes(row())
          .map(({ node }) => node.props?.['aria-label'])
          .filter((label) => typeof label === 'string' && label.startsWith(`${id} `))
          .sort()
        const button = (label) => nodes(row()).find(({ node }) => (
          node.type === 'button' && node.props?.['aria-label'] === label
        ))?.node

        // A declared variant opens shut: a list of presets rather than a wall of
        // boxes. The six fields are the row's whole substance, so the row head
        // carries the one control that reveals them.
        equal(owned('glm-5.3@fast'), [], 'the declared row starts with no fields on screen')
        ok(button('Edit variant glm-5.3@fast') !== undefined, 'and offers the control that opens it')
        is(button('Edit variant glm-5.3@fast').props['aria-expanded'], false)

        await page.click((node) => node.type === 'button' && node.props['aria-label'] === 'Edit variant glm-5.3@fast')
        equal(owned('glm-5.3@fast'), [
          'glm-5.3@fast Context window',
          'glm-5.3@fast Default thinking level',
          'glm-5.3@fast Display name',
          'glm-5.3@fast Output cap',
          'glm-5.3@fast Protocol first',
          'glm-5.3@fast Variant name',
        ].sort(), 'the six fields appeared for the row that asked for them')
        ok(button('Finish editing variant glm-5.3@fast') !== undefined, 'the control now offers the way back')
        is(button('Finish editing variant glm-5.3@fast').props['aria-expanded'], true)

        // Renaming is the case a row's identity has to survive: the name is half
        // of the id, so a row keyed by its id would be rebuilt on the first
        // keystroke — and shut in the reader's face.
        await page.change((node) => node.props['aria-label'] === 'glm-5.3@fast Variant name', 'fastest')
        equal(owned('glm-5.3@fast'), [], 'the field no longer answers to the name it had')
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
        await page.change((node) => node.type === 'select' && node.props['aria-label'] === 'Model', 'glm-5.3')
        await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'Variant name', 'slow')
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        // The row lands where the reader is looking, so the cap and window it
        // was just created to carry are one keystroke away rather than a click.
        for (const field of ['Context window', 'Output cap']) {
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
        // The two name rules — what a blank name becomes, and what a name may
        // hold — used to sit between the form's two rows, which drew a line
        // through it: the fields read as two groups rather than one form. They
        // go under it now, where a footnote belongs.
        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        await page.open()
        // A model with a thinking ladder, so the form shows all five of its
        // fields rather than four.
        await page.change((node) => node.type === 'select' && node.props['aria-label'] === 'Model', 'glm-5.3')

        const section = find(page.tree(), (node) => node.type === 'section' && text(node).includes('Model variants'))
        const flat = nodes(section).map(({ node }) => node)
        const at = (predicate) => flat.findIndex(predicate)
        const field = (label) => at((node) => (node.type === 'input' || node.type === 'select')
          && node.props?.['aria-label'] === label)
        const note = (opening) => at((node) => node.type === 'p' && text(node).startsWith(opening))

        const fields = ['Model', 'Variant name', 'Display name', 'Protocol first', 'Default thinking level']
          .map(field)
        const control = at((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        ok(fields.every((index) => index >= 0), 'every field of the add form is on screen')
        ok(control >= 0, 'and the control that submits it')

        for (const [what, index] of [
          ['the note about a blank name', note('Leave the name blank and it becomes')],
          ['the name rule', note('A variant name may hold letters')],
        ]) {
          ok(index >= 0, `${what} is on screen`)
          // Strictly after every field and the button: a note that lands between
          // two fields is what split the form in the first place.
          const after = [...fields, control].every((position) => position < index)
          ok(after, `${what} sits under the whole form, not inside it`)
        }
      },
    },
    {
      name: 'a variant name left blank takes the default the placeholder showed',
      async run() {
        // The default is named after the thinking level the variant sets, which
        // is the thing that tells two presets of one model apart.
        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        await page.open()
        const nameBox = () => nodes(page.tree())
          .find(({ node }) => node.type === 'input' && node.props['aria-label'] === 'Variant name')?.node
        await page.change((node) => node.type === 'select' && node.props['aria-label'] === 'Model', 'glm-5.3')
        await page.change((node) => node.type === 'select' && node.props['aria-label'] === 'Default thinking level', 'high')
        is(nameBox().props.placeholder, 'high', 'the placeholder names the default before it is used')
        // The page also spells out the id the default will produce.
        ok(text(page.tree()).includes('glm-5.3@high'), 'the full default id is on screen')

        await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        const added = nodes(page.tree()).find(({ node }) => node.type === 'span' && text(node) === 'glm-5.3@high')
        ok(added !== undefined, 'the entry took the default name')
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Save variants')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body), {
          set: { modelVariants: [{ model: 'glm-5.3', name: 'high', effort: 'high' }] },
        })
      },
    },
    {
      name: 'a variant that names no level falls back to the protocol, then to a plain word',
      async run() {
        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        await page.open()
        const nameBox = () => nodes(page.tree())
          .find(({ node }) => node.type === 'input' && node.props['aria-label'] === 'Variant name')?.node
        // No model chosen yet: nothing distinguishes the variant, and the page
        // says so rather than showing a half-built id.
        ok(text(page.tree()).includes('<model>@<thinking level>'), 'the generic form is named')
        await page.change((node) => node.type === 'select' && node.props['aria-label'] === 'Model', 'glm-5.3')
        is(nameBox().props.placeholder, 'default', 'a variant that restates nothing is called "default"')
        await page.change((node) => node.type === 'select' && node.props['aria-label'] === 'Protocol first', 'anthropic-messages')
        is(nameBox().props.placeholder, 'anthropic-messages', 'a protocol the variant sets names it instead')
        // A typed name always wins over the default.
        await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'Variant name', 'chatty')
        is(nameBox().props.value, 'chatty')
      },
    },
    {
      name: 'the variant list can be added to and removed from, by name',
      async run() {
        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        // Scoped to the variants section: the visibility list above it also
        // renders model ids, and one of them is this variant's id.
        const section = find(tree, (node) => node.type === 'section' && text(node).includes('Model variants'))
        ok(section !== undefined, 'the variants section rendered')
        const ids = () => nodes(find(page.tree(), (node) => node.type === 'section' && text(node).includes('Model variants')))
          .filter(({ node }) => node.type === 'span' && node.props.style?.color === 'var(--dsw-alias-label-secondary)')
          .map(({ node }) => text(node))
          .filter((value) => /@/.test(value) && !value.includes('<model>'))
        // The saved variant is listed, with its count stated.
        equal(ids(), ['glm-5.3@fast'], 'the declared variant is in the list')
        ok(text(page.tree()).includes('Variant list (1)'), 'the list says how many it holds')

        // Adding one from the form appends it and updates the count.
        await page.change((node) => node.type === 'select' && node.props['aria-label'] === 'Model', 'glm-5.3')
        await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'Variant name', 'slow')
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        equal(ids(), ['glm-5.3@fast', 'glm-5.3@slow'])
        ok(text(page.tree()).includes('Variant list (2)'))

        // Removing one takes it back out, and the save writes what is left.
        await page.click((node) => node.type === 'button' && node.props['aria-label'] === 'Remove variant glm-5.3@fast')
        equal(ids(), ['glm-5.3@slow'])
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Save variants')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body), { set: { modelVariants: [{ model: 'glm-5.3', name: 'slow' }] } })
      },
    },
    {
      name: 'a name edited in the list is written, and one that collides is refused before saving',
      async run() {
        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        await page.open()
        const add = async (name) => {
          await page.change((node) => node.type === 'select' && node.props['aria-label'] === 'Model', 'glm-5.3')
          await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'Variant name', name)
          await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        }
        await add('one')
        await add('two')
        // Rename the second one onto the first: the id would stop being unique.
        await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'glm-5.3@two Variant name', 'one')
        const save = () => nodes(page.tree())
          .find(({ node }) => node.type === 'button' && text(node).trim() === 'Save variants')?.node
        is(save().props.disabled, true, 'Save is inert while a name collides')
        ok(text(page.tree()).includes('glm-5.3@one'), 'the collision is named by the id it would create')

        // A rename that does not collide is written under the new name.
        await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'glm-5.3@one Variant name', 'three')
        is(save().props.disabled, false)
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Save variants')
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
        await page.change(byLabel('Model'), 'glm-5.3')
        await page.change(byLabel('Variant name'), 'fast')
        const tree = await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        ok(text(tree).includes('Variant "glm-5.3@fast" is already declared.'), text(tree).slice(-300))
        // The draft is unchanged, so the save control is inert and nothing is
        // written: the Host would refuse a duplicate anyway, and the page does
        // not make the reader find that out from an error.
        is(button(tree, 'Save variants').props.disabled, true)
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
        await page.open()
        const field = (node) => node.props.type === 'password'
        await page.change(field, 'sk-a-secret-value')
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Save')
        const written = page.calls.find((call) => call.path === 'opencode-go/credential')
        is(written.init.method, 'POST')
        equal(JSON.parse(written.init.body), { value: 'sk-a-secret-value' })
        const cleared = find(page.tree(), field)
        is(cleared.props.value, '', 'the field is emptied, so the key is not left in the page')
        ok(text(page.tree()).includes('Saved; the next request uses the new key.'), 'the reader is told it worked')
      },
    },
    {
      name: 'a key the launching environment supplies explains itself and offers no clear button',
      async run() {
        // The case the report is about: `OPENCODE_GO_API_KEY` is exported in the
        // shell DSH was started from. The credential seam refuses to replace or
        // remove it, so a Clear button that looked pressable would be a lie.
        const page = await renderPage({
          fetch: host({
            state: {
              body: {
                ...STATE,
                credential: {
                  configured: true,
                  source: 'env',
                  writable: false,
                  removable: false,
                  blockedBy: 'launching-environment',
                  reference: 'OPENCODE_GO_API_KEY',
                  environment: { variable: 'OPENCODE_GO_API_KEY', present: true, source: 'process', path: null },
                },
                environment: { variable: 'OPENCODE_GO_API_KEY', present: true, source: 'process', path: null },
              },
            },
          }),
        })
        const tree = await page.open()
        const section = find(tree, (node) => node.type === 'section' && text(node).includes('API key'))
        const shown = text(section)
        ok(shown.includes('from the launching environment'), shown.slice(0, 300))
        ok(shown.includes('OPENCODE_GO_API_KEY'), 'the message names the variable holding the value')
        ok(shown.includes('point the credential reference below at another name'), 'and the way out of it')

        // Clear is present but inert: the browser will not fire it, and neither
        // does the harness.
        const clear = nodes(section).find(({ node }) => node.type === 'button' && text(node).trim() === 'Clear key')
        is(clear.node.props.disabled, true, 'Clear key is disabled while clearing would do nothing')
        // Storing is refused too, and for the same reason: a stored value under
        // a name the launching environment already supplies would be shadowed
        // and would never be read. The reference editor below is the way out,
        // and the page says so rather than offering a button that cannot work.
        const field = nodes(section).find(({ node }) => node.type === 'input' && node.props.type === 'password')
        is(field.node.props.disabled, true, 'the key field is inert while a store would be shadowed')
        is(
          nodes(section).find(({ node }) => node.type === 'button' && text(node).trim() === 'Save').node.props.disabled,
          true,
        )
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
                  configured: true,
                  source: 'env',
                  writable: false,
                  removable: false,
                  blockedBy: 'launching-environment',
                  reference: 'OPENCODE_GO_API_KEY',
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
        // The save button is inert until the name actually differs, so it can
        // never write back the value it read.
        const save = () => nodes(page.tree())
          .find(({ node }) => node.type === 'button' && text(node).trim() === 'Save reference')?.node
        is(save().props.disabled, true)
        await page.change((node) => node.type === 'input' && node.props['aria-label'] === 'Credential reference', 'OPENCODE_GO_HOME_KEY')
        is(save().props.disabled, false)
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Save reference')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        equal(JSON.parse(written.init.body), { set: { apiKeyEnv: 'OPENCODE_GO_HOME_KEY' } })
      },
    },
    {
      name: 'a gateway that rejects the key says so without a Save button that would work',
      async run() {
        const page = await renderPage({ fetch: host() })
        await page.open()
        await page.change((node) => node.props.type === 'password', 'sk-wrong')
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Save')
        ok(text(page.tree()).includes('Saved; the next request uses the new key.'))

        // And a refusal is reported in the reader's own words, not as a status.
        const refused = await renderPage({
          fetch: host({ credential: { body: { ok: false, message: 'the credential store refused it' } } }),
        })
        await refused.open()
        await refused.change((node) => node.props.type === 'password', 'sk-wrong')
        await refused.click((node) => node.type === 'button' && text(node).trim() === 'Save')
        ok(text(refused.tree()).includes('the credential store refused it'), text(refused.tree()).slice(0, 300))
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
        ok(noEditorText.includes('this deployment has no profile configuration editor'), noEditorText.slice(-220))
        ok(noEditorText.includes('still readable and usage is still recorded'), 'what still works is named')
        // The page is still usable for the parts that cannot write.
        ok(noEditorText.includes('Model visibility'), 'the sections still render')

        const noRow = await renderPage({
          fetch: host({ state: { body: { ...STATE, config: { editable: false, reason: 'entry-not-found' } } } }),
        })
        const noRowText = text(await noRow.open())
        ok(noRowText.includes('no profile entry for this plugin was found'), noRowText.slice(-220))
        is(noRowText.includes('no-config-editor'), false, 'the wrong reason is not shown')
      },
    },
    {
      name: 'no control is ever sized along the wrong axis',
      async run() {
        // The class of bug this guard exists for: `flex: '0 0 200px'` means a
        // *width* in a row container and a *height* in a column one. A box that
        // carried that shorthand into the labelled column around it was 200px
        // tall and clipped its own placeholder text. Every behavioural assertion
        // passes anyway -- the control still holds the right value and still
        // fires the right handler -- so it has to be checked structurally.
        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        const problems = []
        let checked = 0
        for (const { node, path } of nodes(tree)) {
          if (node.type !== 'input' && node.type !== 'select' && node.type !== 'textarea') continue
          const style = node.props.style ?? {}
          const named = node.props['aria-label'] ?? node.props.type ?? node.type
          // A checkbox is not a text control: the platform draws it and it has
          // no 30px box to keep in step with the buttons beside it.
          const toggle = node.type === 'input' && ['checkbox', 'radio', 'range', 'file'].includes(node.props.type)
          if (toggle) continue
          checked += 1
          // A column ancestor is what turns a basis into a height.
          const column = path.some((ancestor) => ancestor.props?.style?.flexDirection === 'column')
          const basis = typeof style.flex === 'string'
            ? style.flex.split(/\s+/).find((part) => /[\d.]/.test(part))
            : undefined
          if (column && basis !== undefined) {
            problems.push(`${named}: flex "${style.flex}" inside a column container`)
          }
          // Whatever the container, a text control is 30px tall: that is what
          // every button beside it is, and the line box is pinned to match so
          // the host's own input rules cannot inflate it.
          if (style.height !== '30px') problems.push(`${named}: height ${String(style.height)}`)
          if (style.boxSizing !== 'border-box') problems.push(`${named}: box-sizing ${String(style.boxSizing)}`)
        }
        equal(problems, [], problems.join(' · '))
        ok(checked > 6, `the page actually rendered the controls this checks (${String(checked)})`)
      },
    },
    {
      name: 'the variant form lays its labelled fields out in one band',
      async run() {
        // The reader-visible symptom of the bug above: the name and display-name
        // columns towered over the model select beside them, so the row read
        // bottom-aligned and out of the order the code declares. Every labelled
        // field in that band is the same height now, which is what makes the
        // labels line up.
        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        const tree = await page.open()
        const section = find(tree, (node) => node.type === 'section' && text(node).includes('Model variants'))
        ok(section !== undefined, 'the variants section rendered')
        const band = nodes(section)
          .filter(({ node }) => node.type === 'div' && node.props.style?.display === 'flex')
          .map(({ node }) => node.children ?? [])
          .find((children) => children.some((child) => text(child).includes('Pick a model')))
        ok(band !== undefined, 'the add-a-variant row rendered')

        // Model, Variant name, Display name -- the order the code declares, and
        // each column holds exactly one control. The label is the child span,
        // so the column's own text starts with it.
        const labelOf = (child) => text((child.children ?? [])[0]).trim()
        equal(band.map(labelOf), ['Model', 'Variant name', 'Display name'])
        for (const child of band) {
          const controls = nodes(child).filter(({ node }) => node.type === 'input' || node.type === 'select')
          equal(controls.length, 1, `${text(child).trim().slice(0, 18)} holds one control`)
          equal(controls[0].node.props.style.height, '30px')
          equal(controls[0].node.props.style.flex, 'none', 'no basis, so no height from the wrong axis')
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
          // 12px text: ~7px for a wide glyph (CJK, capitals), ~6px otherwise,
          // less the control's own padding.
          const placeholder = node.props.placeholder
          const wide = [...placeholder].filter((char) => /[\u3000-\u9fff\uFF00-\uFFEF]/.test(char)).length
          const estimate = (placeholder.length - wide) * 6 + wide * 12
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
        // One dictionary feeds all three surfaces, so a sentence edited for one
        // is edited for the rest — and this case is what keeps that true. It
        // pins the sentences where the panel and the tab show them, and refuses
        // the retired ones everywhere, because "the configuration page was
        // updated and the panel still says the old thing" is exactly how these
        // two blocks drifted apart before.
        const page = await renderPage({ fetch: host() })
        const flat = (tree) => text(tree).replace(/\s+/g, ' ')
        const config = flat(await page.open())
        const panel = flat(await page.surface('main').open())
        const tab = flat(await page.surface('settings.plugins.tab').open())

        const shared = [
          'Calls and tokens recorded locally, grouped by this machine\'s calendar day and kept for 30 days.'
          + ' It counts this plugin\'s route only; the model provider\'s billing may differ.',
          'Hit rate = cache read ÷ (uncached input + cache read). A service that never reported a cache figure shows "—".',
          'Read at ',
        ]
        for (const sentence of shared) {
          for (const [where, surface] of [['the configuration page', config], ['the panel', panel], ['the settings tab', tab]]) {
            ok(surface.includes(sentence), `${where} carries "${sentence.slice(0, 48)}…"`)
          }
        }

        // The pointer to the panel belongs where the reader is not yet in it.
        ok(config.includes('The keyboard shortcut Ctrl/Cmd+U opens the usage panel.'), 'the configuration page names the shortcut')

        // Copy that was taken out stays out, on every surface: a retired
        // sentence that survives on one of them is the bug this guards.
        const retired = [
          'counts only the part of the prompt',
          'rather than a 0%',
          'asking again forces a fresh read',
          'Both of these also have a page of their own',
          'one model\'s second set of settings',
          'It is a local alias',
        ]
        for (const phrase of retired) {
          for (const [where, surface] of [['the configuration page', config], ['the panel', panel], ['the settings tab', tab]]) {
            is(surface.includes(phrase), false, `${where} no longer says "${phrase}"`)
          }
        }
      },
    },
    {
      name: 'the summary view asks the Host for nothing at all',
      async run() {
        const page = await renderPage({ fetch: host() })
        const tree = await page.open('summary')
        equal(page.calls.length, 0)
        is(text(tree), 'Configure the key, models, and usage')
      },
    },
    {
      name: 'every control the page renders has a label a reader can read',
      async run() {
        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        const labels = buttons(tree)
        for (const label of ['Save', 'Clear key', 'Save visibility', 'Discard changes', 'Reload list', 'Fetch the model list', 'Save variants', 'Refresh usage', 'Today', '7 days', '30 days']) {
          ok(labels.includes(label), `a "${label}" control is rendered: [${labels.join(', ')}]`)
        }
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

        // One read, not forced: opening it must not spend a request inside the
        // cache window the Host keeps for the answer.
        equal(page.calls.map((call) => call.path), ['opencode-go/subscription'])
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
        ok(text(bareTree).includes('This deployment has no plugins page'), 'the panel says why there is no entry')

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
        equal(section.options.label(), 'OpenCode Go settings')
        equal(page.calls.map((call) => call.path.split('?')[0]), [
          'opencode-go/state',
          'opencode-go/models',
          'opencode-go/usage',
          'opencode-go/subscription',
        ])

        // The fields are fields, not a readout: the reader who came to Settings
        // to configure this plugin can type here.
        const said = text(tree).replace(/\s+/g, ' ')
        for (const heading of ['Connection', 'API key', 'Model visibility', 'Model variants', 'Usage']) {
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
  ],
}
