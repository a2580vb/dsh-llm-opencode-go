/**
 * Compare the fallback capability table with the OpenCode catalogue this
 * machine has cached.
 *
 * The offline suite runs on fresh clones, where no OpenCode cache exists. The
 * comparison used to live there as a case that called `ok(true)` when the cache
 * was absent, so it counted as a check without checking anything. It is a
 * maintainer's check instead: run it after OpenCode has cached a catalogue.
 *
 *   node scripts/check-cached-models.mjs
 *
 * Exit status is zero when there is no cache (nothing to compare) or when the
 * measured rows agree, and one when a context window disagrees.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CAPABILITY_SOURCE, capabilityFor, measuredIds } from '../lib/model/limits.js'

const paths = [
  process.env.OC_MODELS_CACHE,
  join(homedir(), '.cache', 'opencode', 'models.json'),
].filter((path) => path !== undefined)

let models
for (const path of paths) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    const provider = parsed?.['opencode-go']
    if (provider?.models !== undefined) {
      models = provider.models
      break
    }
  } catch {
    // Try the next candidate; a missing catalogue just means there is nothing
    // to compare on this machine.
  }
}

if (models === undefined) {
  console.log('no local OpenCode catalogue to compare against')
  process.exit(0)
}

const measured = new Set(measuredIds())
const mismatches = []
for (const id of Object.keys(models)) {
  if (!measured.has(id)) continue
  const context = models[id]?.limit?.context
  if (context === undefined) continue
  const record = capabilityFor(id, {})
  if (record.contextWindow !== context) {
    mismatches.push(`${id}: table ${record.contextWindow} vs catalogue ${context}`)
  }
}

if (mismatches.length > 0) {
  console.error(`snapshot ${CAPABILITY_SOURCE} disagrees with the cached catalogue:`)
  for (const line of mismatches) console.error(`  ${line}`)
  process.exit(1)
}
console.log(`snapshot ${CAPABILITY_SOURCE} agrees with the cached catalogue`)
