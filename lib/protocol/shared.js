/**
 * Primitives the three protocol translators share.
 *
 * Each translator reads a different event vocabulary, but all three produce the
 * same stream shape: ordered content blocks, each opened once, grown by deltas,
 * and closed once, followed by exactly one `usage` chunk and one terminal
 * `finish` chunk. {@link StreamBuilder} owns that shape so no protocol module
 * has to re-derive the harness's ordering invariants.
 *
 * @module dsh-llm-opencode-go/protocol/shared
 */

import { ToolCallId } from '../error/errors.js'
import { emptyResponse, malformed } from '../error/mapping.js'

/** Harness finish reasons, in the one place the protocols can share them. */
export const FINISH = Object.freeze({
  STOP: Object.freeze({ kind: 'stop' }),
  TOOL_CALLS: Object.freeze({ kind: 'tool-calls' }),
  MAX_TOKENS: Object.freeze({ kind: 'max-tokens' }),
})

/**
 * Map an OpenAI-shaped `finish_reason` onto a harness finish reason.
 *
 * @param {string} reason - the provider's own value.
 * @param {string} protocol - for the diagnostic when the value is unknown.
 * @returns {{kind: string}} the harness finish reason.
 */
export function finishFromStopReason(reason, protocol) {
  switch (reason) {
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
    case 'completed':
      return FINISH.STOP
    case 'tool_calls':
    case 'tool_use':
    case 'function_call':
      return FINISH.TOOL_CALLS
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
      return FINISH.MAX_TOKENS
    case 'content_filter':
      return FINISH.STOP
    default:
      throw malformed(protocol, `unknown finish reason ${JSON.stringify(reason)}`)
  }
}

/**
 * Map one OpenAI- or Anthropic-shaped usage object onto harness token accounting.
 *
 * The two families disagree about what their prompt figure counts, and the
 * harness settles the disagreement by defining `inputTokens` as the **uncached**
 * input: its own token meter reads the field back under the name
 * `uncachedInputTokens`. So the cached part has to come *out* of the prompt
 * figure when the provider folded it in, and stay where it is when the provider
 * kept it separate:
 *
 *   OpenAI, `prompt_tokens_details` / `input_tokens_details`:
 *     `prompt_tokens: 369` = 113 uncached + 256 cached  ->  `inputTokens: 113`
 *   Anthropic, `cache_read_input_tokens` / `cache_creation_input_tokens`:
 *     `input_tokens: 4` is the uncached part alone      ->  `inputTokens: 4`
 *
 * Both families then add up the same way — uncached + output + read + write —
 * which is what makes one formula correct for both, and what the old code got
 * wrong: it passed the OpenAI prompt count through untouched and then added the
 * cached part on top, counting the same tokens twice.
 *
 * @param {object} usage - the provider's usage object.
 * @returns {object} a harness `TokenUsage`.
 */
export function mapOpenAiUsage(usage) {
  const prompt = number(usage?.prompt_tokens ?? usage?.input_tokens)
  const output = number(usage?.completion_tokens ?? usage?.output_tokens)
  // The detail objects are OpenAI-only and the two `cache_*_input_tokens` fields
  // are Anthropic-only, so which shape this is follows from what is present.
  const details = usage?.prompt_tokens_details ?? usage?.input_tokens_details
  // Only what the detail objects reported sits *inside* the prompt count, and
  // that is by the objects' own definition: they break `prompt_tokens` down.
  const foldedRead = number(details?.cached_tokens)
  const foldedWrite = number(details?.cache_write_tokens)
  const cacheRead = foldedRead || number(usage?.cache_read_input_tokens)
  const cacheWrite = foldedWrite || number(usage?.cache_creation_input_tokens)
  const reasoning = number(
    usage?.completion_tokens_details?.reasoning_tokens
    ?? usage?.output_tokens_details?.reasoning_tokens
    ?? usage?.output_tokens_details?.thinking_tokens,
  )
  const uncached = Math.max(0, prompt - foldedRead - foldedWrite)
  const total = number(usage?.total_tokens)
  // A cache figure is reported when the provider named it, even as a zero: a
  // service that says "nothing was cached" is saying something different from a
  // service that says nothing at all, and the page tells the two apart.
  const reported = details !== undefined && details !== null
    ? (details.cached_tokens !== undefined || details.cache_write_tokens !== undefined)
    : (usage?.cache_read_input_tokens !== undefined || usage?.cache_creation_input_tokens !== undefined)
  return {
    inputTokens: uncached,
    outputTokens: output,
    totalTokens: total === 0 ? uncached + output + cacheRead + cacheWrite : total,
    ...(reported ? { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning === 0 ? {} : { reasoningTokens: reasoning }),
  }
}

/** A finite non-negative integer, or 0. */
function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

/** Raised by {@link StreamBuilder.closeAll} when a tool call never named itself. */
class IncompleteToolCall extends Error {
  constructor(index) {
    super(`tool call block ${index} never named a function`)
    this.index = index
  }
}

/**
 * Accumulates one provider stream into harness chunks.
 *
 * A protocol translator drives this with named events. The builder owns block
 * identity, ordering, and the reasoning signatures replay state needs, which is
 * exactly the part every protocol got subtly wrong when it kept its own map.
 */
export class StreamBuilder {
  /**
   * @param {object} input - the builder input.
   * @param {string} input.protocol - the protocol name, for diagnostics.
   * @param {string} input.model - the requested model id, recorded in replay state.
   */
  constructor(input) {
    this.protocol = input.protocol
    this.model = input.model
    /** @type {Array<{key: string, index: number, type: string, id?: string, name?: string, json: string, text: string}>} */
    this.blocks = []
    /** @type {Map<string, number>} */
    this.byKey = new Map()
    /** @type {Map<string, string>} reasoning text to provider signature. */
    this.signatures = new Map()
    this.responseId = undefined
    this.produced = false
  }

  /** Remember the provider's response id for replay. */
  setResponseId(id) {
    if (typeof id === 'string' && id !== '') this.responseId = id
  }

  /** The block for `key`, creating it when it is new. */
  entry(key, type) {
    const index = this.byKey.get(key)
    if (index === undefined) {
      const created = { key, index: this.blocks.length, type, json: '', text: '' }
      this.byKey.set(key, created.index)
      this.blocks.push(created)
      return { entry: created, created: true }
    }
    const entry = this.blocks[index]
    if (entry.type !== type) {
      throw malformed(this.protocol, `block ${index} changed from ${entry.type} to ${type}`)
    }
    return { entry, created: false }
  }

  /**
   * Open a block if needed.
   *
   * @param {string} key - the protocol's own identity for this block.
   * @param {string} type - the harness block type.
   * @returns {object[]} the chunks to yield.
   */
  open(key, type) {
    const { created, entry } = this.entry(key, type)
    return created ? [{ type: 'block-start', index: entry.index, blockType: type }] : []
  }

  /**
   * Append text to a text block.
   *
   * @param {string} key - block identity.
   * @param {string} text - the delta.
   * @returns {object[]} the chunks to yield.
   */
  text(key, text) {
    if (typeof text !== 'string' || text === '') return []
    const { created, entry } = this.entry(key, 'text')
    entry.text += text
    this.produced = true
    return [
      ...(created ? [{ type: 'block-start', index: entry.index, blockType: 'text' }] : []),
      { type: 'text-delta', index: entry.index, text },
    ]
  }

  /**
   * Append text to a reasoning block, remembering its signature when given.
   *
   * @param {string} key - block identity.
   * @param {string} text - the delta.
   * @param {string} [signatureDelta] - signature bytes arriving with this block.
   * @returns {object[]} the chunks to yield.
   */
  reasoning(key, text, signatureDelta) {
    const { created, entry } = this.entry(key, 'reasoning')
    if (typeof signatureDelta === 'string' && signatureDelta !== '') {
      const previous = this.signatures.get(entry.key) ?? ''
      this.signatures.set(entry.key, previous + signatureDelta)
    }
    if (typeof text !== 'string' || text === '') {
      return created ? [{ type: 'block-start', index: entry.index, blockType: 'reasoning' }] : []
    }
    entry.text += text
    this.produced = true
    return [
      ...(created ? [{ type: 'block-start', index: entry.index, blockType: 'reasoning' }] : []),
      { type: 'reasoning-delta', index: entry.index, text },
    ]
  }

  /**
   * Open a tool-call block and record its identity.
   *
   * @param {string} key - block identity.
   * @param {object} [identity] - `{id, name}` when the protocol states them.
   * @returns {object[]} the chunks to yield.
   */
  openToolCall(key, identity) {
    const { created, entry } = this.entry(key, 'tool-call')
    if (identity?.id !== undefined) entry.id = String(identity.id)
    if (identity?.name !== undefined && identity.name !== null) entry.name = String(identity.name)
    return [
      ...(created ? [{ type: 'block-start', index: entry.index, blockType: 'tool-call' }] : []),
      {
        type: 'tool-call-delta',
        index: entry.index,
        id: ToolCallId(entry.id ?? `call-${entry.index}`),
        ...(entry.name === undefined ? {} : { name: entry.name }),
        argumentsDelta: '',
      },
    ]
  }

  /**
   * Append a tool-call argument delta.
   *
   * @param {string} key - block identity.
   * @param {string} argumentsDelta - raw JSON bytes.
   * @returns {object[]} the chunks to yield.
   */
  toolArguments(key, argumentsDelta) {
    if (typeof argumentsDelta !== 'string' || argumentsDelta === '') return []
    const { entry } = this.entry(key, 'tool-call')
    entry.json += argumentsDelta
    return [{
      type: 'tool-call-delta',
      index: entry.index,
      id: ToolCallId(entry.id ?? `call-${entry.index}`),
      ...(entry.name === undefined ? {} : { name: entry.name }),
      argumentsDelta,
    }]
  }

  /**
   * Close every open block, in stream order.
   *
   * Blocks without an explicit provider close event are closed here, which is
   * what the Chat Completions and Responses protocols need: neither sends one.
   *
   * @returns {object[]} the `block-end` chunks.
   */
  closeAll() {
    const out = []
    for (const entry of this.blocks) {
      if (entry.type === 'tool-call') {
        if (entry.name === undefined) throw new IncompleteToolCall(entry.index)
        out.push({
          type: 'block-end',
          index: entry.index,
          block: {
            type: 'tool-call',
            id: ToolCallId(entry.id ?? `call-${entry.index}`),
            name: entry.name,
            arguments: entry.json === '' ? '{}' : entry.json,
          },
        })
      } else if (entry.type === 'text') {
        out.push({ type: 'block-end', index: entry.index, block: { type: 'text', text: entry.text } })
      } else {
        out.push({ type: 'block-end', index: entry.index, block: { type: 'reasoning', text: entry.text } })
      }
    }
    return out
  }

  /**
   * Close one block by key, when the protocol has an explicit close event.
   *
   * @param {string} key - block identity.
   * @returns {object[]} the `block-end` chunk, or none when the block is unknown.
   */
  close(key) {
    const index = this.byKey.get(key)
    if (index === undefined) return []
    return this.closeAt(index)
  }

  /** Close the block at one index. */
  closeAt(index) {
    const entry = this.blocks.find((block) => block.index === index)
    if (entry === undefined) return []
    if (entry.type === 'tool-call') {
      if (entry.name === undefined) throw new IncompleteToolCall(entry.index)
      return [{
        type: 'block-end',
        index: entry.index,
        block: {
          type: 'tool-call',
          id: ToolCallId(entry.id ?? `call-${entry.index}`),
          name: entry.name,
          arguments: entry.json === '' ? '{}' : entry.json,
        },
      }]
    }
    if (entry.type === 'text') {
      return [{ type: 'block-end', index: entry.index, block: { type: 'text', text: entry.text } }]
    }
    return [{ type: 'block-end', index: entry.index, block: { type: 'reasoning', text: entry.text } }]
  }

  /** Whether any visible content was produced. */
  get hasContent() {
    return this.produced || this.blocks.some((entry) => entry.type === 'tool-call')
  }

  /** Whether any tool call was produced, which forces a `tool-calls` finish. */
  get hasToolCalls() {
    return this.blocks.some((entry) => entry.type === 'tool-call')
  }

  /**
   * The replay state for one finished response.
   *
   * The harness keeps this beside the assistant message and hands it back on
   * the next request, but only when the same adapter owns both routes. Two
   * facts survive the round trip: the provider's response id, and the reasoning
   * signature the Messages API needs before it will accept a thinking block
   * back.
   *
   * The signature is addressed by the exact reasoning text, because that is all
   * a durable `ReasoningBlock` carries — the signature is not part of the
   * harness vocabulary, so it can only be recovered by content. A block whose
   * signature the provider never sent simply has none, and the request
   * converter degrades that block to text instead of sending something the API
   * would refuse.
   *
   * @param {object} [extra] - additional response-level facts.
   * @returns {object} a `ReplayEnvelope`.
   */
  replay(extra) {
    const response = {
      ...(this.responseId === undefined ? {} : { id: this.responseId }),
      ...(extra ?? {}),
    }
    const blocks = this.blocks.map((entry) => {
      if (entry.type !== 'reasoning') return { type: entry.type }
      const signature = this.signatures.get(entry.key)
      return signature === undefined
        ? { type: 'reasoning' }
        : { type: 'reasoning', signature }
    })
    return { response, blocks }
  }

  /**
   * The reasoning-signature index the request converter replays through.
   *
   * @returns {Record<string, string>} reasoning text to signature.
   */
  signatureIndex() {
    const out = {}
    for (const entry of this.blocks) {
      if (entry.type !== 'reasoning') continue
      const signature = this.signatures.get(entry.key)
      if (signature !== undefined && entry.text !== '') out[entry.text] = signature
    }
    return out
  }

  /**
   * The chunks that end a successful stream: usage, then finish.
   *
   * @param {object} input - the terminal facts.
   * @param {object | undefined} input.usage - mapped token usage.
   * @param {object} input.reason - the harness finish reason.
   * @param {object} [input.replayExtra] - extra response-level replay facts.
   * @returns {object[]} the terminal chunks.
   */
  settle(input) {
    if (!this.hasContent) throw emptyResponse(this.protocol)
    const reason = this.hasToolCalls && input.reason === FINISH.STOP ? FINISH.TOOL_CALLS : input.reason
    return [
      { type: 'usage', usage: input.usage ?? { inputTokens: 0, outputTokens: 0 } },
      { type: 'finish', reason, replayState: this.replay(input.replayExtra) },
    ]
  }
}

/** Re-exported so a protocol module has one import for its error helpers. */
export { IncompleteToolCall }
