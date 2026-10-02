# dsh-opencode-go

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
      name: dsh-opencode-go
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
| **Runtime dependencies** | none |

## Install

From this checkout:

```sh
dsh plugin --profile desktop add L:\e2\dsh-plugin\opencodego-transfrom
```

Then **fully restart** the profile: bundle layers are read at startup. Verify the
startup log:

```
dsh-opencode-go: provider "opencode-go" ready at https://opencode.ai/zen/go/v1 (credential OPENCODE_GO_API_KEY, models discover)
```

### Give it a key

Either export `OPENCODE_GO_API_KEY` in the environment that launches DSH, or
store it through the credentials seam — the web Models page writes it. The
plugin resolves the reference per request, so both work and neither requires a
restart.

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
