/**
 * Rewrite the fallback capability table in `lib/model/limits.js`.
 *
 * The table is a snapshot of `https://models.dev/api.json`'s `opencode-go`
 * entry, which is where OpenCode publishes context windows, output caps, and
 * input modalities. The adapter prefers the live `GET /models` rows — they now
 * carry the same facts — and falls back to this table when discovery states
 * nothing: a `modelSource: config` deployment, an empty catalog, a cache file
 * written before the service published the facts, or a model the catalogue has
 * never described. Taking that snapshot from models.dev keeps the fallback
 * reproducible without a credential.
 *
 *   node scripts/snapshot-models.mjs            # report the diff, write nothing
 *   node scripts/snapshot-models.mjs --write     # rewrite the two tables
 *
 * A row is reported as:
 *   `new`       the catalogue names an id neither table holds
 *   `changed`   an id both know, with different figures
 *   `gone`      the MODEL table holds an id the catalogue no longer lists under
 *               `opencode-go`; it moves to the `DELISTED` table, because an
 *               existing conversation may still name it. Rows already in that
 *               table stay there and are not reported again — otherwise every
 *               run after a rewrite would list them as fresh news.
 *
 * Ids the service actually serves but the catalogue never described are not
 * visible here: `/models` lists them and no source publishes their figures. They
 * stay on the family fallback in `limits.js` until the catalogue catches up, and
 * a live discovery row fills them in the meantime.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CATALOGUE = process.env.MODELS_DEV_URL ?? 'https://models.dev/api.json'
const PROVIDER = 'opencode-go'
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TARGET = join(ROOT, 'lib', 'model', 'limits.js')

const write = process.argv.includes('--write')

const response = await fetch(CATALOGUE)
if (!response.ok) {
  console.error(`${CATALOGUE} answered HTTP ${response.status}`)
  process.exit(1)
}
const payload = await response.json()
const provider = payload?.[PROVIDER]
if (provider?.models === undefined) {
  console.error(`${CATALOGUE} has no "${PROVIDER}" provider entry`)
  process.exit(1)
}

/** One catalogue row as the table's shape. */
function row(id) {
  const model = provider.models[id]
  const contextWindow = model?.limit?.context
  const maxTokens = model?.limit?.output
  const modalities = model?.modalities?.input
  if (!Number.isFinite(contextWindow) || !Number.isFinite(maxTokens) || !Array.isArray(modalities)) {
    console.error(`ignoring ${id}: incomplete limit or modalities`)
    return undefined
  }
  return { id, contextWindow, maxTokens, modalities: [...modalities] }
}

const live = new Map()
for (const id of Object.keys(provider.models)) {
  const entry = row(id)
  if (entry !== undefined) live.set(id, entry)
}

const { MODEL_CAPABILITIES, DELISTED_CAPABILITIES } = await import(`${pathToFileURL(TARGET).href}?v=${Date.now()}`)
const asRow = ([id, contextWindow, maxTokens, modalities]) => [
  id,
  { id, contextWindow, maxTokens, modalities: [...modalities] },
]
const model = new Map(MODEL_CAPABILITIES.map(asRow))
const delisted = new Map(DELISTED_CAPABILITIES.map(asRow))
const known = new Map([...delisted, ...model])

const same = (a, b) => a.contextWindow === b.contextWindow
  && a.maxTokens === b.maxTokens
  && a.modalities.join('+') === b.modalities.join('+')

const additions = [...live.values()].filter((entry) => !known.has(entry.id))
const changes = [...live.values()].filter((entry) => known.has(entry.id) && !same(entry, known.get(entry.id)))
const removals = [...model.values()].filter((entry) => !live.has(entry.id))
/** Rows that were delisted before and stay that way; merging them keeps the table from shrinking. */
const keptDelisted = [...delisted.values()].filter((entry) => !live.has(entry.id))

console.log(`${CATALOGUE}: ${live.size} models under "${PROVIDER}";`
  + ` MODEL holds ${model.size}, DELISTED holds ${delisted.size}`)
for (const entry of additions) console.log(`new      ${format(entry)}`)
for (const entry of changes) {
  const before = known.get(entry.id)
  console.log(`changed  ${entry.id}: was ${before.contextWindow}/${before.maxTokens} [${before.modalities.join('+')}]`
    + ` -> ${entry.contextWindow}/${entry.maxTokens} [${entry.modalities.join('+')}]`)
}
for (const entry of removals) console.log(`gone     ${entry.id}`)
if (additions.length + changes.length + removals.length === 0) console.log('the table is current')

if (!write) {
  console.log('\nre-run with --write to rewrite the table')
  process.exit(0)
}

/** Render one table as the source text `limits.js` expects. */
function table(name, rows) {
  const body = rows
    .map((entry) => `  ['${entry.id}', ${entry.contextWindow.toLocaleString('en-US').replace(/,/gu, '_')}, `
      + `${entry.maxTokens.toLocaleString('en-US').replace(/,/gu, '_')}, [${entry.modalities.map((m) => `'${m}'`).join(', ')}]],`)
    .join('\n')
  // The declaration form is part of the replacement, so a rewrite keeps the
  // `export` the module's consumers import.
  return `export const ${name} = Object.freeze([\n${body}\n])`
}

const source = await readFile(TARGET, 'utf8')
const stamp = new Date().toISOString().slice(0, 10)
const gone = [...removals, ...keptDelisted].sort((left, right) => left.id.localeCompare(right.id))
const updated = source
  .replace(/export const CAPABILITY_SOURCE = '[^']*'/, `export const CAPABILITY_SOURCE = 'models.dev/${PROVIDER}@${stamp}'`)
  .replace(/export const MODEL_CAPABILITIES = Object\.freeze\(\[[\s\S]*?\n\]\)/, table('MODEL_CAPABILITIES', [...live.values()]))
  .replace(/export const DELISTED_CAPABILITIES = Object\.freeze\(\[[\s\S]*?\n\]\)/, table('DELISTED_CAPABILITIES', gone))

if (updated === source) {
  console.error('nothing was rewritten; the anchors in limits.js did not match')
  process.exit(1)
}
await writeFile(TARGET, updated, 'utf8')
console.log(`\nrewrote ${TARGET}`)

/** One row as a one-line report. */
function format(entry) {
  return `${entry.id}: ${entry.contextWindow}/${entry.maxTokens} [${entry.modalities.join('+')}]`
}
