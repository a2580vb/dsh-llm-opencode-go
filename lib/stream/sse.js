/**
 * Byte-level SSE framing.
 *
 * All three OpenCode Go protocols answer `text/event-stream`. They differ in
 * how much of the frame carries meaning — Chat Completions puts everything in
 * `data:` and never uses `event:`, while Responses and Messages name each frame
 * — so framing is shared here and interpretation stays with each protocol
 * module.
 *
 * @module dsh-llm-opencode-go/stream/sse
 */

const LF = 0x0a
const CR = 0x0d

/**
 * Decode one `text/event-stream` body into frames.
 *
 * Only the fields this adapter reads are surfaced: the optional `event:` name
 * and the joined `data:` payload. Comment lines (a leading `:`, which is what
 * keep-alive pings look like on the wire) are skipped, and a trailing frame
 * without its terminating blank line is still delivered — some relays end the
 * body on the last `data:` line rather than on a separator.
 *
 * Frames are yielded as soon as their blank line arrives, so a long stream
 * reports tokens while the connection is still open.
 *
 * @param {ReadableStream<Uint8Array>} body - the response body.
 * @param {AbortSignal} [signal] - cancellation; the reader is released on abort.
 * @returns {AsyncGenerator<{ event?: string, data: string }>} decoded frames in order.
 */
export async function* parseSse(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let event
  let data = []
  let sawField = false

  const frame = () => {
    if (!sawField) return undefined
    const value = { data: data.join('\n') }
    if (event !== undefined) value.event = event
    return value
  }

  const reset = () => {
    event = undefined
    data = []
    sawField = false
  }

  const onLine = (line) => {
    if (line === '') {
      const ready = frame()
      reset()
      return ready
    }
    if (line.startsWith(':')) return undefined
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    sawField = true
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    // `id` and `retry` carry no meaning for a single model response.
    return undefined
  }

  const abort = () => {
    reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let start = 0
      for (;;) {
        const nl = buffer.indexOf('\n', start)
        if (nl === -1) break
        let line = buffer.slice(start, nl)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        start = nl + 1
        const ready = onLine(line)
        if (ready !== undefined) yield ready
      }
      buffer = buffer.slice(start)
    }
    buffer += decoder.decode()
    if (buffer.length > 0) {
      let line = buffer
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const ready = onLine(line)
      if (ready !== undefined) yield ready
    }
    const tail = frame()
    if (tail !== undefined) yield tail
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.cancel().catch(() => {})
    reader.releaseLock?.()
  }
}

/**
 * Split one SSE payload into `[eventName, json]`, tolerating an absent name.
 *
 * @param {{ event?: string, data: string }} frame - a decoded frame.
 * @returns {{ name: string | undefined, json: unknown, raw: string }} parsed payload.
 * @throws {SyntaxError} when the payload is not JSON; callers add protocol context.
 */
export function decodeJsonFrame(frame) {
  const raw = frame.data
  return { name: frame.event, json: JSON.parse(raw), raw }
}

/** The literal sentinel OpenAI-compatible endpoints send to close a stream. */
export const SSE_DONE = '[DONE]'

/** Whether a decoded frame is the Chat Completions end-of-stream sentinel. */
export function isDoneFrame(frame) {
  return frame.data === SSE_DONE
}

/**
 * A raw `\n`-delimited body decoded as SSE.
 *
 * Used only by tests, which drive the parser from a string instead of a socket.
 *
 * @param {string} text - the complete response body.
 * @returns {ReadableStream<Uint8Array>} a stream that yields the encoded bytes.
 */
export function bodyFromString(text) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** Re-exported so callers compare against the same byte values the parser uses. */
export const SSE_BYTES = Object.freeze({ LF, CR })
