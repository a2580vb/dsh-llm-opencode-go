/** Anthropic Messages translator, against payloads captured from the live service. */

import * as anthropic from '../../lib/protocol/anthropic-messages.js'
import { equal, is, ok } from '../helpers.mjs'
import { assemble, failureOf, finishChunk, fixture, usageChunk } from './_protocol-harness.mjs'

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
