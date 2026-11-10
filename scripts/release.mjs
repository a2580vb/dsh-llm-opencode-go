/**
 * The release's own decisions, in one place a test can reach.
 *
 * A release workflow is a shell script running in an environment nobody can try
 * locally, which is the worst combination for anything with a condition in it:
 * the feedback arrives on a tag, in public, after a publish has already been
 * attempted. So the parts that decide *something* — which version a tag names,
 * whether a tag and a manifest agree, what the release notes say — live here,
 * where the `ci` and `release` suites exercise them on every push, and the
 * workflow keeps only the steps no shell can avoid.
 *
 * Three answers, one per subcommand:
 *
 *   node scripts/release.mjs version          the version in package.json
 *   node scripts/release.mjs check-tag v0.2.1 the version a tag names, or a refusal
 *   node scripts/release.mjs notes 0.2.1      the changelog section, as a release body
 *
 * The exit status is the answer's truth: zero when it could be answered, non-zero
 * with a reason on stderr when it could not.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The version the package states, which is the authority on what a release is. */
export function manifestVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

/**
 * The version a release tag names, or `undefined` when the tag is not one.
 *
 * A tag is the release here, so this is the only place a version comes from that
 * a person typed rather than a manifest. It refuses anything that is not
 * `v<digits>…`: a dispatch from a branch has a ref name like `main`, and
 * publishing whatever that branch holds under the version `main` is the failure
 * this exists to prevent.
 *
 * @param {string} tag - the ref or tag name to read.
 * @returns {string | undefined} the version, without the `v`, or `undefined`.
 */
export function versionFromTag(tag) {
  return /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag) ? tag.slice(1) : undefined
}

/**
 * The version a release tag names, once the manifest is known to state it.
 *
 * A tag is the release here, but it is only a release of this package when the
 * manifest says the same version: a tag on the wrong commit would publish a
 * tarball whose version is not the one the tag, and its release notes, name.
 * Both refusals state the two values, because this runs on a tag where the log
 * is the only thing a person sees.
 *
 * @param {string} tag - the ref or tag name to read.
 * @returns {string} the version, without the `v`.
 * @throws {Error} when the tag is not a version tag or names another version.
 */
export function checkTag(tag) {
  const version = versionFromTag(tag)
  if (version === undefined) {
    throw new Error(`expected a v-prefixed version tag, got '${tag}'`)
  }
  const stated = manifestVersion()
  if (version !== stated) {
    throw new Error(`the tag says ${version} and package.json says ${stated}`)
  }
  return version
}

/**
 * One section of a changelog, without its heading.
 *
 * Sections are `## <version> — <date>`, newest first, and a section ends at the
 * next level-two heading. The version is the first token after `##`, compared as
 * a whole string: `0.2.1` is not `0.2.1-rc.1` and `0.2.1+build.7` is not
 * `0.2.1`, so a release reads only the section whose token it asked for.
 * Matching the heading rather than searching for the version string matters:
 * `0.2.1` appears in prose about `0.2.1`, and only the heading is a section.
 *
 * @param {string} text - the changelog's contents.
 * @param {string} version - the version to read, without a leading `v`.
 * @returns {string | undefined} the body, trimmed, or `undefined` when absent.
 */
export function section(text, version) {
  const body = []
  let inSection = false
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(\S+)/.exec(line)
    if (heading !== null) {
      if (inSection) break
      const named = heading[1].startsWith('v') ? heading[1].slice(1) : heading[1]
      if (named === version) inSection = true
      continue
    }
    if (inSection) body.push(line)
  }
  const notes = body.join('\n').trim()
  return notes === '' ? undefined : notes
}

/**
 * The body of one version's release page.
 *
 * @param {string} version - the version being released.
 * @returns {string | undefined} the changelog section, or `undefined` when the
 *   file has none — which is not a release, and is why the caller must refuse.
 */
export function releaseNotes(version) {
  return section(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version)
}

/** The subcommands, each answering or explaining why it cannot. */
const COMMANDS = {
  version() {
    return manifestVersion()
  },
  'check-tag': checkTag,
  notes: (version) => {
    const body = releaseNotes(version)
    if (body === undefined) throw new Error(`CHANGELOG.md has no section for ${version}`)
    return body
  },
}

// Only run when invoked directly; importing this must not print or exit.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [name, argument] = process.argv.slice(2)
  const command = COMMANDS[name]
  if (command === undefined) {
    console.error(`usage: node scripts/release.mjs ${Object.keys(COMMANDS).join('|')} [argument]`)
    process.exitCode = 2
  } else {
    try {
      process.stdout.write(`${command(argument)}\n`)
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
