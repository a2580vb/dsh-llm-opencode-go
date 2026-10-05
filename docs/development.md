# Development

> Back to [README](../README.md).

This page is for contributors: the project's current status, how to verify the
plugin, how to re-measure the live facts, and how the code is laid out.

## Project status

| | |
|---|---|
| **Version** | 0.2.0 (package `dsh-llm-opencode-go`) |
| **Protocol map** | Measured per model against the live service; kept in `lib/model/catalog.js` |
| **Capacity and modalities** | A snapshot of the OpenCode catalogue (`models.dev`), dated in `CAPABILITY_SOURCE` in `lib/model/limits.js` (currently `models.dev/opencode-go@2026-10-02`) |
| **Known limits** | See [Reliability](reliability.md#limits) and [Models](models.md) |

## Verification

```sh
npm test            # 370 offline checks: config, SSE framing, catalog, all three protocols, adapter, plugin body, the settings bridge, the client bundle, the display metadata and release coherence
npm run test:cordis # 43 checks mounting the plugin on the harness's own cordis
npm run test:live   # the live suite; needs OC_KEY
```

The count above is restated in both README badges, in this page, in its Chinese
counterpart, and in both changelog files, so a new case moves it in six files.
`release` is the suite that keeps a version bump honest: it reads the manifest and
fails on any place that still states the version a release left behind.

`npm test` runs offline and needs no credential. The protocol suites replay
response bodies **captured from the live service** (`tests/golden/`), so they
fail if a translator stops agreeing with what OpenCode Go actually sends. Every
case assembles its chunks with the harness's own block assembler, which is the
same code the agent loop runs over them. One case compares the capacity snapshot
against whatever OpenCode catalogue the machine has cached, so a stale
`lib/model/limits.js` is reported.

The scratch files these suites write live in `.test-cache/`, a gitignored corner
of the checkout, and their paths come from `tests/suites/_scratch.mjs`: one
directory per case, removed when that case ends, under a name carrying a token
minted for the run. A run that dies before its own cleanup therefore cannot leave
behind the file a later run opens.

The suites that cover the configuration page run offline as well:

- The **bridge suite** drives the real HTTP handler with fake request/response
  pairs, so routing, the request fence, validation, and every refusal path are
  checked without a socket.
- The **client suite** compiles `lib/client.js` in a `node:vm` sandbox whose
  `window` is the module-loader facade, then checks the factory id, the
  `<package>#<row>` slot key (read from `cordis.patch.yml`), a complete
  dictionary for both shipped locales, and that the endpoints it calls are
  exactly the ones the bridge serves.
- The **page suite** renders the page: `tests/suites/_client-harness.mjs` is a
  small React stand-in with working hooks, so the suite can open the page, type
  into its fields, press its controls, and read what a person would see. It
  checks that a save writes the config shape rather than the snapshot it read,
  that a window switch reads the window the reader chose, that a disabled control
  is inert, and that a failure is reported in the reader's own words. It
  evaluates the bundle once and materializes its factory once, the way the
  browser's module loader memoizes a package, and gives each registered slot a
  hook store of its own — which is what lets a case watch one surface's read
  reach the other one drawing the same fact.
- The page's **clock is the suite's**. Delays the page would wait at most a
  second for — the beat after a write — still run themselves, and anything longer
  waits for `page.advance(ms)`, which walks the scheduled work in due order so a
  case can ask what the quota schedule does at thirty seconds, at half an hour, or
  over ten minutes of a busy session. `page.surface(name).close()` is the other
  half of that: it unmounts a surface, so a case can watch what stops when the
  last one goes.

Two checks in the page suite are **structural**, and they double as rules for new
code — a stylesheet here is a plain object, not CSS, so a mistake is easy to write
and hard to see:

- **A `flex` basis is a width in a row container and a height in a column one.**
  So do not put a basis on a control: size the label (the flex item of the row)
  and let the control fill it with `styles.fieldInput`, which sets
  `flex: 'none'`. The suite walks the rendered tree, finds every
  control inside a column ancestor, and refuses any that carries a basis.
- **A placeholder that does not fit is a cut-off sentence.** The suite estimates
  each placeholder against the width its column declares, so a long hint is
  caught here. Rules about accepted input belong in the hint text under the
  field, where they can wrap and be read.

`npm run test:live` spends real quota. It checks, against the live relay: model
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

`npm run test:cordis` reads the harness's own packages out of `app.asar`, mounts
the plugin on the **real** cordis the installation ships, and checks that
activation produces no warning, that the route registers on the real LLM runtime,
that models and reasoning efforts resolve through it, that a streamed call
completes end to end, that unloading releases the route, and that the
configuration page's route is claimed through the real
`ctx.inject(['webServer'], …)` path and answered over a socket. Set `DSH_ASAR` if
the installation lives elsewhere; the suite skips cleanly when it cannot find one.

One constraint to keep in mind when writing the plugin: the exported `Config` is
not free-form. cordis calls `Config['~standard'].validate(raw)` before starting
the plugin, so a plain object there fails activation with
`Cannot read properties of undefined (reading 'validate')` — an isolated unit test
will not catch that class of mistake, and `test:cordis` will.

## Re-measuring the live facts

Two facts about this service are measured rather than published, and both have a
tracked probe. They need a key and spend real quota:

```sh
OC_KEY=oc_sk_... node scripts/probe-protocols.mjs [model ...]   # one probe per served model
OC_KEY=oc_sk_... node scripts/probe-image.mjs                   # image shapes, all three protocols
node scripts/snapshot-models.mjs [--write]                      # capacity snapshot vs the catalogue
```

`probe-protocols.mjs` answers `served=[…]` per model, which is what
`FALLBACK_MODELS` is written from. `probe-image.mjs` posts a PNG over each
protocol and checks the model can actually read it — twice per protocol, once
with the image in a user turn and once with it inside a tool result, because
those are two different shapes and only the second one carries what `read_image`
answers with. Point it at any picture with `OC_IMAGE=path/to.png` (the default,
`.live-cache/probe-image.png`, is untracked scratch) and read the printed answer
against what the picture holds. `snapshot-models.mjs` prints what changed since
the snapshot was taken — `new`, `changed`, `gone` — and rewrites the two tables
with `--write`.

## Architecture

```
lib/
├── index.js                  adapter class, registration, health check
├── client.js                 the browser half: the plugin's configuration page
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
├── transform/
│   ├── messages.js           content blocks → each protocol's messages
│   ├── tools.js              tool schemas → each protocol's declarations
│   └── reasoning.js          harness effort → each protocol's spelling
├── ui/
│   ├── http.js               node:http helpers, request fence
│   └── bridge.js             the Host half of the configuration page
└── usage/store.js            what this route spent, per day and per model

scripts/
├── snapshot-models.mjs       refresh lib/model/limits.js from the catalogue
├── probe-protocols.mjs       measure which protocol each served model accepts
└── probe-image.mjs           measure the image request shape per protocol

locale/
├── en.json                   the display metadata the Plugins page reads
└── zh.json                   the same sentence in Simplified Chinese
```

`locale/` is the one shipped surface the Harness reads **without activating the
plugin**: it is the copy on the bundle's card and on the `opencode-go` row's
header, resolved through the client's active language (English comes from the
manifest as well, which is what npm and the plugin registry show).

Adding a fourth protocol means one new file under `protocol/` and one entry in
the transport map. The configuration page is split the same way: `ui/bridge.js`
owns the Host facts and the write paths, `client.js` owns the rendering, and the
two agree on the endpoints in `ui/bridge.js` and the `<package>#<row>` slot key —
both checked by the offline suites.
