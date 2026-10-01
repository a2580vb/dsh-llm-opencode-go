/**
 * OpenAI-compatible Chat Completions transport.
 *
 * Used by every OpenCode Go model that is not Responses- or Messages-native.
 * The relay forwards these requests to its own upstreams, so the wire shape is
 * deliberately conservative: only fields observed to be accepted are sent, and
 * the reasoning parameter uses the vocabulary the relay itself validates.
 *
 * @module dsh-opencode-go/protocol/chat-completions
 */

import { PROTOCOLS } from '../config.js'
import { malformed, streamClosed } from '../error/mapping.js'
import { isDoneFrame, parseSse } from '../stream/sse.js'
import { toChatMessages } from '../transform/messages.js'
import { reasoningFields } from '../transform/reasoning.js'
import { toToolDeclarations } from '../transform/tools.js'
import { StreamBuilder, finishFromStopReason, mapOpenAiUsage } from './shared.js'

export const PROTOCOL = PROTOCOLS.CHAT

/** Where this protocol posts, relative to the configured API root. */
export const PATH = '/chat/completions'

/**
 * Build the request for one Chat Completions call.
 *
 * @param {object} input - the prepared call.
 * @param {object} input.request - the harness `GenerateOptions`.
 * @param {object} input.model - the catalog record.
 * @param {string} [input.effort] - the resolved reasoning effort.
 * @param {boolean} input.replayReasoning - whether to send reasoning history back.
 * @param {ImageBytesResolver} [input.imageUrl] - resolves one image block to a URL.
 * @returns {Promise<{ body: object, headers: Record<string, string> }>} the wire request.
 */
export async function prepare(input) {
  const { request, model, effort, replayReasoning, imageUrl } = input
  const images = input.images === true
  const messages = await toChatMessages({
    messages: request.messages,
    replayReasoning,
    images,
    imagePart: imageUrl,
  })
  const tools = toToolDeclarations(request.tools, PROTOCOL)

  const body = {
    model: model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools === undefined ? {} : { tools }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    ...(request.stop === undefined ? {} : { stop: request.stop }),
    ...reasoningFields({ protocol: PROTOCOL, effort, maxTokens: request.maxTokens }),
  }

  // The system prompt is a leading message here, not a top-level field.
  if (typeof request.system === 'string' && request.system !== '') {
    body.messages = [{ role: 'system', content: request.system }, ...messages]
  }
  return { body, headers: { accept: 'text/event-stream' } }
}

/**
 * Translate one Chat Completions SSE body into harness chunks.
 *
 * The relay interleaves two independent sequences: content deltas per choice,
 * and a running `usage` object on most frames. Reasoning arrives as either
 * `reasoning_content` (DeepSeek, GLM, Kimi) or `reasoning`, and tool calls
 * arrive fragmented — the function name in the first frame, then argument
 * bytes — so tool identity is remembered per wire index rather than re-read
 * from every frame.
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
  let usage
  let finish
  let settled = false

  for await (const frame of parseSse(body, signal)) {
    activity?.()
    if (isDoneFrame(frame)) break
    if (frame.data === '') continue

    let payload
    try {
      payload = JSON.parse(frame.data)
    } catch {
      throw malformed(PROTOCOL, `a data frame was not JSON: ${frame.data.slice(0, 200)}`)
    }

    builder.setResponseId(payload?.id)
    if (payload?.error !== undefined && payload?.error !== null) {
      const detail = payload.error.message ?? payload.error.code ?? payload.error.type ?? 'unknown error'
      throw malformed(PROTOCOL, `the relay reported an error: ${detail}`)
    }
    if (payload?.usage !== null && typeof payload?.usage === 'object') usage = mapOpenAiUsage(payload.usage)

    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined
    if (choice === null || typeof choice !== 'object') continue

    const delta = choice.delta
    if (delta !== null && typeof delta === 'object') {
      const reasoning = typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' ? delta.reasoning : undefined
      if (reasoning !== undefined && reasoning !== '') {
        yield* builder.reasoning('reasoning:0', reasoning)
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        yield* builder.text('text:0', delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const wireIndex = Number.isInteger(call?.index) ? call.index : 0
          const key = `tool:${wireIndex}`
          const identity = {}
          if (typeof call?.id === 'string' && call.id !== '') identity.id = call.id
          if (typeof call?.function?.name === 'string' && call.function.name !== '') {
            identity.name = call.function.name
          }
          yield* builder.openToolCall(key, identity)
          if (typeof call?.function?.arguments === 'string') {
            yield* builder.toolArguments(key, call.function.arguments)
          }
        }
      }
    }

    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
      finish = finishFromStopReason(choice.finish_reason, PROTOCOL)
      settled = true
    }
  }

  if (!settled) throw streamClosed(PROTOCOL, 'a finish_reason')
  yield* builder.closeAll()
  yield* builder.settle({ usage, reason: finish })
}
