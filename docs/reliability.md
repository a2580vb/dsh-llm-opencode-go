# Reliability

> Back to [README](../README.md).

This page lists the plugin's failure codes and the limits that follow from
measured protocols, the service's own capacity figures, and workspace policy.

## Failures

Stable codes, so consumers route on the code and never on message text:

`AUTH` · `QUOTA` · `RATE_LIMIT` · `CONTEXT_WINDOW_EXCEEDED` · `INVALID_REQUEST`
· `SERVER` · `TRANSPORT` · `ABORTED` · `TIMEOUT` · `MALFORMED_RESPONSE` ·
`STREAM_CLOSED` · `EMPTY_RESPONSE` · `UNSUPPORTED_CONTENT` · `UNSUPPORTED_OPTION`
· `PROTOCOL_UNSUPPORTED` · `MODEL_DEPRECATED` · `MODEL_UNAVAILABLE` ·
`TRAINING_CONSENT_REQUIRED` · `MISSING_CREDENTIAL` · `INVALID_CREDENTIAL`

A credential that does not resolve fails before any network I/O with
`MISSING_CREDENTIAL`, and one that cannot ride in an HTTP header fails with
`INVALID_CREDENTIAL`; neither message contains any part of the secret. A refusal
this account cannot retry its way out of — the workspace has not allowed models
that train on request data — is `TRAINING_CONSENT_REQUIRED`, whose message names
the setting that removes it; see [Models that train on request
data](models.md#models-that-train-on-request-data).

A model the service has retired is named as such rather than as a malformed
request: `410 ModelDeprecated` becomes `MODEL_DEPRECATED` and its message carries
the id the service says to use instead, while `400 Model is unavailable.` becomes
`MODEL_UNAVAILABLE`. Neither is retried over another protocol — the model is gone
from every endpoint, so a second attempt would only repeat the refusal.

Failures are reported by the **shape** the harness reads — an `Error` with own
`code` and `failure` data properties — not by class identity. The plugin
therefore defines its own failure types and depends on no harness package.

A code and a sentence are all that survives a call, which is not enough to
explain one afterwards: a `TRANSPORT` failure's own message is `fetch failed`,
and whether the request never connected or died mid-stream is decided by facts
only the attempt knows. So each failed attempt also appends a metadata-only line
to the [diagnostics log](configuration.md#diagnostics-log) — the stage, the
timing, and the cause chain — and nothing about a call is written anywhere else.

## Limits

- **Protocol preference is published; protocol acceptance is measured.**
  `GET /models` names one wire entry per model in its `api` map, and that entry
  opens the call. It is not a capability limit: every model the service listed on
  2026-11-08 accepted all three protocols when probed, so the record keeps the
  other two behind the preferred one and switches to the next entry only when the
  service answers `400 ModelProtocolUnsupported`. Re-measure with
  `scripts/probe-protocols.mjs` after a service change. The two unknown cases are
  handled differently: an id the service *lists* but the built-in catalog has no
  row for starts at the entry its live row names (or `defaultProtocol` when it
  names none) with the remaining protocols behind it, while an id that appears
  nowhere — not in the built-in catalog and not in the discovered list — is tried
  over every protocol in order.
- **Capacity comes from the service, with a snapshot as its fallback.** A
  discovered row carries the model's `limit` (context and output caps, plus an
  input cap on a few models), `modalities`, `capabilities` (including its own
  reasoning ladder) and `api`; `lib/model/cache.js` keeps those rows and the
  catalog reads them, so a model released after the snapshot still reports its
  real figures. `lib/model/limits.js` holds the same facts measured from the
  OpenCode catalogue on the date in `CAPABILITY_SOURCE`
  (`models.dev/opencode-go@2026-11-08`) and answers when discovery has not
  described a model: no network, an empty answer, or a cache file written before
  rows carried facts. Three consequences:
  - a model neither source describes is served its **family's** measured figures
    (`qwen…`, `glm-…`, `grok-…`, …) rather than the global assumption;
  - a model no family matches takes `defaultContextWindow` and `defaultMaxTokens`,
    which remains the only case where those two values are guesses;
  - an id the service lists but neither source describes is resolvable by the
    `models` / `modelOverrides` config without a plugin release.
  The caps reach the wire differently: Messages always sends one (`max_tokens`,
  falling back to the model's value), while Chat Completions and Responses omit
  theirs when the call states none, so the decision there belongs to the relay
  rather than to this plugin.
- **Reasoning ladders are per model.** The service publishes each model's own
  effort list in `capabilities.reasoning.effort`; that list is what the resolved
  metadata advertises, narrowed to the levels its preferred protocol can spell.
  `none` is the service's way of saying thinking can be switched off, which this
  adapter expresses by omitting the parameter, so it is never advertised; `xhigh`
  is a level like any other. A model the row gives a `supported: true` flag but no
  ladder keeps the built-in list.
- **Two models are gated by a workspace policy, not by this plugin.** The relay
  serves the `…-contributor` ids only while the workspace allows providers that
  train on request data, and it refuses them with its own error before the model
  is reached. The adapter classifies that refusal (`TRAINING_CONSENT_REQUIRED`),
  states the setting and where it lives, notes the models in their metadata, and
  offers `hideTrainingModels` for a deployment that cannot enable it; it provides
  no switch that would grant that consent on a deployment's behalf. See
  [Models that train on request data](models.md#models-that-train-on-request-data).
- **Reasoning is replayed to the Responses API only where the upstream needs
  it.** DeepSeek's thinking mode refuses a request carrying tools unless every
  earlier turn's reasoning comes back, so those models receive it as a plain-text
  `reasoning` item ahead of the assistant message. The OpenAI- and xAI-served
  models on the same wire validate a replayed item against state this harness
  does not retain and answer a mismatch with an opaque `400`, so their requests
  still send none. The condition is a catalog fact (`requiresReasoningReplay`),
  not a protocol rule. The Messages protocol replays thinking blocks with the
  signature the provider issued.
- **A tool call the history cannot answer is dropped, not sent.** An assistant
  message can record a `tool-call` that was never dispatched — the process
  stopped between the model's answer and the tool starting — so no result exists
  to replay. Every protocol refuses that half-pair: the Responses API answers
  `400 No tool output found for tool call <id>` and Messages refuses a `tool_use`
  block that no `tool_result` follows. The converters therefore omit a call whose
  result is missing from the request, and a result whose call is missing with it,
  because sending either alone fails the whole turn and neither can be
  reconstructed. A history hole costs that one call its place in the transcript.
- **Only `text` and `image` are on the wire.** The service gives several models
  `video`, `audio`, or `pdf` input. Those are recorded and reported, but no
  protocol here has a field for them, so no request carries one and a model's
  declared `inputModalities` never claims them. See
  [Modalities](models.md#modalities-what-the-model-takes-versus-what-a-route-can-send).
- **Image input depends on the deployment, not only the model.** `sendImages`
  defaults to `auto`, which declares `image` for a vision model only when the
  attachment seam is mounted. On a deployment without it the model reports
  text-only, with a note naming what the route cannot send.
- **A tool's image reaches the model, in the shape its protocol takes.** `read_image`
  commits the picture it read to the session, and this adapter hands it to the
  provider: inside the result on Responses and Messages, and in the `user` turn
  right after it on Chat Completions, whose tool message is a plain string. A
  refusal of that shape is named as `UNSUPPORTED_CONTENT` rather than as a
  malformed request. A route that cannot take images still receives the envelope
  and a line naming the image it could not send, so a refusal is never silent.
- **`stop` is forwarded as-is.** Whether a given model honours stop sequences is
  the model's business; the plugin does not claim otherwise.
- **Fresh connections for large bodies are opt-in.** Some network paths — a
  transparent proxy's user-space TCP stack among them — reset a large upload
  that rides a keep-alive socket reused from the previous call, before any
  response headers arrive. `freshConnectionOnLargeBody` (default `false`) makes
  every attempt whose body reaches `FRESH_CONNECTION_BYTES` (256 KiB) ask for
  `Connection: close`, so that attempt travels on a socket of its own; smaller
  calls keep the connection they already have. The trade is one handshake per
  large call, which is why it stays off unless a deployment needs it.
- **One route per mount.** Mounting the plugin twice needs two `provider` names
  and two API keys.
