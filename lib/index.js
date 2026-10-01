/**
 * dsh-opencode-go — an OpenCode Go provider adapter for DeepSeek Harness.
 *
 * Registers one provider route whose models live at `https://opencode.ai/zen/go/v1`
 * and implements the harness LLM adapter contract:
 *
 *   - `listModels`   answers from the discovered catalog (`model/cache.js`).
 *   - `resolveModel` answers capability metadata, including which protocols the
 *     model actually serves.
 *   - `stream`       builds the request for the model's protocol, sends it with
 *     the identity headers OpenCode asks for, and translates the SSE response
 *     into harness `StreamChunk` values.
 *
 * Two design decisions are worth stating up front, because both are load-bearing.
 *
 * **Protocol selection is per model.** OpenCode Go serves three wire protocols
 * and is strict about which model may use which: a model that only speaks
 * `/responses` answers `400 ModelProtocolUnsupported` on `/chat/completions`
 * rather than degrading, and vice versa. So every model carries an ordered
 * protocol list, and a request refused that way tries the next entry. The
 * measured mapping ships in `model/catalog.js`.
 *
 * **This adapter imports no harness package.** The harness identifies an
 * adapter's models, streams, and failures by their shape — `registerAdapter`
 * reads methods off the object, and adapter failures are normalized from own
 * `code`/`failure` data properties rather than by class identity. Depending on
 * a specific `@deepseek-ai/dsh-llm` version would therefore buy nothing and
 * cost installability, so the plugin defines the shapes itself. See
 * `error/errors.js`.
 *
 * @module dsh-opencode-go
 */

import {
  DEFAULT_BASE_URL,
  PROTOCOLS,
  PROTOCOL_LIST,
  Config as ConfigSchema,
  resolveConfig,
} from './config.js'
import { PLUGIN_IDENTITY, LlmError } from './error/errors.js'
import {
  CODES,
  malformed,
  refusedRequestError,
  transportError,
} from './error/mapping.js'
import { ModelCache } from './model/cache.js'
import { catalogModelInfo, supportsImages } from './model/capabilities.js'
import { buildCatalog, preferredProtocol } from './model/catalog.js'
import { ImageResolver, anthropicSourceFactory, dataUrlFactory } from './model/images.js'
import * as anthropic from './protocol/anthropic-messages.js'
import * as chat from './protocol/chat-completions.js'
import * as responses from './protocol/responses.js'
import { SESSION_HEADER, createSessionState, identityHeaders } from './session/headers.js'
import { advertisedEfforts } from './transform/reasoning.js'

/** Every protocol module, keyed by the protocol name requests select with. */
const TRANSPORTS = Object.freeze({
  [PROTOCOLS.CHAT]: chat,
  [PROTOCOLS.RESPONSES]: responses,
  [PROTOCOLS.ANTHROPIC]: anthropic,
})

/**
 * The adapter registered on one provider route.
 *
 * Every fact it reads is a thunk over the live plugin configuration, so a
 * configuration edit reaches the next request with no restart, while a request
 * already in flight keeps the facts it started with.
 *
 * The class deliberately does not extend `LlmAdapter`: see the module comment.
 * It implements the same method set, including the optional ones, so a
 * deployment that expects an `LlmAdapter` instance finds the same surface.
 */
export class OpenCodeGoAdapter {
  /**
   * @param {object} deps - injected collaborators.
   * @param {() => object} deps.options - the current resolved configuration.
   * @param {() => Promise<string>} deps.resolveApiKey - per-request credential.
   * @param {ModelCache} deps.cache - the model cache.
   * @param {() => object | undefined} deps.attachments - the mounted attachment seam.
   * @param {object} deps.logger - a Cordis-style logger.
   * @param {typeof fetch} [deps.fetch] - the fetch implementation, for tests.
   */
  constructor(deps) {
    this.deps = deps
    this.sessionState = createSessionState()
    /** Last-assembled catalog, reused across metadata queries. */
    this.catalog = new Map()
    this.catalogReady = false
  }

  /**
   * Describe the route for a provider selector.
   *
   * @param {string} provider - the registered route.
   * @returns {{id: string, name: string}} display metadata whose id equals the route.
   */
  providerInfo(provider) {
    return { id: provider, name: 'OpenCode Go' }
  }

  /**
   * The retry policy this route owns.
   *
   * The retry executor, not this adapter, re-runs a failed request, so this only
   * reports what the deployment configured.
   *
   * @param {string} _provider - the registered route.
   * @returns {object | undefined} a resolved policy, or undefined for the defaults.
   */
  providerRetryPolicy(_provider) {
    return this.deps.options().retryPolicy
  }

  /**
   * This route declares no image pricing.
   *
   * @returns {undefined} always undefined; the token meter uses its own estimate.
   */
  imageRequestPricing() {
    return undefined
  }

  /**
   * Discover the models this route advertises.
   *
   * @param {string} provider - the registered route.
   * @returns {Promise<readonly object[]>} catalog entries in adapter-preferred order.
   */
  async listModels(provider) {
    await this.#ensureCatalog()
    return [...this.catalog.values()].map((record) => catalogModelInfo(provider, record))
  }

  /**
   * Resolve one exact model's metadata.
   *
   * @param {string} provider - the registered route.
   * @param {string} model - the exact model id a request names.
   * @param {AbortSignal} [signal] - cancellation for the catalog lookup.
   * @returns {Promise<object>} resolved model metadata.
   */
  async resolveModel(provider, model, signal) {
    const record = await this.#record(model, signal)
    return this.#resolved(provider, record)
  }

  /**
   * Bind one model's metadata and its dispatch to a single adapter generation.
   *
   * @param {string} provider - the registered route.
   * @param {string} model - the exact model id.
   * @param {AbortSignal} [signal] - cancellation for the catalog lookup.
   * @returns {Promise<{model: object, stream: (options: object) => AsyncIterable<object>}>} the prepared call.
   */
  async prepareCall(provider, model, signal) {
    const config = this.deps.options()
    const record = await this.#record(model, signal)
    // The generation is bound here: a settings change between preparation and
    // dispatch must not combine one catalog's capabilities with another's.
    return {
      model: this.#resolved(provider, record),
      stream: (options) => this.#generate(options, config, record),
    }
  }

  /**
   * Stream one model call.
   *
   * @param {object} options - the full request; `options.provider` selects this route.
   * @returns {AsyncIterable<object>} harness stream chunks.
   */
  stream(options) {
    const config = this.deps.options()
    return (async function* dispatch(adapter) {
      const record = await adapter.#record(options.model, options.signal)
      yield* adapter.#generate(options, config, record)
    }(this))
  }

  /** Assemble the catalog once from discovery plus configuration. */
  async #ensureCatalog() {
    if (this.catalogReady) return
    const config = this.deps.options()
    try {
      const discovered = await this.deps.cache.discover()
      this.catalog = buildCatalog(config, discovered)
    } catch (error) {
      this.deps.logger?.warn?.(
        'dsh-opencode-go: model discovery failed, using the built-in catalog: %s',
        error?.message ?? String(error),
      )
      this.catalog = buildCatalog(config, [])
    }
    this.catalogReady = true
  }

  /** Resolve one record from the current catalog, falling back to a stub. */
  async #record(model, signal) {
    await this.#ensureCatalog()
    signal?.throwIfAborted()
    const known = this.catalog.get(model)
    if (known !== undefined) return known
    // An unlisted id is still routable: core routing does not require catalog
    // membership, and a model newer than the discovered list should work rather
    // than fail. It gets the default protocol first and then every other one,
    // because its protocol is exactly what is unknown about it.
    const config = this.deps.options()
    return {
      id: model,
      name: model,
      protocols: Object.freeze([
        config.defaultProtocol,
        ...PROTOCOL_LIST.filter((protocol) => protocol !== config.defaultProtocol),
      ]),
      inputModalities: undefined,
      contextWindow: config.defaultContextWindow,
      maxTokens: config.defaultMaxTokens,
      reasoning: undefined,
      reasoningEfforts: config.reasoningEfforts,
      defaultEffort: undefined,
      source: 'unlisted',
    }
  }

  /** One record as the harness's resolved-model metadata. */
  #resolved(provider, record) {
    const protocol = preferredProtocol(record)
    const config = this.deps.options()
    const imageCapable = supportsImages(record) && this.deps.attachments() !== undefined
    const info = {
      provider,
      id: record.id,
      name: record.name,
      context: { contextWindow: record.contextWindow },
      defaultMaxTokens: record.maxTokens,
      // Declaring `image` is what makes the runtime hand over real image blocks
      // instead of placeholders, so it is only declared when this adapter can
      // actually resolve their bytes.
      inputModalities: imageCapable
        ? Object.freeze(['text', 'image'])
        : Object.freeze(['text']),
    }
    if (record.reasoning === true) {
      // The runtime validates a requested effort against this set before any
      // network I/O, so it may only list levels this protocol can express.
      const declared = record.reasoningEfforts
      const allowed = advertisedEfforts(
        protocol,
        Array.isArray(declared) && declared.length > 0 ? declared : config.reasoningEfforts,
      )
      if (allowed.length > 0) {
        info.reasoning = {
          efforts: allowed.map((level) => ({ id: level, name: level })),
          ...(record.defaultEffort === undefined || !allowed.includes(record.defaultEffort)
            ? {}
            : { defaultEffort: record.defaultEffort }),
        }
      }
    }
    return info
  }

  /**
   * Stream one model call, trying each protocol the model declares.
   *
   * A refusal that says the model does not serve the protocol moves to the next
   * one; any other failure, and any failure after chunks have been produced, is
   * terminal — a partially consumed stream cannot be restarted behind the
   * caller's back.
   */
  async *#generate(options, config, record) {
    const attempts = orderAttempts(record, config)
    let protocolUnsupported
    for (const protocol of attempts) {
      const transport = TRANSPORTS[protocol]
      if (transport === undefined) continue
      try {
        yield* this.#attempt(options, config, record, protocol, transport)
        return
      } catch (error) {
        if (error?.code !== CODES.PROTOCOL_UNSUPPORTED) throw error
        protocolUnsupported = error
        this.deps.logger?.info?.(
          'dsh-opencode-go: model "%s" does not serve %s; trying the next protocol',
          record.id,
          protocol,
        )
      }
    }
    throw protocolUnsupported ?? new LlmError(
      `opencode-go: model "${record.id}" has no usable protocol`,
      CODES.PROTOCOL_UNSUPPORTED,
    )
  }

  /** One protocol attempt, start to finish. */
  async *#attempt(options, config, record, protocol, transport) {
    const signal = options.signal
    signal?.throwIfAborted()

    // A deadline covers connection and response headers; the idle watchdog
    // covers the stream, so a long generation is not cut off by a total cap.
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error('deadline')), config.timeoutMs)
    const combined = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal])

    let started = false
    try {
      const attachments = this.deps.attachments()
      const resolver = supportsImages(record) && attachments !== undefined
        ? new ImageResolver({ attachments, signal: combined })
        : undefined
      const apiKey = await this.deps.resolveApiKey()
      const wire = await transport.prepare({
        request: options,
        model: record,
        effort: options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
        replayReasoning: !config.disableReasoningReplay,
        signatures: signaturesFromHistory(options.messages),
        images: resolver !== undefined,
        imageUrl: resolver === undefined ? undefined : dataUrlFactory(resolver),
        imageSource: resolver === undefined ? undefined : anthropicSourceFactory(resolver),
      })

      const response = await this.#fetch(`${config.baseURL}${transport.PATH}`, {
        method: 'POST',
        headers: requestHeaders({
          config,
          sessionState: this.sessionState,
          sessionId: options.sessionId,
          protocol,
          apiKey,
        }),
        body: JSON.stringify(wire.body),
        redirect: 'error',
        signal: combined,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        let raw
        try {
          raw = JSON.parse(text)
        } catch {
          raw = undefined
        }
        throw refusedRequestError({
          provider: options.provider,
          model: record.id,
          protocol,
          status: response.status,
          headers: response.headers,
          text,
          raw,
        })
      }
      if (response.body === null) {
        throw new LlmError(`opencode-go: ${protocol} returned no response body`, CODES.EMPTY_RESPONSE)
      }

      started = true
      yield* this.#pump(response.body, transport, { model: record.id, protocol, config, signal: combined })
    } catch (error) {
      if (isLlmFailure(error)) throw error
      if (started) {
        // Mid-stream failure: the request was accepted, so a transport error
        // would misreport what happened.
        throw malformed(protocol, error?.message ?? String(error))
      }
      throw transportError({ protocol, error, signal, deadline: deadline.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Consume one accepted response, enforcing the idle budget between reads.
   *
   * The watchdog aborts the request rather than the read, so a provider that
   * stops sending is torn down instead of left holding a socket.
   */
  async *#pump(body, transport, input) {
    const { model, protocol, config, signal } = input
    const controller = new AbortController()
    const idle = new Error('idle')
    let timer
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(idle), config.streamIdleTimeoutMs)
    }
    const streamingSignal = AbortSignal.any([signal, controller.signal])
    arm()
    try {
      for await (const chunk of transport.translate({
        body,
        model,
        signal: streamingSignal,
        activity: arm,
      })) {
        yield chunk
      }
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason === idle) {
        throw new LlmError(
          `opencode-go: ${protocol} stream was idle for more than ${config.streamIdleTimeoutMs} ms`,
          CODES.TIMEOUT,
          { cause: error },
        )
      }
      if (isLlmFailure(error)) throw error
      throw transportError({ protocol, error, signal })
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  /** The fetch implementation, resolved once per attempt. */
  #fetch(url, init) {
    const implementation = this.deps.fetch ?? globalThis.fetch
    if (typeof implementation !== 'function') {
      throw new LlmError('opencode-go: globalThis.fetch is unavailable', CODES.TRANSPORT)
    }
    return implementation(url, init)
  }
}

/**
 * Whether a thrown value is one of this adapter's own classified failures.
 *
 * Read from the data property rather than `instanceof`, because the harness
 * reads it the same way and a second module instance must not change the answer.
 *
 * @param {unknown} error - the thrown value.
 * @returns {boolean} true when it carries a non-empty `code` and a `failure`.
 */
function isLlmFailure(error) {
  return error !== null
    && typeof error === 'object'
    && typeof error.code === 'string'
    && error.code !== ''
    && typeof error.failure === 'object'
}

/**
 * The protocol order one request tries.
 *
 * The catalog's own preference first, then the remaining declared protocols,
 * then — only for a model the catalog does not describe — every other protocol,
 * because an unlisted id is exactly the case where its protocol is unknown.
 *
 * @param {object} record - a catalog record.
 * @param {object} config - the resolved configuration.
 * @returns {string[]} the protocols to attempt, most preferred first.
 */
export function orderAttempts(record, config) {
  const declared = Array.isArray(record?.protocols) ? record.protocols : []
  const ordered = [...new Set(declared.filter((protocol) => TRANSPORTS[protocol] !== undefined))]
  if (record?.source === 'unlisted') {
    for (const protocol of PROTOCOL_LIST) {
      if (!ordered.includes(protocol)) ordered.push(protocol)
    }
  }
  if (ordered.length === 0) ordered.push(config.defaultProtocol)
  return ordered
}

/**
 * Per-request headers.
 *
 * The plugin's product token prefixes the same `User-Agent` the harness
 * attribution would use rather than replacing it, so both identities stay
 * truthful and OpenCode's client-identity guidance is met. The protocol then
 * contributes its own auth, and the session and client headers follow.
 */
function requestHeaders(input) {
  const { config, sessionState, sessionId, protocol, apiKey } = input
  const identity = identityHeaders(config, sessionState, config.userAgent, sessionId)
  const auth = protocol === PROTOCOLS.ANTHROPIC
    ? anthropic.authHeaders(apiKey)
    : { authorization: `Bearer ${apiKey}` }
  return {
    'content-type': 'application/json',
    ...auth,
    ...identity,
  }
}

/**
 * The reasoning signatures a request may replay, keyed by reasoning text.
 *
 * An assistant message's `replayState.blocks` sits parallel to its content
 * blocks, so the two arrays are walked together. Only entries that actually
 * carry a signature are kept; the Messages converter degrades a reasoning block
 * with no signature to plain text instead of sending something the API refuses.
 *
 * @param {readonly object[]} messages - the request's messages.
 * @returns {Record<string, string>} reasoning text to provider signature.
 */
export function signaturesFromHistory(messages) {
  const out = {}
  for (const message of messages ?? []) {
    if (message?.role !== 'assistant') continue
    const blocks = message?.source?.replayState?.blocks
    if (!Array.isArray(blocks)) continue
    const content = message.content ?? []
    for (let index = 0; index < content.length && index < blocks.length; index += 1) {
      if (content[index]?.type !== 'reasoning') continue
      const signature = blocks[index]?.signature
      const text = content[index].text
      if (typeof signature === 'string' && signature !== '' && typeof text === 'string' && text !== '') {
        out[text] = signature
      }
    }
  }
  return out
}

/**
 * Resolve this route's credential for one request.
 *
 * The reference is resolved per request through the credential seam, so a key
 * changed through the Models page reaches the next call with no restart. A
 * deployment with no credential seam falls back to the process environment.
 * Neither message ever contains any part of the secret.
 */
function credentialResolver(ctx, getConfig) {
  return async () => {
    const config = getConfig()
    const ref = config.apiKeyEnv
    const credentials = ctx.get('credentials')
    let raw
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      raw = hit?.value
    } else {
      raw = process.env[ref]
    }
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      throw new LlmError(
        `dsh-opencode-go: no API key for provider route "${config.provider}";`
        + ` store ${ref} through the credentials service (the web Models page writes it),`
        + ` or export ${ref} in the launching environment`,
        CODES.MISSING_CREDENTIAL,
      )
    }
    const value = String(raw).trim()
    // A key that cannot ride in an HTTP header fails here, naming the setting to
    // fix, instead of surfacing as an opaque fetch error.
    if (!/^[\x21-\x7e]+$/.test(value)) {
      throw new LlmError(
        `dsh-opencode-go: the API key resolved from ${ref} contains characters no HTTP header can carry;`
        + ` set ${ref} to the raw key alone`,
        CODES.INVALID_CREDENTIAL,
      )
    }
    return value
  }
}

/**
 * The Cordis plugin body.
 *
 * @param {object} ctx - the plugin context.
 * @param {unknown} rawConfig - the loader row's `config`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger ?? console

  const resolveApiKey = credentialResolver(ctx, () => config)
  const cache = new ModelCache(config, {
    authHeaders: async () => ({ authorization: `Bearer ${await resolveApiKey()}` }),
    logger,
  })

  const adapter = new OpenCodeGoAdapter({
    options: () => config,
    resolveApiKey,
    cache,
    attachments: () => ctx.get('attachments'),
    logger,
  })

  // Registering inside an effect ties the route to this plugin's fiber, so an
  // unload or reload releases it instead of leaving a dangling adapter.
  ctx.effect(() => ctx.llm.registerAdapter([config.provider], adapter))

  logger.info(
    'dsh-opencode-go: provider "%s" ready at %s (credential %s, models %s)',
    config.provider,
    config.baseURL,
    config.apiKeyEnv,
    config.modelSource,
  )
  if (config.baseURL !== DEFAULT_BASE_URL) {
    logger.info('dsh-opencode-go: using a baseURL other than the OpenCode Go default')
  }
  if (config.sessionHeader === 'off') {
    logger.warn(
      'dsh-opencode-go: %s is disabled; OpenCode may refuse requests or lose prompt-cache affinity',
      SESSION_HEADER,
    )
  }
  if (config.healthCheck === 'startup') {
    void runHealthCheck(adapter, config, logger)
  }
}

/**
 * Verify the credential, the catalog, and each listed model's metadata.
 *
 * A desktop-friendly "test connection" step: it proves the key resolves, that
 * `GET /models` answers, and that every catalog entry resolves a context
 * window — without spending a completion.
 *
 * @param {OpenCodeGoAdapter} adapter - the registered adapter.
 * @param {object} config - the resolved configuration.
 * @param {object} logger - a Cordis-style logger.
 * @returns {Promise<object>} the report, also logged.
 */
export async function runHealthCheck(adapter, config, logger) {
  const report = { provider: config.provider, baseURL: config.baseURL, ok: false, steps: [] }
  try {
    const models = await adapter.listModels(config.provider)
    report.steps.push({ step: 'models', ok: true, count: models.length, ids: models.map((info) => info.id) })
    const unusable = []
    for (const info of models) {
      const resolved = await adapter.resolveModel(config.provider, info.id, undefined)
      if (resolved?.context?.contextWindow === undefined) unusable.push(info.id)
    }
    report.steps.push({ step: 'catalog', ok: unusable.length === 0, unusable })
    report.ok = unusable.length === 0
  } catch (error) {
    report.steps.push({ step: 'models', ok: false, error: error?.message ?? String(error) })
  }
  logger.info('dsh-opencode-go: health check %s', JSON.stringify(report))
  return report
}

export const name = 'dsh-opencode-go'

/**
 * Activate only once the abstract `llm` service exists: the adapter registers
 * onto it. The credentials and attachments services are looked up lazily, so a
 * deployment that mounts neither still works — through the process environment,
 * and with image input correctly reported as unavailable.
 */
export const inject = ['llm']

export const Config = ConfigSchema

export { PLUGIN_IDENTITY }

export default { name, inject, Config, apply }
