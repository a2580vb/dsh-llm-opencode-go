# Wire protocol

> Back to [README](../README.md).

This page describes what crosses the wire: the three endpoints and their auth,
the session affinity header, and how reasoning and tool calls are translated per
protocol.

## Endpoints and auth

| Protocol | Path | Auth |
|---|---|---|
| Chat Completions | `POST {baseURL}/chat/completions` | `Authorization: Bearer <key>` |
| Responses | `POST {baseURL}/responses` | `Authorization: Bearer <key>` |
| Messages | `POST {baseURL}/messages` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |

The Messages endpoint uses its own header set: it refuses a bearer token with
`AuthError: Missing API key`.

Every request also carries:

```http
User-Agent: dsh-opencode-go/0.2.2
x-opencode-session: <stable per-conversation id>
x-opencode-client: dsh-opencode-go
```

Both product tokens above are the `userAgentProduct` default, and their value
differs from the package name `dsh-llm-opencode-go`; set `userAgentProduct` to any
value you want instead.

## `x-opencode-session`

OpenCode's relay pins every request sharing one `x-opencode-session` value to the
same upstream backend, which is how the turns of one conversation keep hitting the
same prompt cache. The value only has to be opaque and stable **per conversation**
— one fixed value for every session would put them all on a shared cache lineage.
The plugin derives it from the DSH session id that already travels with each call:

- `session-id` (default) — the DSH session id: unique per conversation, stable
  across turns, compaction, retries, and process restarts.
- `uuid` — an opaque random UUID derived once per session id and remembered for
  the process, for deployments that would rather not send the harness id.
- `off` — send nothing. The plugin warns at startup: OpenCode may then refuse the
  request or lose cache affinity.

An auxiliary call with no session id (session-title generation) still gets a
per-process fallback value rather than an absent header.

## Reasoning

Each protocol spells thinking differently, and the relay validates the spelling,
so one function owns the translation:

| Protocol | Field | Accepted levels |
|---|---|---|
| Chat Completions | `reasoning_effort` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| Responses | `reasoning.effort` | `low`, `medium`, `high`, `xhigh`, `max` (`minimal` is refused) |
| Messages | `thinking.budget_tokens` | mapped from the level: 1024 / 4096 / 8192 / 16384 / 32768 / 64000 |

A model's resolved metadata advertises only the levels its protocol can express,
because the runtime validates a requested effort against that set before any
network I/O. The Anthropic budget is clamped strictly below `max_tokens`; if the
output cap cannot hold even the smallest budget, thinking is omitted rather than
sent as a request the API would reject.

Reasoning **history** is replayed where the protocol supports it: Chat
Completions takes `reasoning_content` back, and Messages takes thinking blocks
with the signature the provider issued (addressed by the block's exact text, and
degraded to plain text when no signature was retained). The Responses API takes
none, because a reasoning item is validated against upstream state the harness
does not retain. Set `disableReasoningReplay: true` to send no reasoning history
on any protocol.

## Tool calling

Tools cross the wire in each protocol's own spelling — flat declarations with a
`function_call`/`function_call_output` pair on Responses, the `function` wrapper
with `tool_calls` and `role: "tool"` on Chat Completions, `tool_use`/`tool_result`
blocks on Messages — and a conversation is replayed the same way it was answered.

A result's content converts the way a user turn's does, which is what lets a tool
hand back an image: `read_image` answers with an envelope and the picture itself,
and the picture travels inside the result — as `content` parts on the tool
message, as `output` parts on the `function_call_output` item, or as `content`
blocks inside the `tool_result` — never as a message of its own. All three shapes
were measured against the live service; see
[Models](models.md#modalities-what-the-model-takes-versus-what-a-route-can-send).

One rule governs all three translations, because all three wires enforce it: **a
call and its result are sent together or not at all.** The Responses API answers
an unanswered call with `400 No tool output found for tool call <id>`, Chat
Completions requires the turn after an assistant's `tool_calls` to answer every
id it issued, and Messages refuses a `tool_use` block with no `tool_result`. A
history can hold a call with no result — the harness records the model's
`tool-call`, and a process that stops before dispatch never appends one — so the
converters survey the whole history before emitting anything and omit the half
that has no partner. See [Reliability](reliability.md#limits).
