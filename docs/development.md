# Development

> Back to [README](../README.md).

Everything on this page is for contributors: how to verify the plugin and how
the code is laid out. Users who only configure the plugin can stop at
[Configuration](configuration.md).

## Verification

```sh
npm test          # 137 offline checks: config, SSE framing, catalog, all three protocols, adapter, plugin body
npm run test:cordis # 20 checks mounting the plugin on the harness's own cordis
npm run test:live # 20 checks against the real service; needs OC_KEY
```

`npm test` runs offline and needs no credential. The protocol suites replay
response bodies **captured from the live service** (`tests/golden/`), so they
fail if a translator stops agreeing with what OpenCode Go actually sends. Every
case assembles its chunks with the harness's own block assembler, which is the
same code the agent loop runs over them. One case compares the capacity snapshot
against whatever OpenCode catalogue the machine has cached, so a stale
`lib/model/limits.js` is reported instead of quietly drifting.

`npm run test:live` spends real quota. It proves, against the live relay: model
discovery and caching, a round trip over each of the three protocols, a full
tool-calling round trip per protocol, protocol fallback recovery, cache reuse on
a repeated session id, a history holding a tool call that was never dispatched,
that every model reports its own measured context window, cap, and modalities,
that every advertised reasoning effort is accepted, and that a workspace-gated
model either answers or is refused as needing that workspace's consent.

```sh
OC_KEY=oc_sk_... npm run test:live
# optional: OC_BASE, OC_CACHE to keep the discovery cache out of ~/.dsh
```

`npm run test:cordis` is the one that catches loader-level mistakes. It reads
the harness's own packages out of `app.asar`, mounts the plugin on the **real**
cordis the installation ships, and checks that activation produces no warning,
that the route registers on the real LLM runtime, that models and reasoning
efforts resolve through it, that a streamed call completes end to end, and that
unloading releases the route. Set `DSH_ASAR` if the installation lives
elsewhere; the suite skips cleanly when it cannot find one.

That suite exists because a plugin's exported `Config` is not free-form: cordis
calls `Config['~standard'].validate(raw)` before starting the plugin, so a
plain object there fails activation with
`Cannot read properties of undefined (reading 'validate')`. Nothing in an
isolated unit test would have caught that.

## Re-measuring the live facts

Two facts about this service are measured rather than published, and both have a
tracked probe. They need a key and spend real quota:

```sh
OC_KEY=oc_sk_... node scripts/probe-protocols.mjs [model ...]   # one probe per served model
OC_KEY=oc_sk_... node scripts/probe-image.mjs                   # image shapes, all three protocols
node scripts/snapshot-models.mjs [--write]                      # capacity snapshot vs the catalogue
```

`probe-protocols.mjs` answers `served=[…]` per model, which is what
`FALLBACK_MODELS` is written from. `probe-image.mjs` posts a generated PNG over
each protocol and checks the model can actually read it, which is what makes an
`image` declaration honest; its image is written to `.live-cache/probe-image.png`
(untracked scratch). `snapshot-models.mjs` prints what changed since the snapshot
was taken — `new`, `changed`, `gone` — and rewrites the two tables with `--write`.

## Architecture

```
lib/
├── index.js                  adapter class, registration, health check
├── config.js                 schema, defaults, validation
├── error/
│   ├── errors.js             the failure type and brand helpers this plugin owns
│   └── mapping.js            HTTP status / transport failure → stable code
├── model/
│   ├── catalog.js            the measured protocol map and record merging
│   ├── limits.js             the measured capacity and modality snapshot
│   ├── cache.js              GET /models, memory + on-disk cache
│   ├── capabilities.js       records → harness model metadata
│   └── images.js             durable references → request bytes
├── protocol/
│   ├── shared.js             block accumulation and terminal sequencing
│   ├── chat-completions.js
│   ├── responses.js
│   └── anthropic-messages.js
├── session/headers.js        x-opencode-session and request identity
├── stream/sse.js             byte-level SSE framing
└── transform/
    ├── messages.js           content blocks → each protocol's messages
    ├── tools.js              tool schemas → each protocol's declarations
    └── reasoning.js          harness effort → each protocol's spelling

scripts/
├── snapshot-models.mjs       refresh lib/model/limits.js from the catalogue
├── probe-protocols.mjs       measure which protocol each served model accepts
└── probe-image.mjs           measure the image request shape per protocol
```

Adding a fourth protocol means one new file under `protocol/` and one entry in
the transport map — not a rewrite.
