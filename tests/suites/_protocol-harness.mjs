/**
 * Shared harness for the protocol suites.
 *
 * Each suite feeds a translator an SSE payload captured from the live service,
 * then assembles the resulting chunks with the harness's own `BlockAssembler` —
 * the same code the agent loop runs over them. A protocol that violates chunk
 * ordering, block closure, or the terminal sequence fails here.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'

import { ImageResolver, anthropicSourceFactory, dataUrlFactory } from '../../lib/model/images.js'
import { bodyFromString } from '../../lib/stream/sse.js'
import { is, ok } from '../helpers.mjs'

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden')

/** Read one captured response body. */
export async function fixture(name) {
  return readFile(join(goldenDir, name), 'utf8')
}

/** The one image block a `read_image` result carries, occurrence included. */
export const IMAGE_BLOCK = Object.freeze({
  type: 'image',
  attachment: Object.freeze({ attachmentId: 'att-1', mediaType: 'image/png', name: 'shot.png' }),
})

/** Eight bytes standing in for the resolved request image. */
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

/** The two factories an image-capable route hands its converter. */
export function imageParts() {
  const resolver = new ImageResolver({
    attachments: { readImageRequest: async () => ({ data: IMAGE_BYTES, mediaType: 'image/png', width: 8, height: 8 }) },
  })
  return { imageUrl: dataUrlFactory(resolver), imageSource: anthropicSourceFactory(resolver), resolver }
}

/** Run one translator and assemble its chunks the way the agent loop does. */
export async function assemble(transport, text, model) {
  const chunks = []
  for await (const chunk of transport.translate({ body: bodyFromString(text), model })) {
    chunks.push(chunk)
  }
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return { chunks, assembler, blocks: assembler.blocks(), finish: assembler.finish, usage: assembler.usage }
}

/** Run one translator, capturing the failure instead of throwing. */
export async function failureOf(transport, text, model) {
  try {
    await assemble(transport, text, model)
  } catch (error) {
    return error
  }
  return undefined
}

/** The one terminal `finish` chunk, which must come last. */
export function finishChunk(chunks) {
  const finishes = chunks.filter((chunk) => chunk.type === 'finish')
  is(finishes.length, 1, 'exactly one finish chunk')
  is(chunks[chunks.length - 1].type, 'finish', 'finish is terminal')
  return finishes[0]
}

/** The one `usage` chunk, which must precede the terminal finish. */
export function usageChunk(chunks) {
  const usages = chunks.filter((chunk) => chunk.type === 'usage')
  is(usages.length, 1, 'exactly one usage chunk')
  const finishIndex = chunks.findIndex((chunk) => chunk.type === 'finish')
  ok(chunks.indexOf(usages[0]) < finishIndex, 'usage precedes finish')
  return usages[0]
}
