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

/** A Host that answers from one table of endpoints, recording every request. */
function host(overrides = {}) {
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
      name: 'opening the page reads the three endpoints it needs, usage included',
      async run() {
        const page = await renderPage({ fetch: host() })
        await page.open()
        equal(page.calls.map((call) => call.path.split('?')[0]), [
          'opencode-go/state',
          'opencode-go/models',
          'opencode-go/usage',
        ])
        // The window is explicit and is the default one, so the page never
        // depends on the Host guessing what it meant.
        equal(windowsAsked(page.calls), [7])
      },
    },
    {
      name: 'the usage tables carry the figures, with the window that is showing',
      async run() {
        const page = await renderPage({ fetch: host() })
        const tree = await page.open()
        const section = find(tree, (node) => node.type === 'section' && text(node).includes('Usage'))
        ok(section !== undefined, 'the usage section rendered')

        // Three tables, in the order the page introduces them: totals, then the
        // per-model breakdown, then the per-day series.
        const [totalsTable, modelTable, dayTable] = tables(section)
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
        // Nothing declared yet, so this case is about adding one.
        const page = await renderPage({ fetch: host({ models: { body: { ...CATALOG, variants: [] } } }) })
        await page.open()
        const byLabel = (label) => (node) => node.props['aria-label'] === label
        await page.change(byLabel('Model'), 'glm-5.3')
        await page.change(byLabel('Variant name'), 'fast')
        await page.change(byLabel('Default thinking level'), 'low')
        const draft = await page.click((node) => node.type === 'button' && text(node).trim() === 'Add variant')
        ok(text(draft).includes('glm-5.3@fast'), 'the draft entry names the id it will be offered under')
        // Figures belong to the entry, so they are edited on the row the form
        // just added rather than in the form.
        await page.change(byLabel('glm-5.3@fast Context window'), '200000')
        await page.click((node) => node.type === 'button' && text(node).trim() === 'Save variants')
        const written = page.calls.find((call) => call.path === 'opencode-go/config')
        // The form holds strings; the config holds what the schema declares,
        // and a name is part of an id a person types.
        equal(JSON.parse(written.init.body), {
          set: { modelVariants: [{ model: 'glm-5.3', name: 'fast', effort: 'low', contextWindow: 200_000 }] },
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
