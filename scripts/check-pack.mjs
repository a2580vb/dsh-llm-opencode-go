/**
 * The tarball `npm publish` would upload, checked against what it has to carry.
 *
 * `files` is an allowlist, which makes two failures possible and both silent: a
 * document added to the repository and not to that list is a document the
 * package does not have, and an entry that matches nothing publishes nothing.
 * Neither shows up in a diff, and the offline suite cannot see either — it reads
 * the repository, not the artifact.
 *
 * So this packs the real thing and reads the real tarball. Nothing is captured
 * from a child process: npm writes the file, this reads the file. That is also
 * the only shape an environment forbidding piped stdio allows, which is what
 * keeps the check identical in CI and on a developer's machine.
 *
 *   npm run check:pack
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Everything a published package must contain.
 *
 * The list is deliberately short and about *kinds* of file rather than about
 * every file: the pair of READMEs, the pair of changelogs, the patch the Loader
 * reads, the two halves of the client, the locale files the Harness loads
 * without activating the plugin, and the license npm adds on its own.
 */
export const ANCHORS = Object.freeze([
  'package/package.json',
  'package/LICENSE',
  'package/README.md',
  'package/README.zh-CN.md',
  'package/CHANGELOG.md',
  'package/CHANGELOG.zh-CN.md',
  'package/cordis.patch.yml',
  'package/lib/index.js',
  'package/lib/client.js',
  'package/lib/ui/bridge.js',
  'package/lib/usage/store.js',
  'package/locale/en.json',
  'package/locale/zh.json',
])

/** Path prefixes that must never reach a published package. */
export const FORBIDDEN = Object.freeze([
  'package/tests/',
  'package/scripts/',
  'package/.github/',
  'package/node_modules/',
  'package/.test-cache/',
  'package/.live-cache/',
  'package/.npm-cache/',
  'package/promotion/',
])

/**
 * What npm adds whether or not `files` names it.
 *
 * `package.json` is the manifest and the license is a legal requirement, so both
 * travel with every publish; they are therefore allowed to sit outside the
 * allowlist when coverage is computed.
 */
const ALWAYS = Object.freeze(['package/package.json', 'package/LICENSE'])

/**
 * The entry names inside one tar archive.
 *
 * npm writes a plain `ustar` archive, so this reads what it wrote rather than
 * asking a tool to describe it: `name` at 0, `size` as octal at 124, the type at
 * 156, and the `prefix` field as the directory of a long name. A pax header is a
 * real entry that describes the next one, so its payload is skipped.
 *
 * @param {Buffer} archive - the uncompressed tar bytes.
 * @returns {string[]} the entry names, in archive order.
 */
export function tarEntries(archive) {
  const names = []
  let at = 0
  while (at + 512 <= archive.length) {
    const header = archive.subarray(at, at + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0[\s\S]*$/, '')
    const name = field(0, 100)
    const size = Number.parseInt(field(124, 136).trim() || '0', 8)
    const type = field(156, 157)
    const prefix = field(345, 500)
    const payload = Number.isFinite(size) ? Math.ceil(size / 512) * 512 : 0
    if (type !== 'x' && type !== 'g' && name !== '') names.push(prefix === '' ? name : `${prefix}/${name}`)
    at += 512 + payload
  }
  return names
}

/** `files` names paths in the repository; the tarball spells them under `package/`. */
function coveredByFiles(entry, listed) {
  return listed.some((name) => entry === `package/${name}` || entry.startsWith(`package/${name}/`))
}

/**
 * Everything wrong with one tarball, as sentences naming what is wrong.
 *
 * Split from the packing so the rules can be read and tested without running
 * npm: this is the part with the judgement in it, and the part a change to
 * `files` is meant to satisfy.
 *
 * @param {string[]} entries - the tarball's entry names.
 * @param {object} manifest - the parsed `package.json`.
 * @returns {string[]} the problems, empty when the tarball is what it should be.
 */
export function packProblems(entries, manifest) {
  const problems = []
  const present = (name) => entries.includes(name)
  const listed = Array.isArray(manifest.files) ? manifest.files : []

  if (listed.length === 0) problems.push('package.json has no `files` allowlist, so everything is published')

  for (const entry of listed) {
    // A `files` entry matching nothing is a rename someone forgot, or a typo.
    // npm reports it as neither an error nor a warning.
    if (!entries.some((name) => coveredByFiles(name, [entry]))) {
      problems.push(`\`files\` names "${entry}", which contributed nothing to the tarball`)
    }
  }
  for (const anchor of ANCHORS) {
    if (!present(anchor)) problems.push(`the tarball is missing ${anchor}`)
  }
  for (const prefix of FORBIDDEN) {
    const leaked = entries.filter((entry) => entry.startsWith(prefix))
    if (leaked.length > 0) problems.push(`the tarball carries ${prefix} (${leaked.length} entries, e.g. ${leaked[0]})`)
  }
  for (const entry of entries) {
    if (!coveredByFiles(entry, listed) && !ALWAYS.includes(entry)) {
      problems.push(`${entry} is published but no \`files\` entry covers it`)
    }
  }

  // Every document ships in both languages, and a half-pair is exactly the kind
  // of omission this check exists for: named once, translated later, no release.
  for (const entry of entries.filter((name) => /^package\/docs\/[^/]+\.md$/.test(name))) {
    if (entry.endsWith('.zh-CN.md')) continue
    const paired = `${entry.slice(0, -3)}.zh-CN.md`
    if (!present(paired)) problems.push(`${entry} ships without ${paired}`)
  }
  return problems
}

/**
 * Pack the package and return the entry names it produced.
 *
 * @param {object} manifest - the parsed `package.json`, for the tarball's name.
 * @returns {string[]} the tarball's entries.
 * @throws {Error} when npm cannot pack, or wrote no tarball.
 */
function packAndList(manifest) {
  const tarball = join(ROOT, `${manifest.name}-${manifest.version}.tgz`)
  // A stale tarball from an interrupted run would be read as this run's output.
  if (existsSync(tarball)) rmSync(tarball)
  try {
    // `npm_execpath` is how npm hands a script its own entry point, so this runs
    // the same npm the caller did, without a shell and without capturing stdio.
    const npm = process.env.npm_execpath
    const run = npm === undefined
      ? spawnSync('npm', ['pack', '--silent'], { cwd: ROOT, stdio: 'ignore', shell: true })
      : spawnSync(process.execPath, [npm, 'pack', '--silent'], { cwd: ROOT, stdio: 'ignore' })
    if (run.error !== undefined) throw new Error(`could not run npm pack: ${run.error.message}`)
    if (run.status !== 0) throw new Error(`npm pack exited ${String(run.status)}`)
    if (!existsSync(tarball)) throw new Error(`npm pack wrote no ${tarball}`)
    return tarEntries(gunzipSync(readFileSync(tarball)))
  } finally {
    if (existsSync(tarball)) rmSync(tarball)
  }
}

/**
 * Pack, check, report, and answer with the exit status.
 *
 * @returns {boolean} `true` when the package is what it should be.
 */
export function checkPack() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const entries = packAndList(manifest)
  const problems = packProblems(entries, manifest)

  if (problems.length > 0) {
    console.error(`${manifest.name}@${manifest.version}: ${problems.length} problem(s) with the published package\n`)
    for (const problem of problems) console.error(`  - ${problem}`)
    return false
  }
  // The number of files is reported rather than asserted: it changes whenever a
  // file is added, so pinning it would make every real change an edit here. What
  // is asserted is the anchors and the absences above.
  console.log(`${manifest.name}@${manifest.version}: ${entries.length} files in the tarball`)
  console.log(
    `  ${ANCHORS.length} anchors present, ${FORBIDDEN.length} directories absent,`
      + ` ${manifest.files.length} allowlist entries each contributing`,
  )
  return true
}

// Only run when invoked directly; importing this must not pack or exit.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let ok
  try {
    ok = checkPack()
  } catch (error) {
    console.error(`could not check the published package: ${error.message}`)
    ok = false
  }
  if (!ok) process.exitCode = 1
}
