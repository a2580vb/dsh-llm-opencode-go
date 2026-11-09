/**
 * Failure classification for the model-level refusals the service can answer.
 *
 * Three refusals are about the model rather than the request: a protocol the
 * model does not serve (retry another entry), a model the service has retired
 * (`410 ModelDeprecated`, with the id to move to), and an id the service no
 * longer serves at all (`400 Model is unavailable.`). Each must keep its own
 * code, because the harness routes on the code: a retired model reported as
 * `INVALID_REQUEST` sends the reader looking for a fault in a well-formed
 * request, and one reported as `HTTP_410` tells them nothing.
 */

import {
  deprecationReplacement,
  isModelDeprecated,
  isModelUnavailable,
  refusedRequestError,
  streamFailure,
  transportError,
} from '../../lib/error/mapping.js'
import { equal, is, ok } from '../helpers.mjs'

/** One classified refusal, built from the body the service would send. */
function refused(body, input = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    raw = undefined
  }
  return refusedRequestError({
    provider: 'opencode-go',
    model: input.model ?? 'retired-model',
    protocol: input.protocol ?? 'anthropic',
    status: input.status ?? 410,
    headers: new Headers(input.headers ?? {}),
    text,
    raw,
  })
}

export default {
  name: 'error classification',
  cases: [
    {
      name: 'a retired model is named as deprecated, with the replacement the service names',
      run() {
        const body = {
          type: 'error',
          error: {
            type: 'ModelDeprecated',
            message: 'Model minimax-m2.7 has been deprecated. Use minimax-m3.1-flash instead.',
          },
          metadata: { model: 'minimax-m2.7', replacement: 'minimax-m3.1-flash' },
        }
        is(isModelDeprecated(410, body, JSON.stringify(body)), true)
        is(deprecationReplacement(body), 'minimax-m3.1-flash')
        const error = refused(body, { status: 410 })
        is(error.code, 'MODEL_DEPRECATED')
        ok(String(error.message).includes('minimax-m3.1-flash'), 'the replacement is in the message')
        is(error.failure.status, 410)
      },
    },
    {
      name: 'the sentence form of a deprecation is recognised under a plain 400',
      run() {
        const body = { error: { type: 'api_error', message: 'Upstream request failed: Model glm-5.1 has been deprecated. Use glm-5.3 instead.' } }
        is(isModelDeprecated(400, body, JSON.stringify(body)), true)
        is(deprecationReplacement(body), 'glm-5.3')
        is(refused(body, { status: 400 }).code, 'MODEL_DEPRECATED')
      },
    },
    {
      name: 'a model the service no longer serves is unavailable, not invalid',
      run() {
        const body = { error: { type: 'server_error', message: 'Upstream request failed: Model is unavailable.' } }
        is(isModelDeprecated(400, body, JSON.stringify(body)), false)
        is(isModelUnavailable(400, body, JSON.stringify(body)), true)
        const error = refused(body, { status: 400 })
        is(error.code, 'MODEL_UNAVAILABLE')
        ok(String(error.message).includes('Model is unavailable'), 'the provider detail is kept')
      },
    },
    {
      name: 'a protocol refusal keeps the protocol code, whatever else the body says',
      run() {
        const body = { type: 'error', error: { type: 'ModelProtocolUnsupported', message: 'Model does not support this protocol.' } }
        is(isModelUnavailable(400, body, JSON.stringify(body)), false)
        is(refused(body, { status: 400 }).code, 'PROTOCOL_UNSUPPORTED')
      },
    },
    {
      name: 'a 410 that names no deprecation keeps the status-derived code',
      run() {
        const body = { error: { message: 'gone' } }
        const error = refused(body, { status: 410 })
        is(error.code, 'HTTP_410')
        equal(error.failure.message, error.message)
      },
    },
    {
      name: 'a deadline is a timeout, and only the caller can be an abort',
      run() {
        const deadline = new AbortController()
        deadline.abort(new Error('deadline'))
        const caller = new AbortController()
        caller.abort()
        is(
          transportError({ protocol: 'chat-completions', error: new Error('aborted'), deadline: deadline.signal }).code,
          'TIMEOUT',
        )
        is(
          transportError({
            protocol: 'chat-completions',
            error: new Error('aborted'),
            signal: caller.signal,
            deadline: deadline.signal,
          }).code,
          'ABORTED',
        )
      },
    },
    {
      name: 'a mid-stream provider error keeps the code its marker names',
      run() {
        is(streamFailure('anthropic', { type: 'overloaded_error', message: 'busy' }).code, 'SERVER')
        is(streamFailure('chat-completions', { code: 'rate_limit_exceeded', message: 'slow down' }).code, 'RATE_LIMIT')
        is(streamFailure('responses', { type: 'invalid_request_error', message: 'bad field' }).code, 'MALFORMED_RESPONSE')
      },
    },
  ],
}
