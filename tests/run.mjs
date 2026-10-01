/**
 * Minimal test runner: no framework, no dependency beyond Node itself, so the
 * suite runs from a bare checkout.
 *
 * Each file under `suites/` default-exports `{ name, cases }` where a case is
 * `{ name, run }`. `run` may be synchronous or return a promise; a thrown error
 * or a rejected promise is a failure.
 */

import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suitesDir = join(here, 'suites')

const failures = []
let passed = 0
let total = 0

// A leading underscore marks a shared helper, not a suite.
const files = (await readdir(suitesDir))
  .filter((name) => name.endsWith('.mjs') && !name.startsWith('_'))
  .sort()

for (const file of files) {
  const module = await import(pathToFileURL(join(suitesDir, file)).href)
  const suite = module.default
  if (suite === undefined) {
    failures.push({ suite: file, name: '<module>', error: new Error('suite has no default export') })
    continue
  }
  console.log(`\n${suite.name ?? file}`)
  for (const testCase of suite.cases ?? []) {
    total += 1
    const label = testCase.name ?? '<unnamed case>'
    try {
      await testCase.run()
      passed += 1
      console.log(`  ok   ${label}`)
    } catch (error) {
      failures.push({ suite: suite.name ?? file, name: label, error })
      console.log(`  FAIL ${label}`)
    }
  }
}

console.log(`\n${passed}/${total} passed`)
for (const failure of failures) {
  console.log(`\n--- ${failure.suite} :: ${failure.name}`)
  console.log(failure.error?.stack ?? String(failure.error))
}
if (failures.length > 0) process.exitCode = 1
