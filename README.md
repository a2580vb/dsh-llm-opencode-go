# dsh-opencode-go

**English** | [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin that serves **OpenCode Go** (`https://opencode.ai/zen/go/v1`) as a native
DSH model provider.

It is a complete LLM adapter, not a proxy: it owns the wire for all three
protocols OpenCode Go serves, translates harness messages, tools, and reasoning
into each one, and translates the streamed response back into DSH
`StreamChunk` values.

```yaml
- insert:
    - id: opencode-go
      name: dsh-opencode-go
      config:
        apiKeyEnv: OPENCODE_GO_API_KEY
```

That is the whole required configuration. The API key value never enters the
config file: `apiKeyEnv` names a **credential reference** resolved through the
harness credential seam on every request, so a key written by the web Models
page reaches the next call with no restart.

## What it does

| | |
|---|---|
| **Provider route** | `opencode-go` (configurable) |
| **Protocols** | OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages |
| **Model discovery** | `GET /models`, with a memory + on-disk cache |
| **Session affinity** | `x-opencode-session`, one stable id per conversation |
| **Tool calling** | Full round trip for every dispatched call: definitions, fragmented arguments, tool results, follow-up turn |
| **Reasoning** | Per-protocol effort mapping, including Anthropic thinking budgets |
| **Streaming** | SSE → `StreamChunk`, with usage, finish reason, and an idle watchdog |
| **Failures** | Stable provider-neutral codes (`AUTH`, `RATE_LIMIT`, `QUOTA`, `CONTEXT_WINDOW_EXCEEDED`, …) |
| **Runtime dependencies** | none |

## Install

From this checkout:

```sh
dsh plugin --profile desktop add L:\e2\dsh-plugin\opencodego-transfrom
```

Then **fully restart** the profile: bundle layers are read at startup. Verify the
startup log:

```
dsh-opencode-go: provider "opencode-go" ready at https://opencode.ai/zen/go/v1 (credential OPENCODE_GO_API_KEY, models discover)
```

### Give it a key

Either export `OPENCODE_GO_API_KEY` in the environment that launches DSH, or
store it through the credentials seam — the web Models page writes it. The
plugin resolves the reference per request, so both work and neither requires a
restart.

If you would rather the plugin read a differently-named variable, point
`apiKeyEnv` at it:

```yaml
config:
  apiKeyEnv: OC_KEY
```

The value is never read from the config file itself, only the variable *name*.

## Why protocol selection is per model

OpenCode Go serves three wire protocols and is **strict** about which model may
use which. A model that only speaks `/responses` does not degrade onto
`/chat/completions`; it answers:

```json
{"type":"error","error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}
```

So every model carries an ordered protocol list rather than one global endpoint
choice. When a request is refused that way, the adapter logs it and retries the
same call over the model's next protocol. Measured against the live service:

| Models | Protocols served |
|---|---|
| `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4.1-flash`, `deepseek-flash`, `deepseek-v4-flash-vision-exp` | responses, chat-completions, anthropic |
| `gpt-6-luna`, `gpt-5.6-luna`, `grok-4.7`, `grok-4.6` | responses |
| `minimax-m2.7` | anthropic |
| `minimax-m3`, `kimi-k3`, `qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-plus`, `space-bunny-free` | chat-completions, anthropic |
| `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `kimi-k2.7-code`, `mimo-*`, `longcat-*`, `hy3`, `hy4-preview` | chat-completions |
| `muse-spark-1.*-contributor` | listed, but refused for a non-contributor account |

Preference order is responses → chat-completions → anthropic. Pin a different
one with `protocolOverrides`:

```yaml
config:
  protocolOverrides:
    deepseek-v4-flash: chat-completions
```

A model the catalog does not describe is handled by how unknown it actually is.
An id the service lists but this plugin has never measured is recorded with the
default protocol alone, because the service naming it is a fact this plugin
lacks. An id that appears **nowhere** — new enough that even `GET /models` has
not caught up, or reached through a gateway with no discovery — is the one case
where the protocol is genuinely unknown, so it tries every protocol in order.
You never have to wait for a plugin release to use a new model.

## Configuration

Every key is optional. Run `dsh --profile <name> --dump-config` for the composed
view, or read `Config` from the plugin for the authoritative list.

| Field | Default | Meaning |
|---|---|---|
| `provider` | `opencode-go` | Route name requests select with `GenerateOptions.provider` |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | Credential **reference**, resolved per request |
| `baseURL` | `https://opencode.ai/zen/go/v1` | API root; a compatible gateway needs only this |
| `userAgentProduct` | `dsh-opencode-go` | Product token leading the `User-Agent` |
| `attribution` | absent | Extra product token appended to the `User-Agent`, e.g. `deepseek-harness/0.2.0` |
| `timeoutMs` | `600000` | Deadline for connect + response headers |
| `streamIdleTimeoutMs` | `300000` | Maximum provider idle time between stream reads |
| `modelSource` | `discover` | `discover` = `GET /models` + built-in fallback; `config` = the `models` list alone |
| `modelsCacheSeconds` | `21600` | Discovered-catalog lifetime |
| `modelsCachePath` | `~/.dsh/cache/opencode-go-models.json` | Cache file; an unwritable path only warns |
| `models` | `[]` | Advisory catalog entries; the whole catalog when `modelSource: config` |
| `modelOverrides` | `{}` | Reshape one catalog model without restating the rest |
| `protocolOverrides` | `{}` | `{"<model id>": "<protocol>"}` shorthand |
| `defaultProtocol` | `chat-completions` | Protocol for an entry that names none |
| `defaultContextWindow` | `262144` | Capacity fallback for an undescribed model |
| `defaultMaxTokens` | `32768` | Output-cap fallback for an undescribed model |
| `reasoningEfforts` | `[minimal, low, medium, high, max]` | Selectable thinking levels; narrowed per protocol |
| `sessionHeader` | `session-id` | `session-id` \| `uuid` \| `off` |
| `sendClientHeader` | `true` | Send `x-opencode-client` |
| `disableReasoningReplay` | `false` | Stop sending prior reasoning back (see [Reasoning](#reasoning)) |
| `healthCheck` | `off` | `startup` logs a credential + catalog report |
| `retryPolicy` | normal, 5 retries | Provider-owned policy the retry executor applies |

### Shaping the catalog

`models` entries **replace** the catalog record for the ids they name in
`discover` mode, so an entry is the whole truth about that model: a field it does
not state comes from the top-level defaults rather than from the measured record.
A `models` entry for `gpt-5.6-luna` that names only its `contextWindow` therefore
loses the measured `[responses]` protocol list and its `reasoning: true` flag
unless it restates them. `modelOverrides` is the merging counterpart — it changes
the fields it names on the existing record and leaves everything else intact:

```yaml
config:
  models:
    - id: glm-5.3
      name: GLM 5.3
      contextWindow: 200000
      maxTokens: 131072
      reasoning: true
      efforts: [low, medium, high]
```

With `modelSource: config`, `models` becomes the entire catalog and `GET /models`
is never called — the right posture for a compatible gateway.

### Image input

Image input is **off** for every model by default, and the plugin's resolved
`inputModalities` says so. That is not an oversight: a durable `ImageBlock`
carries an attachment *reference*, and turning it into request bytes needs the
mounted `attachments` service. Declaring `image` for a model on a deployment
that cannot resolve it would fail every request that contained a picture.

To enable it for a model that really accepts images:

```yaml
config:
  modelOverrides:
    deepseek-v4-flash-vision-exp:
      input: [text, image]
```

The adapter then resolves each occurrence through the attachment seam; if no
attachment provider is mounted, `inputModalities` still reports text-only, so
the request path and the declared capability cannot disagree.

## Endpoints and auth

| Protocol | Path | Auth |
|---|---|---|
| Chat Completions | `POST {baseURL}/chat/completions` | `Authorization: Bearer <key>` |
| Responses | `POST {baseURL}/responses` | `Authorization: Bearer <key>` |
| Messages | `POST {baseURL}/messages` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |

The Messages endpoint refuses a bearer token with `AuthError: Missing API key`;
that is why it has its own header set rather than inheriting the shared one.

Every request also carries:

```http
User-Agent: dsh-opencode-go/0.1.0
x-opencode-session: <stable per-conversation id>
x-opencode-client: dsh-opencode-go
```

## `x-opencode-session`

OpenCode's relay pins every request sharing one `x-opencode-session` value to
the same upstream backend, which is what keeps its prompt cache warm across the
turns of a conversation. The value only has to be opaque and stable **per
conversation** — a single fixed value would put every session on one shared
cache lineage, so this plugin derives it from the DSH session id that already
travels with each call.

- `session-id` (default) — the DSH session id: unique per conversation, stable
  across turns, compaction, retries, and process restarts.
- `uuid` — an opaque random UUID derived once per session id and remembered for
  the process, for deployments that would rather not send the harness id.
- `off` — send nothing. The plugin warns at startup, because OpenCode may then
  refuse the request or lose cache affinity.

An auxiliary call with no session id (session-title generation) still gets a
per-process fallback value rather than an absent header.

## Reasoning

Each protocol spells thinking differently, and the relay validates the spelling,
so one function owns the translation:

| Protocol | Field | Accepted levels |
|---|---|---|
| Chat Completions | `reasoning_effort` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| Responses | `reasoning.effort` | `low`, `medium`, `high`, `xhigh`, `max` (`minimal` is refused) |
| Messages | `thinking.budget_tokens` | mapped from the level: 1024 / 4096 / 8192 / 16384 / 32768 / 64000 |

A model's resolved metadata advertises only the levels its protocol can express,
because the runtime validates a requested effort against that set before any
network I/O. The Anthropic budget is clamped strictly below `max_tokens`; if the
output cap cannot hold even the smallest budget, thinking is omitted rather than
sent as a request the API would reject.

Reasoning **history** is replayed where the protocol supports it: Chat
Completions takes `reasoning_content` back, and Messages takes thinking blocks
with the signature the provider issued (addressed by the block's exact text, and
degraded to plain text when no signature was retained). The Responses API takes
none, because a reasoning item is validated against upstream state the harness
does not retain. Set `disableReasoningReplay: true` to send no reasoning history
on any protocol.

## Tool calling

Tools cross the wire in each protocol's own spelling — flat declarations with a
`function_call`/`function_call_output` pair on Responses, the `function` wrapper
with `tool_calls` and `role: "tool"` on Chat Completions, `tool_use`/`tool_result`
blocks on Messages — and a conversation is replayed the same way it was answered.

One rule governs all three translations, because all three wires enforce it: **a
call and its result are sent together or not at all.** The Responses API answers
an unanswered call with `400 No tool output found for tool call <id>`, Chat
Completions requires the turn after an assistant's `tool_calls` to answer every
id it issued, and Messages refuses a `tool_use` block with no `tool_result`. A
history can hold a call with no result — the harness records the model's
`tool-call`, and a process that stops before dispatch never appends one — so the
converters survey the whole history before emitting anything and omit the half
that has no partner. See [Limits](#limits).

## Failures

Stable codes, so consumers route on the code and never on message text:

`AUTH` · `QUOTA` · `RATE_LIMIT` · `CONTEXT_WINDOW_EXCEEDED` · `INVALID_REQUEST`
· `SERVER` · `TRANSPORT` · `ABORTED` · `TIMEOUT` · `MALFORMED_RESPONSE` ·
`STREAM_CLOSED` · `EMPTY_RESPONSE` · `UNSUPPORTED_CONTENT` · `UNSUPPORTED_OPTION`
· `PROTOCOL_UNSUPPORTED` · `MISSING_CREDENTIAL` · `INVALID_CREDENTIAL`

A credential that does not resolve fails before any network I/O with
`MISSING_CREDENTIAL`, and one that cannot ride in an HTTP header fails with
`INVALID_CREDENTIAL`; neither message contains any part of the secret.

An adapter failure is reported by the **shape** the harness reads — an `Error`
with own `code` and `failure` data properties — not by class identity. That is
why this plugin can define its own failure type and depend on no harness
package: a cross-package copy of the harness class would never be recognized by
`instanceof` in the harness anyway.

## Verify it

```sh
npm test          # 117 offline checks: config, SSE framing, catalog, all three protocols, adapter, plugin body
npm run test:cordis # 20 checks mounting the plugin on the harness's own cordis
npm run test:live # 16 checks against the real service; needs OC_KEY
```

`npm test` runs offline and needs no credential. The protocol suites replay
response bodies **captured from the live service** (`tests/golden/`), so they
fail if a translator stops agreeing with what OpenCode Go actually sends. Every
case assembles its chunks with the harness's own block assembler, which is the
same code the agent loop runs over them.

`npm run test:live` spends real quota. It proves, against the live relay: model
discovery and caching, a round trip over each of the three protocols, a full
tool-calling round trip per protocol, protocol fallback recovery, cache reuse on
a repeated session id, a history holding a tool call that was never dispatched,
and that every advertised reasoning effort is accepted.

```sh
OC_KEY=oc_sk_... npm run test:live
# optional: OC_BASE, OC_CACHE to keep the discovery cache out of ~/.dsh
```

`npm run test:cordis` is the one that catches loader-level mistakes. It reads
the harness's own packages out of `app.asar`, mounts the plugin on the **real**
cordis the installation ships, and checks that activation produces no warning,
that the route registers on the real LLM runtime, that models and reasoning
efforts resolve through it, that a streamed call completes end to end, and that
unloading releases the route. Set `DSH_ASAR` if the installation lives
elsewhere; the suite skips cleanly when it cannot find one.

That suite exists because a plugin's exported `Config` is not free-form: cordis
calls `Config['~standard'].validate(raw)` before starting the plugin, so a
plain object there fails activation with
`Cannot read properties of undefined (reading 'validate')`. Nothing in an
isolated unit test would have caught that.

## Limits

- **Protocol capability is measured, not published.** OpenCode Go's `/models`
  response lists ids only, so the mapping in `lib/model/catalog.js` comes from
  probing the live service. A model whose protocol changes needs a
  `protocolOverrides` entry or a new plugin version. The two unknown cases differ
  in how much is unknown: an id the service *lists* but this plugin has not
  measured gets `defaultProtocol` and no fallback, while an id that appears
  nowhere — not in the built-in catalog and not in the discovered list — is tried
  over every protocol, because its protocol is exactly what is missing.
- **Context windows and output caps are fallbacks.** The service does not
  publish them, so `defaultContextWindow` and `defaultMaxTokens` are assumed
  unless a `models` entry corrects them. The two reach the wire differently:
  Messages always sends a cap (`max_tokens`, falling back to the model's value),
  while Chat Completions and Responses omit theirs when the call states none, so
  the decision there belongs to the relay rather than to this plugin.
- **Reasoning is not replayed to the Responses API.** A reasoning item is
  validated against upstream state the harness does not retain, and a mismatch
  is an opaque `400`, so prior thinking is dropped from that protocol's requests
  rather than sent and refused at random. The Messages protocol does replay
  thinking blocks, using the signature the provider issued.
- **A tool call the history cannot answer is dropped, not sent.** An assistant
  message can record a `tool-call` that was never dispatched — the process
  stopped between the model's answer and the tool starting — so no result exists
  to replay. Every protocol refuses that half-pair: the Responses API answers
  `400 No tool output found for tool call <id>` and Messages refuses a `tool_use`
  block that no `tool_result` follows. The converters therefore omit a call whose
  result is missing from the request, and a result whose call is missing with it,
  because sending either alone fails the whole turn and neither can be
  reconstructed. A history hole costs that one call its place in the transcript;
  it no longer costs the session.
- **Image input is opt-in per model** — see above.
- **`stop` is forwarded as-is.** Whether a given model honours stop sequences is
  the model's business; the plugin does not claim otherwise.
- **One route per mount.** Mounting the plugin twice needs two `provider` names
  and two API keys.

## Layout

```
lib/
├── index.js                  adapter class, registration, health check
├── config.js                 schema, defaults, validation
├── error/
│   ├── errors.js             the failure type and brand helpers this plugin owns
│   └── mapping.js            HTTP status / transport failure → stable code
├── model/
│   ├── catalog.js            the measured protocol map and record merging
│   ├── cache.js              GET /models, memory + on-disk cache
│   ├── capabilities.js       records → harness model metadata
│   └── images.js             durable references → request bytes
├── protocol/
│   ├── shared.js             block accumulation and terminal sequencing
│   ├── chat-completions.js
│   ├── responses.js
│   └── anthropic-messages.js
├── session/headers.js        x-opencode-session and request identity
├── stream/sse.js             byte-level SSE framing
└── transform/
    ├── messages.js           content blocks → each protocol's messages
    ├── tools.js              tool schemas → each protocol's declarations
    └── reasoning.js          harness effort → each protocol's spelling
```

Adding a fourth protocol means one new file under `protocol/` and one entry in
the transport map — not a rewrite.

## License

MIT
