/**
 * Live probe: which wire protocol does each served model actually accept?
 *
 * `GET /models` names the models and the catalogue's preferred entry, but not
 * which other protocols a model serves. This posts a short request over each
 * protocol for every id the service lists and reports the result: the
 * catalogue's `api` map names each model's preferred entry, and this probe
 * verifies that every served model accepts all three, which is what the
 * remaining protocols behind the preferred entry rest on. Re-run it when a
 * model is added.
 *
 * Requests use 32 output tokens so a minimum-length refusal is not mistaken for
 * a protocol refusal. Failures are printed per model; the exit status stays zero
 * unless the `/models` request itself fails.
 *
 * Each request's base is derived the way the adapter derives it, so a probe of
 * the hosted service measures the same endpoints a call would use; `OC_BASE`
 * still overrides the root, which is what makes the legacy layout probeable.
 *
 *   OC_KEY=oc_sk_... node scripts/probe-protocols.mjs [model ...]
 */

import { DEFAULT_BASE_URL, inferenceBase } from '../lib/config.js'

const KEY = process.env.OC_KEY
if (KEY === undefined || KEY === '') {
  console.error('OC_KEY is not set; refusing to run the live probe')
  process.exit(1)
}

const BASE = process.env.OC_BASE ?? DEFAULT_BASE_URL
const HEADERS = { 'content-type': 'application/json', 'x-opencode-session': 'probe-protocols', accept: 'text/event-stream' }

const PROBES = {
  'chat-completions': async (model) => {
    const response = await fetch(`${inferenceBase(BASE, 'chat-completions')}/chat/completions`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${KEY}` },
      // The relay validates minimum output lengths per model family; `8` is
      // below that floor for some ids and would read as a protocol refusal.
      body: JSON.stringify({ model, stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'Reply with: OK' }] }),
    })
    return describe(response, await response.text())
  },
  responses: async (model) => {
    const response = await fetch(`${inferenceBase(BASE, 'responses')}/responses`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, stream: true, max_output_tokens: 32, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with: OK' }] }] }),
    })
    return describe(response, await response.text())
  },
  anthropic: async (model) => {
    const response = await fetch(`${inferenceBase(BASE, 'anthropic')}/messages`, {
      method: 'POST',
      headers: { ...HEADERS, 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, stream: true, max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with: OK' }] }] }),
    })
    return describe(response, await response.text())
  },
}

function describe(response, text) {
  if (response.status === 200) {
    // A 200 can still carry a protocol-level refusal inside the SSE stream
    // (`event: error` / `"type":"error"`), which reading only the status would
    // count as acceptance.
    const error = sseError(text)
    return error === undefined ? 'ok' : `200 ${error}`
  }
  let message = text.slice(0, 120)
  try {
    const parsed = JSON.parse(text)
    message = parsed?.error?.type ?? parsed?.error?.message ?? parsed?.type ?? message
  } catch {
    // keep the raw prefix
  }
  return `${response.status} ${String(message).replace(/\s+/g, ' ').slice(0, 70)}`
}

/** The type or message of an error frame inside a 200 SSE body, when there is one. */
function sseError(text) {
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const parsed = JSON.parse(line.slice('data: '.length))
      if (parsed?.type === 'error') {
        return String(parsed?.error?.type ?? parsed?.error?.message ?? 'error').replace(/\s+/g, ' ').slice(0, 70)
      }
    } catch {
      // a non-JSON frame is not an error marker
    }
  }
  return undefined
}

const wanted = process.argv.slice(2)
const listed = await (await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${KEY}`, accept: 'application/json' } })).json()
const ids = wanted.length > 0 ? wanted : listed.data.map((row) => row.id)
console.log(`${ids.length} models\n`)

for (const id of ids) {
  const results = {}
  for (const [protocol, probe] of Object.entries(PROBES)) {
    try {
      results[protocol] = await probe(id)
    } catch (error) {
      results[protocol] = `error ${error.message}`
    }
  }
  const served = Object.entries(results).filter(([, value]) => value === 'ok').map(([name]) => name)
  console.log(`${id.padEnd(30)} served=[${served.join(', ')}]`)
  for (const [protocol, value] of Object.entries(results)) {
    if (value !== 'ok') console.log(`${''.padEnd(32)}${protocol.padEnd(18)} ${value}`)
  }
}
