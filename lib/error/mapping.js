/**
 * Provider failure classification.
 *
 * Every failure reaching the harness carries a stable code, because consumers
 * route on the code and never on message text. This module is the one place
 * that turns an HTTP status, a relay error body, or a transport exception into
 * that vocabulary.
 *
 * @module dsh-llm-opencode-go/error/mapping
 */

import { DATA_POLICY_ERROR, MODEL_PROTOCOL_UNSUPPORTED, TRAINING_CONSENT_CONSOLE, TRAINING_CONSENT_SETTING, TRAINING_NOT_ALLOWED } from '../config.js'
import { LlmError } from './errors.js'

/** Codes this adapter can emit, kept beside the mapping that chooses them. */
export const CODES = Object.freeze({
  AUTH: 'AUTH',
  QUOTA: 'QUOTA',
  RATE_LIMIT: 'RATE_LIMIT',
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  SERVER: 'SERVER',
  TRANSPORT: 'TRANSPORT',
  ABORTED: 'ABORTED',
  TIMEOUT: 'TIMEOUT',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  STREAM_CLOSED: 'STREAM_CLOSED',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
  UNSUPPORTED_OPTION: 'UNSUPPORTED_OPTION',
  PROTOCOL_UNSUPPORTED: 'PROTOCOL_UNSUPPORTED',
  // The relay's training-consent gate: the model exists and this account may
  // use it the moment its workspace allows data-training providers. Distinct
  // from `INVALID_REQUEST` because nothing about the request is wrong, and
  // distinct from `AUTH` because the credential is fine.
  TRAINING_CONSENT_REQUIRED: 'TRAINING_CONSENT_REQUIRED',
  // Raised before any network I/O by the credential resolver in `index.js`;
  // without these two entries its `LlmError` constructor rejects the undefined
  // code, and a missing key would surface as an opaque transport failure.
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  INVALID_CREDENTIAL: 'INVALID_CREDENTIAL',
})

/** The relay's credential refusal, as it names the missing piece. */
const AUTH_MARKERS = ['AuthError', 'Missing API key', 'invalid_api_key', 'unauthorized']

/** Body text the relay uses for a context-window refusal. */
const CONTEXT_MARKERS = ['context length', 'context_length', 'too many tokens', 'maximum context']

/** Body text the relay uses for a quota or rate refusal. */
const RATE_MARKERS = ['rate limit', 'rate_limit', 'too many requests']

/** Parse a JSON error body, tolerating a plain-text or empty one. */
function parseBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Pull a human-readable detail out of whichever error envelope the relay used.
 *
 * Three shapes appear in practice: the OpenAI `{error: {message, type, code}}`,
 * the Anthropic `{type: 'error', error: {type, message}}`, and the terse
 * `{model: '<id>'}` body OpenCode Go returns for some model-level refusals.
 *
 * @param {unknown} raw - the decoded body, when it was JSON.
 * @param {string} text - the raw body text.
 * @returns {{ message: string, type?: string, code?: string }} the extracted detail.
 */
export function providerErrorDetail(raw, text) {
  const error = raw?.error
  if (error !== null && typeof error === 'object') {
    const message = typeof error.message === 'string' && error.message !== ''
      ? error.message
      : typeof error.type === 'string' ? error.type : 'provider error'
    const detail = { message }
    if (typeof error.type === 'string') detail.type = error.type
    if (typeof error.code === 'string') detail.code = error.code
    return detail
  }
  if (typeof raw?.message === 'string' && raw.message !== '') return { message: raw.message }
  if (typeof raw?.model === 'string' && raw.model !== '') {
    return { message: `the relay refused model "${raw.model}" without a detail` }
  }
  const trimmed = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : ''
  return { message: trimmed === '' ? 'the relay returned no detail' : trimmed.slice(0, 500) }
}

/**
 * Whether a failure means "this model does not serve this protocol".
 *
 * OpenCode Go answers `400` with `error.type === 'ModelProtocolUnsupported'`
 * when a model exists but the endpoint does not serve it. Recognising that
 * specific fact is what lets the adapter try the model's other protocols
 * instead of surfacing a bare 400.
 *
 * @param {number} status - the HTTP status.
 * @param {unknown} raw - the decoded body, when it was JSON.
 * @param {string} text - the raw body text.
 * @returns {boolean} true when the model simply does not speak this protocol.
 */
export function isProtocolUnsupported(status, raw, text) {
  if (status !== 400 && status !== 404 && status !== 405) return false
  if (raw?.error?.type === MODEL_PROTOCOL_UNSUPPORTED) return true
  if (typeof raw?.type === 'string' && raw.type === MODEL_PROTOCOL_UNSUPPORTED) return true
  return typeof text === 'string' && text.includes(MODEL_PROTOCOL_UNSUPPORTED)
}

/**
 * The refusal that means "this model's provider trains on request data, and
 * your workspace has not allowed that".
 *
 * It is an account-level policy refusal, so it is worth naming: no retry, no
 * other protocol, and no different key changes it — only the workspace setting
 * does. Two spellings reach this adapter, because the gate has moved:
 *
 *   - the current relay throws its own `DataPolicyError`, answered as
 *     `403 {"type":"error","error":{"type":"DataPolicyError","message":"…"}}`;
 *   - deployments that surface the refusal from the upstream service answer
 *     `400` with an `Account.TrainingNotAllowed` code and the sentence "This Go
 *     model trains on request data…" inside the error message.
 *
 * Both are matched, plus the sentence itself, so a body whose envelope is a
 * third shape is still classified by what it says.
 *
 * @param {number} status - the HTTP status.
 * @param {unknown} raw - the decoded body, when it was JSON.
 * @param {string} text - the raw body text.
 * @returns {boolean} true when the relay refused on training consent.
 */
export function isTrainingConsentRefusal(status, raw, text) {
  if (status !== 400 && status !== 403) return false
  const typed = [raw?.error?.type, raw?.error?.code, raw?.type, raw?.code]
    .filter((value) => typeof value === 'string' && value !== '')
  if (typed.some((value) => mentions(value, [DATA_POLICY_ERROR, TRAINING_NOT_ALLOWED]))) return true
  return mentions([...typed, text].join(' '), TRAINING_MARKERS)
}

/** Wording the relay uses in the sentence form of the same refusal. */
const TRAINING_MARKERS = ['trains on request data', 'train on request data', 'trains on your request data']

/**
 * What to do about {@link isTrainingConsentRefusal}, appended to its message.
 *
 * The switch belongs to the workspace, so the sentence names it, locates it, and
 * says plainly that this plugin cannot grant it — a reader who sees only
 * "HTTP 403" would otherwise try another key or another protocol, neither of
 * which is the missing piece.
 */
export const TRAINING_CONSENT_REMEDY = `the relay refused this on the workspace's data policy: an admin`
  + ` enables "${TRAINING_CONSENT_SETTING}" in the OpenCode console`
  + ` (${TRAINING_CONSENT_CONSOLE} → the workspace → Go → Providers) to allow models whose provider trains`
  + ` on request data, and this plugin cannot grant that consent for a request — enable it there, or select`
  + ` a model that does not train on request data`

/** Case-insensitive "does any marker appear" test over a joined haystack. */
function mentions(haystack, markers) {
  const lower = haystack.toLowerCase()
  return markers.some((marker) => lower.includes(marker.toLowerCase()))
}

/**
 * Map one non-2xx response to a stable code.
 *
 * Status first, because it is authoritative; body text only separates the cases
 * one status covers — a 400 is a context overflow or a malformed request, and a
 * 402/429 is a hard quota or a transient rate limit.
 *
 * @param {number} status - the HTTP status.
 * @param {string} haystack - body text plus any extracted message, for marker tests.
 * @returns {string} one of {@link CODES}.
 */
export function codeForStatus(status, haystack) {
  if (status === 401 || status === 403) return CODES.AUTH
  if (status === 402) return CODES.QUOTA
  if (status === 404) return CODES.INVALID_REQUEST
  if (status === 408 || status === 504) return CODES.TIMEOUT
  if (status === 429) {
    return mentions(haystack, ['quota', 'insufficient', 'credit', 'balance'])
      ? CODES.QUOTA
      : CODES.RATE_LIMIT
  }
  if (status === 400 || status === 422) {
    if (mentions(haystack, CONTEXT_MARKERS)) return CODES.CONTEXT_WINDOW_EXCEEDED
    return CODES.INVALID_REQUEST
  }
  if (status >= 500) return CODES.SERVER
  return `HTTP_${status}`
}

/** `retry-after` in seconds or as an HTTP date, normalized to milliseconds. */
export function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after')
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
  const date = Date.parse(String(raw))
  if (Number.isFinite(date)) {
    const delta = date - Date.now()
    return delta > 0 ? delta : undefined
  }
  return undefined
}

/**
 * Build the `LlmError` for one refused request.
 *
 * @param {object} input - the failure facts.
 * @param {string} input.provider - the provider route, for the message.
 * @param {string} input.model - the model id.
 * @param {string} input.protocol - the wire protocol that was attempted.
 * @param {number} input.status - the HTTP status.
 * @param {Headers} input.headers - the response headers.
 * @param {string} input.text - the raw response body.
 * @param {unknown} input.raw - the decoded body, when it was JSON.
 * @returns {LlmError} a classified failure.
 */
export function refusedRequestError(input) {
  const { provider, model, protocol, status, headers, text, raw } = input
  const detail = providerErrorDetail(raw, text)
  // Consent first: the relay's gate is a workspace policy, so it must not be
  // reported as a malformed request, and — unlike every other refusal here — the
  // message has to carry the one action that removes it.
  const consent = isTrainingConsentRefusal(status, raw, text)
  const code = isProtocolUnsupported(status, raw, text)
    ? CODES.PROTOCOL_UNSUPPORTED
    : consent
      ? CODES.TRAINING_CONSENT_REQUIRED
      : codeForStatus(status, `${detail.message} ${detail.type ?? ''} ${detail.code ?? ''}`)
  const retryAfter = retryAfterMs(headers)
  const requestId = headers?.get?.('x-opencode-log-id') ?? headers?.get?.('x-request-id') ?? undefined
  return new LlmError(
    `opencode-go: ${protocol} request for "${model}" on provider "${provider}" failed with HTTP ${status}:`
    + ` ${detail.message}${consent ? ` — ${TRAINING_CONSENT_REMEDY}` : ''}`,
    code,
    {
      status,
      ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
      ...(requestId === undefined ? {} : { requestId }),
      cause: new Error(typeof text === 'string' && text !== '' ? text.slice(0, 1000) : `HTTP ${status}`),
    },
  )
}

/**
 * Classify a thrown transport, timeout, or cancellation failure.
 *
 * A caller abort and an internal deadline must stay distinguishable: the loop
 * turns the first into an `aborted` finish and the second into a retryable
 * timeout.
 *
 * @param {object} input - the failure facts.
 * @param {string} input.protocol - the wire protocol that was attempted.
 * @param {unknown} input.error - the thrown value.
 * @param {AbortSignal} [input.signal] - the caller's signal.
 * @param {AbortSignal} [input.deadline] - this attempt's own deadline signal.
 * @returns {LlmError} a classified failure.
 */
export function transportError(input) {
  const { protocol, error, signal, deadline } = input
  if (error instanceof LlmError) return error
  if (signal?.aborted) {
    return new LlmError(`opencode-go: ${protocol} request aborted by the caller`, CODES.ABORTED, { cause: error })
  }
  if (deadline?.aborted || error?.name === 'TimeoutError') {
    return new LlmError(`opencode-go: ${protocol} request timed out`, CODES.TIMEOUT, { cause: error })
  }
  return new LlmError(
    `opencode-go: ${protocol} transport failed: ${error?.message ?? String(error)}`,
    CODES.TRANSPORT,
    { cause: error },
  )
}

/**
 * A protocol-level violation: a frame that cannot be true of the protocol.
 *
 * @param {string} protocol - the wire protocol.
 * @param {string} detail - what was wrong.
 * @returns {LlmError} a `MALFORMED_RESPONSE` failure.
 */
export function malformed(protocol, detail) {
  return new LlmError(`opencode-go: ${protocol} returned a malformed stream: ${detail}`, CODES.MALFORMED_RESPONSE)
}

/**
 * A stream that ended before its protocol's terminal event.
 *
 * @param {string} protocol - the wire protocol.
 * @param {string} missing - the event that never arrived.
 * @returns {LlmError} a `STREAM_CLOSED` failure.
 */
export function streamClosed(protocol, missing) {
  return new LlmError(
    `opencode-go: ${protocol} stream ended before ${missing}`,
    CODES.STREAM_CLOSED,
  )
}

/**
 * A stream that settled successfully but produced nothing the model could read.
 *
 * The default retry policy treats this as retryable, which is the right answer
 * for a relay that occasionally drops a completion.
 *
 * @param {string} protocol - the wire protocol.
 * @returns {LlmError} an `EMPTY_RESPONSE` failure.
 */
export function emptyResponse(protocol) {
  return new LlmError(`opencode-go: ${protocol} returned no content`, CODES.EMPTY_RESPONSE)
}
