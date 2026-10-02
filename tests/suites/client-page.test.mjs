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

/** A usage table with one model's calls. */
const USAGE = {
  ok: true,
  window: 7,
  today: '2026-01-15',
  windows: [1, 7, 30],
  days: [{ day: '2026-01-15', counters: { requests: 4, failures: 1, inputTokens: 400, outputTokens: 100, totalTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
  models: [{ model: 'glm-5.3', counters: { requests: 4, failures: 1, inputTokens: 400, outputTokens: 100, totalTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
  totals: { requests: 4, failures: 1, inputTokens: 400, outputTokens: 100, totalTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
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

        // Four tables, in the order the page introduces them: the provider's
        // own quota, then totals, then the per-model breakdown, then the
        // per-day series.
        const [quotaTable, totalsTable, modelTable, dayTable] = tables(section)
        equal(rows(quotaTable)[0], ['Window', 'Used', 'Resets'], 'the quota table comes first')
        const totals = rows(totalsTable)
        equal(totals[0], ['Total', 'Calls', 'Failed', 'Input tokens', 'Output tokens', 'Total tokens', 'Cache read'])
        equal(totals[1], ['Total', '4', '1', '400', '100', '500', '0'], totals[1].join(','))
        const byModel = rows(modelTable)
        equal(byModel[0], ['Model', 'Calls', 'Failed', 'Input tokens', 'Output tokens', 'Total tokens'])
        equal(byModel[1], ['glm-5.3', '4', '1', '400', '100', '500'])
        const byDay = rows(dayTable)
        equal(byDay[0], ['Day', 'Calls', 'Failed', 'Total tokens'])
        equal(byDay[1], ['2026-01-15', '4', '1', '500'])

        // The selected window is the one markable as current, so a reader can
        // tell what the numbers cover.
        const thirty = button(tree, '30 days')
        const seven = button(tree, '7 days')
        is(seven.props.style.background, 'var(--dsw-alias-brand-primary)')
        ok(thirty.props.style.background !== 'var(--dsw-alias-brand-primary)')
      },
    },
    {
      name: 'the quota panel shows the service\'s own three windows, and a refresh forces a read',
      async run() {
        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        const section = find(tree, (node) => node.type === 'section' && text(node).includes('Usage'))
        const [quotaTable] = tables(section)
        const quota = rows(quotaTable)
        equal(quota[1][0], 'Rolling')
        equal(quota[1][1], '8%')
        equal(quota[2][1], '42%')
        equal(quota[3][1], '91%')
        // The window a reader is closest to losing is the one worth noticing,
        // so it carries the warning colour rather than the ordinary one.
        const monthly = nodes(quotaTable).find(({ node }) => node.type === 'span' && text(node) === '91%')
        is(monthly?.node.props.style.color, 'var(--dsw-alias-state-warn-primary)')

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
        const [, totalsTable] = tables(section)
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
  ],
}
