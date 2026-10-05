# dsh-llm-opencode-go

**English** | [简体中文](README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/dsh-llm-opencode-go)](https://www.npmjs.com/package/dsh-llm-opencode-go)
[![npm downloads](https://img.shields.io/npm/dm/dsh-llm-opencode-go)](https://www.npmjs.com/package/dsh-llm-opencode-go)
[![offline checks](https://img.shields.io/badge/offline_checks-344-brightgreen)](docs/development.md#verification)
[![ci](https://github.com/a2580vb/dsh-llm-opencode-go/actions/workflows/ci.yml/badge.svg)](https://github.com/a2580vb/dsh-llm-opencode-go/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Introduction

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin that serves **OpenCode Go** (`https://opencode.ai/zen/go/v1`) as a native
DSH model provider.

The plugin implements OpenCode Go's three wire formats itself: it translates
harness messages, tools, and reasoning into each protocol's request, and
translates the streamed response back into DSH `StreamChunk` values.

```yaml
- insert:
    - id: opencode-go
      name: dsh-llm-opencode-go
      config:
        apiKeyEnv: OPENCODE_GO_API_KEY
```

That is the whole required configuration. `apiKeyEnv` names a **credential
reference**, not the key itself: the key value never enters the config file, and
the plugin resolves the reference through the harness credential seam on every
request, so a key written by the web Models page reaches the next call with no
restart.

## Features

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
| **Runtime** | Node.js ≥ 20; no runtime dependencies |

## Install and use

### Install

```sh
dsh plugin add dsh-llm-opencode-go
```

Then **fully restart** the profile: bundle layers are read at startup. The startup
log should carry:

```
dsh-llm-opencode-go: provider "opencode-go" ready at https://opencode.ai/zen/go/v1 (credential OPENCODE_GO_API_KEY, models discover)
```

### Give it a key

Either export `OPENCODE_GO_API_KEY` in the environment that launches DSH, or
store it through the credentials seam — the web Models page writes it. The plugin
resolves the reference per request, so both work and neither requires a restart.

### See the usage

Usage has three entries, all reading the same facts:

| Entry | Where |
|---|---|
| **The quota capsule at the sidebar's foot** | Beside Settings. One row, three groups — `◉ 5H 92% │ ◉ 周 58% │ ◉ 月 9%` — visible without a click; that row opens the usage panel, and the gear beside it opens the plugin's configuration page. |
| **The usage panel** | From that row, or the keyboard (desktop `Ctrl/Cmd+U`): the subscription's three windows first, this route's counters under them, and a button in its header that goes straight to the plugin's configuration page. |
| **Settings → Plugins → OpenCode Go usage** | A tab inside the settings panel, carrying the same content as the panel. |

All three need the web client; a deployment without one has none of them and is
otherwise unchanged. See [Configuration](docs/configuration.md#fast-entries).

## Configuration

The `config` block above is all that is required; every other key is optional.
The full field table, catalog shaping, and image input live in
[Configuration](docs/configuration.md).

**Point it at another credential reference**, if you would rather the plugin read
a differently-named variable:

```yaml
config:
  apiKeyEnv: OC_KEY
```

The value is never read from the config file itself, only the variable *name*.

**Or configure it from the web client.** The sidebar's **Plugins** page lists the
`dsh-llm-opencode-go` bundle, and its `opencode-go` row has a **Configure**
control that opens the plugin's own page: the API key, the credential reference
it is stored under, one switch per catalog model for what the picker offers, the
model variants, a control that re-reads the service's model list, and what this
route has spent. The key is written to the credential store, never to
`cordis.patch.yml`, and the page is mounted only by a deployment that serves the
web client. See
[Configuration](docs/configuration.md#graphical-configuration).

## Docs

Details live under [`docs/`](docs/models.md); start with what you need:

- [Models](docs/models.md) — per-model protocol table, training-data gate, capacity snapshot, text/image split
- [Configuration](docs/configuration.md) — full field table, shaping the catalog, image input, the graphical and fast entries
- [Wire protocol](docs/wire-protocol.md) — endpoints and auth, `x-opencode-session`, reasoning and tool-calling translations
- [Reliability](docs/reliability.md) — stable failure codes and limits
- [Development](docs/development.md) — project status, verification suites, re-measure probes, architecture

## License

MIT
