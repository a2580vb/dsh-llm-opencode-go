# Models

> Back to [README](../README.md).

This page describes the model catalog: what the service publishes for each model,
how the adapter opens a call, which models are gated by a training-data policy,
and what capacity and input modalities the catalog reports. The catalog is built
from the live `GET /models` rows, with the measured protocol table and the
`models.dev` capacity snapshot as its fallbacks (`lib/model/catalog.js`,
`lib/model/limits.js`).

## Protocol selection is per model

OpenCode Go serves three wire protocols. Its catalogue names one **preferred
entry** per model in the row's `api` map — `chat-completions`, `responses`, or
`messages` — but that is a recommendation, not a capability limit: a probe on
2026-11-08 accepted all three protocols for every served model. So every model
carries an ordered protocol list, the preferred entry first and the other two
behind it. If a call is nonetheless refused that way, it answers:

```json
{"type":"error","error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}
```

The adapter logs it and retries the same call over the model's next protocol.
Grouped by the entry each row names, the modeled order is:

| Models | Protocols, in order |
|---|---|
| `beam-free`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`, `hy3`, `hy4`, `hy4-preview`, `iceman-contributor-free`, `kimi-k2.7-code`, `kimi-k3`, `kimi-k3.1-pro`, `longcat-2.0`, `mimo-v2.6-flash`, `mimo-v2.6-pro`, `minimax-m3.1-flash`, `step-5-preview` | chat-completions, responses, anthropic |
| `crouton-alpha-free`, `gemini-4-argon`, `gpt-5.6-luna`, `gpt-6-luna`, `grok-4.7` | responses, chat-completions, anthropic |
| `claude-haiku-5-5`, `minimax-m3`, `qwen3.7-plus`, `qwen3.8-flash`, `qwen3.8-max` | anthropic, responses, chat-completions |
| `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor` | responses, chat-completions, anthropic, and only while the workspace allows providers that train on request data (see [Models that train on request data](#models-that-train-on-request-data)) |

The built-in catalog has a row for every id `GET /models` listed on 2026-11-08,
so no served model has to discover its own protocol by failing first. Ids the
service no longer serves are absent from it; a session that still names one
resolves its capacity from the measured table in `lib/model/limits.js` and
receives `MODEL_DEPRECATED` or `MODEL_UNAVAILABLE` from the service (see
[Reliability](reliability.md#failures)). Re-measure after a service change with
the probe described in
[Development](development.md#re-measuring-the-live-facts).

The `api` map also names a per-protocol SDK base URL
(`/inference/go/openai/…`, `/inference/go/anthropic/…`, `/inference/go/google/…`).
Those are the catalogue's SDK entry points; the relay serves the same protocols
at the unified `baseURL` this plugin uses, so no host changes. The one model
whose row names Google's `generate-content` (`gemini-4-argon`) is served over all
three protocols here too — this adapter has no Google transport, so its row opens
with responses.

Change the opening protocol for one model with `protocolOverrides`; the model's
other protocols stay behind it as fallbacks:

```yaml
config:
  protocolOverrides:
    gpt-5.6-luna: chat-completions
```

A model the catalog does not describe falls into one of two cases:

- **An id the service lists but this plugin has no built-in row for**: its live
  `api` entry opens the call, with the other protocols behind it; a row that names
  no entry this adapter can carry opens with `defaultProtocol`, again with the
  rest behind it.
- **An id that appears nowhere** — new enough that even `GET /models` has not
  caught up, or reached through a gateway with no discovery: its protocol is
  unknown, so it tries every protocol in order.

Neither case needs a plugin release before the model can be used.

## Models that train on request data

The providers of `muse-spark-1.3-contributor` and `muse-spark-1.2-contributor` use
prompts and completions to train future models. The relay gates them on a
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

How the adapter handles that refusal:

- **It is classified separately, and no other protocol is tried.** It is reported
  as `TRAINING_CONSENT_REQUIRED`, carrying the setting to enable and where to
  enable it, instead of as `INVALID_REQUEST` (nothing about the request is wrong)
  or `AUTH` (the credential is fine). The gate is an account policy, so a second
  request cannot answer differently.
- **The model states what it needs while it is still being chosen.** A gated model
  carries the note in its listing and in its resolved metadata, so a selector can
  show the requirement before the first call rather than after a refused one.
- **The plugin does not change the setting for a deployment.** No header, body
  field, or config switch here flips it; the adapter only reports it. It does log
  the gated models once, when the catalog is assembled.

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

`GET /models` describes each model. A row, trimmed to the fields this adapter
reads:

```json
{
  "id": "deepseek-v4.1-flash",
  "name": "DeepSeek V4.1 Flash",
  "description": "DeepSeek V4.1 Flash model for reasoning and agentic coding",
  "limit": { "context": 1000000, "output": 384000 },
  "modalities": { "input": ["text", "image/jpeg", "image/png"], "output": ["text"] },
  "capabilities": {
    "tools": { "supported": true },
    "reasoning": { "supported": true, "effort": ["low", "high", "max"] }
  },
  "api": { "chat-completions": { "base_url": "https://opencode.ai/inference/go/openai/v1" } }
}
```

`created` in a live row is the moment of the request, not the model's release
date; `release_date` and `last_updated` carry those. A discovered row is the
first source for the model's facts: `limit` supplies the context window and
output cap (and, on a few models, a `limit.input` single-request cap this adapter
does not model separately), `modalities` supplies the provider's input list,
`capabilities.reasoning.effort` supplies the thinking ladder, and `api` names the
preferred protocol. Discovery keeps the rows in its cache, so a model added since
the snapshot was taken still reports its own figures.

Behind that sits a snapshot. `lib/model/limits.js` carries the same facts
measured from the OpenCode catalogue (`models.dev`) on the date in
`CAPABILITY_SOURCE` (`models.dev/opencode-go@2026-11-08`). It answers whenever
discovery has not described a model — a deployment with no network, a gateway
that answers with ids only, or a cache file written before rows carried facts —
because a call that needs a context window must not wait on a third-party
endpoint, and a deployment with no egress must still show real limits. Every
resolved model reports its own:

| Model | Context | Output cap | Model input |
|---|---|---|---|
| `deepseek-v4.1-flash` | 1,000,000 | 384,000 | text, image |
| `gpt-5.6-luna` | 1,050,000 | 128,000 | text, image, pdf |
| `grok-4.7` | 500,000 | 500,000 | text, image, pdf |
| `claude-haiku-5-5` | 1,000,000 | 128,000 | text, image, pdf |
| `kimi-k2.7-code` | 262,144 | 262,144 | text, image, video |
| `mimo-v2.6-pro` | 1,048,576 | 131,072 | text, image, audio, video |
| `hy3` | 256,000 | 128,000 | text |

A model neither source describes — one released after both — is matched to its
family's measured figures (`qwen…`, `glm-…`, `grok-…`, …) before falling back to
`defaultContextWindow`. A compatible gateway that publishes the same fields is
read the same way; see [Configuration](configuration.md#shaping-the-catalog).
The row's `capabilities.reasoning.effort` is also what the model advertises as
its thinking ladder; see [Wire protocol](wire-protocol.md#reasoning).

### Modalities: what the model takes versus what a route can send

A live row lists input modalities as MIME types (`image/jpeg`,
`application/pdf`, `video/mp4`, …); the snapshot lists the same abilities in the
catalogue's vocabulary (`image`, `pdf`, `video`, …). Both are normalized to one
list — after which the service's abilities include some no wire protocol here has
a field for — `video`, `audio`, `pdf` — so two facts are kept apart:

- **`providerModalities`** is the provider's own list, normalized to those names
  and kept whole.
- **`inputModalities`** is what this adapter can actually put in a request. The
  harness models two and this adapter has a wire for two, so the resolved model
  declares `['text']` or `['text', 'image']`.

The split is observable: the harness projects durable image blocks on the strength
of the resolved list — a route that declares `image` is handed real image blocks
and must resolve their bytes, while one that does not gets a text placeholder. A
model whose abilities this route cannot carry therefore carries a note saying so:

```
"description": "the model also accepts video, audio, which no protocol on this route can send"
```

`sendImages` decides whether image bytes are attempted at all:

| Value | Effect |
|---|---|
| `auto` (default) | Declare `image` for a vision model **when this deployment can resolve image bytes** — that is, when the attachment seam is mounted. Otherwise report text-only, and say what was left out. |
| `always` | Declare `image` for every model whose row takes images, mounted seam or not. A request that then contains an image fails with the reason instead of silently sending text. |
| `off` | Never declare `image`. |

Set it to `always` if your deployment mounts images somewhere other than the
attachment seam:

```yaml
config:
  sendImages: always
```

All three protocols carry images once declared: Chat Completions and Responses
receive a `data:` URL part, Messages receives a base64 `source`. An image reaches
the model by either route — attached to a turn, or returned by a tool — because
`read_image` answers with text and the image itself. Responses and Messages send
it inside the tool result (the `function_call_output` item's `output` parts, or
the `tool_result` block's `content`); Chat Completions sends the result as a
string and the picture in the turn right after it. This is measured against the
live service and can be re-checked with the probes in
[Development](development.md#re-measuring-the-live-facts).
