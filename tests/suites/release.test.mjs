/**
 * Release coherence: one version, stated in many places.
 *
 * A publish reads `package.json`, but the plugin reports its own version from
 * module constants, and two shipped documents restate it. The configuration page
 * shows `PLUGIN_IDENTITY.version` to whoever opens it, so a bump that moves the
 * manifest and misses that constant ships a plugin advertising a version that was
 * never published — and the config suite would not notice, because the manifest
 * and `PLUGIN_VERSION` would still agree with each other.
 *
 * These cases make a version bump self-checking: change `package.json`, and every
 * other place that has to move with it is named here.
 *
 * The changelog is deliberately absent from the version cases: its headings are
 * history, so the 0.1.0 entry has to keep saying 0.1.0 after the project moves on.
 * It does get a case of its own — the notes ship in two languages, and those two
 * have to keep saying the same thing.
 */

import { readFile } from 'node:fs/promises'

import { PLUGIN_VERSION } from '../../lib/config.js'
import { PLUGIN_IDENTITY } from '../../lib/error/errors.js'
import { equal, is } from '../helpers.mjs'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

const manifest = JSON.parse(await read('package.json'))
const version = manifest.version

/**
 * The version `text` states, read through `shape`. A file that stopped stating it
 * in that shape fails with the file named rather than as a `null` comparison, so
 * a reformatted document says what to do about it.
 */
function statedVersion(path, text, shape) {
  const match = shape.exec(text)
  if (match === null) {
    throw new Error(
      `${path} no longer states the plugin version where this case reads it; ` +
        'update the pattern here to match the document, and keep it in step with package.json',
    )
  }
  return match[1]
}

export default {
  name: 'release',
  cases: [
    {
      name: 'the adapter reports the manifest version',
      run() {
        is(PLUGIN_VERSION, version, 'PLUGIN_VERSION drifted from the manifest')
      },
    },
    {
      name: 'the version the configuration page shows is the manifest version',
      run() {
        is(
          PLUGIN_IDENTITY.version,
          version,
          'PLUGIN_IDENTITY drifted from the manifest, so the configuration page would show it',
        )
      },
    },
    {
      name: 'the lock file records the manifest version',
      async run() {
        const lock = JSON.parse(await read('package-lock.json'))
        is(lock.version, version, 'the lock file root version drifted from the manifest')
        is(lock.packages[''].version, version, 'the lock file entry for this package drifted')
      },
    },
    {
      name: 'the shipped development page states the manifest version',
      async run() {
        const shape = /^\|\s*\*\*(?:Version|版本)\*\*\s*\|\s*(\d+\.\d+\.\d+)/m
        for (const path of ['docs/development.md', 'docs/development.zh-CN.md']) {
          is(statedVersion(path, await read(path), shape), version, `${path} states a stale version`)
        }
      },
    },
    {
      name: 'the changelog ships in both languages, in step',
      async run() {
        // The notes are the first thing a release, and the plugin market's
        // change link, put in front of a reader — and half of those readers read
        // the Chinese one. Two files that stopped matching would tell two
        // different stories about one release, so the pair is held here: the same
        // heading sequence, and an entry under each one.
        const paths = ['CHANGELOG.md', 'CHANGELOG.zh-CN.md']
        const texts = await Promise.all(paths.map((path) => read(path)))
        for (const [index, text] of texts.entries()) {
          is(text.includes(paths[1 - index]), true, `${paths[index]} points at the other language`)
        }
        const shape = (text) => ({
          headings: text.split('\n').filter((line) => /^#{2,3} /.test(line)).map((line) => line.trim()),
          entries: text.split('\n').filter((line) => line.startsWith('- ')).length,
        })
        const [en, zh] = texts.map(shape)
        equal(zh.headings, en.headings, 'the two changelogs carry the same sections')
        // Version headings are history, so the count of entries is what keeps the
        // two sides honest: a note added to one file alone shows up here.
        is(zh.entries, en.entries, 'the two changelogs carry the same number of entries')
      },
    },
    {
      name: 'the shipped protocol example carries the manifest version',
      async run() {
        const shape = /User-Agent: dsh-opencode-go\/(\d+\.\d+\.\d+)/
        for (const path of ['docs/wire-protocol.md', 'docs/wire-protocol.zh-CN.md']) {
          is(statedVersion(path, await read(path), shape), version, `${path} shows a stale User-Agent`)
        }
      },
    },
  ],
}
