# Models

> Back to [README](../README.md).

This page describes the model catalog: which wire protocol each model serves,
which models are gated by a training-data policy, and what capacity and input
modalities the catalog reports. All three come from the same two measured sources
(`lib/model/catalog.js`, `lib/model/limits.js`).

## Protocol selection is per model

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
| `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor` | responses, and only while the workspace allows providers that train on request data (see [Models that train on request data](#models-that-train-on-request-data)) |

Every id `GET /models` returns has a row in that table. Re-measure after a
service change with the probe described in
[Development](development.md#re-measuring-the-live-facts).

Preference order is responses → chat-completions → anthropic. Pin a different
one with `protocolOverrides`:

```yaml
config:
  protocolOverrides:
    deepseek-v4-flash: chat-completions
```

A model the catalog does not describe falls into one of two cases:

- **An id the service lists but this plugin has not measured**: it is recorded
  with `defaultProtocol` alone (`chat-completions` unless configured otherwise),
  with no fallback.
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

`GET /models` publishes ids only:

```json
{"id":"deepseek-v4.1-flash","object":"model","created":1790899718,"owned_by":"opencode"}
```

No context window, no output cap, no modalities. The figures exist on the
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
[Configuration](configuration.md#shaping-the-catalog).

### Modalities: what the model takes versus what a route can send

The catalogue lists abilities no wire protocol here has a field for — `video`,
`audio`, `pdf` — so two facts are kept apart:

- **`providerModalities`** is the catalogue's own list, kept whole.
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
| `always` | Declare `image` for every model whose catalogue entry takes images, mounted seam or not. A request that then contains an image fails with the reason instead of silently sending text. |
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
`read_image` answers with text and the image itself, and that image is sent inside
the tool result (the tool message's `content` parts, the `function_call_output`
item's `output` parts, or the `tool_result` block's `content`). This is measured
against the live service and can be re-checked with the probes in
[Development](development.md#re-measuring-the-live-facts).
