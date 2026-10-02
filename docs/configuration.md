# Configuration

> Back to [README](../README.md).

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
| `sendImages` | `auto` | `auto` \| `always` \| `off` — whether image bytes are attempted (see [Models](models.md#modalities-what-the-model-takes-versus-what-a-route-can-send)) |
| `disableReasoningReplay` | `false` | Stop sending prior reasoning back (see [Wire protocol](wire-protocol.md#reasoning)) |
| `hideTrainingModels` | `false` | Keep models whose provider trains on request data out of the listing (see [Models](models.md#models-that-train-on-request-data)) |
| `healthCheck` | `off` | `startup` logs a credential + catalog report |
| `retryPolicy` | normal, 5 retries | Provider-owned policy the retry executor applies |

## Shaping the catalog

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

## Image input

Image input follows the model. A vision model in the [models
page](models.md#capacity-and-modalities) declares `image`, and the adapter resolves each
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
