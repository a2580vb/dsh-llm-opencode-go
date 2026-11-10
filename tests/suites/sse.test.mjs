/** SSE framing: field handling, chunk boundaries, and end-of-stream shapes. */

import { bodyFromString, isDoneFrame, parseSse } from '../../lib/stream/sse.js'
import { equal, is } from '../helpers.mjs'

async function frames(text) {
  const out = []
  for await (const frame of parseSse(bodyFromString(text))) out.push(frame)
  return out
}

export default {
  name: 'stream/sse',
  cases: [
    {
      name: 'data-only frames, as Chat Completions and Responses send them',
      async run() {
        const out = await frames('data: {"a":1}\n\ndata: {"b":2}\n\n')
        equal(out, [{ data: '{"a":1}' }, { data: '{"b":2}' }])
      },
    },
    {
      name: 'a named event keeps its name, as Messages sends it',
      async run() {
        const out = await frames('event: message_start\ndata: {"type":"message_start"}\n\n')
        equal(out, [{ event: 'message_start', data: '{"type":"message_start"}' }])
      },
    },
    {
      name: 'the optional space after the colon is removed',
      async run() {
        const out = await frames('data:{"nospace":true}\n\ndata:  {"two":true}\n\n')
        equal(out[0].data, '{"nospace":true}')
        is(out[1].data, ' {"two":true}')
      },
    },
    {
      name: 'comment lines are ignored, so keep-alive pings produce no frame',
      async run() {
        const out = await frames(': ping\n\ndata: {"a":1}\n\n')
        equal(out, [{ data: '{"a":1}' }])
      },
    },
    {
      name: 'CRLF line endings are accepted',
      async run() {
        const out = await frames('event: x\r\ndata: {"a":1}\r\n\r\n')
        equal(out, [{ event: 'x', data: '{"a":1}' }])
      },
    },
    {
      name: 'a trailing frame without its blank line is still delivered',
      async run() {
        const out = await frames('data: {"a":1}\n\ndata: [DONE]')
        is(out.length, 2)
        is(out[1].data, '[DONE]')
      },
    },
    {
      name: 'a multi-line data field is joined with newlines',
      async run() {
        const out = await frames('data: line one\ndata: line two\n\n')
        is(out[0].data, 'line one\nline two')
      },
    },
    {
      name: 'the [DONE] sentinel is recognized',
      async run() {
        const out = await frames('data: [DONE]\n\n')
        is(isDoneFrame(out[0]), true)
        is(isDoneFrame({ data: '{"a":1}' }), false)
      },
    },
    {
      name: 'every non-empty body read is activity, including a comment ping and a partial frame',
      async run() {
        // The idle watchdog is fed by these ticks. A comment line and an
        // unfinished frame both prove the connection is alive, and neither
        // produces a frame -- so frame delivery cannot be the activity signal.
        const encoder = new TextEncoder()
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array())
            controller.enqueue(encoder.encode(': ping\n\n'))
            controller.enqueue(encoder.encode('data: {"a":'))
            controller.enqueue(encoder.encode('1}\n\n'))
            controller.close()
          },
        })
        const ticks = []
        const out = []
        for await (const frame of parseSse(body, undefined, () => ticks.push('read'))) out.push(frame)
        equal(out, [{ data: '{"a":1}' }])
        is(ticks.length, 3, 'one tick per non-empty read, not one per decoded frame')
      },
    },
    {
      name: 'a read that yields only bytes, never a frame, still ticks',
      async run() {
        // A provider that sends a keep-alive comment while it thinks must keep
        // the stream alive even though it emits nothing the translator can use.
        const encoder = new TextEncoder()
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(':'))
            controller.enqueue(encoder.encode(' keep-alive\n'))
            controller.close()
          },
        })
        const ticks = []
        const out = []
        for await (const frame of parseSse(body, undefined, () => ticks.push('read'))) out.push(frame)
        equal(out, [])
        is(ticks.length, 2)
      },
    },
  ],
}
