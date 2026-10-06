# Changelog

> Chinese version: [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

Releases carry the notes that appear on the GitHub release and, through it, on the
plugin market's **What changed** link. Keep the newest section at the top, give
every released version one, and keep each entry to a line if it fits.

## 0.2.1 — 2026-10-06

Four fixes to one theme: what a surface showed was not always what was true. The
release itself is now a tag, and the package it produces is checked.

### Fixed

- **A tool's image reaches the model.** `read_image` answers with an envelope and
  the picture itself, and every protocol sent the envelope alone; the image now
  travels inside the tool result, on all three wires.
- **The capsule follows a re-read.** The four surfaces that draw the quota shared
  one reader but not one answer, so *re-read quota* moved the surface it was
  pressed on and left the others as they were.
- **The counters follow a re-read too.** The three surfaces that draw them each
  kept a copy; the table for a window is shared now, though which window a
  surface shows is still its own.
- **A hit rate under half is no longer green on the panel**, where the
  configuration page had always drawn it plain.

### Added

- **Two intervals for the quota schedule**, `subscriptionMinIntervalSeconds` (30)
  and `subscriptionMaxIntervalSeconds` (1800): the capsule checks on the floor
  while calls are being made and on the ceiling while they are not, asking a
  memory-only endpoint, `GET /opencode-go/activity`, in between.
- **The image shapes a tool result needs**, measured per protocol and
  re-checkable with `scripts/probe-image.mjs`, which probes both routes now.
- **A tag publishes the release.** `release.yml` checks the tag against the
  manifest, re-runs the suite, and publishes to npm through trusted publishing —
  no token is stored — then opens the release page from the changelog section.
- **`npm run check:pack`**, which packs the tarball and reads it, because
  `files` is an allowlist whose two failure modes are both silent.
- **The activation suite runs in CI**, on the harness packages from npm when no
  DSH installation is present.
- **CI reads either line ending.** A checkout on Windows has CRLF by default, and
  the suite's workflow parser found nothing in one — worth a case, since that
  reads as "CI does not run the tests" on one platform only.

### Changed

- 382 offline checks, up from 349.
- **The workflows are checked too**, by a new `ci` suite: an action pinned to a
  branch, a tab in the YAML, or a release that could publish before comparing the
  tag with the manifest fails the suite rather than a release.

## 0.2.0 — 2026-10-06

An interface release: the usage panel can be dismissed, the configuration page is
reachable from Settings, and the package card reads in Chinese. The adapter's
behaviour is unchanged from 0.1.1.

### Added

- **The package card in Chinese.** `locale/zh.json` and `locale/en.json` ship with
  the package; the Harness reads them without activating the plugin, and a
  language with no file falls back to the manifest.
- **The usage panel can be dismissed.** Its title row is pinned to the top of the
  scroll and carries a **×** that returns to the Conversation.
- **The configuration page sits in Settings.** It is a row of Settings' own
  navigation, beside the pages the shell ships.

### Changed

- **A pass over the panel's copy and layout.** Shorter sentences, shared by the
  configuration page, the usage panel and the settings tab; *re-read quota* moved
  beside the heading it belongs to.
- **Model variants: fields fold away.** A row's fields sit behind its **Edit**
  control, and the add form keeps its fields together with the name rules under
  them.
- **The training-gate badge** now reads *conversations used for training*, in the
  warning colour.
- **The credential-reference hint** now says what it sets.
- **The changelog ships in English and Chinese**, and both files go into the
  published package, held in step by a case.
- 349 offline checks, up from 331.
- Both development pages name all six files that restate the check count.

## 0.1.1 — 2026-10-05

Documentation and test-infrastructure release. The adapter's behaviour is unchanged
from 0.1.0.

### Fixed

- **The version the configuration page shows.** `PLUGIN_IDENTITY.version` restates
  the package version and is handed to the web client, and nothing checked it
  against the manifest — a release that moved `package.json` and missed this
  constant would have shown the reader a version that was never published. It
  reads correctly now, and a test keeps it that way.

### Added

- **A `release` suite, so a version bump is self-checking.** The version is stated
  in nine places across the shipped surface. The suite reads the manifest and
  fails, naming the file, on any place still stating the version a release left
  behind: the two constants the plugin reports, the lock file, the development
  page's status table, and the `User-Agent` example in the protocol page.
- **CI**, on every push and pull request: the offline suite on Node 20, 22 and 24
  on Linux and on Node 22 on Windows. It needs no credential and spends no quota,
  which is why the cordis and live suites are not in it.

### Changed

- The version expectations in the `config` suite are derived from the manifest
  rather than written out, so a bump no longer edits four assertions by hand.
- Both READMEs carry badges: npm version, npm downloads, the offline check count,
  CI and license. The `awesome · DSH plugin` badge is absent on purpose — it would
  claim a listing this package does not have yet.
- 331 offline checks, up from 326.

## 0.1.0 — 2026-10-03

First release, published to npm as `dsh-llm-opencode-go`.

### Added

- **Provider route** — OpenCode Go (`https://opencode.ai/zen/go/v1`) registered on
  the harness LLM runtime under the `opencode-go` route id (configurable), with a
  runtime health check that reports the base URL and credential reference.
- **Three wire protocols** — OpenAI Responses, OpenAI-compatible Chat Completions,
  and Anthropic Messages, each implemented by the plugin: harness messages, tools
  and reasoning are translated into the protocol's request, and its streamed
  response is translated back into DSH `StreamChunk` values.
- **Model discovery** — `GET /models` with an in-memory and an on-disk cache, a
  built-in fallback catalog, and per-model protocol selection measured against the
  live service.
- **`x-opencode-session`** — one stable id per conversation, derived from the DSH
  session id by default, which is what keeps a conversation's turns on the same
  upstream backend and the same prompt cache.
- **Tool calling** — a full round trip for every dispatched call: definitions,
  fragmented arguments, tool results, and the follow-up turn.
- **Reasoning** — per-protocol effort mapping, including Anthropic thinking budgets.
- **Streaming** — SSE to `StreamChunk` with usage, finish reason, and an idle
  watchdog.
- **Failures** — provider-neutral codes (`AUTH`, `RATE_LIMIT`, `QUOTA`,
  `CONTEXT_WINDOW_EXCEEDED`, …) so the harness can act on a failure without knowing
  which protocol produced it.
- **Configuration page** — a page in the web client's Plugins list: API key,
  credential reference, per-model visibility, model variants, re-reading the
  service's model list, and what this route has spent. The key goes to the
  credential store, never into `cordis.patch.yml`.
- **Usage entries** — the quota capsule at the sidebar's foot (one ring per window:
  `5H / Wk / Mo`), a usage panel of its own, and a usage tab under Settings.
- **Test suites** — 326 offline checks across config, SSE framing, catalog, all
  three protocols, the adapter, the plugin body, the settings bridge and the client
  bundle, replaying response bodies captured from the live service
  (`tests/golden/`); 43 further checks mounting the plugin on the harness's own
  cordis; and a live suite that spends real quota.
- **Zero runtime dependencies** — the adapter implements the harness contract with
  its own error and brand helpers, so it installs into any DSH version.
