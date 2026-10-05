/** Responses translator, against payloads captured from the live service. */

import * as responses from '../../lib/protocol/responses.js'
import { equal, is, ok } from '../helpers.mjs'
import { IMAGE_BLOCK, assemble, failureOf, finishChunk, fixture, imageParts, usageChunk } from './_protocol-harness.mjs'

export default {
  name: 'protocol/responses',
  cases: [
    {
      name: 'an output-text reply becomes a text block',
      async run() {
        const text = await fixture('responses.text.sse')
        const { chunks, blocks, finish, usage } = await assemble(responses, text, 'gpt-5.6-luna')
        equal(blocks.map((block) => block.type), ['text'])
        is(blocks[0].text, 'OK')
        equal(finish, { kind: 'stop' })
        ok(usage.inputTokens > 0, 'input tokens were reported')
        finishChunk(chunks)
        usageChunk(chunks)
      },
    },
    {
      name: 'a function call becomes a tool-call block with raw JSON arguments',
      async run() {
        const text = await fixture('responses.tools.sse')
        const { blocks, finish } = await assemble(responses, text, 'gpt-5.6-luna')
        const call = blocks.find((block) => block.type === 'tool-call')
        ok(call !== undefined, 'a tool-call block was assembled')
        is(call.name, 'get_weather')
        is(call.arguments, '{"city":"Paris"}')
        is(call.id, 'call_QQfpY6z8xmJv6aM5oIaCTege')
        is(typeof call.arguments, 'string')
        equal(finish, { kind: 'tool-calls' })
      },
    },
    {
      name: 'the complete arguments event does not double the accumulated deltas',
      async run() {
        const text = await fixture('responses.tools.sse')
        const { blocks } = await assemble(responses, text, 'gpt-5.6-luna')
        const call = blocks.find((block) => block.type === 'tool-call')
        is(call.arguments, '{"city":"Paris"}')
      },
    },
    {
      name: 'the system prompt is top-level instructions, never an input item',
      async run() {
        const wire = await responses.prepare({
          request: {
            messages: [{ role: 'system', content: [{ type: 'text', text: 'ignored' }] }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            system: 'You are terse.',
          },
          model: { id: 'm' },
        })
        is(wire.body.instructions, 'You are terse.')
        equal(wire.body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
      },
    },
    {
      name: 'history replays paired function_call and function_call_output items',
      async run() {
        const wire = await responses.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{"city":"Paris"}' }] },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '18C' }] },
            ],
          },
          model: { id: 'm' },
        })
        equal(wire.body.input, [
          { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{"city":"Paris"}' },
          { type: 'function_call_output', call_id: 'c1', output: '18C' },
        ])
      },
    },
    {
      name: 'a tool result that carries an image sends it inside function_call_output',
      async run() {
        // The item's `output` takes a string or a list of input parts, and the
        // list is what carries `read_image`'s answer to the model.
        const { imageUrl } = imageParts()
        const wire = await responses.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_image', arguments: '{}' }] },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '<type>image</type>' }, IMAGE_BLOCK] },
            ],
          },
          model: { id: 'm' },
          images: true,
          imageUrl,
        })
        equal(wire.body.input, [
          { type: 'function_call', call_id: 'c1', name: 'read_image', arguments: '{}' },
          {
            type: 'function_call_output',
            call_id: 'c1',
            output: [
              { type: 'input_text', text: '<type>image</type>' },
              { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
            ],
          },
        ])
      },
    },
    {
      name: 'a tool result with text alone stays the plain string, and a text-only route says why not',
      async run() {
        const { imageUrl } = imageParts()
        const messages = [
          { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{}' }] },
          { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '18C' }] },
        ]
        const wire = await responses.prepare({ request: { messages }, model: { id: 'm' }, images: true, imageUrl })
        equal(wire.body.input[1], { type: 'function_call_output', call_id: 'c1', output: '18C' })

        // Without image input the result still names the image it could not carry.
        const gated = await responses.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_image', arguments: '{}' }] },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'read it' }, IMAGE_BLOCK] },
            ],
          },
          model: { id: 'm' },
          images: false,
        })
        const output = String(gated.body.input[1].output)
        ok(output.includes('read it') && output.includes('shot.png') && output.includes('not sent'), output)
      },
    },
    {
      name: 'prior reasoning is dropped, because a reasoning item cannot be replayed',
      async run() {
        const wire = await responses.prepare({
          request: {
            messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'ok' }] }],
          },
          model: { id: 'm' },
        })
        equal(wire.body.input, [{ role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }])
      },
    },
    {
      name: 'a call the history never answered is not sent, so no 400 can name it',
      async run() {
        const wire = await responses.prepare({
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
              { role: 'user', content: [{ type: 'text', text: 'continue' }] },
            ],
          },
          model: { id: 'm' },
        })
        // `c2` was never dispatched, so nothing answers it: the request drops it
        // rather than being refused with `No tool output found for tool call c2`.
        equal(wire.body.input, [
          { role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] },
          { type: 'function_call', call_id: 'c1', name: 'web_search', arguments: '{"q":"x"}' },
          { type: 'function_call_output', call_id: 'c1', output: 'search failed' },
          { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
        ])
      },
    },
    {
      name: 'every function_call in a request is answered by the output behind it',
      async run() {
        // The invariant the wire enforces, asserted structurally: no call may be
        // separated from its output, and no output may cite a call that is absent.
        const wire = await responses.prepare({
          request: {
            messages: [
              {
                role: 'assistant',
                content: [
                  { type: 'reasoning', text: 'thinking' },
                  { type: 'text', text: 'checking' },
                  { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
                  { type: 'tool-call', id: 'c2', name: 'grep', arguments: '{}' },
                ],
              },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
              { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'ok' }] },
            ],
          },
          model: { id: 'm' },
        })
        const calls = wire.body.input.filter((item) => item.type === 'function_call')
        equal(calls.map((item) => item.call_id), ['c1', 'c2'])
        for (const call of calls) {
          const index = wire.body.input.indexOf(call)
          const answers = wire.body.input.filter((item) => item.type === 'function_call_output' && item.call_id === call.call_id)
          is(answers.length, 1, `exactly one output answers ${call.call_id}`)
          is(
            wire.body.input.indexOf(answers[0]) > index,
            true,
            `the output for ${call.call_id} follows its call`,
          )
        }
        // Nothing may stand inside the group: the outputs directly follow the calls.
        const types = wire.body.input.map((item) => item.type ?? item.role)
        equal(types.slice(1), ['function_call', 'function_call', 'function_call_output', 'function_call_output'])
      },
    },
    {
      name: 'a tool result whose call is absent is dropped rather than left dangling',
      async run() {
        const wire = await responses.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
              { role: 'tool', toolCallId: 'c_gone', content: [{ type: 'text', text: 'stale' }] },
            ],
          },
          model: { id: 'm' },
        })
        equal(wire.body.input, [{ role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }])
      },
    },
    {
      name: 'tools are declared flat, without the function wrapper',
      async run() {
        const wire = await responses.prepare({
          request: {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
          },
          model: { id: 'm' },
        })
        equal(wire.body.tools, [
          { type: 'function', name: 't', description: 'd', parameters: { type: 'object', properties: {} } },
        ])
      },
    },
    {
      name: 'the output cap is max_output_tokens',
      async run() {
        const wire = await responses.prepare({
          request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 1234 },
          model: { id: 'm' },
        })
        is(wire.body.max_output_tokens, 1234)
        is('max_tokens' in wire.body, false)
      },
    },
    {
      name: 'a stream that ends before response.completed is a STREAM_CLOSED failure',
      async run() {
        const error = await failureOf(
          responses,
          'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
          'm',
        )
        is(error?.code, 'STREAM_CLOSED')
      },
    },
    {
      name: 'a response.failed event is surfaced with its own message',
      async run() {
        const error = await failureOf(
          responses,
          'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"upstream refused"}}}\n\n',
          'm',
        )
        is(error?.code, 'MALFORMED_RESPONSE')
        ok(String(error.message).includes('upstream refused'))
      },
    },
  ],
}
