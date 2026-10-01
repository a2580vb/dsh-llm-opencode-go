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

import { bodyFromString } from '../../lib/stream/sse.js'
import { is, ok } from '../helpers.mjs'

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden')

/** Read one captured response body. */
export async function fixture(name) {
  return readFile(join(goldenDir, name), 'utf8')
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
