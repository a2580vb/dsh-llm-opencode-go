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
| `usagePath` | `~/.dsh/cache/opencode-go-usage.json` | Where the usage counters live; an unwritable path only warns |
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
| `hiddenModels` | `[]` | Model ids this deployment keeps out of the listing; hiding never makes a model unusable |
| `modelVariants` | `[]` | Named presets of one model, each offered as its own `<model>@<name>` entry |
| `healthCheck` | `off` | `startup` logs a credential + catalog report |
| `retryPolicy` | normal, 5 retries | Provider-owned policy the retry executor applies |

## Graphical configuration

The plugin ships a page in the Harness web client. Open the sidebar's
**Plugins** page, open the `dsh-opencode-go` bundle, and press **Configure** on
the `opencode-go` row. The page covers the facts that are per-deployment and
change often:

| | |
|---|---|
| **API key** | Stored write-only through the credential seam under `apiKeyEnv`. The page reports whether it is configured, where it comes from, and whether it can be replaced — never the value. |
| **Credential reference** | Which `apiKeyEnv` the key is stored under. |
| **Model visibility** | One switch per catalog model, written to `hiddenModels`. The page shows the whole catalog — including models this deployment already hides — because a listing that showed only what is listed could not offer a way back. |
| **Model variants** | Named presets of one model, written to `modelVariants`. |
| **Fetch the model list** | Re-reads `GET /models` on demand and reports what appeared and what went away. The only control on the page that reaches the provider. |
| **Usage** | Calls and tokens this plugin counted itself, per model and per day. |

Writing an ordinary config field reloads that plugin row — the Loader reconciles
it through the profile patch — so the page re-reads what the Host reports a beat
later rather than assuming its own draft survived, and says so when the read
back fails. The key is the exception: it goes to the credential store and applies
to the next request.

## Fetching the model list

A deployment in `modelSource: discover` reads `GET /models` once and keeps the
answer for `modelsCacheSeconds`. The configuration page can also re-read it on
demand, which is the one thing the page does that costs a request:

- **What it reports** is what changed, counted over the *listing* rather than
  over the raw answer. A model the service stops listing but the built-in
  catalog also knows stays offered, and saying it went away would describe a
  change nobody sees.
- **A failed read never costs the catalog.** The previous answer stays in place,
  the page says why the read failed, and the models stay callable. Discovery
  failing is not a reason for a working deployment to lose its models.
- **The first read is the only awaited one.** Everything else — startup, the
  listing, the page's own load — is answered from memory or the cache file, so
  opening the page is not a request.

`modelSource: config` has nothing to fetch: the catalog is exactly the entries
the deployment wrote, and the control says so instead of pretending to read.


## Hiding models from the listing

`hiddenModels` is this deployment's own menu choice: the named ids disappear from
the model picker while staying resolvable and callable, so a session already
pinned to one keeps working. It is the per-model counterpart of
`hideTrainingModels`, which is a data-policy stance rather than a preference —
that field keeps every model whose provider trains on request data out of the
listing, whatever the individual switches say.

```yaml
config:
  hiddenModels:
    - space-bunny-free
    - glm-5.2
```

An id the catalog does not list is kept rather than dropped, so hiding a model
OpenCode has not published yet starts working the moment it appears; a startup
warning names ids nothing in the catalog matches, which is usually a typo. The
configuration page writes this field, and the two agree because both read the
same listing decision.

## Usage

The plugin counts what goes through this route, because nothing else can: the
harness reports tokens to whoever made the call, and only the adapter knows which
model a token went to and which deployment paid for it. The page shows the
result as totals, a per-model table, and a per-day series.

```
~/.dsh/cache/opencode-go-usage.json
{
  "version": 1,
  "updatedAt": 1767225600000,
  "days": { "2026-01-15": { "glm-5.3": { "requests": 12, "failures": 0, "inputTokens": …, … } } }
}
```

| Fact | How it is counted |
|---|---|
| **A call** | One per harness call, however many protocols it took: a request that fell back and then succeeded is one call, not two. |
| **A failure** | A call that ended in an error, including one the provider refused before any stream. A model that only ever fails is exactly what this table is for. |
| **The model** | The id the harness asked for, so a variant appears under its own alias. |
| **The day** | This machine's local calendar day, so a token spent at 23:00 belongs to the evening it was spent. |
| **The window** | 1, 7, or 30 days. The page can ask for nothing else; a 30-day retention window is dropped from the file as it is written. |
| **A write** | Debounced a few seconds and flushed on unload, so a stream never waits on an `fs` call and a reload does not lose the tail. |

Three properties are deliberate:

- **It is a report, not a bill.** These are the figures the service reported to
  this client. The provider's own accounting of what a workspace spent is the
  authority; a page that implied otherwise would be wrong about a number people
  act on.
- **Losing it is never a failure.** An unreadable file means no history yet, an
  unwritable one is one warning, and a call is never failed because its token
  count could not be saved.
- **It is per deployment.** Two profiles, or two machines, keep their own
  counters. Nothing here is shared, and nothing is sent anywhere.

A call whose stream the caller abandoned is not counted: this table is about what
the route spent, and an outcome nobody observed is not a fact worth inventing.

## Model variants

A variant is one model's second set of settings under a name. It appears in the
model list as its own entry — `<model>@<name>` — so choosing between presets is
the same gesture as choosing between models, and a session can pin one.

```yaml
config:
  modelVariants:
    - model: gpt-5.6-luna
      name: fast            # the entry is gpt-5.6-luna@fast
      label: Luna Fast      # optional; otherwise "<model name> (fast)"
      protocol: chat-completions
      effort: low
      contextWindow: 200000
      maxTokens: 32768
```

| Key | Meaning |
|---|---|
| `model` | The model this varies. Must be a catalog id, and may not contain `@`. |
| `name` | The variant's own name; `model@name` is the id it is offered under. |
| `label` | Optional display name. |
| `protocol` | Optional. The protocol a call through this variant opens with; the model's other protocols stay behind it as fallbacks. |
| `effort` | Optional. The thinking level calls through this variant open with. The model must support reasoning, and must offer this level. |
| `contextWindow`, `maxTokens` | Optional. What the variant advertises instead of the model's own figures. |

Rules worth knowing before writing one:

- **A variant is a local alias.** The harness selects and reports
  `<model>@<name>`; the request on the wire still names `model`. Nothing about
  the provider's view of the model changes.
- **A variant inherits everything it does not restate**, including the base's
  capacity, modalities, reasoning ladder, and remaining protocols.
- **A variant whose `model` the catalog does not list is not offered**, and one
  startup warning names the ids. It would otherwise advertise capacities nothing
  measured and fail at the far end of a call.
- **A variant is a default, not a cage.** `effort` and `maxTokens` decide what a
  call opens with; a request that names its own values wins.
- **Two contradictions are refused at startup** rather than absorbed, each by
  name: an effort on a model that does not support reasoning, and an effort the
  model does not offer.
- **An entry may carry only the keys above.** The page writes what it read plus
  your edits, and a key the config does not declare — a typo, or a field the
  snapshot happened to carry — is refused by name rather than written into
  `cordis.patch.yml`.

Everything else — protocol shaping, timeouts, retry policy, cache paths — stays
in `cordis.patch.yml`, where a machine-readable value lives next to the comment
that explains it.

Two properties are worth stating because they decide what a deployment can
expect:

- **The page is optional in both directions.** It is served only when the
  deployment mounts a web server *and* registers a client half for this bundle.
  A headless deployment has no route and no page, and the plugin behaves
  identically without them.
- **The route is not a second authentication path.** `/opencode-go/*` is
  answered only for requests the connection service admits — the same Host and
  `Origin` fence plus browser-session check the rest of the GUI uses. Without a
  connection service only a loopback authority is answered.

A credential reference is a *name*, so it can be edited freely; the key behind it
lives in the credential store. A key the launching environment supplies cannot be
overwritten from the page, which reports it as read-only — clear the variable in
the launching shell first.

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
