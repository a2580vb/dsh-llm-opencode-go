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
  retryAfterMs,
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
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
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
      name: 'a refusal that echoes the API key carries it nowhere in the failure',
      run() {
        const canary = 'sk-canary-refusal-4c1f'
        for (const status of [400, 401]) {
          const body = {
            error: {
              type: 'invalid_request_error',
              code: 'invalid_api_key',
              message: `Incorrect API key provided: ${canary}`,
            },
            echo: `the raw body also carried ${canary}`,
          }
          const error = refused(body, {
            status,
            apiKey: canary,
            headers: { 'x-request-id': `req-${canary}` },
          })
          is(error.code, status === 401 ? 'AUTH' : 'INVALID_REQUEST')
          is(error.failure.status, status)
          ok(!String(error.message).includes(canary), `the secret is not in the ${status} message`)
          ok(!JSON.stringify(error.failure).includes(canary), `the secret is not in the ${status} failure facts`)
          ok(!String(error.cause?.message ?? '').includes(canary), `the secret is not in the ${status} cause`)
          ok(String(error.failure.requestId ?? '').startsWith('req-'), 'the request id stays usable')
          ok(String(error.message).includes('Incorrect API key provided:'), 'the provider detail around the secret stays')
        }
        // A quote in the key travels escaped on the wire; the escaped spelling
        // must not become a second, less obvious copy in the cause.
        const escaped = 'sk-canary-"quoted"-5e2'
        const error = refused({ error: { message: `Incorrect API key provided: ${escaped}` } }, {
          status: 401,
          apiKey: escaped,
        })
        ok(!String(error.message).includes(escaped), 'the decoded secret is not in the message')
        ok(!String(error.cause?.message ?? '').includes(escaped), 'the escaped secret is not in the cause')
      },
    },
    {
      name: 'a blank request-id header falls back or disappears instead of breaking the failure',
      run() {
        const fallback = refused({ error: { message: 'invalid key' } }, {
          status: 401,
          headers: { 'x-opencode-log-id': '   ', 'x-request-id': ' req-42 ' },
        })
        is(fallback.code, 'AUTH')
        is(fallback.failure.requestId, 'req-42', 'the usable header is trimmed and used')

        const trimmed = refused({ error: { message: 'invalid key' } }, {
          status: 401,
          headers: { 'x-opencode-log-id': ' req-log ' },
        })
        is(trimmed.failure.requestId, 'req-log', 'the log id is trimmed')

        const absent = refused({ error: { message: 'invalid key' } }, {
          status: 401,
          headers: { 'x-opencode-log-id': '', 'x-request-id': '   ' },
        })
        is(absent.code, 'AUTH')
        is('requestId' in absent.failure, false, 'no empty request id is recorded')
      },
    },
    {
      name: 'retry-after advice is either a positive finite millisecond value or absent',
      run() {
        const header = (value) => new Headers({ 'retry-after': value })
        is(retryAfterMs(header('2.5')), 2500)
        is(retryAfterMs(header('0.0001')), undefined, 'a sub-millisecond hint is not rounded to zero')
        is(retryAfterMs(header('Infinity')), undefined, 'an infinite hint is not a delay')
        is(retryAfterMs(header('1e306')), undefined, 'a hint whose milliseconds overflow is not usable')

        for (const value of ['0.0001', 'Infinity', '1e306', '0']) {
          const error = refused({ error: { message: 'quota exhausted' } }, {
            status: 402,
            headers: { 'retry-after': value },
          })
          is(error.code, 'QUOTA', `${value}: the status code survives`)
          is(error.failure.status, 402)
          is('providerRetryAfterMs' in error.failure, false, `${value}: no invalid delay is recorded`)
        }
      },
    },
    {
      name: 'a message-only stream error is classified from the message',
      run() {
        is(streamFailure('chat-completions', { message: 'Rate limit exceeded' }).code, 'RATE_LIMIT')
        is(streamFailure('responses', { message: 'The server is overloaded' }).code, 'SERVER')
        const anthropic = streamFailure('anthropic', { message: 'Rate limit exceeded' })
        is(anthropic.code, 'RATE_LIMIT')
        ok(String(anthropic.message).includes('Rate limit exceeded'), 'the provider wording is kept')
      },
    },
    {
      name: 'a 401 with a blank log id and a 402 with a hostile retry-after keep their codes',
      run() {
        const auth = refused({ error: { message: 'invalid key' } }, {
          status: 401,
          headers: { 'x-opencode-log-id': '', 'retry-after': '0.0001' },
        })
        is(auth.code, 'AUTH')
        is(auth.failure.status, 401)
        is('providerRetryAfterMs' in auth.failure, false)

        const quota = refused({ error: { message: 'quota exhausted' } }, {
          status: 402,
          headers: { 'retry-after': 'Infinity' },
        })
        is(quota.code, 'QUOTA')
        is(quota.failure.status, 402)
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
