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
| `subscriptionCacheSeconds` | `60` | How long the page reuses a subscription-quota answer before asking the service again |
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

## Fast entries

Usage is a question asked several times a day ("how much of the plan is left"),
so it should not sit behind the Plugins page. Besides that page, the plugin hangs
one entry in each of three shallow places, all reading the same facts:

| Entry | Where | What it offers |
|---|---|---|
| **The quota capsule at the sidebar's foot** | Beside Settings, in `sidebar.footer.action` | How much of the shortest metered window is left, without a click. One row, two actions: the row opens the usage panel, the gear opens the plugin's configuration page. |
| **The usage panel** | From that row, or the keyboard (`main`, id `opencode-go-usage`) | The whole picture: the subscription's three windows first, this route's counters (totals, by model, by day) under them, with *re-read quota* and a jump to the plugin's configuration page in its header. |
| **A tab under Settings → Plugins** | `settings.plugins.tab` | The same two blocks as the panel, in the place a reader looks when they go to Settings. |

Three properties of this set are deliberate:

- **The capsule shows what is *left*, and it shows the *shortest* window** — the
  rolling one, which resets in hours and therefore runs out first. The ring beside
  it draws one arc per window, sized by that window's remaining share, and
  coloured with the same thresholds the bars use (warning at 80%, error at 100%),
  so the figure and the page it leads to say the same thing.
- **The panel keeps no sidebar row of its own.** The panel and the capsule are two
  views of one number, and a second sidebar entry holding it would be a second
  door into one room — while every other row in that list is the host's. The panel
  is entered from the capsule's row and left with the keyboard. For the same
  reason the row is drawn to the host's own foot measurements (42px tall, 12px
  radius, 14px type) and becomes the 36px round button the host's rail uses: a
  control in that column that picked its own size reads as a foreign object.
- **Every entry is optional.** The panel body, the capsule's click, and the
  shortcut come from `layout` and `shortcuts`; the configuration entry comes from
  the Plugins page's `pluginNavigation`. Where one is missing the entry is *not
  rendered* rather than rendered inert: a deployment with no Plugins page shows
  neither the gear nor the *Plugin settings* button, and one without the
  `shortcuts` service or a selectable panel simply has no such command.

The shortcut is rebindable in Settings → Shortcuts. It is `Ctrl/Cmd+U` on the
desktop; the browser shell refuses a bare `primary+U`, so there it defaults to
`Ctrl/Cmd+Alt+U` (Linux browsers can set their own).

Opening the panel *does* read the service's quota, through the Host's
`subscriptionCacheSeconds` cache; only *re-read quota* forces a fresh request. The
capsule reads once when it mounts and never polls — a quota only moves when a
request does.

## Graphical configuration

The plugin ships a page in the Harness web client. Open the sidebar's
**Plugins** page, open the `dsh-opencode-go` bundle, and press **Configure** on
the `opencode-go` row. The page covers the facts that are per-deployment and
change often:

| | |
|---|---|
| **API key** | Stored write-only through the credential seam under `apiKeyEnv`. The page reports whether it is configured, where it comes from, and whether it can be replaced — never the value. |
| **Credential reference** | Which `apiKeyEnv` the key is stored under. Editable, because it is the way out of a key the launching environment supplies. |
| **Model visibility** | One switch per catalog model, written to `hiddenModels`. The page shows the whole catalog — including models this deployment already hides — because a listing that showed only what is listed could not offer a way back. |
| **Model variants** | Named presets of one model, written to `modelVariants`, in an editable list: add a model, name it, then change or delete any row. |
| **Fetch the model list** | Re-reads `GET /models` on demand and reports what appeared and what went away. |
| **Usage** | Two things side by side: the service's own metered quota for the subscription, and the calls and tokens this plugin counted itself, per model and per day. The same block is the substance of the panel described under [fast entries](#fast-entries), so this page points at that one rather than implying it is the only door. |

Writing an ordinary config field reloads that plugin row — the Loader reconciles
it through the profile patch — so the page re-reads what the Host reports a beat
later rather than assuming its own draft survived, and says so when the read
back fails. The key is the exception: it goes to the credential store and applies
to the next request.

### Where the API key comes from, and why "Clear" is sometimes inert

The credential seam layers a reference, most trusted first:

| Layer | What a write there does | What the page shows |
|---|---|---|
| the launching environment | nothing — a process cannot change its own inherited environment | **Clear key** is disabled, and the message names the variable and points at the reference field |
| the managed store (`~/.dsh/.credentials.yaml`) | this is the value the route reads | **Clear key** removes it |
| a `.env` file (project first, then home) | stores, and is immediately shadowed back by the file | **Clear key** is disabled, and the message names the file |

The page can only remove the middle one, so it reports which layer it found
rather than offering a button that would do nothing. When a value is supplied
from outside, the way out is the **Credential reference** field: point the route
at a name nothing shadows (`OPENCODE_GO_HOME_KEY`, say), press **Save reference**,
and store the key under that name. It is an ordinary config field, so the Loader
applies it on reload — no restart and no editing of your shell profile.

### The page's own endpoints

The page is a separate artifact from the Host half, and the two agree on one flat
namespace. Nothing else serves these paths, so they are safe to read with `curl`
while the client is open:

| Endpoint | Method | Answers |
|---|---|---|
| `/opencode-go/state` | `GET` | the route, the `apiKeyEnv` in use, the credential's status — never its value — and the profile override of each managed field |
| `/opencode-go/models` | `GET` | the whole catalog, listed and hidden, with the reason each hidden model is hidden |
| `/opencode-go/config` | `POST` | writes one managed field into the profile patch |
| `/opencode-go/credential` | `POST` | stores the API key; `DELETE` clears it |
| `/opencode-go/refresh` | `POST` | re-reads `GET /models` and reports what changed |
| `/opencode-go/usage` | `GET` | the usage table for `?days=1`, `7`, or `30` |
| `/opencode-go/subscription` | `GET` | the subscription's own quota, read from the service; `?refresh=1` bypasses the cache |

Three properties are deliberate:

- **The fence comes first.** Every request goes through the harness's connection
  service, which owns the host/origin policy and the browser session. Without
  that service the fallback is a loopback authority, a `sec-fetch-site` that is
  not `cross-site`, and an `Origin` matching the authority — so a page on another
  host cannot read these endpoints, and a cross-site form post cannot write them.
  A refused request gets a status and no body: an unauthenticated caller learns
  nothing about the surface.
- **No secret ever travels back.** The key is written and reported as
  configured-or-not; nothing here returns its value, and `state` never carries it.
- **A wrong method answers `405` with `Allow`**, an unknown path under the prefix
  answers `404`, and a body over 64 KiB answers `413` — the page can always tell
  a refusal it caused from a fault.

The page itself is only mounted by a deployment that serves the web client.
Without a `webServer`, the plugin is complete and this whole surface is absent,
which is what the offline suites exercise by mounting nothing.

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

The usage section answers two different questions, and the page keeps them apart
because they come from different places:

| | |
|---|---|
| **Subscription quota** | The service's own metering, read from `GET {baseURL}/usage`: one bar per metered window — rolling, weekly, monthly — with the spent share in grey and the remaining share in pale green, both percentages as figures, and when the window resets. This is what answers "how much of the plan is left". |
| **This route's counters** | What the plugin counted itself, below: totals, per model, per day. |

The bars keep the service's own window names rather than mapping them onto "day,
week, month": the shortest one is a rolling window that resets within hours
rather than at midnight, so calling it a day would be a claim the service does
not make. Each bar says when its window resets, which is the fact that matters
for that one. Running out is the only thing this panel warns about, so past 80%
the figure takes the warning colour and at 100% the error colour — the bar
shortening is the primary signal, and the same numbers travel in
`aria-valuetext` for a reader who cannot see the colour.

The quota endpoint is not part of the published API — it is what the console
calls — so the *shape* may move without notice. Every way it can be missing is
a sentence rather than a failure: a gateway that mirrors only the model surface
answers `404`, a key the service rejects answers `401`, and an unreachable host
answers nothing at all. In all three cases the local counters stay on screen and
the quota panel says which one happened. Opening the page reuses an answer for
`subscriptionCacheSeconds`; only **Re-read quota** forces a fresh call.

The counters below are the plugin's own, because nothing else can produce them:
the harness reports tokens to whoever made the call, and only the adapter knows
which model a token went to and which deployment paid for it. The page shows the
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
| **Uncached input** | The part of the prompt the service did not serve from cache. Not the whole prompt: see below. |
| **Cache read / write** | What the service said it read from, and wrote to, its prompt cache. |
| **Hit rate** | Cache read ÷ (uncached input + cache read) — the share of the prompt that came from cache. Shown as `—` when no call reported a cache figure at all. |

### What the input column means, and why the cache columns need care

The two service families disagree about what their prompt count contains, and the
numbers above are only checkable if that disagreement is resolved the same way
every time. It is resolved the way the Harness resolves it: `inputTokens` is the
**uncached** input — the Harness's own token meter reads exactly this field under
the name `uncachedInputTokens`.

| Service family | What it sends | What this plugin records |
|---|---|---|
| OpenAI-shaped (`prompt_tokens_details`, `input_tokens_details`) | `prompt_tokens: 3689` with `cached_tokens: 3584` inside it | uncached input `105`, cache read `3584` |
| Anthropic-shaped (`cache_read_input_tokens`, `cache_creation_input_tokens`) | `input_tokens: 4`, cache reported beside it | uncached input `4`, cache read `2048` |

Both then add up the same way — uncached + output + read + write — which is what
makes one total correct for both families, and what an earlier version got wrong:
it passed the OpenAI prompt count through untouched *and* added the cached part
on top. On a real cached call that reported 3689 prompt tokens of which 3584 were
cached, the input column read 3689 instead of 105 and the hit rate came out at
39% instead of 65%.

Two further consequences worth stating, because both showed up as wrong data
rather than as an error:

- **`0%` and `—` are different claims.** A service that reports "nothing was
  cached" supports a hit rate of 0%; a service that reports no cache figure at
  all does not, and gets `—`. The counters keep how many calls reported one, so
  the page can tell the two apart.
- **The Messages protocol announces its cache figures once.** They arrive in
  `message_start`, and every later `message_delta` talks about output alone. The
  two halves are merged field by field, so the cache figures survive; a merge
  that rebuilt the object would report a cache hit of zero for every call.

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

Counting starts before the file is read, and the file is folded into what has
been counted rather than replacing it, so the first call after a restart is not
thrown away by the write that follows it. Every counter row is read through a
default, so a field a newer build added is zero in a file an older one wrote
instead of becoming `NaN` and poisoning everything written after it.

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
| `name` | The variant's own name; `model@name` is the id it is offered under. The page leaves it optional: a name left blank becomes the thinking level the variant sets (then the protocol it leads with, then `default`), because that is what tells two presets of one model apart. |
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
