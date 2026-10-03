/**
 * The failure type and identity helpers this adapter owns.
 *
 * The harness identifies an adapter failure by its own data properties, not by
 * class identity: `normalizeLlmFailure` reads an own `failure` snapshot and an
 * own `code`, and falls back to `error.code` when the thrown value is not a
 * harness `HarnessError`. A cross-package copy of the harness error class would
 * therefore never be recognized by `instanceof` anyway — so this plugin defines
 * the same shape itself and depends on no harness package at runtime.
 *
 * That is what keeps the plugin installable into any DSH version: a route
 * registration, a stream, and a failure all cross the boundary as plain data.
 *
 * @module dsh-llm-opencode-go/errors
 */

/**
 * A model-call failure carrying the stable code consumers route on.
 *
 * `code` and `failure` are own data properties so the harness can read them
 * from a value whose class it does not know.
 */
export class LlmError extends Error {
  /**
   * @param {string} message - non-empty human-readable summary.
   * @param {string} code - non-empty stable provider-neutral machine code.
   * @param {object} [options] - validated serializable provider facts.
   * @param {number} [options.status] - provider HTTP status, when there was one.
   * @param {number} [options.providerRetryAfterMs] - provider-advised delay.
   * @param {string} [options.requestId] - provider request id for support.
   * @param {unknown} [options.cause] - the underlying failure.
   */
  constructor(message, code, options) {
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('LlmError message must be a non-empty string')
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('LlmError code must be a non-empty string')
    }
    const { status, providerRetryAfterMs, requestId, cause } = options ?? {}
    if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) {
      throw new Error('LlmError status must be an integer from 100 through 599')
    }
    if (providerRetryAfterMs !== undefined
      && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0)) {
      throw new Error('LlmError providerRetryAfterMs must be a positive finite number')
    }
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0)) {
      throw new Error('LlmError requestId must be a non-empty string')
    }
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LlmError'
    this.code = code
    this.failure = Object.freeze({
      message,
      code,
      ...(status === undefined ? {} : { status }),
      ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
      ...(requestId === undefined ? {} : { requestId }),
    })
  }
}

/**
 * Brand an opaque provider tool-call id.
 *
 * The harness's own constructor is an identity function whose brand exists only
 * in the type system, so this is the same value under a different name.
 *
 * @param {string} id - the provider-issued call id.
 * @returns {string} the same id.
 */
export function ToolCallId(id) {
  return String(id)
}

/**
 * Brand one reasoning-effort identifier.
 *
 * @param {string} id - the level name.
 * @returns {string} the same name.
 */
export function ReasoningEffortId(id) {
  return String(id)
}

/** This plugin's own product identity, and the version it reports. */
export const PLUGIN_IDENTITY = Object.freeze({
  product: 'dsh-llm-opencode-go',
  version: '0.1.0',
})
