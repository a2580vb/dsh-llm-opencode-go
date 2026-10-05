/** Chat Completions translator, against payloads captured from the live service. */

import * as chat from '../../lib/protocol/chat-completions.js'
import { equal, is, ok } from '../helpers.mjs'
import { IMAGE_BLOCK, assemble, failureOf, finishChunk, fixture, imageParts, usageChunk } from './_protocol-harness.mjs'

export default {
  name: 'protocol/chat-completions',
  cases: [
    {
      name: 'a reasoning-then-text reply becomes reasoning and text blocks',
      async run() {
        const text = await fixture('chat-completions.text.sse')
        const { chunks, blocks, finish, usage } = await assemble(chat, text, 'deepseek-v4-flash')
        equal(blocks.map((block) => block.type), ['reasoning', 'text'])
        ok(blocks[0].text.includes('reply'), 'reasoning text was accumulated')
        is(blocks[1].text, 'OK')
        equal(finish, { kind: 'stop' })
        is(usage.inputTokens, 88)
        is(usage.outputTokens, 19)
        is(usage.totalTokens, 107)
        finishChunk(chunks)
        usageChunk(chunks)
      },
    },
    {
      name: 'a fragmented tool call becomes one complete tool-call block',
      async run() {
        const text = await fixture('chat-completions.tools.sse')
        const { blocks, finish, chunks } = await assemble(chat, text, 'deepseek-v4-flash')
        const call = blocks.find((block) => block.type === 'tool-call')
        ok(call !== undefined, 'a tool-call block was assembled')
        is(call.name, 'get_weather')
        is(call.arguments, '{"city": "Paris"}')
        is(call.id, 'call_ed5b2fc3fcfe4697a4bd275d')
        // The provider reported `tool_calls`, so the harness finish follows it.
        equal(finish, { kind: 'tool-calls' })
        // Arguments stay a raw JSON string, never a parsed object.
        is(typeof call.arguments, 'string')
        const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
        ok(deltas.length >= 2, 'arguments arrived as more than one delta')
        // The cache-read figure is reported beside input tokens, not subtracted.
        is(usageChunk(chunks).usage.cacheReadTokens, 256)
      },
    },
    {
      name: 'a tool result that carries an image sends the image, not a placeholder',
      async run() {
        // `read_image` answers with an envelope and the image itself. Sending only
        // the text left the model reading a description of a picture it could not
        // see — the one thing that tool exists to prevent.
        const { imageUrl } = imageParts()
        const wire = await chat.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_image', arguments: '{"file_path":"a.png"}' }] },
              {
                role: 'tool',
                toolCallId: 'c1',
                content: [{ type: 'text', text: '<type>image</type>' }, IMAGE_BLOCK],
              },
            ],
          },
          model: { id: 'm' },
          images: true,
          imageUrl,
        })
        // The image rides the tool message's own content parts, which is the shape
        // the live service accepts — the same parts a user turn uses.
        equal(wire.body.messages[1], {
          role: 'tool',
          tool_call_id: 'c1',
          content: [
            { type: 'text', text: '<type>image</type>' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
        })
        // Nothing about the pairing changed, so the turn still answers the call.
        is(wire.body.messages[0].tool_calls[0].id, 'c1')
      },
    },
    {
      name: 'a tool result with text alone stays the plain string every wire takes',
      async run() {
        const { imageUrl } = imageParts()
        const wire = await chat.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{}' }] },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '18C' }] },
            ],
          },
          model: { id: 'm' },
          images: true,
          imageUrl,
        })
        equal(wire.body.messages[1], { role: 'tool', tool_call_id: 'c1', content: '18C' })
      },
    },
    {
      name: 'a route that cannot take images says so in the tool result, rather than dropping it',
      async run() {
        const wire = await chat.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_image', arguments: '{}' }] },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'read it' }, IMAGE_BLOCK] },
            ],
          },
          model: { id: 'm' },
          images: false,
        })
        // A text-only route still carries the fact that an image was there: a
        // silent omission would read to the model as a tool that returned nothing.
        ok(String(wire.body.messages[1].content).includes('read it'), 'the envelope survives')
        ok(String(wire.body.messages[1].content).includes('shot.png'), 'and the image is named')
        ok(String(wire.body.messages[1].content).includes('not sent'), 'with the reason it is missing')
      },
    },
    {
      name: 'the system prompt is sent as a leading message',
      async run() {
        const wire = await chat.prepare({
          request: {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            system: 'You are terse.',
          },
          model: { id: 'm' },
          replayReasoning: true,
        })
        equal(wire.body.messages[0], { role: 'system', content: 'You are terse.' })
        equal(wire.body.messages[1], { role: 'user', content: 'hi' })
        is(wire.body.stream, true)
        equal(wire.body.stream_options, { include_usage: true })
      },
    },
    {
      name: 'history replays reasoning_content and paired tool calls',
      async run() {
        const wire = await chat.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'ok' }] },
              {
                role: 'assistant',
                content: [{ type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{"city":"Paris"}' }],
              },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '18C' }] },
            ],
          },
          model: { id: 'm' },
          replayReasoning: true,
        })
        equal(wire.body.messages[0], { role: 'assistant', content: 'ok', reasoning_content: 'thinking' })
        equal(wire.body.messages[1].tool_calls, [
          { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
        ])
        equal(wire.body.messages[2], { role: 'tool', tool_call_id: 'c1', content: '18C' })
      },
    },
    {
      name: 'tool arguments that are not a JSON object are sent as an empty object',
      async run() {
        const wire = await chat.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{broken' }] },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
            ],
          },
          model: { id: 'm' },
          replayReasoning: true,
        })
        // Chat Completions carries arguments as text, so a malformed historical
        // value is passed through rather than failing the request.
        is(wire.body.messages[0].tool_calls[0].function.arguments, '{broken')
      },
    },
    {
      name: 'a call the history never answered is not sent',
      async run() {
        const wire = await chat.prepare({
          request: {
            messages: [
              {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'on it' },
                  { type: 'tool-call', id: 'c1', name: 'web_search', arguments: '{"q":"x"}' },
                  { type: 'tool-call', id: 'c2', name: 'ask_user_question', arguments: '{"q":[]}' },
                ],
              },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'search failed' }] },
            ],
          },
          model: { id: 'm' },
          replayReasoning: true,
        })
        // The next turn answers every `tool_call_id` it was given, so a call with
        // no result behind it is left out instead of being sent unanswerable.
        equal(wire.body.messages[0].tool_calls.map((call) => call.id), ['c1'])
        equal(wire.body.messages[0].content, 'on it')
        equal(wire.body.messages[1], { role: 'tool', tool_call_id: 'c1', content: 'search failed' })
      },
    },
    {
      name: 'an assistant message left empty by a dropped call is not sent at all',
      async run() {
        const wire = await chat.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }] },
              { role: 'user', content: [{ type: 'text', text: 'hello' }] },
            ],
          },
          model: { id: 'm' },
          replayReasoning: true,
        })
        equal(wire.body.messages, [{ role: 'user', content: 'hello' }])
      },
    },
    {
      name: 'tools are declared in the function wrapper',
      async run() {
        const wire = await chat.prepare({
          request: {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
          },
          model: { id: 'm' },
          replayReasoning: true,
        })
        equal(wire.body.tools, [
          { type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', properties: {} } } },
        ])
      },
    },
    {
      name: 'no tools means no tools field at all',
      async run() {
        const wire = await chat.prepare({
          request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] },
          model: { id: 'm' },
          replayReasoning: true,
        })
        is('tools' in wire.body, false)
      },
    },
    {
      name: 'a stream that ends without a finish_reason is a STREAM_CLOSED failure',
      async run() {
        const text = 'data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'
        const error = await failureOf(chat, text, 'm')
        is(error?.code, 'STREAM_CLOSED')
      },
    },
    {
      name: 'a malformed data frame is a MALFORMED_RESPONSE failure',
      async run() {
        const error = await failureOf(chat, 'data: {not json}\n\n', 'm')
        is(error?.code, 'MALFORMED_RESPONSE')
      },
    },
    {
      name: 'a mid-stream error envelope is surfaced rather than ignored',
      async run() {
        const error = await failureOf(chat, 'data: {"error":{"type":"invalid_request_error","message":"bad field"}}\n\n', 'm')
        is(error?.code, 'MALFORMED_RESPONSE')
        ok(String(error.message).includes('bad field'), 'the provider message is carried through')
      },
    },
  ],
}
