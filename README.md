# dsh-llm-opencode-go

**English** | [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin that serves **OpenCode Go** (`https://opencode.ai/zen/go/v1`) as a native
DSH model provider.

It is a complete LLM adapter, not a proxy: it owns the wire for all three
protocols OpenCode Go serves, translates harness messages, tools, and reasoning
into each one, and translates the streamed response back into DSH
`StreamChunk` values.

```yaml
- insert:
    - id: opencode-go
      name: dsh-llm-opencode-go
      config:
        apiKeyEnv: OPENCODE_GO_API_KEY
```

That is the whole required configuration. The API key value never enters the
config file: `apiKeyEnv` names a **credential reference** resolved through the
harness credential seam on every request, so a key written by the web Models
page reaches the next call with no restart.

## What it does

| | |
|---|---|
| **Provider route** | `opencode-go` (configurable) |
| **Protocols** | OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages |
| **Model discovery** | `GET /models`, with a memory + on-disk cache |
| **Session affinity** | `x-opencode-session`, one stable id per conversation |
| **Tool calling** | Full round trip for every dispatched call: definitions, fragmented arguments, tool results, follow-up turn |
| **Reasoning** | Per-protocol effort mapping, including Anthropic thinking budgets |
| **Streaming** | SSE → `StreamChunk`, with usage, finish reason, and an idle watchdog |
| **Failures** | Stable provider-neutral codes (`AUTH`, `RATE_LIMIT`, `QUOTA`, `CONTEXT_WINDOW_EXCEEDED`, …) |
| **Configuration UI** | A page in the web client's Plugins list: API key, credential reference, model visibility, model variants, fetching the model list, usage |
| **Fast entries** | A quota capsule at the sidebar's foot (one ring per window — `5H / Wk / Mo` — with what is left of each), a usage panel of its own (from that row, or the keyboard), and a usage page under Settings |
| **Runtime dependencies** | none |

## Install

### From npm (recommended)

```sh
dsh plugin add dsh-llm-opencode-go
```

### From a local checkout

```sh
dsh plugin add /path/to/opencodego-transfrom
```

Then **fully restart** the profile: bundle layers are read at startup. Verify the
startup log:

```
dsh-llm-opencode-go: provider "opencode-go" ready at https://opencode.ai/zen/go/v1 (credential OPENCODE_GO_API_KEY, models discover)
```

### Give it a key

Either export `OPENCODE_GO_API_KEY` in the environment that launches DSH, or
store it through the credentials seam — the web Models page writes it. The
plugin resolves the reference per request, so both work and neither requires a
restart.

### See the usage at any time

Usage should not require a walk through the Plugins page. The sidebar's foot
carries the number at all times, and two more places carry the detail:

| Entry | Where |
|---|---|
| **The quota capsule at the sidebar's foot** | Beside Settings. One row, three groups — `◉ 5H 92% │ ◉ 周 58% │ ◉ 月 9%` — at a glance; that row opens the usage panel, and the gear beside it opens the configuration page above. |
| **The usage panel** | From those lines, or the keyboard (desktop `Ctrl/Cmd+U`): the subscription's three windows first, this route's counters under them, and a button in its header that goes straight to the plugin's configuration page. It keeps no sidebar row of its own — the capsule already holds that number, and one number wants one door. |
| **Settings → Plugins → OpenCode Go usage** | A tab inside the settings panel, carrying the same content as the panel. |

All three need the web client, the same as the configuration page; a deployment
without one has none of them and is otherwise unchanged. See
[Configuration](docs/configuration.md#fast-entries).

### Or use the plugin's own page

The sidebar's **Plugins** page lists the `dsh-llm-opencode-go` bundle, and its
`opencode-go` row has a **Configure** control that opens the plugin's own page:
the API key, the credential reference it is stored under, one switch per catalog
model for what the picker offers, the model variants, a control that re-reads the
service's model list, and what this route has spent. The key is written to the
credential store, never to `cordis.patch.yml`, and the page is offered only by a
deployment that serves the web client. See
[Configuration](docs/configuration.md#graphical-configuration).

If you would rather the plugin read a differently-named variable, point
`apiKeyEnv` at it:

```yaml
config:
  apiKeyEnv: OC_KEY
```

The value is never read from the config file itself, only the variable *name*.

## Docs

Details live under [`docs/`](docs/models.md); start with what you need:

- [Models](docs/models.md) — per-model protocol table, training-data gate, capacity snapshot, text/image split
- [Configuration](docs/configuration.md) — full field table, shaping the catalog, image input
- [Wire protocol](docs/wire-protocol.md) — endpoints and auth, `x-opencode-session`, reasoning and tool-calling translations
- [Reliability](docs/reliability.md) — stable failure codes and limits
- [Development](docs/development.md) — verification suites, re-measure probes, architecture

Quick check:

```sh
npm test          # offline, no credential needed
```

See [Development](docs/development.md) for the cordis and live suites.

## License

MIT
