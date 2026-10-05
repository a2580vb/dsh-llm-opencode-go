# Changelog

Releases carry the notes that appear on the GitHub release and, through it, on the
plugin market's **What changed** link. Keep the newest section at the top and give
every released version one.

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
