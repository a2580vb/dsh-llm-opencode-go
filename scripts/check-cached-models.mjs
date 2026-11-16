/**
 * Compare the measured context windows with the OpenCode catalogue this machine
 * has cached.
 *
 * Only `limit.context` is compared: output caps and input modalities belong to
 * `snapshot-models.mjs`, which compares all three against the catalogue it
 * reads. The comparison here needs a file only this machine has, so it is a
 * maintainer's check rather than an offline case — the suite runs on fresh
 * clones, where no cache exists, and a case there would count as a check while
 * comparing nothing.
 *
 *   node scripts/check-cached-models.mjs
 *
 * Exit status is zero when there is no cache (nothing to compare) or when the
 * measured context windows agree, and one when one disagrees.
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
