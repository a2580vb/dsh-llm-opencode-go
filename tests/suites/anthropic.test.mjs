/** Anthropic Messages translator, against payloads captured from the live service. */

import * as anthropic from '../../lib/protocol/anthropic-messages.js'
import { equal, is, ok } from '../helpers.mjs'
import { IMAGE_BLOCK, assemble, failureOf, finishChunk, fixture, imageParts, usageChunk } from './_protocol-harness.mjs'

export default {
  name: 'protocol/anthropic',
  cases: [
    {
      name: 'the Messages endpoint authenticates with x-api-key, not bearer',
      run() {
        const headers = anthropic.authHeaders('secret')
        is(headers['x-api-key'], 'secret')
        is('authorization' in headers, false)
        is(headers['anthropic-version'], '2023-06-01')
      },
    },
    {
      name: 'the cache figures message_start reported survive the message_delta that follows',
      async run() {
        // This API announces its input side once, in `message_start`, and the
        // cache figures only ever appear there. Every later `message_delta`
        // speaks about output alone, so a merge that rebuilt the usage object
        // instead of merging into it threw the cache away -- and the page then
        // reported a cache hit of zero for every Messages-protocol call.
        const text = [
          'event: message_start',
          'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"glm-5.3","content":[],"usage":{"input_tokens":46,"output_tokens":0,"cache_read_input_tokens":2048,"cache_creation_input_tokens":1024}}}',
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
          '',
          'event: content_block_stop',
          'data: {"type":"content_block_stop","index":0}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":129}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
          '',
        ].join('\n')
        const { usage, chunks } = await assemble(anthropic, text, 'glm-5.3')
        is(usage.inputTokens, 46, 'the input count is the uncached part this shape reports')
        is(usage.outputTokens, 129, 'the delta supplied the output half')
        is(usage.cacheReadTokens, 2048, 'the cache read outlived the delta')
        is(usage.cacheWriteTokens, 1024, 'and so did the cache write')
        // This shape never folds the cached part into the prompt count, so the
        // four parts are exclusive and simply add up.
        is(usage.totalTokens, 46 + 129 + 2048 + 1024)
        is(usageChunk(chunks).usage.cacheReadTokens, 2048, 'and the same figures reach the harness')
      },
    },
    {
      name: 'thinking then text becomes two blocks, with the signature retained',
      async run() {
        const text = await fixture('anthropic.text.sse')
        const { chunks, blocks, finish, usage } = await assemble(anthropic, text, 'minimax-m2.7')
        equal(blocks.map((block) => block.type), ['reasoning', 'text'])
        is(blocks[1].text, 'OK')
        equal(finish, { kind: 'stop' })
        is(usage.inputTokens, 46)
        is(usage.outputTokens, 129)
        is(usage.reasoningTokens, 127)
        const terminal = finishChunk(chunks)
        // The signature is what makes a thinking block replayable later.
        const entry = terminal.replayState.blocks.find((block) => block.type === 'reasoning')
        is(entry.signature, 'f9fc27f12fa06675d12751cefcdf901ab0ca1fb2cfeb286170f599b016e8f7b3')
        usageChunk(chunks)
      },
    },
    {
      name: 'a tool_use block becomes a tool-call block with raw JSON arguments',
      async run() {
        const text = await fixture('anthropic.tools.sse')
        const { blocks, finish, chunks } = await assemble(anthropic, text, 'minimax-m2.7')
        const call = blocks.find((block) => block.type === 'tool-call')
        ok(call !== undefined, 'a tool-call block was assembled')
        is(call.name, 'get_weather')
        // The wire streams `input_json_delta`, so arguments arrive as raw JSON.
        is(call.arguments, '{"city": "Paris"}')
        equal(finish, { kind: 'tool-calls' })
        is(finishChunk(chunks).replayState.response.stopReason, 'tool_use')
      },
    },
    {
      name: 'a tool result that carries an image sends it inside tool_result',
      async run() {
        // Messages takes `tool_result.content` as a string or a list of blocks,
        // and the list is what carries `read_image`'s answer to the model.
        const { imageSource } = imageParts()
        const wire = await anthropic.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_image', arguments: '{}' }] },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '<type>image</type>' }, IMAGE_BLOCK] },
            ],
          },
          model: { id: 'm', maxTokens: 4096 },
          replayReasoning: false,
          images: true,
          imageSource,
        })
        equal(wire.body.messages[1].content, [{
          type: 'tool_result',
          tool_use_id: 'c1',
          content: [
            { type: 'text', text: '<type>image</type>' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          ],
        }])
        // A failed read keeps its `is_error` beside the image it did produce.
        const failed = await anthropic.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_image', arguments: '{}' }] },
              { role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'partial' }, IMAGE_BLOCK] },
            ],
          },
          model: { id: 'm', maxTokens: 4096 },
          replayReasoning: false,
          images: true,
          imageSource,
        })
        is(failed.body.messages[1].content[0].is_error, true)
        is(Array.isArray(failed.body.messages[1].content[0].content), true)
      },
    },
    {
      name: 'a tool result with text alone stays the plain string, and a text-only route says why not',
      async run() {
        const { imageSource } = imageParts()
        const wire = await anthropic.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{}' }] },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '18C' }] },
            ],
          },
          model: { id: 'm', maxTokens: 4096 },
          replayReasoning: false,
          images: true,
          imageSource,
        })
        equal(wire.body.messages[1].content, [{ type: 'tool_result', tool_use_id: 'c1', content: '18C' }])

        const gated = await anthropic.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_image', arguments: '{}' }] },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'read it' }, IMAGE_BLOCK] },
            ],
          },
          model: { id: 'm', maxTokens: 4096 },
          replayReasoning: false,
          images: false,
        })
        const content = String(gated.body.messages[1].content[0].content)
        ok(content.includes('read it') && content.includes('shot.png') && content.includes('not sent'), content)
      },
    },
    {
      name: 'the system prompt is a top-level field and tool results sit in a user turn',
      async run() {
        const wire = await anthropic.prepare({
          request: {
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
              { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{"city":"Paris"}' }] },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '18C' }] },
            ],
            system: 'You are terse.',
          },
          model: { id: 'm', maxTokens: 4096 },
          replayReasoning: false,
        })
        is(wire.body.system, 'You are terse.')
        equal(wire.body.messages[1].content, [
          { type: 'tool_use', id: 'c1', name: 'get_weather', input: { city: 'Paris' } },
        ])
        equal(wire.body.messages[2].content, [
          { type: 'tool_result', tool_use_id: 'c1', content: '18C' },
        ])
      },
    },
    {
      name: 'consecutive tool results share one user turn',
      async run() {
        const wire = await anthropic.prepare({
          request: {
            messages: [
              {
                role: 'assistant',
                content: [
                  { type: 'tool-call', id: 'c1', name: 'a', arguments: '{}' },
                  { type: 'tool-call', id: 'c2', name: 'b', arguments: '{}' },
                ],
              },
              { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a' }] },
              { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'b' }] },
            ],
          },
          model: { id: 'm', maxTokens: 4096 },
          replayReasoning: false,
        })
        // The assistant turn holds both `tool_use` blocks, and both results land
        // in the single user turn that answers them.
        is(wire.body.messages.length, 2)
        equal(wire.body.messages[1].content.map((part) => part.tool_use_id), ['c1', 'c2'])
      },
    },
    {
      name: 'a failed tool result carries is_error',
      async run() {
        const wire = await anthropic.prepare({
          request: {
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }],
              },
              { role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'boom' }] },
            ],
          },
          model: { id: 'm', maxTokens: 4096 },
          replayReasoning: false,
        })
        is(wire.body.messages[1].content[0].is_error, true)
      },
    },
    {
      name: 'a tool_use with no tool_result behind it is not sent',
      async run() {
        const wire = await anthropic.prepare({
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
          model: { id: 'm', maxTokens: 4096 },
          replayReasoning: false,
        })
        // Messages refuses a `tool_use` block that no `tool_result` answers, so
        // the undispatched call is dropped with its missing result.
        equal(wire.body.messages[0].content, [
          { type: 'text', text: 'on it' },
          { type: 'tool_use', id: 'c1', name: 'web_search', input: { q: 'x' } },
        ])
        equal(wire.body.messages[1].content, [{ type: 'tool_result', tool_use_id: 'c1', content: 'search failed' }])
        equal(wire.body.messages[2].content, [{ type: 'text', text: 'continue' }])
      },
    },
    {
      name: 'a tool_result citing an absent tool_use is not sent',
      async run() {
        const wire = await anthropic.prepare({
          request: {
            messages: [
              { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
              { role: 'tool', toolCallId: 'c_gone', content: [{ type: 'text', text: 'stale' }] },
            ],
          },
          model: { id: 'm', maxTokens: 4096 },
          replayReasoning: false,
        })
        equal(wire.body.messages, [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }])
      },
    },
    {
      name: 'a signature that was retained is replayed as a thinking block',
      async run() {
        const wire = await anthropic.prepare({
          request: {
            messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'ok' }] }],
          },
          model: { id: 'm', maxTokens: 4096 },
          replayReasoning: true,
          signatures: { thinking: 'sig-1' },
        })
        equal(wire.body.messages[0].content[0], { type: 'thinking', thinking: 'thinking', signature: 'sig-1' })
      },
    },
    {
      name: 'a reasoning block with no signature degrades to text instead of failing',
      async run() {
        const wire = await anthropic.prepare({
          request: {
            messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'ok' }] }],
          },
          model: { id: 'm', maxTokens: 4096 },
          replayReasoning: true,
          signatures: {},
        })
        equal(wire.body.messages[0].content[0], { type: 'text', text: 'thinking' })
      },
    },
    {
      name: 'reasoning history is not replayed when replay is off',
      async run() {
        const wire = await anthropic.prepare({
          request: {
            messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'ok' }] }],
          },
          model: { id: 'm', maxTokens: 4096 },
          replayReasoning: false,
          signatures: { thinking: 'sig-1' },
        })
        equal(wire.body.messages[0].content, [{ type: 'text', text: 'ok' }])
      },
    },
    {
      name: 'the thinking budget stays strictly below max_tokens',
      async run() {
        const wire = await anthropic.prepare({
          request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 4096 },
          model: { id: 'm', maxTokens: 4096 },
          effort: 'high',
        })
        is(wire.body.thinking.type, 'enabled')
        is(wire.body.thinking.budget_tokens, 4095)
      },
    },
    {
      name: 'an output cap too small for thinking omits it rather than failing',
      async run() {
        const wire = await anthropic.prepare({
          request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 256 },
          model: { id: 'm', maxTokens: 256 },
          effort: 'high',
        })
        is('thinking' in wire.body, false)
      },
    },
    {
      name: 'tools are declared with input_schema',
      async run() {
        const wire = await anthropic.prepare({
          request: {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
          },
          model: { id: 'm', maxTokens: 4096 },
        })
        equal(wire.body.tools, [
          { name: 't', description: 'd', input_schema: { type: 'object', properties: {} } },
        ])
      },
    },
    {
      name: 'a stream that ends before message_stop is a STREAM_CLOSED failure',
      async run() {
        const error = await failureOf(
          anthropic,
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n',
          'm',
        )
        is(error?.code, 'STREAM_CLOSED')
      },
    },
  ],
}
