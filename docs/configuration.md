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
| `subscriptionMinIntervalSeconds` | `30` | The shortest wait between two of the page's own quota checks (see [Fast entries](#fast-entries)) |
| `subscriptionMaxIntervalSeconds` | `1800` | The longest a quota answer may go unchecked, however quiet the route is |
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

Usage has three entries, all reading the same facts:

| Entry | Where | What it offers |
|---|---|---|
| **The quota capsule at the sidebar's foot** | Beside Settings, in `sidebar.footer.action` | One group per metered window in a single row — ring, short tag, and what is left, separated by hairlines — without a click. That row opens the usage panel, and the gear beside it opens the plugin's configuration page. |
| **The usage panel** | From that row, or the keyboard (`main`, id `opencode-go-usage`) | The subscription's three windows first, this route's counters (totals, by model, by day) under them; its header stays pinned to the top of the scroll and carries the jump to the plugin's configuration page and an **×** back to the Conversation; *re-read quota* sits beside the "Subscription quota" heading. |
| **A tab under Settings → Plugins** | `settings.plugins.tab`, id `opencode-go-usage` | The same two blocks as the panel. |
| **A row in Settings' navigation** | `settings.section`, id `opencode-go` | The [configuration page](#graphical-configuration) itself, after the pages the shell ships. |

All four are optional. The panel body, the capsule's click, the shortcut, and the
panel's own way out all come from `layout` and `shortcuts`; the configuration entry
comes from the Plugins page's `pluginNavigation`. Where one of those is missing the
entry is *not rendered* rather than rendered inert: a deployment with no Plugins
page shows neither the gear nor the *Plugin settings* button, and one without the
`shortcuts` service or a selectable panel simply has no such command — and, having
no panel to leave, no × to leave it with. The Settings page is the exception: it
needs nothing but the web client's own Settings panel, which is also what renders
it.

The capsule itself:

- Each metered window gets **one ring of its own**, and the row reads
  `◉ 5H 92% │ ◉ 周 58% │ ◉ 月 9%`: the tag comes before the figure, the figures are
  "% left", and they are set in tabular figures. The tags are two characters
  (`5H`, `周`, `月`); the spelled-out names do not fit the sidebar's 264px
  minimum, so they travel in the tooltip and the accessible name.
- A window the service did not report keeps its group, loses its arc, and prints a
  dash: "not measured" is not "nothing left".
- The row is drawn to the host's own foot measurements (42px tall, 12px radius)
  and spread across its width with `space-between`. Collapsed to the rail it
  becomes the 36px round button the host's rail uses, showing the rolling window
  alone.

The shortcut is rebindable in Settings → Shortcuts. It is `Ctrl/Cmd+U` on the
desktop; the browser shell refuses a bare `primary+U`, so there it defaults to
`Ctrl/Cmd+Alt+U` (Linux browsers can set their own).

Opening a surface reads the service's quota once, through the Host's
`subscriptionCacheSeconds` cache; only *re-read quota* forces a fresh request.
Every surface draws the same answer — the capsule, the panel, the settings tab,
and the configuration page — so a re-read on one of them moves the numbers on all
of them.

The capsule keeps those numbers current without polling the service. The quota
moves only when a call is made, so the page's schedule is driven by whether one
was: every `subscriptionMinIntervalSeconds` (30 by default, and only while a
surface is mounted) it asks `GET /opencode-go/activity` — a question the Host
answers from memory, never from the service — and reads the quota only when that
says something was spent, or when the answer on file has reached
`subscriptionMaxIntervalSeconds` (1800 by default). What that last bound covers is
the spending this process cannot see: another machine, another session.

So a session that is working reads the quota at most once per floor, an idle one
at most once per ceiling, and a closed panel costs nothing at all. Both fields
must be positive — an interval of zero would be the poll this replaces — and a
ceiling below the floor is lifted to it, since no interval could satisfy both.

This route's own counters are shared the same way, with one difference worth
knowing: what the surfaces share is **the table for a window**, not the window.
Three surfaces draw those tables — the configuration page's usage section, the
panel, and the settings tab — and a read publishes to all of them at once, but
**each surface keeps its own window**: opening 30 days on the panel asks a
different question from the one the settings tab is showing, and neither moves the
other. A surface reads its window when it mounts, when the reader switches the
window, and when the reader presses *refresh usage*; two surfaces asking for the
same window at the same moment spend one request between them.

## Graphical configuration

The plugin ships a page in the Harness web client. It opens from two places, both
rendering the same page: a row of Settings' own navigation (**OpenCode Go
settings**, beside the pages the shell ships), or the sidebar's **Plugins** page,
where the `dsh-llm-opencode-go` bundle's `opencode-go` row has a **Configure**
control. The page covers the facts that are per-deployment and change often:

| | |
|---|---|
| **API key** | Stored write-only through the credential seam under `apiKeyEnv`. The page reports whether it is configured, where it comes from, and whether it can be replaced — never the value. |
| **Credential reference** | Which `apiKeyEnv` the key is stored under. Editable, so a name other than the one the launching environment supplies can be used. |
| **Model visibility** | One switch per catalog model, written to `hiddenModels`. The page shows the whole catalog, including models this deployment already hides. |
| **Model variants** | Named presets of one model, written to `modelVariants`, in an editable list: add a model, name it, then open any row's **Edit** to change its fields, or **Remove** to drop it. |
| **Fetch the model list** | Re-reads `GET /models` on demand and reports what appeared and what went away. |
| **Usage** | Two things side by side: the service's own metered quota for the subscription, and the calls and tokens this plugin counted itself, per model and per day. This is the same block the panel under [fast entries](#fast-entries) carries. |

Writing an ordinary config field reloads that plugin row — the Loader reconciles
it through the profile patch — after which the page re-reads what the Host
reports, and says so when the read back fails. The key is the exception: it goes
to the credential store and applies to the next request.

The card this bundle gets in that list, and the header of the `opencode-go` row's
own page, carry the one-line description the package declares in
`locale/en.json` and `locale/zh.json`. The Harness reads those files without
activating the plugin, and the client resolves the one matching the interface
language; with neither file, both fall back to the manifest's `description` — the
sentence npm and the plugin registry show.

### Where the key comes from, and when "Clear" is unavailable

The credential seam layers a reference, most trusted first:

| Layer | What a write there does | What the page shows |
|---|---|---|
| the launching environment | nothing — a process cannot change its own inherited environment | **Clear key** is disabled, and the message names the variable and points at the reference field |
| the managed store (`~/.dsh/.credentials.yaml`) | this is the value the route reads | **Clear key** removes it |
| a `.env` file (project first, then home) | stores, and is immediately shadowed back by the file | **Clear key** is disabled, and the message names the file |

The page can remove only the middle layer, and reports which layer it found in the
other two cases. When a value is supplied from outside, the way out is the
**Credential reference** field: point the route at a name nothing shadows
(`OPENCODE_GO_HOME_KEY`, say), press **Save reference**, and store the key under
that name. It is an ordinary config field, so the Loader applies it on reload — no
restart and no editing of your shell profile.

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
| `/opencode-go/activity` | `GET` | whether that quota answer has gone old — answered from memory, never from the service |

How the surface is guarded:

- **The fence comes first.** Every request goes through the harness's connection
  service, which owns the host/origin policy and the browser session. Without
  that service the fallback is a loopback authority, a `sec-fetch-site` that is
  not `cross-site`, and an `Origin` matching the authority — so a page on another
  host cannot read these endpoints, and a cross-site form post cannot write them.
  A refused request gets a status and no body.
- **No secret ever travels back.** The key is written and reported as
  configured-or-not; nothing here returns its value, and `state` never carries it.
- **A wrong method answers `405` with `Allow`**, an unknown path under the prefix
  answers `404`, and a body over 64 KiB answers `413` — the page can always tell
  a refusal it caused from a fault.

The page is served only by a deployment that mounts a `webServer`; without one the
plugin is complete and this whole surface is absent.

## Fetching the model list

A deployment in `modelSource: discover` reads `GET /models` once and keeps the
answer for `modelsCacheSeconds`. The configuration page can also re-read it on
demand, which is the one thing the page does that costs a request:

- **What it reports** is what changed, counted over the *listing* rather than
  over the raw answer. A model the service stops listing but the built-in
  catalog also knows stays offered, so it is not reported as a change.
- **A failed read never costs the catalog.** The previous answer stays in place,
  the page says why the read failed, and the models stay callable.
- **The first read is the only awaited one.** Everything else — startup, the
  listing, the page's own load — is answered from memory or the cache file, so
  opening the page is not a request.

`modelSource: config` has nothing to fetch: the catalog is exactly the entries
the deployment wrote, and the control says so.

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
configuration page writes this field, and both sides read the same listing
decision.

## Usage

The usage section answers two different questions, kept apart because they come
from different places:

| | |
|---|---|
| **Subscription quota** | The service's own metering, read from `GET {baseURL}/usage`: one bar per metered window — rolling, weekly, monthly — with the spent share in grey and the remaining share in pale green, both percentages as figures, and when the window resets. |
| **This route's counters** | What the plugin counted itself, below: totals, per model, per day. |

The bars keep the service's own window names rather than mapping them onto "day,
week, month": the shortest one is a rolling window that resets within hours rather
than at midnight. Each bar says when its window resets. Past 80% the figure takes
the warning colour and at 100% the error colour, and the same numbers travel in
`aria-valuetext`.

The quota endpoint is not part of the published API — it is what the console
calls — so the *shape* may move without notice. Every way it can be missing is
a sentence rather than a failure: a gateway that mirrors only the model surface
answers `404`, a key the service rejects answers `401`, and an unreachable host
answers nothing at all. In all three cases the local counters stay on screen and
the quota panel says which one happened. Opening the page reuses an answer for
`subscriptionCacheSeconds`; only **Re-read quota** forces a fresh call.

The counters below are the plugin's own. The harness reports tokens to whoever
made the call, and only the adapter knows which model a token went to and which
deployment paid for it. The page shows the result as totals, a per-model table,
and a per-day series.

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
| **A failure** | A call that ended in an error, including one the provider refused before any stream. |
| **The model** | The id the harness asked for, so a variant appears under its own alias. |
| **The day** | This machine's local calendar day, so a token spent at 23:00 belongs to the evening it was spent. |
| **The window** | 1, 7, or 30 days. The page can ask for nothing else; a 30-day retention window is dropped from the file as it is written. |
| **A write** | Debounced a few seconds and flushed on unload, so a stream never waits on an `fs` call and a reload does not lose the tail. |
| **Uncached input** | The part of the prompt the service did not serve from cache. Not the whole prompt: see below. |
| **Cache read / write** | What the service said it read from, and wrote to, its prompt cache. |
| **Hit rate** | Cache read ÷ (uncached input + cache read) — the share of the prompt that came from cache. Shown as `—` when no call reported a cache figure at all. |

A call whose stream the caller abandoned is not counted: this table is about what
the route spent, not about an outcome nobody observed. Counting starts before the
file is read, and the file is folded into what has been counted rather than
replacing it, so the first call after a restart is not thrown away by the write
that follows it. Every counter row is read through a default, so a field a newer
build added is zero in a file an older one wrote instead of becoming `NaN` and
poisoning everything written after it.

### What the input column means

The two service families disagree about what their prompt count contains, and the
figures above are only checkable if that disagreement is resolved the same way
every time. It is resolved the way the Harness resolves it: `inputTokens` is the
**uncached** input — the Harness's own token meter reads exactly this field under
the name `uncachedInputTokens`.

| Service family | What it sends | What this plugin records |
|---|---|---|
| OpenAI-shaped (`prompt_tokens_details`, `input_tokens_details`) | `prompt_tokens: 3689` with `cached_tokens: 3584` inside it | uncached input `105`, cache read `3584` |
| Anthropic-shaped (`cache_read_input_tokens`, `cache_creation_input_tokens`) | `input_tokens: 4`, cache reported beside it | uncached input `4`, cache read `2048` |

Both then add up the same way — uncached + output + read + write — so one total
formula is correct for both families.

Two further consequences show up as **wrong data** rather than as an error, so
they are worth knowing when the columns are used:

- **`0%` and `—` are different claims.** A service that reports "nothing was
  cached" supports a hit rate of 0%; a service that reports no cache figure at
  all does not, and gets `—`. The counters keep how many calls reported one, so
  the page can tell the two apart.
- **The Messages protocol announces its cache figures once.** They arrive in
  `message_start`, and every later `message_delta` talks about output alone. The
  two halves are merged field by field, so the cache figures survive.

Three further properties of this data:

- **It is a report, not a bill.** These are the figures the service reported to
  this client. The provider's own accounting of what a workspace spent is the
  authority.
- **Losing it is never a failure.** An unreadable file means no history yet, an
  unwritable one is one warning, and a call is never failed because its token
  count could not be saved.
- **It is per deployment.** Two profiles, or two machines, keep their own
  counters. Nothing here is shared, and nothing is sent anywhere.

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
| `name` | The variant's own name; `model@name` is the id it is offered under. The page leaves it optional: a name left blank becomes the thinking level the variant sets (then the protocol it leads with, then `default`). |
| `label` | Optional display name. |
| `protocol` | Optional. The protocol a call through this variant opens with; the model's other protocols stay behind it as fallbacks. |
| `effort` | Optional. The thinking level calls through this variant open with. The model must support reasoning, and must offer this level. |
| `contextWindow`, `maxTokens` | Optional. What the variant advertises instead of the model's own figures. |

The remaining rules:

- **A variant is a local alias.** The harness selects and reports
  `<model>@<name>`; the request on the wire still names `model`. Nothing about
  the provider's view of the model changes.
- **A variant inherits everything it does not restate**, including the base's
  capacity, modalities, reasoning ladder, and remaining protocols.
- **A variant whose `model` the catalog does not list is not offered**, and one
  startup warning names the ids.
- **A variant is a default, not a cage.** `effort` and `maxTokens` decide what a
  call opens with; a request that names its own values wins.
- **Two contradictions are refused at startup**, each by name: an effort on a
  model that does not support reasoning, and an effort the model does not offer.
- **An entry may carry only the keys above.** The page writes what it read plus
  your edits, and a key the config does not declare — a typo, or a field the
  snapshot happened to carry — is refused by name rather than written into
  `cordis.patch.yml`.

Everything else — protocol shaping, timeouts, retry policy, cache paths — stays
in `cordis.patch.yml`.

Two further properties of the configuration page:

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

That declaration follows the deployment's condition — see `sendImages` above. A
durable `ImageBlock` carries an attachment *reference*, and turning it into
request bytes needs the `attachments` service, so a route that cannot resolve one
reports text-only rather than declaring a capability it would fail to honour. The
provider's own list is never lost: the resolved description names whatever the
route cannot send.

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
