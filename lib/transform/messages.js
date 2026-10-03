/**
 * DSH content blocks and messages to each protocol's request shape.
 *
 * The harness hands the adapter provider-neutral `Message` values: roles
 * `system`, `developer`, `user`, `assistant`, and `tool`, over content blocks
 * `text`, `reasoning`, `image`, `file`, `tool-call`, `tool-addition`, and
 * `tool-removal`. This module names those shapes for all three protocols so the
 * protocol modules stay about transport and streaming.
 *
 * Four invariants hold everywhere here:
 *   - No adapter-authored prose enters a request. Conversion is structural; the
 *     only text this module writes is a placeholder for something it cannot
 *     send, so a refusal is visible rather than silent.
 *   - Tool-call arguments stay raw JSON strings, as the harness requires. They
 *     are passed through, or parsed for the one protocol that needs an object,
 *     and never re-serialized from a parsed form.
 *   - A durable image reference is never sent as an id. It is resolved to real
 *     bytes through the attachment seam, or replaced by its placeholder.
 *   - Every protocol is sent a complete call/result pairing. A call the history
 *     cannot answer is omitted rather than sent into a refusal, because all
 *     three wires reject the request that carries it.
 *
 * @module dsh-llm-opencode-go/transform/messages
 */

import { malformed } from '../error/mapping.js'

/**
 * Convert one image block into a request part.
 *
 * @callback ImagePartFactory
 * @param {object} block - the harness image block.
 * @param {string} mediaType - the media type to declare for the bytes.
 * @returns {Promise<object | undefined>} a protocol-specific part or URL, or
 *   undefined when the bytes could not be produced.
 */

/** Text-only placeholder for an image block, so a refusal is never silent. */
export function imagePlaceholder(block) {
  const name = block?.attachment?.name ?? block?.attachment?.attachmentId ?? 'image'
  const mediaType = block?.attachment?.mediaType ?? 'unknown type'
  return `[image ${name} (${mediaType}) was not sent: this route is not configured for image input]`
}

/** File blocks never reach an adapter; the runtime replaces them with handles. */
export function filePlaceholder(block) {
  return `[file ${block?.attachment?.name ?? block?.attachment?.attachmentId ?? 'attachment'} was not sent]`
}

/**
 * Whether a converted message carries anything the provider can read.
 *
 * An empty user turn is legal in the harness but rejected on the wire, so
 * callers drop these after conversion.
 *
 * @param {unknown} value - a converted content value.
 * @returns {boolean} true when it has something to send.
 */
export function hasContent(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  return false
}

/** Tool arguments as the wire wants them: a JSON object string. */
function argumentsText(block) {
  const raw = block?.arguments
  if (typeof raw !== 'string' || raw.trim() === '') return '{}'
  return raw
}

/** Parse historical tool arguments for the one protocol that needs an object. */
function argumentsObject(block, context) {
  const raw = argumentsText(block)
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('arguments are not a JSON object')
    }
    return parsed
  } catch (error) {
    throw malformed(context, `tool call "${block?.name ?? '?'}" carried unusable arguments: ${error.message}`)
  }
}

/** A short label for a tool result that has no text of its own. */
function toolResultFallbackText(message) {
  return message?.isError === true ? '(the tool failed without a message)' : '(the tool returned no text)'
}

/**
 * Join the text of a message's blocks into one plain string.
 *
 * @param {readonly object[]} content - the message content blocks.
 * @returns {string} the joined text.
 */
export function textOf(content) {
  const parts = []
  for (const block of content ?? []) {
    switch (block?.type) {
      case 'text':
        parts.push(String(block.text ?? ''))
        break
      case 'assistant-text':
        parts.push(String(block.text ?? ''))
        break
      case 'image':
        parts.push(imagePlaceholder(block))
        break
      case 'file':
        parts.push(filePlaceholder(block))
        break
      default:
        // Reasoning is replayed through its protocol's dedicated field.
        break
    }
  }
  return parts.join('')
}

/** The joined reasoning text of one message, or undefined when it has none. */
export function reasoningOf(content) {
  const parts = []
  for (const block of content ?? []) {
    if (block?.type === 'reasoning') parts.push(String(block.text ?? ''))
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/** Every tool call in one message, in order. */
export function toolCallsOf(content) {
  return (content ?? []).filter((block) => block?.type === 'tool-call')
}

/** The identity a tool result cites, as the wire spells it. */
function resultCallId(message) {
  const id = message?.toolCallId
  return id === undefined || id === null ? undefined : String(id)
}

/**
 * The tool-call ids the history actually answers, and the ids it invokes.
 *
 * A `tool-call` block with no `tool` message answering it is a hole in the
 * history: this adapter never wrote a result for it, so no provider can be told
 * what the call returned. Every protocol here is strict about that hole — the
 * Responses API rejects the whole request with `400 No tool output found for
 * tool call <id>`, and Messages refuses a `tool_use` block no `tool_result`
 * answers — so the converters need both sets before they emit anything.
 *
 * The harness normally pairs every call with a result (its session repair
 * synthesizes one for an interrupted turn), but a call it recorded and never
 * dispatched, or a history whose result was replaced, leaves the call standing
 * alone. See `toResponsesInput` for what this adapter does about it.
 *
 * @param {readonly object[]} messages - harness messages.
 * @returns {{answered: Set<string>, invoked: Set<string>}} the paired ids.
 */
function toolCallIds(messages) {
  const answered = new Set()
  const invoked = new Set()
  for (const message of messages ?? []) {
    if (message?.role === 'assistant') {
      for (const block of toolCallsOf(message.content)) {
        if (block?.id !== undefined && block?.id !== null) invoked.add(String(block.id))
      }
    } else if (message?.role === 'tool') {
      const id = resultCallId(message)
      if (id !== undefined) answered.add(id)
    }
  }
  return { answered, invoked }
}

/**
 * Whether one call has a result anywhere in the history.
 *
 * The default answers yes, so a caller that did not survey the history keeps
 * every call: only a complete survey can prove a hole, and keeping a call is the
 * pre-existing behaviour.
 *
 * @param {object} block - the harness `tool-call` block.
 * @param {Set<string> | undefined} answered - ids a result cites, when surveyed.
 * @returns {boolean} true when the call may be sent.
 */
function callIsAnswered(block, answered) {
  if (answered === undefined) return true
  const id = block?.id
  if (id === undefined || id === null) return false
  return answered.has(String(id))
}

/**
 * Whether a message carries an image the request must resolve.
 *
 * @param {readonly object[]} content - the message content blocks.
 * @returns {boolean} true when at least one image block is present.
 */
export function hasImageBlock(content) {
  return (content ?? []).some((block) => block?.type === 'image')
}

/**
 * Convert harness messages to OpenAI Chat Completions `messages`.
 *
 * @param {object} input - the conversion input.
 * @param {readonly object[]} input.messages - harness messages.
 * @param {boolean} input.replayReasoning - whether to send `reasoning_content` back.
 * @param {boolean} input.images - whether the model accepts image parts.
 * @param {ImagePartFactory} [input.imagePart] - resolves one image block.
 * @returns {Promise<object[]>} wire messages.
 */
export async function toChatMessages(input) {
  const { messages, replayReasoning, images, imagePart } = input
  const out = []
  const { answered } = toolCallIds(messages)

  for (const message of messages) {
    switch (message?.role) {
      case 'system':
      case 'developer': {
        const text = textOf(message.content)
        if (text.trim() !== '') out.push({ role: 'system', content: text })
        break
      }
      case 'user': {
        const content = await chatUserContent(message.content, images, imagePart)
        if (hasContent(content)) out.push({ role: 'user', content })
        break
      }
      case 'assistant': {
        const text = textOf(message.content)
        // A call with no result in the history is dropped: Chat Completions
        // requires the next turn to answer every `tool_call_id` it was given, so
        // sending an unanswerable call fails the turn.
        const calls = toolCallsOf(message.content).filter((block) => callIsAnswered(block, answered))
        const reasoning = replayReasoning ? reasoningOf(message.content) : undefined
        if (text.trim() === '' && calls.length === 0 && reasoning === undefined) break
        const wire = { role: 'assistant', content: text === '' ? null : text }
        if (reasoning !== undefined) wire.reasoning_content = reasoning
        if (calls.length > 0) {
          wire.tool_calls = calls.map((block) => ({
            id: String(block.id),
            type: 'function',
            function: { name: String(block.name), arguments: argumentsText(block) },
          }))
        }
        out.push(wire)
        break
      }
      case 'tool': {
        const text = textOf(message.content)
        out.push({
          role: 'tool',
          tool_call_id: String(message.toolCallId),
          content: text.trim() === '' ? toolResultFallbackText(message) : text,
        })
        break
      }
      default:
        // Tool update messages are not messages; the runtime projects them out.
        break
    }
  }
  return out
}

/**
 * Chat Completions user content: a plain string for text-only turns, and an
 * array of parts once an image is present.
 */
async function chatUserContent(content, images, imagePart) {
  const blocks = content ?? []
  if (!images || !hasImageBlock(blocks)) {
    const text = textOf(blocks)
    return text.trim() === '' ? undefined : text
  }
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text') {
      if (String(block.text ?? '') !== '') parts.push({ type: 'text', text: String(block.text) })
    } else if (block?.type === 'image') {
      const url = imagePart === undefined ? undefined : await imagePart(block, block?.attachment?.mediaType)
      parts.push(url === undefined
        ? { type: 'text', text: imagePlaceholder(block) }
        : { type: 'image_url', image_url: { url } })
    } else if (block?.type === 'file') {
      parts.push({ type: 'text', text: filePlaceholder(block) })
    }
  }
  return parts
}

/**
 * Convert harness messages to OpenAI Responses `input` items.
 *
 * Reasoning items are never replayed. The Responses API validates a reasoning
 * item against upstream state the harness does not retain, and answers a
 * mismatch with an opaque `400`, so the model receives the conversation without
 * its own prior chain of thought rather than a request that fails at random.
 *
 * Function calls and their outputs are replayed as the paired items the API
 * requires, and the pairing is positional: an item of any other kind between a
 * `function_call` and its `function_call_output` is answered with `400 No tool
 * output found for tool call <id>`, which fails the whole turn. Three rules keep
 * a request inside that shape:
 *
 *   - an assistant message's text is emitted ahead of the calls it accompanies,
 *     so a parallel group is answered by the results that follow it;
 *   - a call whose result is not in the history is not sent at all, because the
 *     request that carries it cannot be answered and is refused outright;
 *   - a result the history cites with no call to answer is not sent either, so
 *     no output is left citing a call the API was never shown.
 *
 * The two omissions are the same hole seen from either side, and both are
 * deliberate: the API refuses the request that keeps either half alone.
 *
 * @param {object} input - the conversion input.
 * @param {readonly object[]} input.messages - harness messages.
 * @param {boolean} input.images - whether the model accepts image parts.
 * @param {ImagePartFactory} [input.imagePart] - resolves one image block.
 * @returns {Promise<object[]>} wire input items.
 */
export async function toResponsesInput(input) {
  const { messages, images, imagePart } = input
  const out = []
  const { answered, invoked } = toolCallIds(messages)
  /** Calls already emitted whose outputs have not been emitted yet. */
  let unanswered = 0

  /** Append an item outside a call group. */
  const push = (item) => {
    out.push(item)
  }
  /** Append a call, opening or extending the group it belongs to. */
  const pushCall = (item) => {
    out.push(item)
    unanswered += 1
  }
  /** Append the output answering one call. */
  const pushOutput = (item) => {
    out.push(item)
    if (unanswered > 0) unanswered -= 1
  }

  for (const message of messages) {
    switch (message?.role) {
      case 'system':
      case 'developer':
        // Instructions are a top-level field; a system turn cannot ride `input`.
        break
      case 'user': {
        const parts = await responsesUserParts(message.content, images, imagePart)
        if (parts.length > 0) push({ role: 'user', content: parts })
        break
      }
      case 'assistant': {
        // Text first: the calls that follow are answered by the tool results
        // that come after this message, and nothing else may stand between them.
        const text = textOf(message.content)
        if (text.trim() !== '') push({ role: 'assistant', content: [{ type: 'output_text', text }] })
        for (const block of toolCallsOf(message.content)) {
          if (!callIsAnswered(block, answered)) continue
          pushCall({
            type: 'function_call',
            call_id: String(block.id),
            name: String(block.name),
            arguments: argumentsText(block),
          })
        }
        break
      }
      case 'tool': {
        const callId = resultCallId(message)
        // A result whose call this request does not carry would be an item the
        // API has no `function_call` to attach, so it is left out.
        if (callId === undefined || !invoked.has(callId)) break
        const text = textOf(message.content)
        pushOutput({
          type: 'function_call_output',
          call_id: callId,
          output: text.trim() === '' ? toolResultFallbackText(message) : text,
        })
        break
      }
      default:
        break
    }
  }

  // Every call that was sent has its output behind it, so the list is already in
  // the API's shape.
  if (unanswered !== 0) {
    // Unreachable while `callIsAnswered` gates every call, and kept as a stated
    // invariant rather than a silent one could-never-happen comment.
    throw malformed('responses', `${unanswered} function call(s) were emitted without their tool output`)
  }
  return out
}

async function responsesUserParts(content, images, imagePart) {
  const blocks = content ?? []
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text') {
      if (String(block.text ?? '') !== '') parts.push({ type: 'input_text', text: String(block.text) })
    } else if (block?.type === 'image' && images) {
      const url = imagePart === undefined ? undefined : await imagePart(block, block?.attachment?.mediaType)
      parts.push(url === undefined
        ? { type: 'input_text', text: imagePlaceholder(block) }
        : { type: 'input_image', image_url: url })
    } else if (block?.type === 'image') {
      parts.push({ type: 'input_text', text: imagePlaceholder(block) })
    } else if (block?.type === 'file') {
      parts.push({ type: 'input_text', text: filePlaceholder(block) })
    }
  }
  if (parts.length === 0) {
    const text = textOf(blocks)
    if (text.trim() !== '') parts.push({ type: 'input_text', text })
  }
  return parts
}

/**
 * Convert harness messages to Anthropic Messages `messages` plus a system prompt.
 *
 * The Messages API takes the system prompt as a top-level field and requires
 * tool results inside a `user` turn, so this returns both halves already split.
 * `GenerateOptions.system` is the harness's own prompt and is not a message, so
 * it is prepended here; a `system` turn inside the history joins it rather than
 * becoming an assistant or user turn.
 *
 * Thinking blocks are replayed with the signature the provider issued; a
 * signature the harness did not retain degrades that block to plain text,
 * because the API refuses a thinking block without one.
 *
 * Tool blocks are paired the same way the Responses converter pairs them: a
 * `tool_use` whose result is missing from the history is dropped, and a
 * `tool_result` with no `tool_use` to cite is dropped with it, because Messages
 * refuses either half on its own.
 *
 * @param {object} input - the conversion input.
 * @param {readonly object[]} input.messages - harness messages.
 * @param {string} [input.system] - `GenerateOptions.system`.
 * @param {boolean} input.replayReasoning - whether to send thinking blocks back.
 * @param {Record<string, string>} input.signatures - reasoning text to provider signature.
 * @param {boolean} input.images - whether the model accepts image parts.
 * @param {ImagePartFactory} [input.imagePart] - resolves one image block.
 * @returns {Promise<{ system?: string, messages: object[] }>} the wire request halves.
 */
export async function toAnthropicMessages(input) {
  const { messages, replayReasoning, signatures, images, imagePart } = input
  const systemParts = typeof input.system === 'string' && input.system.trim() !== '' ? [input.system] : []
  const out = []
  const { answered, invoked } = toolCallIds(messages)

  for (const message of messages) {
    switch (message?.role) {
      case 'system':
      case 'developer': {
        const text = textOf(message.content)
        if (text.trim() !== '') systemParts.push(text)
        break
      }
      case 'user': {
        const content = await anthropicUserContent(message.content, images, imagePart)
        if (content.length > 0) out.push({ role: 'user', content })
        break
      }
      case 'assistant': {
        const content = []
        const reasoning = reasoningOf(message.content)
        if (reasoning !== undefined && replayReasoning) {
          const signature = signatures?.[reasoning]
          content.push(signature === undefined
            ? { type: 'text', text: reasoning }
            : { type: 'thinking', thinking: reasoning, signature })
        }
        const text = textOf(message.content)
        if (text.trim() !== '') content.push({ type: 'text', text })
        for (const block of toolCallsOf(message.content)) {
          // Messages refuses a `tool_use` block that no `tool_result` answers,
          // so the block is only sent when the history can answer for it.
          if (!callIsAnswered(block, answered)) continue
          content.push({
            type: 'tool_use',
            id: String(block.id),
            name: String(block.name),
            input: argumentsObject(block, 'anthropic'),
          })
        }
        if (content.length > 0) out.push({ role: 'assistant', content })
        break
      }
      case 'tool': {
        const callId = resultCallId(message)
        // A result whose `tool_use` is not in this request would be refused for
        // citing a block the API was never shown.
        if (callId === undefined || !invoked.has(callId)) break
        const text = textOf(message.content)
        const block = {
          type: 'tool_result',
          tool_use_id: callId,
          content: text.trim() === '' ? toolResultFallbackText(message) : text,
        }
        if (message.isError === true) block.is_error = true
        // Consecutive tool results belong to one user turn.
        const previous = out[out.length - 1]
        if (previous?.role === 'user' && previous.content.every((part) => part.type === 'tool_result')) {
          previous.content.push(block)
        } else {
          out.push({ role: 'user', content: [block] })
        }
        break
      }
      default:
        break
    }
  }

  const reply = { messages: out }
  if (systemParts.length > 0) reply.system = systemParts.join('\n\n')
  return reply
}

async function anthropicUserContent(content, images, imagePart) {
  const parts = []
  for (const block of content ?? []) {
    if (block?.type === 'text') {
      if (String(block.text ?? '') !== '') parts.push({ type: 'text', text: String(block.text) })
    } else if (block?.type === 'image' && images) {
      const source = imagePart === undefined ? undefined : await imagePart(block, block?.attachment?.mediaType)
      parts.push(source === undefined
        ? { type: 'text', text: imagePlaceholder(block) }
        : { type: 'image', source })
    } else if (block?.type === 'image') {
      parts.push({ type: 'text', text: imagePlaceholder(block) })
    } else if (block?.type === 'file') {
      parts.push({ type: 'text', text: filePlaceholder(block) })
    }
  }
  return parts
}
