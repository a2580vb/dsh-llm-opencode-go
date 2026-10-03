/**
 * Anthropic Messages transport.
 *
 * The native protocol for the MiniMax, Kimi, and Qwen families on OpenCode Go.
 * The relay's Messages endpoint authenticates with `x-api-key` — a bearer token
 * is refused as `AuthError: Missing API key` — which is why this protocol owns
 * its own header set instead of inheriting the shared one.
 *
 * Its stream is the only one of the three that closes blocks explicitly, so
 * this translator maps `content_block_stop` rather than closing everything at
 * the end.
 *
 * @module dsh-llm-opencode-go/protocol/anthropic-messages
 */

import { PROTOCOLS } from '../config.js'
import { malformed, streamClosed } from '../error/mapping.js'
import { parseSse } from '../stream/sse.js'
import { toAnthropicMessages } from '../transform/messages.js'
import { reasoningFields } from '../transform/reasoning.js'
import { toToolDeclarations } from '../transform/tools.js'
import { StreamBuilder, FINISH, finishFromStopReason, mapOpenAiUsage } from './shared.js'

export const PROTOCOL = PROTOCOLS.ANTHROPIC

/** Where this protocol posts, relative to the configured API root. */
export const PATH = '/messages'

/** The Messages API version this adapter speaks. */
export const API_VERSION = '2023-06-01'

/**
 * Headers every Messages request carries.
 *
 * `x-api-key` rather than `authorization`, and `anthropic-version` is required.
 *
 * @param {string} apiKey - the resolved credential.
 * @returns {Record<string, string>} the protocol's own headers.
 */
export function authHeaders(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    accept: 'text/event-stream',
  }
}

/**
 * Build the request for one Messages call.
 *
 * @param {object} input - the prepared call.
 * @param {object} input.request - the harness `GenerateOptions`.
 * @param {object} input.model - the catalog record.
 * @param {string} [input.effort] - the resolved reasoning effort.
 * @param {boolean} input.replayReasoning - whether to replay thinking blocks.
 * @param {Record<string, string>} input.signatures - reasoning text to signature.
 * @param {ImageBytesResolver} [input.imageSource] - resolves one image block to a source.
 * @returns {Promise<{ body: object, headers: Record<string, string> }>} the wire request.
 */
export async function prepare(input) {
  const { request, model, effort, replayReasoning, signatures, imageSource } = input
  const images = input.images === true
  const converted = await toAnthropicMessages({
    messages: request.messages,
    system: request.system,
    replayReasoning,
    signatures,
    images,
    imagePart: imageSource,
  })
  const tools = toToolDeclarations(request.tools, PROTOCOL)

  const body = {
    model: model.id,
    // Required by the API; the harness always resolves a cap before dispatch,
    // but a hand-built call may not, so a conservative default stands in.
    max_tokens: request.maxTokens ?? model.maxTokens,
    stream: true,
    messages: converted.messages,
    ...(converted.system === undefined ? {} : { system: converted.system }),
    ...(tools === undefined ? {} : { tools }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.stop === undefined ? {} : { stop_sequences: request.stop }),
    ...reasoningFields({ protocol: PROTOCOL, effort, maxTokens: request.maxTokens ?? model.maxTokens }),
  }
  return { body, headers: {} }
}

/**
 * Translate one Messages SSE body into harness chunks.
 *
 * @param {object} input - the stream input.
 * @param {ReadableStream<Uint8Array>} input.body - the response body.
 * @param {string} input.model - the requested model id, recorded in replay state.
 * @param {AbortSignal} [input.signal] - cancellation.
 * @param {() => void} [input.activity] - called on every received frame.
 * @returns {AsyncGenerator<object>} harness stream chunks.
 */
export async function* translate(input) {
  const { body, model, signal, activity } = input
  const builder = new StreamBuilder({ protocol: PROTOCOL, model })
  /** Wire block index to the key the builder knows it by. */
  const keys = new Map()
  let usage
  let finish
  let stopReason
  let settled = false

  for await (const frame of parseSse(body, signal)) {
    activity?.()
    if (frame.data === '' || frame.data === '[DONE]') continue

    let event
    try {
      event = JSON.parse(frame.data)
    } catch {
      throw malformed(PROTOCOL, `an event frame was not JSON: ${frame.data.slice(0, 200)}`)
    }
    const type = typeof event?.type === 'string' ? event.type : frame.event
    if (typeof type !== 'string') continue

    switch (type) {
      case 'message_start': {
        builder.setResponseId(event?.message?.id)
        if (event?.message?.usage !== undefined) usage = mapOpenAiUsage(event.message.usage)
        break
      }
      case 'content_block_start': {
        const wireIndex = Number.isInteger(event?.index) ? event.index : 0
        const native = event?.content_block
        const key = `block:${wireIndex}`
        keys.set(wireIndex, key)
        if (native?.type === 'tool_use') {
          yield* builder.openToolCall(key, { id: native.id, name: native.name })
          // A gateway answering without streaming sends the finished input up
          // front, as `{}` for a call with no arguments — which must not be
          // appended, or the streamed deltas would be preceded by an empty
          // object and the assembled arguments would not be valid JSON.
          if (native.input !== null && typeof native.input === 'object'
            && Object.keys(native.input).length > 0) {
            yield* builder.toolArguments(key, JSON.stringify(native.input))
          }
        } else if (native?.type === 'thinking') {
          const initial = typeof native.thinking === 'string' ? native.thinking : ''
          if (initial !== '') yield* builder.reasoning(key, initial)
        } else if (native?.type === 'text') {
          const initial = typeof native.text === 'string' ? native.text : ''
          if (initial !== '') yield* builder.text(key, initial)
        }
        break
      }
      case 'content_block_delta': {
        const wireIndex = Number.isInteger(event?.index) ? event.index : 0
        const key = keys.get(wireIndex) ?? `block:${wireIndex}`
        keys.set(wireIndex, key)
        const delta = event?.delta
        if (delta?.type === 'thinking_delta') {
          yield* builder.reasoning(key, typeof delta.thinking === 'string' ? delta.thinking : '')
        } else if (delta?.type === 'signature_delta') {
          yield* builder.reasoning(key, '', typeof delta.signature === 'string' ? delta.signature : '')
        } else if (delta?.type === 'text_delta') {
          yield* builder.text(key, typeof delta.text === 'string' ? delta.text : '')
        } else if (delta?.type === 'input_json_delta') {
          yield* builder.toolArguments(key, typeof delta.partial_json === 'string' ? delta.partial_json : '')
        }
        break
      }
      case 'content_block_stop': {
        const wireIndex = Number.isInteger(event?.index) ? event.index : 0
        const key = keys.get(wireIndex)
        if (key !== undefined) yield* builder.close(key)
        break
      }
      case 'message_delta': {
        const reason = event?.delta?.stop_reason
        if (typeof reason === 'string' && reason !== '') {
          stopReason = reason
          finish = finishFromStopReason(reason, PROTOCOL)
        }
        if (event?.usage !== undefined && event.usage !== null) {
          usage = mergeMessageUsage(usage, event.usage)
        }
        break
      }
      case 'message_stop': {
        settled = true
        break
      }
      case 'error': {
        const detail = event?.error?.message ?? 'the relay reported an error'
        throw malformed(PROTOCOL, detail)
      }
      default:
        // `ping` and any future event this adapter does not need.
        break
    }
  }

  if (!settled) throw streamClosed(PROTOCOL, 'message_stop')
  if (finish === undefined) throw streamClosed(PROTOCOL, 'a stop_reason')
  if (stopReason === 'refusal') {
    // A refusal is a legitimate stop, not an error; the text carries the reason.
    finish = FINISH.STOP
  }
  yield* builder.closeAll()
  yield* builder.settle({ usage, reason: finish, replayExtra: { stopReason } })
}

/**
 * The Messages API splits usage across `message_start` (input) and
 * `message_delta` (output), and reports thinking tokens inside
 * `output_tokens_details`, so the two halves are merged rather than replaced.
 *
 * Merging must be field by field rather than by rebuilding the object, because
 * `message_start` is the only event that carries the two cache figures. Dropping
 * them here is what made every Messages-protocol call report a cache hit of
 * zero: the numbers arrived, were mapped, and were then replaced by a delta that
 * had never heard of them.
 */
function mergeMessageUsage(previous, delta) {
  const inputTokens = number(delta.input_tokens) || previous?.inputTokens || 0
  const outputTokens = number(delta.output_tokens) || previous?.outputTokens || 0
  const cacheReadTokens = number(delta.cache_read_input_tokens) || previous?.cacheReadTokens || 0
  const cacheWriteTokens = number(delta.cache_creation_input_tokens) || previous?.cacheWriteTokens || 0
  const reasoning = number(delta.output_tokens_details?.thinking_tokens) || previous?.reasoningTokens || 0
  return {
    inputTokens,
    outputTokens,
    // This shape never folds the cached part into the prompt count, so the four
    // parts are simply added.
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    // Carried through as present/absent, so the page can still tell "reported as
    // zero" from "not reported" after the merge.
    ...((previous?.cacheReadTokens !== undefined || delta.cache_read_input_tokens !== undefined)
      ? { cacheReadTokens }
      : {}),
    ...((previous?.cacheWriteTokens !== undefined || delta.cache_creation_input_tokens !== undefined)
      ? { cacheWriteTokens }
      : {}),
    ...(reasoning === 0 ? {} : { reasoningTokens: reasoning }),
  }
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}
