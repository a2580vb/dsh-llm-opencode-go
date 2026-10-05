# Reliability

> Back to [README](../README.md).

This page lists the plugin's failure codes and the limits that follow from
measured protocols, snapshot capacity, and workspace policy.

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
data](models.md#models-that-train-on-request-data).

Failures are reported by the **shape** the harness reads — an `Error` with own
`code` and `failure` data properties — not by class identity. The plugin
therefore defines its own failure types and depends on no harness package.

## Limits

- **Protocol capability is measured, not published.** OpenCode Go's `/models`
  response lists ids only, so the mapping in `lib/model/catalog.js` comes from
  probing the live service, one endpoint at a time. A model whose protocol
  changes needs a `protocolOverrides` entry or a re-measure. The two unknown cases
  are handled differently: an id the service *lists* but this plugin has not
  measured gets `defaultProtocol` and no fallback, while an id that appears
  nowhere — not in the built-in catalog and not in the discovered list — is tried
  over every protocol in order.
- **Capacity is a snapshot, not a subscription.** `lib/model/limits.js` holds the
  context windows, output caps, and provider modality lists measured from the
  OpenCode catalogue on the date in `CAPABILITY_SOURCE`, refreshed with
  `node scripts/snapshot-models.mjs --write`. Three consequences:
  - a model released after the snapshot is served its **family's** measured
    figures (`qwen…`, `glm-…`, `grok-…`, …) rather than the global assumption;
  - a model no family matches takes `defaultContextWindow` and `defaultMaxTokens`,
    which remains the only case where those two values are guesses;
  - an id the service lists but the catalogue does not describe is resolvable by
    the `models` / `modelOverrides` config without a plugin release.
  The caps reach the wire differently: Messages always sends one (`max_tokens`,
  falling back to the model's value), while Chat Completions and Responses omit
  theirs when the call states none, so the decision there belongs to the relay
  rather than to this plugin.
- **Two models are gated by a workspace policy, not by this plugin.** The relay
  serves the `…-contributor` ids only while the workspace allows providers that
  train on request data, and it refuses them with its own error before the model
  is reached. The adapter classifies that refusal (`TRAINING_CONSENT_REQUIRED`),
  states the setting and where it lives, notes the models in their metadata, and
  offers `hideTrainingModels` for a deployment that cannot enable it; it provides
  no switch that would grant that consent on a deployment's behalf. See
  [Models that train on request data](models.md#models-that-train-on-request-data).
- **Reasoning is not replayed to the Responses API.** A reasoning item is
  validated against upstream state the harness does not retain, and a mismatch
  is an opaque `400`, so prior thinking is dropped from that protocol's requests.
  The Messages protocol does replay thinking blocks, using the signature the
  provider issued.
- **A tool call the history cannot answer is dropped, not sent.** An assistant
  message can record a `tool-call` that was never dispatched — the process
  stopped between the model's answer and the tool starting — so no result exists
  to replay. Every protocol refuses that half-pair: the Responses API answers
  `400 No tool output found for tool call <id>` and Messages refuses a `tool_use`
  block that no `tool_result` follows. The converters therefore omit a call whose
  result is missing from the request, and a result whose call is missing with it,
  because sending either alone fails the whole turn and neither can be
  reconstructed. A history hole costs that one call its place in the transcript.
- **Only `text` and `image` are on the wire.** The catalogue gives several models
  `video`, `audio`, or `pdf` input. Those are recorded and reported, but no
  protocol here has a field for them, so no request carries one and a model's
  declared `inputModalities` never claims them. See
  [Modalities](models.md#modalities-what-the-model-takes-versus-what-a-route-can-send).
- **Image input depends on the deployment, not only the model.** `sendImages`
  defaults to `auto`, which declares `image` for a vision model only when the
  attachment seam is mounted. On a deployment without it the model reports
  text-only, with a note naming what the route cannot send.
- **A tool's image is sent as part of the tool result.** `read_image` commits the
  picture it read to the session, and this adapter hands it to the provider inside
  that result — not in a turn of its own, which would change what the transcript
  says happened. A route that cannot take images still receives the envelope and a
  line naming the image it could not send, so a refusal is never silent.
- **`stop` is forwarded as-is.** Whether a given model honours stop sequences is
  the model's business; the plugin does not claim otherwise.
- **One route per mount.** Mounting the plugin twice needs two `provider` names
  and two API keys.
