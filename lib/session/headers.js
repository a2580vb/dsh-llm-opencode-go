/**
 * The `x-opencode-session` affinity header, and the rest of the request identity.
 *
 * OpenCode's relay pins every request that carries the same
 * `x-opencode-session` value to the same upstream backend, which is what keeps
 * its prompt cache warm across the turns of one conversation. The value only
 * has to be opaque and stable **per conversation** — a single fixed value for
 * every request would put every session on one shared cache lineage, so this
 * module derives it from the DSH session id that already travels with each call.
 *
 * @module dsh-llm-opencode-go/session/headers
 */

import { randomUUID } from 'node:crypto'

export const SESSION_HEADER = 'x-opencode-session'
export const CLIENT_HEADER = 'x-opencode-client'

/**
 * Derive the header value for one model call.
 *
 * Modes:
 *   `session-id` (default) — the DSH session id itself: unique per conversation
 *     and stable across turns, compaction, retries, and process restarts.
 *   `uuid` — an opaque random UUID derived once per session id and remembered
 *     for this process, for deployments that would rather not send the harness
 *     id upstream. It is stable across the turns of one run only.
 *   `off` — send no header at all.
 *
 * A call with no session id — session-title generation and other auxiliary
 * requests — gets a per-process fallback rather than an absent header, so the
 * relay still sees a stable client identity while each distinct tool-generated
 * call cannot be mistaken for a conversation turn.
 *
 * @param {object} config - the resolved plugin configuration.
 * @param {object} state - process-lifetime state.
 * @param {Map<string, string>} state.uuidBySession - `uuid`-mode memo.
 * @param {() => string} state.fallbackUuid - lazily created anonymous id.
 * @param {unknown} sessionId - `GenerateOptions.sessionId`, when the caller set one.
 * @returns {string | undefined} the header value, or undefined when disabled.
 */
export function sessionHeaderValue(config, state, sessionId) {
  if (config.sessionHeader === 'off') return undefined
  const raw = sessionId === undefined || sessionId === null ? '' : String(sessionId)
  if (raw === '') return state.fallbackUuid()
  if (config.sessionHeader !== 'uuid') return raw
  let value = state.uuidBySession.get(raw)
  if (value === undefined) {
    value = randomUUID()
    state.uuidBySession.set(raw, value)
  }
  return value
}

/**
 * Build the process-lifetime state {@link sessionHeaderValue} needs.
 *
 * @returns {{ uuidBySession: Map<string, string>, fallbackUuid: () => string }} fresh state.
 */
export function createSessionState() {
  let anonymous
  return {
    uuidBySession: new Map(),
    fallbackUuid: () => {
      anonymous ??= `dsh-anonymous-${randomUUID()}`
      return anonymous
    },
  }
}

/**
 * Every header one OpenCode Go request carries beyond its auth and content type.
 *
 * `attribution` is the harness's own `User-Agent`, which the plugin's product
 * token is prefixed onto — both identities stay truthful in one header. The
 * session and client headers follow it.
 *
 * @param {object} config - the resolved plugin configuration.
 * @param {object} state - process-lifetime state from {@link createSessionState}.
 * @param {string} userAgent - the resolved `User-Agent` value.
 * @param {unknown} sessionId - the call's session id, when it has one.
 * @returns {Record<string, string>} headers to merge into the request.
 */
export function identityHeaders(config, state, userAgent, sessionId) {
  const headers = { 'user-agent': userAgent }
  const session = sessionHeaderValue(config, state, sessionId)
  if (session !== undefined) headers[SESSION_HEADER] = session
  if (config.sendClientHeader) headers[CLIENT_HEADER] = config.userAgentProduct
  return headers
}
