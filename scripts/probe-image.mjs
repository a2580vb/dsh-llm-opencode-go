/**
 * Live probe: do this adapter's image request shapes actually work?
 *
 * Reads a generated PNG, builds the exact body each protocol module produces for
 * an image occurrence, and posts it to OpenCode Go. This is what decides whether
 * a model's declared `image` modality is a capability this plugin can honour or
 * a claim it cannot.
 *
 *   OC_KEY=oc_sk_... node scripts/probe-image.mjs
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { dataUrlFactory, anthropicSourceFactory, ImageResolver } from '../lib/model/images.js'
import { toChatMessages, toResponsesInput, toAnthropicMessages } from '../lib/transform/messages.js'

const KEY = process.env.OC_KEY
if (KEY === undefined || KEY === '') {
  console.error('OC_KEY is not set; refusing to run the live probe')
  process.exit(1)
}

const BASE = process.env.OC_BASE ?? 'https://opencode.ai/zen/go/v1'
const MODEL = process.env.OC_MODEL ?? 'deepseek-v4-flash-vision-exp'
const here = dirname(fileURLToPath(import.meta.url))

const bytes = new Uint8Array(await readFile(join(here, 'probe-image.png')))
const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`

const block = { type: 'image', attachment: { attachmentId: 'probe', mediaType: 'image/png' } }
// The request path the adapter uses: a resolver over the attachment seam, faked
// here so the probe exercises the same factories the adapter wires in.
const resolver = new ImageResolver({ attachments: { readImageRequest: async () => ({ data: bytes, mediaType: 'image/png', width: 320, height: 200 }) } })
const imageUrl = dataUrlFactory(resolver)
const imageSource = anthropicSourceFactory(resolver)

const QUESTION = 'What colour is the rectangle, what colour is the circle, and what text is written in the image? Answer in one short line.'
const history = [{ role: 'user', content: [{ type: 'text', text: QUESTION }, block] }]

async function post(path, headers, body, label) {
  const response = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  if (response.status !== 200) {
    console.log(`FAIL ${label} -> HTTP ${response.status} ${text.slice(0, 220)}`)
    return
  }
  const answer = [...text.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`))
    .join('')
  console.log(`OK   ${label} -> HTTP 200 ${JSON.stringify(answer.slice(0, 160))}`)
}

const session = { 'x-opencode-session': 'probe-image-session', accept: 'text/event-stream' }

{
  const messages = await toChatMessages({ messages: history, images: true, imagePart: imageUrl, replayReasoning: false })
  await post('/chat/completions', { ...session, 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, {
    model: MODEL,
    stream: true,
    messages,
    max_tokens: 1024,
  }, `chat-completions image (data URL ${dataUrl.length} chars)`)
}

{
  const input = await toResponsesInput({ messages: history, images: true, imagePart: imageUrl })
  await post('/responses', { ...session, 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, {
    model: MODEL,
    stream: true,
    input,
    max_output_tokens: 1024,
  }, 'responses image (input_image with data URL)')
}

{
  const wire = await toAnthropicMessages({ messages: history, images: true, imagePart: imageSource, replayReasoning: false, signatures: {} })
  await post('/messages', { ...session, 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, {
    model: MODEL,
    stream: true,
    max_tokens: 1024,
    messages: wire.messages,
  }, 'anthropic image (base64 source)')
}

