/**
 * The repository's own automation, held to the rules it depends on.
 *
 * Workflows are the one part of this project nothing else reads. The offline
 * suite covers the adapter and the page, `prepublishOnly` covers the package,
 * and a workflow that is wrong runs on GitHub and nowhere else — where a typo is
 * a job that quietly never does the thing it was added for.
 *
 * The specific failures these cases exist for, in the order they have actually
 * happened to people:
 *
 *   - a workflow that does not run at all, because the trigger lists the wrong
 *     branch or the YAML has a tab in it (tabs are illegal in YAML, and the file
 *     still looks fine in an editor);
 *   - an action referenced by a moving target (`@main`, or no ref at all), which
 *     is an unreviewed update to the build system on every run;
 *   - a release that publishes a version the manifest does not state, or one the
 *     changelog has no notes for — the two things a reader would see;
 *   - a step naming an npm script that was renamed, which fails at the last
 *     moment, on a tag, where it is most expensive.
 *
 * GitHub parses the YAML and is the final authority on whether it is valid; what
 * is checked here is everything GitHub would accept and then do the wrong thing
 * with.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import { ANCHORS, FORBIDDEN } from '../../scripts/check-pack.mjs'
import { manifestVersion, releaseNotes, section, versionFromTag } from '../../scripts/release.mjs'
import { equal, is, ok } from '../helpers.mjs'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

const manifest = JSON.parse(await read('package.json'))
const version = manifest.version

/** The workflows this repository ships, keyed by file name. */
const WORKFLOWS = ['ci.yml', 'release.yml']

/**
 * A workflow's lines, however the checkout wrote them.
 *
 * Splitting on `\n` alone leaves the `\r` of a `\r\n` pair at the end of every
 * line, and that is not a cosmetic difference here: `.` does not match `\r`, and
 * `$` in multiline mode deliberately refuses to match before a `\r` that is
 * followed by `\n`. A parser written against LF therefore matches *nothing* in a
 * CRLF checkout, silently. `core.autocrlf` is true by default on Windows, so
 * that checkout is what a contributor on Windows has.
 */
const textLines = (text) => text.split(/\r?\n/)

/** The lines of a workflow, with the comment-only lines dropped. */
function lines(text) {
  return textLines(text)
    .map((line, index) => ({ number: index + 1, text: line }))
    .filter(({ text: line }) => !/^\s*#/.test(line) && line.trim() !== '')
}

/** `false` when `pattern` appears nowhere in `text`. */
const has = (text, pattern) => new RegExp(pattern, 'm').test(text)

/**
 * The `run:` command bodies of a workflow, as a single string per step.
 *
 * A step's body runs as one shell script, so a check about what a step does is a
 * check about the whole thing rather than about one line of it.
 */
function runBodies(text) {
  const bodies = []
  const all = textLines(text)
  for (const [index, line] of all.entries()) {
    const start = /^(\s*)-?\s*run:\s*(\||>)?\s*(.*)$/.exec(line)
    if (start === null) continue
    if (start[2] === undefined) {
      bodies.push(start[3])
      continue
    }
    const indent = start[1].length
    const body = []
    for (const following of all.slice(index + 1)) {
      if (following.trim() !== '' && following.search(/\S/) <= indent) break
      body.push(following.trim())
    }
    bodies.push(body.join('\n'))
  }
  return bodies
}

/** Every npm script a workflow tells npm to run. */
function scriptsRun(text) {
  const found = new Set()
  for (const body of runBodies(text)) {
    for (const match of body.matchAll(/npm run ([a-z:-]+)/g)) found.add(match[1])
    // A bare `npm test` is the `test` script, spelled the short way.
    if (/(^|\s)npm test(\s|$)/m.test(body)) found.add('test')
  }
  return [...found]
}

/**
 * A workflow's executable content, with comments removed.
 *
 * Checks about what a workflow *does* have to read the same thing GitHub runs,
 * or a comment promising the opposite of the code would satisfy them. This one
 * caught itself doing that: the release workflow's comment says no `NPM_TOKEN`
 * is stored, and a scan of the raw text read that sentence as a stored token.
 */
const effective = (text) => lines(text).map(({ text: line }) => line).join('\n')

export default {
  name: 'ci',
  cases: [
    {
      name: 'every workflow is a file GitHub will read, with no tabs in it',
      async run() {
        // YAML forbids a tab character anywhere it is used for indentation, and
        // the failure is a parse error on GitHub rather than anything a local
        // run would notice. An editor that shows tabs as spaces hides it.
        for (const name of WORKFLOWS) {
          const text = await read(`.github/workflows/${name}`)
          const tabs = lines(text).filter(({ text: line }) => line.includes('\t'))
          is(tabs.length, 0, `${name} has a tab at line ${tabs[0]?.number ?? '?'}, which YAML forbids`)
          ok(text.trim().length > 0, `${name} is not empty`)
          // A workflow with no `on:` never runs, whatever else it says.
          ok(has(text, '^on:'), `${name} declares its triggers`)
          ok(has(text, '^jobs:'), `${name} declares its jobs`)
        }
      },
    },
    {
      name: 'every action is pinned to a version, not to a branch',
      async run() {
        // `@main` (or a missing ref, which is the same thing) hands the build to
        // whatever that repository pushes next. A version tag is the smallest
        // thing that makes a run reproducible.
        const pattern = /uses:\s*([^\s#]+)/g
        for (const name of WORKFLOWS) {
          const text = await read(`.github/workflows/${name}`)
          const refs = [...text.matchAll(pattern)].map((match) => match[1])
          ok(refs.length > 0, `${name} uses at least one action`)
          for (const ref of refs) {
            const at = ref.lastIndexOf('@')
            const pinned = at > 0 && /^v?\d+(\.\d+)*$/.test(ref.slice(at + 1))
            is(pinned, true, `${name} uses ${ref}, which is not pinned to a version`)
          }
        }
      },
    },
    {
      name: 'the actions run on the runtime the runner has, not the one they were written for',
      async run() {
        // A pinned major is not only reproducibility: it decides which Node the
        // action expects. GitHub deprecated Node 20 as an action runtime, and an
        // action that targets it still runs — forced onto Node 24, with a
        // warning on every job — so the pin is a thing to keep current rather
        // than find out about one job at a time.
        //
        // `setup-node` is the one with teeth here. Before v7 it exported a dummy
        // `NODE_AUTH_TOKEN`, which the maintainers describe as not breaking OIDC
        // while still leaving a non-functional token in the environment — on
        // exactly the publish path this repository uses, which is OIDC plus
        // `registry-url` and no stored token.
        const VERIFIED = { 'actions/checkout': 7, 'actions/setup-node': 7 }
        const seen = new Set()
        for (const name of WORKFLOWS) {
          const text = await read(`.github/workflows/${name}`)
          for (const match of text.matchAll(/uses:\s*([^\s#]+)/g)) {
            const [action, ref] = match[1].split('@')
            if (!(action in VERIFIED)) continue
            seen.add(action)
            const major = Number.parseInt(ref.replace(/^v/, ''), 10)
            is(
              Number.isFinite(major) && major >= VERIFIED[action],
              true,
              `${name} pins ${action}@${ref}; this repository verified ${VERIFIED[action]} as the oldest current major`,
            )
          }
        }
        // A row for an action nothing uses is a rule that checks nothing, which
        // is how this list would quietly rot after a workflow loses a step.
        for (const action of Object.keys(VERIFIED)) {
          is(seen.has(action), true, `the table names ${action}, which no workflow uses`)
        }
      },
    },
    {
      name: 'the offline suite runs on every push and pull request',
      async run() {
        const text = await read('.github/workflows/ci.yml')
        ok(has(text, '^  push:'), 'ci runs on push')
        ok(has(text, 'branches: \\[main\\]'), 'ci runs for main')
        ok(has(text, '^  pull_request:'), 'ci runs on pull requests')
        // The suite is the point of the workflow: without it this runs a syntax
        // check and reports green.
        is(scriptsRun(text).includes('test'), true, 'ci runs the offline suite')
        is(has(text, 'npm run check($|\\s)'), true, 'ci runs the syntax check')
        // Read-only on purpose: a test job has no reason to write to the repo.
        ok(has(text, 'contents: read'), 'ci asks only for read access')
        ok(text.includes('id-token: write') === false, 'ci does not ask for an OIDC token')
      },
    },
    {
      name: 'ci runs the packed-package check and the activation suite',
      async run() {
        const text = await read('.github/workflows/ci.yml')
        is(scriptsRun(text).includes('check:pack'), true, 'ci checks the tarball a publish would upload')
        is(scriptsRun(text).includes('test:cordis'), true, 'ci activates the plugin on a real cordis')
        // Packing the same bytes in four matrix legs is three wasted jobs.
        ok(has(text, 'if:'), 'the pack check is gated to one leg of the matrix')
        // The activation suite is what closes the config-schema gap, so it has to
        // exist as its own job rather than riding on the offline suite.
        ok(has(text, '^  cordis:'), 'the activation suite is a job of its own')
      },
    },
    {
      name: 'the release workflow is a tag, and it can be run again by hand',
      async run() {
        const text = await read('.github/workflows/release.yml')
        ok(has(text, "tags: \\['v\\*'\\]"), 'release runs on version tags')
        ok(has(text, '^  workflow_dispatch:'), 'a release that failed halfway can be finished')
        // OIDC is the whole reason there is no long-lived npm token in this
        // repository; without the token permission the exchange cannot happen.
        ok(has(text, 'id-token: write'), 'release can exchange an OIDC token for a publisher credential')
        ok(has(text, 'contents: write'), 'release can write the release page')
        // The workflow's own comments explain why there is no token, so this
        // reads only what runs: the point is that no secret is ever passed in.
        const code = effective(text)
        ok(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM/.test(code) === false, 'release stores no npm token')
        // `GITHUB_TOKEN` is not a stored secret — GitHub mints it for every run —
        // so naming it is fine and anything else is a secret this repository
        // would have to hold. That is the property worth keeping.
        const named = [...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1])
        equal([...new Set(named)], ['GITHUB_TOKEN'], 'release reaches for no repository secret but GitHub\'s own token')
      },
    },
    {
      name: 'the release checks the tag against the manifest before publishing',
      async run() {
        // The order matters and is asserted as an order: the version is resolved
        // from the tag (which is also where a disagreement with the manifest is
        // refused) and only then used. A publish that could run before that
        // comparison would publish a version nobody asked for.
        const text = await read('.github/workflows/release.yml')
        const order = ['Resolve the version', 'Publish to npm', 'Release on GitHub']
        const at = order.map((step) => text.indexOf(step))
        for (const [index, position] of at.entries()) {
          is(position >= 0, true, `release has a "${order[index]}" step`)
          if (index > 0) is(at[index - 1] < position, true, `"${order[index - 1]}" comes before "${order[index]}"`)
        }
        // The decision lives in the script, where it is tested, rather than in
        // shell that only ever runs on a tag.
        ok(has(text, 'scripts/release\\.mjs check-tag'), 'the tag is resolved and compared by the tested script')
        // Publishing something already on npm is a failure npm reports at the
        // very end; asking first is what makes a re-run safe.
        ok(has(text, 'npm view'), 'release asks npm whether the version is already published')
        ok(has(text, 'npm publish --provenance'), 'release publishes with provenance')
        ok(has(text, 'gh release create'), 'release writes the release page')
        ok(has(text, '--notes-file'), 'the release page is the changelog section')
        // A manual dispatch is built from the tag it names, not from the branch
        // it was dispatched on.
        ok(has(text, 'ref: \\$\\{\\{ env\\.RELEASE_TAG \\}\\}'), 'release checks out the tagged commit')
      },
    },
    {
      name: 'a tag names a version, and anything else is refused',
      async run() {
        // This is the one version a person types rather than a manifest states,
        // so it is the one that can be wrong in a way nothing else catches.
        is(versionFromTag('v0.2.1'), '0.2.1')
        is(versionFromTag('v1.0.0'), '1.0.0')
        is(versionFromTag('v0.2.1-rc.1'), '0.2.1-rc.1')
        is(versionFromTag('v0.2.1+build.7'), '0.2.1+build.7')
        // A branch name is the case this exists for: dispatching from `main`
        // must not publish a version called "main".
        for (const tag of ['main', '0.2.1', 'v', 'v0.2', 'release-0.2.1', 'v0.2.1.4', '']) {
          is(versionFromTag(tag), undefined, `'${tag}' is not a release tag`)
        }
      },
    },
    {
      name: 'a release runs the same checks a push does, plus the notes',
      async run() {
        const text = await read('.github/workflows/release.yml')
        const scripts = scriptsRun(text)
        for (const script of ['check', 'test', 'check:pack']) {
          is(scripts.includes(script), true, `release runs \`${script}\` before publishing`)
        }
        // A tag can point at a commit that never passed on main, so the checks
        // have to run here rather than be assumed.
        const publishAt = text.indexOf('Publish to npm')
        for (const script of ['npm run check', 'npm test', 'npm run check:pack']) {
          is(text.indexOf(script) < publishAt, true, `\`${script}\` runs before the publish step`)
        }
      },
    },
    {
      name: 'every npm script the workflows run exists',
      async run() {
        // A renamed script is a release that fails on a tag, which is the most
        // expensive moment to find out.
        for (const name of WORKFLOWS) {
          const text = await read(`.github/workflows/${name}`)
          for (const script of scriptsRun(text)) {
            is(script in manifest.scripts, true, `${name} runs \`npm run ${script}\`, which package.json has no script for`)
          }
        }
      },
    },
    {
      name: 'the pack check names anchors that exist, and leaks nothing that is in the repository',
      async run() {
        // An anchor is a path in the *tarball*; the same file lives at the same
        // path without the `package/` prefix in the repository. A renamed file
        // leaves an anchor pointing at nothing, which fails the pack check on
        // every run from then on — better caught here, with the path named.
        for (const anchor of ANCHORS) {
          ok(anchor.startsWith('package/'), `${anchor} is a path inside the tarball`)
          if (anchor === 'package/LICENSE') continue // npm adds it; the repo need not hold it
          const inRepo = anchor.slice('package/'.length)
          is(existsSync(new URL(`../../${inRepo}`, import.meta.url)), true, `the pack check anchors ${anchor}, which the repository does not have`)
        }
        // A forbidden prefix that names nothing the repository knows about checks
        // nothing: `package/.livecache/` would sit in the list for ever without
        // ever being able to match. What counts as "knows about" is the trap
        // here — half of these directories are gitignored scratch, so they exist
        // on a working machine and in no clone at all, which is exactly the
        // difference that made this case fail in CI and pass locally.
        const ignored = new Set(
          textLines(await read('.gitignore'))
            .map((line) => line.trim().replace(/\/$/, ''))
            .filter((line) => line !== '' && !line.startsWith('#')),
        )
        for (const prefix of FORBIDDEN) {
          const inRepo = prefix.slice('package/'.length).replace(/\/$/, '')
          const known = existsSync(new URL(`../../${inRepo}`, import.meta.url)) || ignored.has(inRepo)
          is(known, true, `the pack check forbids ${prefix}, which is neither present nor gitignored`)
        }
      },
    },
    {
      name: 'the workflow parser reads a CRLF checkout, which is what Windows gets',
      async run() {
        // `core.autocrlf` is true by default on Windows, so every file in a clone
        // there has CRLF — and a parser that anchors to `$` finds nothing in that,
        // because the regex has no `m` flag, `$` then means end-of-string, and a
        // trailing `\r` is a character neither `$` nor `.` will accept. The
        // failure reads as "the workflow does not run the tests", on one platform,
        // with nothing about line endings in it. This case is why the helpers
        // split on `/\r?\n/`.
        for (const name of WORKFLOWS) {
          const raw = await read(`.github/workflows/${name}`)
          // Whatever this checkout wrote, both variants are built from the same
          // text: a case that assumed the file was LF would double every CR on a
          // Windows machine and fail there for its own reason.
          const lf = raw.replace(/\r\n/g, '\n')
          const crlf = lf.replace(/\n/g, '\r\n')
          equal(runBodies(crlf), runBodies(lf), `${name} yields the same step bodies either way`)
          is(scriptsRun(raw).length > 0, true, `${name} parses as this checkout actually wrote it`)
        }
        const ci = await read('.github/workflows/ci.yml')
        const crlf = ci.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
        is(scriptsRun(crlf).includes('test'), true, 'the offline suite is still found in a CRLF checkout')
        is(scriptsRun(crlf).includes('check:pack'), true, 'and so is the pack check, which is a step of its own')
      },
    },
    {
      name: 'the release notes come from the changelog, one section per version',
      async run() {
        // The notes a reader sees on the release page and the notes in the
        // shipped changelog are the same text, read out of one file.
        const notes = releaseNotes(version)
        ok(notes !== undefined, `CHANGELOG.md has a section for ${version}, the version in package.json`)
        // The section must be the whole section: a heading is where it starts and
        // the next heading is where it stops.
        ok(notes.includes('###'), 'the notes carry their subsections')
        ok(/^##\s/m.test(notes) === false, 'the notes stop at the next version')
        // A version is not a prefix: `0.2.1` must not read back the `0.2.10`
        // section, and a heading that is only a heading has no notes to ship.
        is(section('## 0.2.10 — x\n\nlatest\n', '0.2.1'), undefined, 'a version does not match a longer one')
        is(section('## 0.2.1 — x\n\n## 0.2.0 — y\n\nolder\n', '0.2.1'), undefined, 'a heading with no body is not notes')
        is(section('## 0.2.1 — x\n\nbody\n\n## 0.2.0 — y\n\nolder\n', '0.2.1'), 'body', 'and a section stops at the next')
        is(section('# Changelog\n\nsee 0.2.1 for details\n', '0.2.1'), undefined, 'prose is not a section')
        // Version headings are exactly what a release reads, so every one of them
        // in the shipped changelog has to have notes behind it.
        const text = await read('CHANGELOG.md')
        for (const match of text.matchAll(/^##\s+v?(\d+\.\d+\.\d+)/gm)) {
          ok(section(text, match[1]) !== undefined, `the ## ${match[1]} heading has a body`)
        }
        is(manifestVersion(), version, 'the notes default to the manifest version')
      },
    },
  ],
}
