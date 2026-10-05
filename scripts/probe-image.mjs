/**
 * Live probe: do this adapter's image request shapes actually work?
 *
 * Reads a PNG, builds the exact bodies each protocol module produces, and posts
 * them to OpenCode Go. This is what decides whether a model's declared `image`
 * modality is a capability this plugin can honour or a claim it cannot.
 *
 * Two histories are probed per protocol, because an image reaches a model by two
 * different routes and the second one is not the first one's shape:
 *
 *   - **in the user turn** — what a pasted or attached image produces;
 *   - **inside a tool result** — what `read_image` answers with, where the image
 *     has to ride the tool message, the `function_call_output` item, or the
 *     `tool_result` block rather than a user turn of its own.
 *
 *   OC_KEY=oc_sk_... node scripts/probe-image.mjs
 *   OC_IMAGE=.live-cache/probe-image.png OC_MODEL=deepseek-v4-flash-vision-exp ...
 *
 * The image defaults to `.live-cache/probe-image.png`; any PNG works, and the
 * answer is printed so it can be compared with what the picture holds.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join } from 'node:path'

import { dataUrlFactory, anthropicSourceFactory, ImageResolver } from '../lib/model/images.js'
import { toChatMessages, toResponsesInput, toAnthropicMessages } from '../lib/transform/messages.js'

const KEY = process.env.OC_KEY
if (KEY === undefined || KEY === '') {
  console.error('OC_KEY is not set; refusing to run the live probe')
  process.exit(1)
}

const BASE = process.env.OC_BASE ?? 'https://opencode.ai/zen/go/v1'
const MODEL = process.env.OC_MODEL ?? 'deepseek-v4-flash-vision-exp'
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const IMAGE = process.env.OC_IMAGE ?? join(ROOT, '.live-cache', 'probe-image.png')
const imagePath = isAbsolute(IMAGE) ? IMAGE : join(ROOT, IMAGE)

let bytes
try {
  bytes = new Uint8Array(await readFile(imagePath))
} catch (error) {
  // The default lives in untracked scratch, so a fresh clone has no picture to
  // read. Say which file and which variable, rather than a bare ENOENT.
  console.error(`${imagePath} could not be read (${error.code ?? error.message}).`)
  console.error('Point OC_IMAGE at a PNG: OC_KEY=... OC_IMAGE=path/to.png node scripts/probe-image.mjs')
  process.exit(1)
}
const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`

const QUESTION = 'What colour is the rectangle, what colour is the circle, and what text is written in the image? Answer in one short line.'
const CALL_ID = 'call_probe_1'
const ENVELOPE = `<type>image</type>\n<content>\nimage/png image, ${String(bytes.byteLength)} bytes\n</content>`

/** The image block the harness hands this adapter for one occurrence. */
const block = { type: 'image', attachment: { attachmentId: 'probe', mediaType: 'image/png' } }

// The request path the adapter uses: a resolver over the attachment seam, faked
// here so the probe exercises the same factories the adapter wires in.
const resolver = new ImageResolver({ attachments: { readImageRequest: async () => ({ data: bytes, mediaType: 'image/png' }) } })
const imageUrl = dataUrlFactory(resolver)
const imageSource = anthropicSourceFactory(resolver)

/** One attached image, asked about directly. */
const DIRECT = [{ role: 'user', content: [{ type: 'text', text: QUESTION }, block] }]

/** The same image, read by a tool: `read_image` answers with text and the image. */
const VIA_TOOL = [
  { role: 'user', content: [{ type: 'text', text: `Use read_image on foo.png, then answer: ${QUESTION}` }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: CALL_ID, name: 'read_image', arguments: '{"file_path":"foo.png"}' }] },
  { role: 'tool', toolCallId: CALL_ID, content: [{ type: 'text', text: ENVELOPE }, block] },
]

const READ_IMAGE_PARAMETERS = {
  type: 'object',
  properties: { file_path: { type: 'string', description: 'Path to the image file.' } },
  required: ['file_path'],
}
const TOOL_BY_PROTOCOL = {
  chat: [{ type: 'function', function: { name: 'read_image', description: 'Read an image file.', parameters: READ_IMAGE_PARAMETERS } }],
  responses: [{ type: 'function', name: 'read_image', description: 'Read an image file.', parameters: READ_IMAGE_PARAMETERS }],
  anthropic: [{ name: 'read_image', description: 'Read an image file.', input_schema: READ_IMAGE_PARAMETERS }],
}

async function post(path, headers, body, label) {
  const response = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  if (response.status !== 200) {
    console.log(`FAIL ${label} -> HTTP ${response.status} ${text.slice(0, 220)}`)
    return
  }
  // Three protocols, three delta spellings: `delta.content` on Chat Completions,
  // `delta.text` on Messages, `output_text.delta` on Responses.
  const answer = [...text.matchAll(/"(?:text|content)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`))
    .join('')
  console.log(`OK   ${label} -> ${JSON.stringify(answer.slice(0, 160)) || '(no text found)'}`)
}

const session = { 'x-opencode-session': 'probe-image-session', accept: 'text/event-stream' }
const json = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }

for (const [where, messages, tools] of [['user turn', DIRECT, undefined], ['tool result', VIA_TOOL, TOOL_BY_PROTOCOL.chat]]) {
  await post('/chat/completions', { ...session, ...json }, {
    model: MODEL,
    stream: true,
    messages: await toChatMessages({ messages, images: true, imagePart: imageUrl, replayReasoning: false }),
    ...(tools === undefined ? {} : { tools }),
    max_tokens: 1024,
  }, `chat-completions image in the ${where} (data URL ${dataUrl.length} chars)`)
}

for (const [where, messages, tools] of [['user turn', DIRECT, undefined], ['tool result', VIA_TOOL, TOOL_BY_PROTOCOL.responses]]) {
  await post('/responses', { ...session, ...json }, {
    model: MODEL,
    stream: true,
    input: await toResponsesInput({ messages, images: true, imagePart: imageUrl }),
    ...(tools === undefined ? {} : { tools }),
    max_output_tokens: 1024,
  }, `responses image in the ${where} (input_image with data URL)`)
}

for (const [where, messages, tools] of [['user turn', DIRECT, undefined], ['tool result', VIA_TOOL, TOOL_BY_PROTOCOL.anthropic]]) {
  const wire = await toAnthropicMessages({ messages, images: true, imagePart: imageSource, replayReasoning: false, signatures: {} })
  await post('/messages', { ...session, 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, {
    model: MODEL,
    stream: true,
    max_tokens: 1024,
    messages: wire.messages,
    ...(tools === undefined ? {} : { tools }),
  }, `anthropic image in the ${where} (base64 source)`)
}
