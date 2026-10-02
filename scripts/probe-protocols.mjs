/**
 * Live probe: which wire protocol does each served model actually accept?
 *
 * `GET /models` publishes ids only, so the adapter's per-model protocol map is
 * measured. This posts a one-token request over each protocol for every id the
 * service lists and reports the result, which is what `FALLBACK_MODELS` is
 * written from.
 *
 *   OC_KEY=oc_sk_... node scripts/probe-protocols.mjs [model ...]
 */

const KEY = process.env.OC_KEY
if (KEY === undefined || KEY === '') {
  console.error('OC_KEY is not set; refusing to run the live probe')
  process.exit(1)
}

const BASE = process.env.OC_BASE ?? 'https://opencode.ai/zen/go/v1'
const HEADERS = { 'content-type': 'application/json', 'x-opencode-session': 'probe-protocols', accept: 'text/event-stream' }

const PROBES = {
  'chat-completions': async (model) => {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with: OK' }] }),
    })
    return describe(response, await response.text())
  },
  responses: async (model) => {
    const response = await fetch(`${BASE}/responses`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, stream: true, max_output_tokens: 16, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with: OK' }] }] }),
    })
    return describe(response, await response.text())
  },
  anthropic: async (model) => {
    const response = await fetch(`${BASE}/messages`, {
      method: 'POST',
      headers: { ...HEADERS, 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, stream: true, max_tokens: 16, messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with: OK' }] }] }),
    })
    return describe(response, await response.text())
  },
}

function describe(response, text) {
  if (response.status === 200) return 'ok'
  let message = text.slice(0, 120)
  try {
    const parsed = JSON.parse(text)
    message = parsed?.error?.type ?? parsed?.error?.message ?? parsed?.type ?? message
  } catch {
    // keep the raw prefix
  }
  return `${response.status} ${String(message).replace(/\s+/g, ' ').slice(0, 70)}`
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
