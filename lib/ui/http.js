/**
 * Small HTTP helpers for the graphical-configuration bridge.
 *
 * The bridge answers browser requests on the harness's own `webServer`, so it
 * speaks `node:http` directly (`req`/`res`) and keeps no framework dependency.
 * Everything here is deliberately dependency-free and shape-tolerant: a test
 * hands the same helpers a plain object, and Node's real request passes the
 * same checks.
 *
 * @module dsh-opencode-go/ui/http
 */

/** Largest request body the bridge accepts; every endpoint here sends a form. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Read one header value, whatever shape the request carries.
 *
 * Node's own request lowercases header names, but a `Headers` instance (a test
 * using `fetch` shapes) needs `get()`, and a hand-written object may use any
 * case, so all three are accepted rather than assumed.
 *
 * @param {object} request - a node request or a `{ headers }` stand-in.
 * @param {string} name - the header name, in any case.
 * @returns {string | undefined} the first value, or undefined when absent.
 */
export function headerValue(request, name) {
  const headers = request?.headers
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return value === undefined || value === null ? undefined : String(value)
  }
  const wanted = String(name).toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined || value === null) continue
    return Array.isArray(value) ? String(value[0]) : String(value)
  }
  return undefined
}

/** Write a JSON response: no cache, one body, no further writes. */
export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

/** Reject a request whose method the endpoint does not serve. */
export function sendMethodNotAllowed(response, allowed) {
  response.setHeader('allow', allowed.join(', '))
  sendJson(response, 405, { ok: false, error: 'method-not-allowed', allow: allowed })
}

/**
 * Read a JSON request body with a bound.
 *
 * An empty body reads as `{}` so a body-less POST is a shape error reported by
 * the endpoint rather than a parse failure; anything larger than `limit` is
 * refused before it can be buffered.
 *
 * @param {AsyncIterable<Uint8Array>} request - the node request stream.
 * @param {number} [limit] - the largest accepted body, in bytes.
 * @returns {Promise<unknown>} the decoded body.
 * @throws {Error} `body-too-large` or `invalid-json`.
 */
export async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    size += bytes.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('invalid-json')
  }
}

/**
 * Whether a WHATWG hostname names the local loopback authority.
 *
 * Mirrors the rule the harness applies to its own `/api` fence, so this bridge
 * accepts exactly the authorities the rest of the installation treats as local.
 *
 * @param {string} hostname - a URL hostname (IPv6 literals keep their brackets).
 * @returns {boolean} true for localhost, IPv6 loopback, or any IPv4 127/8 address.
 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = String(hostname).split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Parse an authority header (`host`) into its hostname and normalized host.
 *
 * @param {string | undefined} authority - the `host` header value.
 * @returns {{ hostname: string, host: string } | undefined} parsed parts, or
 *   undefined when the value is not an authority this fence can judge.
 */
export function parseAuthority(authority) {
  if (typeof authority !== 'string' || authority.trim() === '') return undefined
  try {
    const url = new URL(`http://${authority.trim()}`)
    return { hostname: url.hostname, host: url.host }
  } catch {
    return undefined
  }
}

/**
 * The bridge's own request fence, used when no connection service is mounted.
 *
 * It answers the two confused-deputy paths a browser opens against a local HTTP
 * API: DNS rebinding (a `Host` naming someone else's domain while the socket
 * reaches this server) and a cross-site request fired from a foreign page. It
 * is not an authentication layer — without the connection service there is no
 * browser session to authenticate, so only loopback authorities pass.
 *
 * @param {object} request - the node request.
 * @returns {number | undefined} an HTTP status to answer with, or undefined to admit.
 */
export function fenceRejection(request) {
  const authority = parseAuthority(headerValue(request, 'host'))
  if (authority === undefined || !isLoopbackHostname(authority.hostname)) return 403
  if (headerValue(request, 'sec-fetch-site') === 'cross-site') return 403
  const origin = headerValue(request, 'origin')
  if (origin === undefined) return undefined
  try {
    return new URL(origin).host === authority.host ? undefined : 403
  } catch {
    return 403
  }
}

/**
 * Decide whether one request may reach the bridge.
 *
 * The connection service owns the real policy (host/origin fence plus the
 * browser-session cookie), so it is asked first; the local fence above is the
 * fallback for a composition that mounts a web server without a connection
 * carrier, which is also the shape the offline suites exercise.
 *
 * @param {object | undefined} connection - the mounted connection service.
 * @param {object} request - the node request.
 * @returns {number | undefined} 401/403 to reject with, or undefined to admit.
 */
export function rejectionFor(connection, request) {
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    return connection.requestRejection(request)
  }
  return fenceRejection(request)
}
