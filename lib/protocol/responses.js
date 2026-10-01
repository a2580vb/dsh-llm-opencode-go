/**
 * OpenAI Responses transport.
 *
 * The native protocol for the GPT and Grok families on OpenCode Go; those
 * models refuse `/chat/completions` with `ModelProtocolUnsupported`. Its stream
 * is fully event-typed, so this translator is mostly a mapping table — but two
 * details need care:
 *
 *   - the system prompt is `instructions`, a top-level field, and a `system`
 *     turn inside `input` is rejected rather than ignored;
 *   - reasoning items cannot be replayed, so prior thinking is dropped from the
 *     request instead of being sent back as an item the API would refuse.
 *
 * @module dsh-opencode-go/protocol/responses
 */

import { PROTOCOLS } from '../config.js'
import { malformed, streamClosed } from '../error/mapping.js'
import { parseSse } from '../stream/sse.js'
import { toResponsesInput } from '../transform/messages.js'
import { reasoningFields } from '../transform/reasoning.js'
import { toToolDeclarations } from '../transform/tools.js'
import { StreamBuilder, FINISH, finishFromStopReason, mapOpenAiUsage } from './shared.js'

export const PROTOCOL = PROTOCOLS.RESPONSES

/** Where this protocol posts, relative to the configured API root. */
export const PATH = '/responses'

/**
 * Build the request for one Responses call.
 *
 * @param {object} input - the prepared call.
 * @param {object} input.request - the harness `GenerateOptions`.
 * @param {object} input.model - the catalog record.
 * @param {string} [input.effort] - the resolved reasoning effort.
 * @param {ImageBytesResolver} [input.imageUrl] - resolves one image block to a URL.
 * @returns {Promise<{ body: object, headers: Record<string, string> }>} the wire request.
 */
export async function prepare(input) {
  const { request, model, effort, imageUrl } = input
  const images = input.images === true
  const input_items = await toResponsesInput({
    messages: request.messages,
    images,
    imagePart: imageUrl,
  })
  const tools = toToolDeclarations(request.tools, PROTOCOL)

  const body = {
    model: model.id,
    stream: true,
    input: input_items,
    ...(tools === undefined ? {} : { tools }),
    ...(typeof request.system === 'string' && request.system !== ''
      ? { instructions: request.system }
      : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { max_output_tokens: request.maxTokens }),
    ...(request.stop === undefined ? {} : { stop: request.stop }),
    ...reasoningFields({ protocol: PROTOCOL, effort, maxTokens: request.maxTokens }),
  }
  return { body, headers: { accept: 'text/event-stream' } }
}

/**
 * Translate one Responses SSE body into harness chunks.
 *
 * `output_index` is the protocol's own block identity, so it is used directly
 * as the block key: a single response can interleave a reasoning item, a
 * message item, and several function-call items.
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
  /** Reasoning text, so an `output_item.done` item can be matched back. */
  const reasoningText = new Map()
  let usage
  let finish
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

    if (type === 'response.created' || type === 'response.in_progress') {
      builder.setResponseId(event?.response?.id)
      continue
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      builder.setResponseId(event?.response?.id)
      usage = mapOpenAiUsage(event?.response?.usage)
      // `incomplete` is the truncation signal; `completed` always means stop.
      finish = type === 'response.incomplete' ? FINISH.MAX_TOKENS : finish ?? FINISH.STOP
      settled = true
      continue
    }
    if (type === 'response.failed') {
      const detail = event?.response?.error?.message ?? 'the response failed'
      throw malformed(PROTOCOL, detail)
    }
    if (type === 'error') {
      const detail = event?.error?.message ?? event?.message ?? 'the relay reported an error'
      throw malformed(PROTOCOL, detail)
    }

    const outputIndex = Number.isInteger(event?.output_index) ? event.output_index : 0
    const key = `item:${outputIndex}`

    switch (type) {
      case 'response.output_item.added': {
        const item = event?.item
        if (item?.type === 'reasoning') {
          // Opened lazily: a reasoning item with no summary text produces nothing.
          reasoningText.set(outputIndex, '')
        } else if (item?.type === 'function_call') {
          yield* builder.openToolCall(key, { id: item.call_id, name: item.name })
        } else if (item?.type === 'message') {
          // The message item itself carries no text; parts arrive as deltas.
        }
        break
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = typeof event?.delta === 'string' ? event.delta : ''
        reasoningText.set(outputIndex, (reasoningText.get(outputIndex) ?? '') + delta)
        yield* builder.reasoning(key, delta)
        break
      }
      case 'response.output_text.delta': {
        yield* builder.text(key, typeof event?.delta === 'string' ? event.delta : '')
        break
      }
      case 'response.refusal.delta': {
        // A refusal is visible content; the harness has no separate block for it.
        yield* builder.text(key, typeof event?.delta === 'string' ? event.delta : '')
        break
      }
      case 'response.function_call_arguments.delta': {
        yield* builder.toolArguments(key, typeof event?.delta === 'string' ? event.delta : '')
        break
      }
      case 'response.function_call_arguments.done': {
        // The complete string is authoritative; replay it only if no delta
        // arrived, so the accumulated arguments cannot be doubled.
        const complete = typeof event?.arguments === 'string' ? event.arguments : ''
        const entry = builder.blocks.find((block) => block.key === key)
        if (complete !== '' && (entry === undefined || entry.json === '')) {
          yield* builder.toolArguments(key, complete)
        }
        break
      }
      case 'response.output_item.done': {
        const item = event?.item
        if (item?.type === 'function_call' && typeof item.arguments === 'string' && item.arguments !== '') {
          const entry = builder.blocks.find((block) => block.key === key)
          if (entry !== undefined && entry.json === '' && item.arguments !== '') {
            yield* builder.toolArguments(key, item.arguments)
          }
        }
        break
      }
      default:
        break
    }
  }

  if (!settled) throw streamClosed(PROTOCOL, 'response.completed')
  yield* builder.closeAll()
  yield* builder.settle({ usage, reason: finish ?? FINISH.STOP })
}
