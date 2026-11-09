# Changelog

> Chinese version: [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

Every released version has a section here, and that section is what its GitHub release page carries. The newest release comes first.

## 0.2.5 — 2026-11-10

### Added

- **The sidebar capsule can be switched off.** `showQuotaCapsule` hides the quota row at the sidebar's foot; the usage panel, its shortcut and the Settings tab stay, so hiding the row does not close the way back to it.

### Changed

- **The offline-check count is checked, not only written.** `npm test` now compares the README badges and the two development pages with the run it has just finished, and fails when the two disagree.

### Fixed

- **A reasoning-only assistant turn is not sent.** An interrupted step could leave one behind; Chat Completions sent it as `content: null`, the relay refused the whole request, and every later turn failed too. Chat Completions and Messages now drop the turn, as Responses already did.
- **A long generation outlives the connect deadline.** `timeoutMs` capped the whole attempt, so a stream that kept producing was still cut off; the response body now leaves the idle deadline to `streamIdleTimeoutMs`, and a deadline during the stream is a retryable timeout rather than a caller abort.
- **A save the row has not reflected yet is reported as stale.** The page compares every written value with the row it re-read and waits one more beat before calling the write stale, instead of reporting a read-back that failed as saved.
- **The patch file lists `sendImages`.** The field list an operator reads is complete, and points at `docs/configuration.md` for the detail.
- 464 offline checks, up from 450.

## 0.2.4 — 2026-11-08

### Added

- **The configuration page is the Harness settings page.** It uses the native sections, fields, switches and tables; only the key and the model card keep a Save button.
- **Transport and retry settings are editable on the page.** One block covers the large-body switch, the two deadlines and the retry policy; a first delay longer than the longest is refused before it is written.
- **Usage history is complete and pageable.** Range, size and number-format menus; every recorded day can be paged to, and compact units are the default.
- **Failures leave a diagnostics record.** One metadata-only JSONL line per failed attempt in `~/.dsh/logs/opencode-go.jsonl`; `diagnostics: all` records successes too, and the file rotates at 1 MB.

### Changed

- **Model facts come from the service.** Discovery keeps the name, description, limits, modalities, reasoning ladder and preferred protocol from `GET /models`; the `models.dev` snapshot answers only when discovery has nothing.
- **The built-in catalog is append-only.** A retired model keeps its row, marked `retired`, out of the picker but still resolvable; only a live listing brings it back.
- **Two failures are named.** `MODEL_DEPRECATED` carries the replacement the service names and `MODEL_UNAVAILABLE` covers a model the relay no longer serves; the fallback catalogue is re-measured at 30 served models and 15 retired rows.

### Fixed

- **A tool result's picture travels beside the chat tool string.** The chat message stays a plain string, and a grouped image turn follows the last result.
- **DeepSeek thinking calls replay their reasoning on the Responses wire.** The replay is derived per provider family; other providers still send none.
- **System messages reach Responses as instructions.** `GenerateOptions.system` and system-role messages are collected, not dropped.
- **Large request bodies can travel on a fresh connection.** `freshConnectionOnLargeBody` is off by default and decides whether a body over its threshold opens its own connection.
- 450 offline checks, up from 427.

## 0.2.3 — 2026-10-07

### Changed

- A cleanup pass: the pages say what the code does, no note written for this checkout ships with the package, and the published artifact can publish itself.

## 0.2.2 — 2026-10-06

An interface release, and the release process is part of it: the quota rhythm is editable on the page, the capsule's gear opens the settings dialog rather than the plugins list, and a tag publishes the package and its notes without a stored token.

### Fixed

- **The quota rhythm section reads as one row.** Its two intervals are labelled *Shortest/Longest quota update interval*, share a line at the same width, and no longer carry the three explanatory paragraphs; a row that reports no intervals at all says so instead of waiting on them forever.
- **The capsule's gear opens Settings on the plugin's row, not the Plugins page.** It presses the shell's own way in — its trigger, or the account launcher's *Settings* row where a package has taken that seat — then this plugin's nav row; the usage panel's *Plugin settings* button does the same, and both fall back to the Plugins page where the shell answers neither press.

### Added

- **The quota rhythm is editable on the page.** The two intervals were config-file-only; they now have a section of their own, saved as one setting, with a floor above its ceiling refused where the reader can see it.
- **A tag publishes the release.** `release.yml` checks the tag against the manifest, re-runs the suite, and publishes to npm through trusted publishing — no token is stored — then opens the release page from the changelog section.
- **`npm run check:pack`**, which packs the tarball and reads it, because `files` is an allowlist whose two failure modes are both silent.
- **The activation suite runs in CI**, on the harness packages from npm when no DSH installation is present.
- **CI reads either line ending.** A checkout on Windows has CRLF by default, and the suite's workflow parser found nothing in one — worth a case, since that reads as "CI does not run the tests" on one platform only.
- **The workflows use current actions.** `checkout` and `setup-node` moved to v7, which is what makes the publish path OIDC alone: before v7 `setup-node` left a dummy `NODE_AUTH_TOKEN` in the environment.

### Changed

- 398 offline checks, up from 370.
- **The workflows are checked too**, by a new `ci` suite: an action pinned to a branch, a tab in the YAML, or a release that could publish before comparing the tag with the manifest fails the suite rather than a release.

## 0.2.1 — 2026-10-06

Four fixes to one theme: what a surface showed was not always what was true.

### Fixed

- **A tool's image reaches the model.** `read_image` answers with an envelope and the picture itself, and every protocol sent the envelope alone; the image now travels inside the tool result, on all three wires.
- **The capsule follows a re-read.** The four surfaces that draw the quota shared one reader but not one answer, so *re-read quota* moved the surface it was pressed on and left the others as they were.
- **The counters follow a re-read too.** The three surfaces that draw them each kept a copy; the table for a window is shared now, though which window a surface shows is still its own.
- **A hit rate under half is no longer green on the panel**, where the configuration page had always drawn it plain.

### Added

- **Two intervals for the quota schedule**, `subscriptionMinIntervalSeconds` (30) and `subscriptionMaxIntervalSeconds` (1800): the capsule checks on the floor while calls are being made and on the ceiling while they are not, asking a memory-only endpoint, `GET /opencode-go/activity`, in between.
- **The image shapes a tool result needs**, measured per protocol and re-checkable with `scripts/probe-image.mjs`, which probes both routes now.

### Changed

- 370 offline checks, up from 349.

## 0.2.0 — 2026-10-06

An interface release: the usage panel can be dismissed, the configuration page is reachable from Settings, and the package card reads in Chinese. The adapter's behaviour is unchanged from 0.1.1.

### Added

- **The package card in Chinese.** `locale/zh.json` and `locale/en.json` ship with the package; the Harness reads them without activating the plugin, and a language with no file falls back to the manifest.
- **The usage panel can be dismissed.** Its title row is pinned to the top of the scroll and carries a **×** that returns to the Conversation.
- **The configuration page sits in Settings.** It is a row of Settings' own navigation, beside the pages the shell ships.

### Changed

- **A pass over the panel's copy and layout.** Shorter sentences, shared by the configuration page, the usage panel and the settings tab; *re-read quota* moved beside the heading it belongs to.
- **Model variants: fields fold away.** A row's fields sit behind its **Edit** control, and the add form keeps its fields together with the name rules under them.
- **The training-gate badge** now reads *conversations used for training*, in the warning colour.
- **The credential-reference hint** now says what it sets.
- **The changelog ships in English and Chinese**, and both files go into the published package, held in step by a case.
- 349 offline checks, up from 331.
- Both development pages name all six files that restate the check count.

## 0.1.1 — 2026-10-05

Documentation and test-infrastructure release. The adapter's behaviour is unchanged from 0.1.0.

### Fixed

- **The version the configuration page shows.** `PLUGIN_IDENTITY.version` restates the package version and is handed to the web client, and nothing checked it against the manifest — a release that moved `package.json` and missed this constant would have shown the reader a version that was never published. It reads correctly now, and a test keeps it that way.

### Added

- **A `release` suite, so a version bump is self-checking.** The version is stated in nine places across the shipped surface. The suite reads the manifest and fails, naming the file, on any place still stating the version a release left behind: the two constants the plugin reports, the lock file, the development page's status table, and the `User-Agent` example in the protocol page.
- **CI**, on every push and pull request: the offline suite on Node 20, 22 and 24 on Linux and on Node 22 on Windows. It needs no credential and spends no quota, which is why the cordis and live suites are not in it.

### Changed

- The version expectations in the `config` suite are derived from the manifest rather than written out, so a bump no longer edits four assertions by hand.
- Both READMEs carry badges: npm version, npm downloads, the offline check count, CI and license. The `awesome · DSH plugin` badge is absent on purpose — it would claim a listing this package does not have yet.
- 331 offline checks, up from 326.

## 0.1.0 — 2026-10-03

First release, published to npm as `dsh-llm-opencode-go`.

### Added

- **Provider route** — OpenCode Go (`https://opencode.ai/zen/go/v1`) registered on the harness LLM runtime under the `opencode-go` route id (configurable), with a runtime health check that reports the base URL and credential reference.
- **Three wire protocols** — OpenAI Responses, OpenAI-compatible Chat Completions, and Anthropic Messages, each implemented by the plugin: harness messages, tools and reasoning are translated into the protocol's request, and its streamed response is translated back into DSH `StreamChunk` values.
- **Model discovery** — `GET /models` with an in-memory and an on-disk cache, a built-in fallback catalog, and per-model protocol selection measured against the live service.
- **`x-opencode-session`** — one stable id per conversation, derived from the DSH session id by default, which is what keeps a conversation's turns on the same upstream backend and the same prompt cache.
- **Tool calling** — a full round trip for every dispatched call: definitions, fragmented arguments, tool results, and the follow-up turn.
- **Reasoning** — per-protocol effort mapping, including Anthropic thinking budgets.
- **Streaming** — SSE to `StreamChunk` with usage, finish reason, and an idle watchdog.
- **Failures** — provider-neutral codes (`AUTH`, `RATE_LIMIT`, `QUOTA`, `CONTEXT_WINDOW_EXCEEDED`, …) so the harness can act on a failure without knowing which protocol produced it.
- **Configuration page** — a page in the web client's Plugins list: API key, credential reference, per-model visibility, model variants, re-reading the service's model list, and what this route has spent. The key goes to the credential store, never into `cordis.patch.yml`.
- **Usage entries** — the quota capsule at the sidebar's foot (one ring per window: `5H / Wk / Mo`), a usage panel of its own, and a usage tab under Settings.
- **Test suites** — 326 offline checks across config, SSE framing, catalog, all three protocols, the adapter, the plugin body, the settings bridge and the client bundle, replaying response bodies captured from the live service (`tests/golden/`); 43 further checks mounting the plugin on the harness's own cordis; and a live suite that spends real quota.
- **Zero runtime dependencies** — the adapter implements the harness contract with its own error and brand helpers, so it installs into any DSH version.
