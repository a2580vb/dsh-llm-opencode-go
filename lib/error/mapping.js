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
  // The service has retired a model. It answers `410 ModelDeprecated` with the
  // id it wants callers to move to; nothing about the request is wrong, and
  // retrying, another protocol or another key cannot change it.
  MODEL_DEPRECATED: 'MODEL_DEPRECATED',
  // The service answers that this id exists no more, as
  // `400 Model is unavailable.` — a model-level refusal rather than a malformed
  // request, and distinct from a protocol it does not serve.
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
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

/**
 * Sentence a backend uses when it cannot read a message's content shape.
 *
 * The chat route's tool message is a plain string in this adapter, so the marker
 * exists to name the refusal — `UNSUPPORTED_CONTENT` — should a message arrive in
 * a parts shape by another path.
 */
const UNSENDABLE_CONTENT_MARKERS = ['tool message content must be a string']

/** Parse a JSON error body, tolerating a plain-text or empty one. */
function parseBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** What replaces a known secret wherever it would otherwise be repeated. */
export const REDACTED = '[redacted]'

/** Non-empty strings from a secret list, longest first so nesting stays stable. */
function secretsOf(secrets) {
  const list = typeof secrets === 'string' ? [secrets] : [...(secrets ?? [])]
  return list
    .filter((secret) => typeof secret === 'string' && secret !== '')
    .sort((left, right) => right.length - left.length)
}

/**
 * Remove every exact occurrence of a known secret from one string.
 *
 * A refusal body is allowed to quote the request that caused it, and a 401 may
 * quote the key it rejected. This plugin knows the key it put on the wire, so
 * that one string can be removed exactly; prompts cannot be known that way, and
 * are kept out of the diagnostics log instead of being guessed at by a pattern.
 *
 * @param {string} text - the text to sanitize.
 * @param {string | Iterable<string>} secrets - values that must not survive.
 * @returns {string} the text with each known secret replaced by {@link REDACTED}.
 */
export function redactSecrets(text, secrets) {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  for (const secret of secretsOf(secrets)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  return out
}

/**
 * Redact every string in a decoded JSON body.
 *
 * Working on the decoded body rather than its text covers a secret the wire
 * escaped (quotes, backslashes), which a text-level replacement alone would miss.
 *
 * @param {unknown} value - a decoded body, or any JSON-shaped value.
 * @param {string | Iterable<string>} secrets - values that must not survive.
 * @returns {unknown} the same shape with every string sanitized.
 */
export function redactValue(value, secrets) {
  if (typeof value === 'string') return redactSecrets(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[redactSecrets(key, secrets)] = redactValue(item, secrets)
  }
  return out
}

/** Provider identifiers are punctuation-bearing tokens, never a sentence. */
const STABLE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** One provider-supplied machine identifier, or undefined when it is prose. */
function stableIdentifier(value) {
  return typeof value === 'string' && STABLE_IDENTIFIER.test(value) ? value : undefined
}

/**
 * The provider's own stable type and code, when the refusal carries them.
 *
 * These are the machine identifiers a support reader greps for, and they are
 * safe to persist because they are not prose: anything that does not look like
 * an identifier is dropped. Redact the body first, so a gateway that echoes a
 * credential into `type` cannot smuggle it through this allowlist.
 *
 * @param {unknown} raw - the decoded body, when it was JSON.
 * @returns {{ type?: string, code?: string }} the identifiers that are usable.
 */
export function providerErrorKind(raw) {
  const type = stableIdentifier(raw?.error?.type) ?? stableIdentifier(raw?.type)
  const code = stableIdentifier(raw?.error?.code) ?? stableIdentifier(raw?.code)
  return {
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
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
 * Whether a failure means "the service has retired this model".
 *
 * A retired model answers `410` with an `error.type` of `ModelDeprecated` and a
 * message naming the id to move to. The status is the authoritative signal, but
 * the type is matched too because some gateways surface the same refusal under
 * `400`; the sentence is the last resort for a body whose envelope this adapter
 * has not seen. Unlike an unsupported protocol, another protocol or a retry
 * cannot succeed.
 *
 * @param {number} status - the HTTP status.
 * @param {unknown} raw - the decoded body, when it was JSON.
 * @param {string} text - the raw body text.
 * @returns {boolean} true when the service has retired the model.
 */
export function isModelDeprecated(status, raw, text) {
  if (status !== 400 && status !== 410) return false
  const typed = [raw?.error?.type, raw?.error?.code, raw?.type, raw?.code]
    .filter((value) => typeof value === 'string' && value !== '')
  if (typed.some((value) => mentions(value, ['ModelDeprecated']))) return true
  return mentions(String(text ?? ''), ['has been deprecated'])
}

/**
 * The model id the service names as the replacement for a retired one.
 *
 * The refusal carries it as `metadata.replacement`; the sentence form
 * ("Model X has been deprecated. Use Y instead.") is the fallback for an
 * envelope that only keeps the message.
 *
 * @param {unknown} raw - the decoded body, when it was JSON.
 * @returns {string | undefined} the replacement id, or undefined when none is named.
 */
export function deprecationReplacement(raw) {
  const named = raw?.metadata?.replacement ?? raw?.error?.metadata?.replacement
  if (typeof named === 'string' && named.trim() !== '') return named.trim()
  const message = raw?.error?.message ?? raw?.message
  if (typeof message !== 'string') return undefined
  const match = /Use\s+([A-Za-z0-9._-]+)\s+instead/iu.exec(message)
  return match === null ? undefined : match[1]
}

/**
 * Whether a failure means "the service no longer serves this id at all".
 *
 * The relay answers `400` with a sentence naming the model as unavailable. That
 * is not a malformed request — the payload is fine — and not a protocol the
 * model refuses, so it gets a code of its own.
 *
 * @param {number} status - the HTTP status.
 * @param {unknown} raw - the decoded body, when it was JSON.
 * @param {string} text - the raw body text.
 * @returns {boolean} true when the model is gone from the service.
 */
export function isModelUnavailable(status, raw, text) {
  if (status !== 400) return false
  const detail = providerErrorDetail(raw, text)
  return mentions(`${detail.message} ${String(text ?? '')}`, ['model is unavailable'])
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
 * The refusal a backend gives for a message whose content shape it cannot read.
 *
 * It is a content refusal, not a malformed request: the request says what it
 * means, the far end just spells that message differently. Naming it separately
 * keeps the harness from reporting it as a broken payload, and the remedy below
 * says which shape is expected.
 *
 * @param {number} status - the HTTP status.
 * @param {string} haystack - body text plus any extracted message, for marker tests.
 * @returns {boolean} true when a message's content shape was refused.
 */
export function isUnsendableContent(status, haystack) {
  if (status !== 400 && status !== 422) return false
  return mentions(haystack, UNSENDABLE_CONTENT_MARKERS)
}

/**
 * What to do about {@link isUnsendableContent}, appended to its message.
 *
 * A refusal of this kind is about the shape the far end accepts, not about the
 * credential or the model, so neither a retry nor another protocol changes it:
 * the message says so and asks for the request id instead.
 */
export const UNSENDABLE_CONTENT_REMEDY = `the backend this route reached accepts a tool result only as a plain string;`
  + ` a retry would repeat the same shape, so report the refusal with the request id`

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
  if (Number.isFinite(seconds) && seconds > 0) {
    // The header is legal and still may describe no usable delay: 0.0001s
    // rounds to zero, and a huge value overflows to Infinity. Neither is a
    // value `LlmError` can carry, so the advice is dropped rather than
    // allowed to turn a classified refusal into a constructor failure.
    const milliseconds = Math.round(seconds * 1000)
    return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined
  }
  const date = Date.parse(String(raw))
  if (Number.isFinite(date)) {
    const delta = date - Date.now()
    return delta > 0 ? delta : undefined
  }
  return undefined
}

/**
 * The provider request id from the response headers, when one is usable.
 *
 * The log id is the preferred spelling, but a blank value is the absence of an
 * id rather than an id of "": accepting it would make `LlmError` reject its own
 * options and turn a classified refusal into a transport failure. Only a
 * trimmed non-empty string is accepted, the fallback header is tried next, and
 * a response with neither simply carries no id.
 *
 * @param {Headers} headers - the response headers.
 * @param {string | Iterable<string>} [secrets] - values that must not survive.
 * @returns {string | undefined} the trimmed id, or undefined when none is usable.
 */
export function requestIdFromHeaders(headers, secrets) {
  for (const name of ['x-opencode-log-id', 'x-request-id']) {
    const raw = headers?.get?.(name)
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed === '') continue
    return redactSecrets(trimmed, secrets ?? [])
  }
  return undefined
}

/**
 * The stable failure for a caller that has already cancelled.
 *
 * `AbortSignal.throwIfAborted()` throws a DOMException, which the harness cannot
 * classify: it carries no `code` and no `failure` snapshot. Every public entry
 * raises this shape instead, so a pre-cancelled call is `ABORTED` before any
 * catalog or network work and without leaking a browser exception.
 *
 * @param {unknown} [cause] - the signal's reason, when it has one.
 * @returns {LlmError} an `ABORTED` failure.
 */
export function abortedError(cause) {
  return new LlmError('opencode-go: request aborted by the caller', CODES.ABORTED, { cause })
}

/**
 * Rebuild a classified failure with every known secret removed.
 *
 * A mid-stream failure is built by a protocol translator, which sees the
 * provider's error object but not the credential the request carried. The
 * adapter knows the key, so it applies the same exact-string redaction here
 * that {@link refusedRequestError} applies to an HTTP refusal, before the
 * harness can read the message or the failure facts.
 *
 * @param {unknown} error - a thrown value.
 * @param {string | Iterable<string>} secrets - values that must not survive.
 * @returns {unknown} an equivalent failure, or the value unchanged when it is
 *   not a classified one.
 */
export function redactFailure(error, secrets) {
  if (error === null || typeof error !== 'object'
    || typeof error.code !== 'string' || error.code === ''
    || error.failure === null || typeof error.failure !== 'object') {
    return error
  }
  const message = redactSecrets(String(error.message ?? ''), secrets)
  const failure = redactValue(error.failure, secrets)
  const cause = redactCause(error.cause, secrets)
  return new LlmError(message === '' ? 'opencode-go: classified failure' : message, error.code, {
    ...(Number.isInteger(failure?.status) && failure.status >= 100 && failure.status <= 599
      ? { status: failure.status }
      : {}),
    ...(Number.isFinite(failure?.providerRetryAfterMs) && failure.providerRetryAfterMs > 0
      ? { providerRetryAfterMs: failure.providerRetryAfterMs }
      : {}),
    ...(typeof failure?.requestId === 'string' && failure.requestId !== ''
      ? { requestId: failure.requestId }
      : {}),
    ...(cause === undefined ? {} : { cause }),
  })
}

/**
 * A cause with every known secret removed, without losing its name.
 *
 * @param {unknown} cause - the cause under a classified failure.
 * @param {string | Iterable<string>} secrets - values that must not survive.
 * @returns {unknown} the original cause when it is already clean.
 */
function redactCause(cause, secrets) {
  if (cause === undefined) return undefined
  if (typeof cause === 'string') return redactSecrets(cause, secrets)
  if (cause === null || typeof cause !== 'object' || typeof cause.message !== 'string') return cause
  const message = redactSecrets(cause.message, secrets)
  if (message === cause.message) return cause
  const copy = new Error(message)
  if (typeof cause.name === 'string' && cause.name !== '') copy.name = cause.name
  return copy
}

/**
 * Build the `LlmError` for one refused request.
 *
 * A refusal is free to repeat whatever it disliked, and a 401 can quote the
 * credential it rejected, so the known key is removed from the detail and the
 * raw body before either becomes a message, a failure fact, or a cause. Prompt
 * text has no equivalent known value: it is kept out of the diagnostics log by
 * an allowlist instead, never by guessing at what looks like a prompt.
 *
 * @param {object} input - the failure facts.
 * @param {string} input.provider - the provider route, for the message.
 * @param {string} input.model - the model id.
 * @param {string} input.protocol - the wire protocol that was attempted.
 * @param {number} input.status - the HTTP status.
 * @param {Headers} input.headers - the response headers.
 * @param {string} input.text - the raw response body.
 * @param {unknown} input.raw - the decoded body, when it was JSON.
 * @param {string} [input.apiKey] - the credential this request carried.
 * @returns {LlmError} a classified failure.
 */
export function refusedRequestError(input) {
  const { provider, model, protocol, status, headers, text, raw, apiKey } = input
  const secrets = apiKey === undefined ? [] : [apiKey]
  const safeText = redactSecrets(text, secrets)
  const safeRaw = redactValue(raw, secrets)
  // A JSON body may spell the secret with escapes, so the cause is taken from
  // the redacted structure when there is one; a plain-text body is replaced
  // directly. Either way the credential cannot reach the cause.
  const safeBody = raw === undefined ? safeText : JSON.stringify(safeRaw)
  const detail = providerErrorDetail(safeRaw, safeText)
  // Consent first: the relay's gate is a workspace policy, so it must not be
  // reported as a malformed request, and — unlike every other refusal here — the
  // message has to carry the one action that removes it.
  const consent = isTrainingConsentRefusal(status, safeRaw, safeText)
  const haystack = `${detail.message} ${detail.type ?? ''} ${detail.code ?? ''}`
  const unsendable = isUnsendableContent(status, `${haystack} ${safeText}`)
  // A retired or vanished model is a fact about the id, not about the request:
  // it reads differently from a malformed payload and cannot be retried away.
  const deprecated = isModelDeprecated(status, safeRaw, safeText)
  const unavailable = !deprecated && isModelUnavailable(status, safeRaw, safeText)
  const code = isProtocolUnsupported(status, safeRaw, safeText)
    ? CODES.PROTOCOL_UNSUPPORTED
    : deprecated
      ? CODES.MODEL_DEPRECATED
      : consent
        ? CODES.TRAINING_CONSENT_REQUIRED
        : unavailable
          ? CODES.MODEL_UNAVAILABLE
          : unsendable
            ? CODES.UNSUPPORTED_CONTENT
            : codeForStatus(status, haystack)
  const retryAfter = retryAfterMs(headers)
  const requestId = requestIdFromHeaders(headers, secrets)
  const replacement = deprecated ? deprecationReplacement(safeRaw) : undefined
  const remedy = deprecated
    ? (replacement === undefined
      ? ' — the service has retired this model'
      : ` — the service names "${replacement}" as its replacement`)
    : consent ? ` — ${TRAINING_CONSENT_REMEDY}` : unsendable ? ` — ${UNSENDABLE_CONTENT_REMEDY}` : ''
  return new LlmError(
    `opencode-go: ${protocol} request for "${model}" on provider "${provider}" failed with HTTP ${status}:`
    + ` ${detail.message}${remedy}`,
    code,
    {
      status,
      ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
      ...(requestId === undefined ? {} : { requestId }),
      cause: new Error(typeof safeBody === 'string' && safeBody !== '' ? safeBody.slice(0, 1000) : `HTTP ${status}`),
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
 * A failure after the response headers arrived — an unreadable refusal body,
 * for instance — still knows the status and request id that did arrive. Those
 * are passed through so the classified failure keeps them, which is what lets a
 * reader tell an unread refusal from a connection that never opened.
 *
 * @param {object} input - the failure facts.
 * @param {string} input.protocol - the wire protocol that was attempted.
 * @param {unknown} input.error - the thrown value.
 * @param {AbortSignal} [input.signal] - the caller's signal.
 * @param {AbortSignal} [input.deadline] - this attempt's own deadline signal.
 * @param {number} [input.status] - an HTTP status that already arrived.
 * @param {string} [input.requestId] - a request id that already arrived.
 * @returns {LlmError} a classified failure.
 */
export function transportError(input) {
  const { protocol, error, signal, deadline, status, requestId } = input
  if (error instanceof LlmError) return error
  const observed = {
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(typeof requestId === 'string' && requestId !== '' ? { requestId } : {}),
  }
  if (signal?.aborted) {
    return new LlmError(
      `opencode-go: ${protocol} request aborted by the caller`,
      CODES.ABORTED,
      { ...observed, cause: error },
    )
  }
  if (deadline?.aborted || error?.name === 'TimeoutError') {
    return new LlmError(
      `opencode-go: ${protocol} request timed out`,
      CODES.TIMEOUT,
      { ...observed, cause: error },
    )
  }
  return new LlmError(
    `opencode-go: ${protocol} transport failed: ${error?.message ?? String(error)}`,
    CODES.TRANSPORT,
    { ...observed, cause: error },
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
 * A provider error object delivered inside an otherwise healthy stream.
 *
 * The stream was accepted and then the relay switched to its error vocabulary
 * mid-answer. That is a failed attempt, not a malformed one, and the code is
 * what decides whether the retry executor may try again — so it comes from the
 * provider's own transient markers rather than from the fact that the answer
 * stopped early.
 *
 * @param {string} protocol - the wire protocol.
 * @param {object} [error] - the provider's error object.
 * @returns {LlmError} a classified mid-stream failure.
 */
export function streamFailure(protocol, error) {
  const detail = error?.message ?? error?.code ?? error?.type ?? 'the relay reported an error'
  // A provider is free to name the condition only in the sentence — "Rate limit
  // exceeded" is common — with no `type` or `code` beside it. Reading the
  // message is what keeps that from being reported as a malformed stream; the
  // sentence is also where the adapter's known key is redacted at the request
  // boundary before this failure reaches the harness.
  const marker = `${error?.type ?? ''} ${error?.code ?? ''} ${error?.message ?? ''}`.toLowerCase()
  const message = `opencode-go: ${protocol} reported an error mid-stream: ${detail}`
  if (/rate.?limit|too.?many.?requests/.test(marker)) return new LlmError(message, CODES.RATE_LIMIT)
  if (/overload|server|unavailable|timeout|api_error|internal/.test(marker)) {
    return new LlmError(message, CODES.SERVER)
  }
  return new LlmError(message, CODES.MALFORMED_RESPONSE)
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
