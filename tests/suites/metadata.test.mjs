/**
 * Display metadata: the one-liner the Plugins page and the Settings plugin
 * inventory show for this package, and the language it is written in.
 *
 * The Harness reads it **without activating the plugin**. `readPluginMeta`
 * resolves `<package>/locale/en.json` first — that file is what makes it read
 * any other language at all — then merges every `<language>.json` beside it into
 * one translation map, which the client resolves through the active locale's
 * fallback chain (`zh` → `en`). Four consequences are checked here:
 *
 *   - a package with `exports` must export the locale subpath, or the Harness's
 *     own module resolution of it fails and the plugin has no description;
 *   - a file `files` leaves out is never published, so the installed package is
 *     read as having no translations;
 *   - the English text must stay identical to the manifest's, which is what npm,
 *     the plugin registry, and every reader of an older installed copy see;
 *   - the Chinese file must actually carry Chinese, because a missing key falls
 *     back to English in silence — which reads exactly like a translation that
 *     shipped.
 */

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { equal, is, ok } from '../helpers.mjs'

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))

/** The filenames the Harness accepts: a language id, then `.json`. */
const LANGUAGE_FILE = /^([A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)\.json$/

/**
 * The technical names the description promises. A translation may reorder or
 * rephrase everything around them, but a reader deciding whether to install this
 * plugin is looking for these.
 */
const TECHNICAL_NAMES = [
  'OpenCode Go',
  'DeepSeek Harness',
  '/models',
  'OpenAI Responses',
  'Chat Completions',
  'Anthropic Messages',
  'x-opencode-session',
]

const read = async (name) => JSON.parse(await readFile(join(ROOT, 'locale', name), 'utf8'))
const english = await read('en.json')
const chinese = await read('zh.json')

/** The description one locale file declares. */
const described = (file) => file?.meta?.description

export default {
  name: 'display metadata',
  cases: [
    {
      name: 'the manifest exports and publishes the locale files',
      run() {
        is(
          manifest.exports['./locale/*.json'],
          './locale/*.json',
          'the Harness resolves <package>/locale/en.json through this subpath',
        )
        ok(manifest.files.includes('locale'), `a publish carries locale/: ${manifest.files.join(', ')}`)
      },
    },
    {
      name: 'every shipped locale file is named as a language',
      async run() {
        const names = (await readdir(join(ROOT, 'locale'))).sort()
        ok(names.length >= 2, `the anchor and its translations: ${names.join(', ')}`)
        const seen = new Set()
        for (const name of names) {
          const match = LANGUAGE_FILE.exec(name)
          ok(match !== null, `${name} is <language>.json`)
          const id = match[1].toLowerCase()
          ok(!seen.has(id), `${name} does not duplicate locale ${id}`)
          seen.add(id)
        }
        ok(seen.has('en'), 'en.json is present: without it no other language is read at all')
      },
    },
    {
      name: 'both locales declare the same fields',
      run() {
        const fields = (file) => Object.keys(file.meta ?? {}).sort()
        equal(fields(english), fields(chinese), 'a field only one locale carries falls back in silence')
        ok(fields(english).includes('description'), 'the package card has copy to show')
      },
    },
    {
      name: 'the English locale restates the manifest description',
      run() {
        is(
          described(english),
          manifest.description,
          'npm, the registry and the Plugins page would state two different sentences',
        )
      },
    },
    {
      name: 'the Chinese locale translates it, in Chinese',
      run() {
        const text = described(chinese)
        ok(typeof text === 'string' && text !== '', 'the Chinese file carries the sentence')
        ok(text !== described(english), 'the Chinese file is not the English one under another name')
        ok(/[\u4e00-\u9fff]/u.test(text), `the sentence is Chinese: ${text}`)
        ok(!/\{\w+\}/u.test(text), 'no unreplaced placeholder')
      },
    },
    {
      name: 'the translation keeps every technical name the English one states',
      run() {
        for (const name of TECHNICAL_NAMES) {
          ok(described(english).includes(name), `the English description names ${name}`)
          ok(described(chinese).includes(name), `the Chinese description names ${name}`)
        }
      },
    },
  ],
}
