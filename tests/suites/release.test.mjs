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
 * The changelog is deliberately absent: its headings are history, so the 0.1.0
 * entry has to keep saying 0.1.0 after the project moves on.
 */

import { readFile } from 'node:fs/promises'

import { PLUGIN_VERSION } from '../../lib/config.js'
import { PLUGIN_IDENTITY } from '../../lib/error/errors.js'
import { is } from '../helpers.mjs'

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
