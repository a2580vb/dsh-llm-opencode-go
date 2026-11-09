/**
 * Minimal test runner: no framework, no dependency beyond Node itself, so the
 * suite runs from a bare checkout.
 *
 * Each file under `suites/` default-exports `{ name, cases }` where a case is
 * `{ name, run }`. `run` may be synchronous or return a promise; a thrown error
 * or a rejected promise is a failure.
 */

import { readdir, readFile } from 'node:fs/promises'
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

// The four places the suite's size is stated to a reader. A stale badge is a
// published fact that is wrong, so the runner refuses to stay green when the
// count it just ran is not the count those files claim.
const stated = [
  ['README.md', /offline_checks-(\d+)-brightgreen/],
  ['README.zh-CN.md', /offline_checks-(\d+)-brightgreen/],
  ['docs/development.md', /# (\d+) offline checks/],
  ['docs/development.zh-CN.md', /# (\d+) 项离线检查/],
]
const root = join(here, '..')
const mismatches = []
for (const [file, pattern] of stated) {
  let text
  try {
    text = await readFile(join(root, file), 'utf8')
  } catch {
    continue // a tree without the docs (a tarball) has nothing to check
  }
  const claimed = text.match(pattern)?.[1]
  if (claimed !== String(total)) mismatches.push(`${file} says ${claimed ?? 'nothing'}`)
}
if (mismatches.length > 0) {
  console.log(`\nthe offline-check count is out of step with this run (${total}): ${mismatches.join(', ')}`)
  console.log('update the badge and both development pages together with the cases')
  process.exitCode = 1
}
