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
same call over the model's next protocol. Measured against the live service,
model by model:

| Models | Protocols served |
|---|---|
| `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4.1-flash`, `deepseek-flash`, `deepseek-v4-flash-vision-exp` | responses, chat-completions, anthropic |
| `gpt-6-luna`, `gpt-5.6-luna`, `grok-4.7`, `grok-4.6` | responses |
| `minimax-m2.7` | anthropic |
| `minimax-m2.5`, `minimax-m3`, `kimi-k3`, `qwen3.6-plus`, `qwen3.7-max`, `qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-plus`, `space-bunny-free` | chat-completions, anthropic |
| `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `glm-5.1`, `kimi-k2.7-code`, `kimi-k2.6`, `mimo-v2.6-pro`, `mimo-v2.6-flash`, `mimo-v2.5-pro`, `mimo-v2.5`, `longcat-*`, `hy3`, `hy4-preview`, `omen-alpha` | chat-completions |
| `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor` | responses, and only while the workspace allows providers that train on request data (see [below](#models-that-train-on-request-data)) |

Every id `GET /models` returns has a row in that table, so no served model has to
discover its own protocol by failing first. Re-measure after a service change
with the probe described in [Verify it](#verify-it).

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

## Models that train on request data

Two Go models — `muse-spark-1.3-contributor` and `muse-spark-1.2-contributor` —
are cheap under a data policy rather than a price: their provider uses prompts and
completions to train future models. The relay therefore gates them on a
**workspace** setting and refuses the call before the model is reached:

```json
{"type":"error","error":{"type":"DataPolicyError","message":"This model collects data used to improve its quality and requires explicit opt in: https://opencode.ai/workspace/<workspace>/go"}}
```

Deployments that surface the refusal from the upstream service answer the same
thing as `400` with an `Account.TrainingNotAllowed` code and the sentence "This Go
model trains on request data…"; both spellings are recognized. Until an admin
enables **Allow models that train on request data**, every call to those ids fails
— here and in OpenCode itself. The switch lives on the workspace's Go page
(`https://opencode.ai/workspace` → the workspace → Go → Providers); on console
builds that hide it from the sidebar, `…/settings/privacy` still reaches it.

Three consequences shape what this adapter does, and none of them is "ask the
service again":

- **The refusal is named, not generalized.** It is reported as
  `TRAINING_CONSENT_REQUIRED`, carrying the setting to enable and where to enable
  it, instead of as `INVALID_REQUEST` (nothing about the request is wrong) or
  `AUTH` (the credential is fine). No other protocol is tried: the gate is an
  account policy, so a second request cannot answer differently.
- **The model states what it needs while it is still being chosen.** A gated model
  carries the note in its listing and in its resolved metadata, so a selector can
  show the requirement before the first call rather than after a refused one.
- **This plugin never grants the consent itself.** Whether prompts may train a
  third party's model is the workspace owner's decision, so no header, body field,
  or config switch here flips it; the adapter only reports it. It does log the
  gated models once, when the catalog is assembled — earlier than the first
  refusal.

A deployment that cannot enable the setting — a workspace in a region the model is
not offered in, or one route shared by several accounts — can keep those ids out
of the model list:

```yaml
config:
  hideTrainingModels: true
```

Hiding is a listing decision, not a routing one: the ids still resolve and still
stream, so a session already using one keeps working and enabling the setting
later needs no plugin change.

## Capacity and modalities

`GET /models` publishes ids only:

```json
{"id":"deepseek-v4.1-flash","object":"model","created":1790899718,"owned_by":"opencode"}
```

No context window, no output cap, no modalities. The figures do exist, on the
catalogue OpenCode itself ships (`models.dev`), so `lib/model/limits.js` carries
them as a **snapshot** rather than fetching them per request: a call that needs a
context window must not wait on a third-party endpoint, and a deployment with no
egress must still show real limits. Every resolved model reports its own:

| Model | Context | Output cap | Model input |
|---|---|---|---|
| `deepseek-v4.1-flash` | 1,000,000 | 384,000 | text, image |
| `gpt-5.6-luna` | 1,050,000 | 128,000 | text, image, pdf |
| `grok-4.7` | 500,000 | 500,000 | text, image, pdf |
| `minimax-m2.7` | 204,800 | 131,072 | text |
| `kimi-k2.7-code` | 262,144 | 262,144 | text, image, video |
| `mimo-v2.6-pro` | 1,048,576 | 131,072 | text, image, audio, video |
| `hy3` | 256,000 | 128,000 | text |

A model the snapshot has never heard of — one released after it was taken — is
matched to its family's measured figures (`qwen…`, `glm-…`, `grok-…`, …) before
falling back to `defaultContextWindow`. A model reached through a gateway that
publishes its own capacity is read from the wire; see
[Shaping the catalog](#shaping-the-catalog).

### Modalities: what the model takes versus what a route can send

The catalogue lists abilities no wire protocol here has a field for — `video`,
`audio`, `pdf` — so two facts are kept apart:

- **`providerModalities`** is the catalogue's own list, kept whole.
- **`inputModalities`** is what this adapter can actually put in a request. The
  harness models two and this adapter has a wire for two, so the resolved model
  declares `['text']` or `['text', 'image']`.

The split is not cosmetic. The harness projects durable image blocks on the
strength of the resolved list: a route that declares `image` is handed real image
blocks and must resolve their bytes, while one that does not gets a text
placeholder. A model whose abilities this route cannot carry therefore carries a
note saying so:

```
"description": "the model also accepts video, audio, which no protocol on this route can send"
```

`sendImages` decides whether image bytes are attempted at all:

| Value | Effect |
|---|---|
| `auto` (default) | Declare `image` for a vision model **when this deployment can resolve image bytes** — that is, when the attachment seam is mounted. Otherwise report text-only, and say what was left out. |
| `always` | Declare `image` for every model whose catalogue entry takes images, mounted seam or not. A request that then contains an image fails with the reason instead of silently sending text. |
| `off` | Never declare `image`. |

Set it to `always` if your deployment mounts images somewhere other than the
attachment seam:

```yaml
config:
  sendImages: always
```

All three protocols carry images once declared: Chat Completions and Responses
receive a `data:` URL part, Messages receives a base64 `source`. That is measured
against the live service, not assumed — see [Verify it](#verify-it).

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
| `defaultContextWindow` | `262144` | Capacity used when neither the measured table nor a family names the model |
| `defaultMaxTokens` | `32768` | Output cap under the same condition |
| `reasoningEfforts` | `[minimal, low, medium, high, max]` | Selectable thinking levels; narrowed per protocol |
| `sessionHeader` | `session-id` | `session-id` \| `uuid` \| `off` |
| `sendClientHeader` | `true` | Send `x-opencode-client` |
| `sendImages` | `auto` | `auto` \| `always` \| `off` — whether image bytes are attempted (see [Modalities](#modalities-what-the-model-takes-versus-what-a-route-can-send)) |
| `disableReasoningReplay` | `false` | Stop sending prior reasoning back (see [Reasoning](#reasoning)) |
| `hideTrainingModels` | `false` | Keep models whose provider trains on request data out of the listing (see [Models that train on request data](#models-that-train-on-request-data)) |
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

An entry may also paste a catalogue record verbatim: `limit: { context, output }`
is accepted as a synonym for `contextWindow` / `maxTokens`, and
`modalities: { input: [...] }` (or a bare `modalities: [...]`) records the
provider's own list. Only `text` and `image` mean anything to this adapter, so a
pasted list is kept whole while the sendable subset is what gets declared.

With `modelSource: config`, `models` becomes the entire catalog and `GET /models`
is never called — the right posture for a compatible gateway.

### Image input

Image input follows the model. A vision model in the [capacity
table](#capacity-and-modalities) declares `image`, and the adapter resolves each
occurrence through the mounted attachment seam into a request part: a `data:` URL
for Chat Completions and Responses, a base64 source for Messages.

That declaration is deliberately conditional on the deployment — see
`sendImages` above. A durable `ImageBlock` carries an attachment *reference*, and
turning it into request bytes needs the `attachments` service, so a route that
cannot resolve one reports text-only rather than declaring a capability it would
fail to honour. The provider's own list is never lost: the resolved description
names whatever the route cannot send.

Override either half per model:

```yaml
config:
  modelOverrides:
    # Force image input on a model the catalogue does not describe.
    my-vision-model:
      input: [text, image]
    # Record the provider's list for a model, without declaring image support.
    some-model:
      modalities: { input: [text, image, video] }
```

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
· `PROTOCOL_UNSUPPORTED` · `TRAINING_CONSENT_REQUIRED` · `MISSING_CREDENTIAL` ·
`INVALID_CREDENTIAL`

A credential that does not resolve fails before any network I/O with
`MISSING_CREDENTIAL`, and one that cannot ride in an HTTP header fails with
`INVALID_CREDENTIAL`; neither message contains any part of the secret. A refusal
this account cannot retry its way out of — the workspace has not allowed models
that train on request data — is `TRAINING_CONSENT_REQUIRED`, whose message names
the setting that removes it; see [Models that train on request
data](#models-that-train-on-request-data).

An adapter failure is reported by the **shape** the harness reads — an `Error`
with own `code` and `failure` data properties — not by class identity. That is
why this plugin can define its own failure type and depend on no harness
package: a cross-package copy of the harness class would never be recognized by
`instanceof` in the harness anyway.

## Verify it

```sh
npm test          # 137 offline checks: config, SSE framing, catalog, all three protocols, adapter, plugin body
npm run test:cordis # 20 checks mounting the plugin on the harness's own cordis
npm run test:live # 20 checks against the real service; needs OC_KEY
```

`npm test` runs offline and needs no credential. The protocol suites replay
response bodies **captured from the live service** (`tests/golden/`), so they
fail if a translator stops agreeing with what OpenCode Go actually sends. Every
case assembles its chunks with the harness's own block assembler, which is the
same code the agent loop runs over them. One case compares the capacity snapshot
against whatever OpenCode catalogue the machine has cached, so a stale
`lib/model/limits.js` is reported instead of quietly drifting.

`npm run test:live` spends real quota. It proves, against the live relay: model
discovery and caching, a round trip over each of the three protocols, a full
tool-calling round trip per protocol, protocol fallback recovery, cache reuse on
a repeated session id, a history holding a tool call that was never dispatched,
that every model reports its own measured context window, cap, and modalities,
that every advertised reasoning effort is accepted, and that a workspace-gated
model either answers or is refused as needing that workspace's consent.

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

### Re-measuring the live facts

Two facts about this service are measured rather than published, and both have a
tracked probe. They need a key and spend real quota:

```sh
OC_KEY=oc_sk_... node scripts/probe-protocols.mjs [model ...]   # one probe per served model
OC_KEY=oc_sk_... node scripts/probe-image.mjs                   # image shapes, all three protocols
node scripts/snapshot-models.mjs [--write]                      # capacity snapshot vs the catalogue
```

`probe-protocols.mjs` answers `served=[…]` per model, which is what
`FALLBACK_MODELS` is written from. `probe-image.mjs` posts a generated PNG over
each protocol and checks the model can actually read it, which is what makes an
`image` declaration honest; its image is written to `.live-cache/probe-image.png`
(untracked scratch). `snapshot-models.mjs` prints what changed since the snapshot
was taken — `new`, `changed`, `gone` — and rewrites the two tables with `--write`.

## Limits

- **Protocol capability is measured, not published.** OpenCode Go's `/models`
  response lists ids only, so the mapping in `lib/model/catalog.js` comes from
  probing the live service, one endpoint at a time. A model whose protocol
  changes needs a `protocolOverrides` entry or a re-measure. The two unknown cases
  differ in how much is unknown: an id the service *lists* but this plugin has not
  measured gets `defaultProtocol` and no fallback, while an id that appears
  nowhere — not in the built-in catalog and not in the discovered list — is tried
  over every protocol, because its protocol is exactly what is missing.
- **Capacity is a snapshot, not a subscription.** `lib/model/limits.js` holds the
  context windows, output caps, and provider modality lists measured from the
  OpenCode catalogue on the date in `CAPABILITY_SOURCE`, refreshed with
  `node scripts/snapshot-models.mjs --write`. Three consequences:
  - a model released after the snapshot is served its **family's** measured
    figures (`qwen…`, `glm-…`, `grok-…`, …) rather than the global assumption;
  - a model no family matches takes `defaultContextWindow` and `defaultMaxTokens`,
    which remains the only case where those two values are guesses;
  - an id the service lists but the catalogue does not describe is visible in the
    plugin's own startup line and resolvable by `models` / `modelOverrides`
    config without a plugin release.
  The caps reach the wire differently: Messages always sends one (`max_tokens`,
  falling back to the model's value), while Chat Completions and Responses omit
  theirs when the call states none, so the decision there belongs to the relay
  rather than to this plugin.
- **Two models are gated by a workspace policy, not by this plugin.** The relay
  serves the `…-contributor` ids only while the workspace allows providers that
  train on request data, and it refuses them with its own error before the model
  is reached. The adapter classifies that refusal (`TRAINING_CONSENT_REQUIRED`),
  states the setting and where it lives, notes the models in their metadata, and
  offers `hideTrainingModels` for a deployment that cannot enable it — but it
  never enables it, because that consent is not a client's to give. See [Models
  that train on request data](#models-that-train-on-request-data).
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
- **Only `text` and `image` are on the wire.** The catalogue gives several models
  `video`, `audio`, or `pdf` input. Those are recorded and reported, but no
  protocol here has a field for them, so no request carries one and a model's
  declared `inputModalities` never claims them. See
  [Modalities](#modalities-what-the-model-takes-versus-what-a-route-can-send).
- **Image input depends on the deployment, not only the model.** `sendImages`
  defaults to `auto`, which declares `image` for a vision model only when the
  attachment seam is mounted. On a deployment without it the model reports
  text-only, with a note naming what the route cannot send.
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
│   ├── limits.js             the measured capacity and modality snapshot
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

scripts/
├── snapshot-models.mjs       refresh lib/model/limits.js from the catalogue
├── probe-protocols.mjs       measure which protocol each served model accepts
└── probe-image.mjs           measure the image request shape per protocol
```

Adding a fourth protocol means one new file under `protocol/` and one entry in
the transport map — not a rewrite.

## License

MIT
