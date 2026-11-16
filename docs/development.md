# Development

> Back to [README](../README.md).

This page is for contributors: the project's current status, how to verify the plugin, how to re-measure the live facts, and how the code is laid out.

## Project status

| | |
|---|---|
| **Version** | 0.2.5 (package `dsh-llm-opencode-go`) |
| **Protocol map** | One preferred entry per model, taken from the live `api` map and measured against the service; kept in `lib/model/catalog.js` |
| **Capacity, modalities, and reasoning ladders** | Read from the live `GET /models` rows; the `models.dev` snapshot in `lib/model/limits.js` is the fallback, dated in `CAPABILITY_SOURCE` (currently `models.dev/opencode-go@2026-11-08`) |
| **Known limits** | See [Reliability](reliability.md#limits) and [Models](models.md) |

## Verification

```sh
npm test            # 554 offline checks, including config, SSE framing, catalog and discovery, all three protocols, adapter, usage counters, subscription, plugin body, the settings bridge and page, display metadata, diagnostics, release coherence and CI
npm run test:cordis # 44 checks mounting the plugin on the harness's own cordis
npm run test:live   # the live suite; needs OC_KEY
npm run check:pack  # what `npm publish` would upload
```

The count above is restated in both README badges and in this page and its Chinese counterpart — the four places `tests/run.mjs` re-checks when the suite finishes, so a stale badge fails the run. A release states the same number in the newest changelog section; an older section's number is history, and `release` is the suite that keeps a version bump honest: it reads the manifest and fails on any place that still states the version a release left behind.

`npm test` runs offline and needs no credential. The protocol suites replay response bodies **captured from the live service** (`tests/golden/`), so they fail if a translator stops agreeing with what OpenCode Go actually sends. Every case assembles its chunks with the harness's own block assembler, which is the same code the agent loop runs over them. The capacity snapshot is compared with the machine's cached OpenCode catalogue by `scripts/check-cached-models.mjs` (below), not by the offline suite: a fresh clone has no cache to compare.

The scratch files these suites write live in `.test-cache/`, a gitignored corner of the checkout, and their paths come from `tests/suites/_scratch.mjs`: one directory per case, removed when that case ends, under a name carrying a token minted for the run. A run that dies before its own cleanup therefore cannot leave behind the file a later run opens.

The **diagnostics suite** drives the real adapter against transports that fail in the three ways a call can — never connected, refused, and accepted-then-broken — and then reads the file the plugin wrote, because a log is only worth having if the difference between those three survives it.

The suites that cover the configuration page run offline as well:

- The **bridge suite** drives the real HTTP handler with fake request/response pairs, so routing, the request fence, validation, and every refusal path are checked without a socket.
- The **client suite** compiles `lib/client.js` in a `node:vm` sandbox whose `window` is the module-loader facade, then checks the factory id, the `<package>#<row>` slot key (read from `cordis.patch.yml`), a complete dictionary for both shipped locales, and that the endpoints it calls are exactly the ones the bridge serves.
- The **page suite** renders the page: `tests/suites/_client-harness.mjs` is a small React stand-in with working hooks, so the suite can open the page, type into its fields, press its controls, and read what a person would see. It checks that a save writes the config shape rather than the snapshot it read, that a window switch reads the window the reader chose, that a disabled control is inert, and that a failure is reported in the reader's own words and can be retried. It evaluates the bundle once and materializes its factory once, the way the browser's module loader memoizes a package, and gives each registered slot a hook store of its own — which is what lets a case watch one surface's read reach the other one drawing the same fact.
- The page's **clock is the suite's**. Delays the page would wait at most a second for — the beat after a write — still run themselves, and anything longer waits for `page.advance(ms)`, which walks the scheduled work in due order so a case can ask what the quota schedule does at thirty seconds, at half an hour, or over ten minutes of a busy session. `page.surface(name).close()` is the other half of that: it unmounts a surface, so a case can watch what stops when the last one goes.

Two checks in the page suite are **structural**, and they double as rules for new code — a stylesheet here is a plain object, not CSS, so a mistake is easy to write and hard to see:

- **A `flex` basis is a width in a row container and a height in a column one.** So do not put a basis on a control: size the label (the flex item of the row) and let the control fill it with `styles.fieldInput`, which sets `flex: 'none'`. The suite walks the rendered tree, finds every control inside a column ancestor, and refuses any that carries a basis.
- **A placeholder that does not fit is a cut-off sentence.** The suite estimates each placeholder against the width its column declares, so a long hint is caught here. Rules about accepted input belong in the hint text under the field, where they can wrap and be read.

`npm run test:live` spends real quota. It checks, against the live relay: model discovery and the caching of the service's row facts, a model added after the snapshot resolving with its live facts, a round trip over each of the three protocols, a full tool-calling round trip per protocol, a model forced onto a non-preferred protocol still serving, a second turn on one session id finishing and reporting its cache figures, a history holding a tool call that was never dispatched, that every listed model reports its own context window and output cap, that a vision model and a text-only model report the modalities the attachment seam allows, that one Responses model's advertised reasoning ladder is accepted, and that a workspace-gated model either answers or is refused as needing that workspace's consent.

```sh
OC_KEY=oc_sk_... npm run test:live
# optional: OC_BASE, OC_CACHE to keep the discovery cache out of ~/.dsh
```

`npm run test:cordis` reads the harness's own packages out of `app.asar`, mounts the plugin on the **real** cordis the installation ships, and checks that activation produces no warning, that the route registers on the real LLM runtime, that models and reasoning efforts resolve through it, that a streamed call completes end to end, that unloading releases the route, and that the configuration page's route is claimed through the real `ctx.inject(['webServer'], …)` path and answered over a socket. `DSH_ASAR` names an installation to read — that installation's `app.asar` — and the suite skips cleanly when it finds neither one nor the npm copies.

The archive is only how those packages are *packaged*, not what makes the suite work: the same libraries are on npm at the same versions, so when no installation is present the suite runs them from `node_modules` — which is how CI runs it, on a version pinned by the lock file rather than by whatever a developer has installed. `DSH_BUNDLE` overrides both, and a machine with neither skips.

One constraint to keep in mind when writing the plugin: the exported `Config` is not free-form. cordis calls `Config['~standard'].validate(raw)` before starting the plugin, so a plain object there fails activation with `Cannot read properties of undefined (reading 'validate')` — an isolated unit test will not catch that class of mistake, and `test:cordis` will. A malformed value, a container of the wrong type included, comes back as Standard Schema `issues` naming the field, never as a thrown error.

`npm run check:pack` packs the real tarball and reads it, because `files` is an allowlist and both of its failure modes are silent: a document the repository has and the list omits is a document the package does not have, and an entry matching nothing publishes nothing. It asserts that the package carries its two READMEs, its two changelogs, the patch the Loader reads, both halves of the client and both locale files; that it carries no test, script, workflow or cache directory; that no published file sits outside the allowlist; and that every `docs/*.md` ships with its `.zh-CN.md` half.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: the syntax check, the offline suite, and — on one leg of the matrix rather than all four, since the bytes are the same — the pack check. A second job runs the activation suite on Node 20, 22 and 24. The live suite is not there: it needs a credential and spends real quota.

The actions are pinned to a major, and the major is kept current rather than merely reproducible: it decides which Node runtime the action expects. `setup-node` v7 writes no dummy `NODE_AUTH_TOKEN`; the release path is OIDC with `registry-url` and no stored token, so a stray one is exactly what would confuse it.

The workflows are themselves checked, by the `ci` suite. Nothing else reads them, and a workflow that is wrong runs on GitHub and nowhere else, where a typo is a job that quietly never does what it was added for. So the suite refuses a tab character (illegal in YAML, invisible in an editor), an action pinned to a branch rather than a version, a release that could publish before checking the tag against the manifest, a stored npm token, a step naming an npm script that does not exist, and a pack anchor pointing at a file the repository does not have.

Two rules this suite exists to keep:

- **A clone is not the working tree.** `.test-cache/`, `.live-cache/` and `.npm-cache/` are gitignored, so they exist only on the machine that made them. A case that asserts a path is *there* therefore passes locally and fails in a clone; a forbidden prefix therefore accepts a gitignored path as known, while a pack anchor still has to exist in the repository.
- **A checkout is not another checkout.** `core.autocrlf` is true by default on Windows, so a workflow is CRLF there and LF in CI; `.` cannot consume the `\r` and `$` will not match before it, so an LF-only parser finds nothing, and "does the workflow run the tests" answers no with nothing about line endings in the message. The suite splits on `/\r?\n/`, and a case asserts both give the same answer.

## Releasing

A release is a tag. Everything a person does by hand is what a version bump already needed: move the version everywhere the `release` suite reads it — the manifest, the lock file, `PLUGIN_VERSION`, `PLUGIN_IDENTITY`, both development status tables, and both wire-protocol `User-Agent` examples — update the `release.mjs` example commands in both development pages by hand, since the suite does not read them, open a changelog section, and run the suite. The rest is done by tag.

`scripts/release.mjs` holds the release's own decisions, because a release workflow is a shell script running in an environment nobody can try locally: the feedback would arrive on a tag, in public, after a publish had been attempted. So the parts that decide something live where the `ci` and `release` suites exercise them on every push, and the workflow keeps only steps no shell can avoid.

```sh
node scripts/release.mjs version          # the version in package.json
node scripts/release.mjs check-tag v0.2.5 # the version a tag names, or a refusal
node scripts/release.mjs notes 0.2.5      # the changelog section, as a release body
```

`check-tag` is the one that matters: a tag is the only version a person types rather than a manifest states, so it is the one that can be wrong in a way nothing else catches. It refuses anything that is not a `v<version>` tag — a dispatch from a branch has a ref name like `main` — and refuses a tag whose version is not what `package.json` says, which is a tag on the wrong commit.

`.github/workflows/release.yml` runs on a `v*` tag and does the rest: resolves the version, re-runs the syntax check, the offline suite, the activation suite and the pack check on the tagged commit, reads the notes, publishes to npm with provenance, and opens the release. It authenticates through npm's **trusted publishing**: the workflow exchanges its OIDC token for a short-lived publisher credential, so no npm token is stored in this repository or anywhere else. `workflow_dispatch` finishes a release that failed halfway — it checks out the tag it names, so what is published is still the tagged commit — and skips the publish when the version is already on npm, which is what makes a re-run safe.

Two things have to be true on npm's side, once: the package must name this repository and `release.yml` under **Trusted Publishers**, and the workflow must run npm 11.5.1 or newer, which is why it upgrades npm before publishing. The credential exchange writes the token itself, so the `registry-url` that `actions/setup-node` leaves in `.npmrc` is not in the way.

`prepublishOnly` still runs the syntax check and the offline suite, which is redundant in the workflow and deliberately so: it is also what holds when a human publishes from their own machine. The suite runs only where it exists — `tests/` and `scripts/` are outside `files`, so a tarball republished through a mirror or a private registry has no suite to run, and the script says so rather than failing with a module error.

## Re-measuring the live facts

The service publishes each model's capacity, modalities, and reasoning ladder in `GET /models`, so the probes cover what a row cannot settle: how the relay actually accepts each protocol, and the request shapes for image input. They need a key and spend real quota:

```sh
OC_KEY=oc_sk_... node scripts/probe-protocols.mjs [model ...]   # one probe per served model
OC_KEY=oc_sk_... node scripts/probe-image.mjs                   # image shapes, all three protocols
node scripts/snapshot-models.mjs [--write]                      # fallback snapshot vs the catalogue
node scripts/check-cached-models.mjs                            # fallback table vs this machine's OpenCode cache
```

`probe-protocols.mjs` answers `served=[…]` per model. The `api` map in a live row is a preference, not a whitelist, so that measured list is what the remaining protocols behind the preferred entry are kept for. The probe keeps every request above the service's minimum output budget (16 tokens, so it sends 32) and fails on a stream error event as well as on the HTTP status, because a request shape the service rejects otherwise reads like a protocol refusal.

`probe-image.mjs` posts a PNG over each protocol and checks the model can actually read it — twice per protocol, once with the image in a user turn and once with it carried by a tool result, because those are two different shapes and only the second one carries what `read_image` answers with. Point it at any picture with `OC_IMAGE=path/to.png` (the default, `.live-cache/probe-image.png`, is untracked scratch) and read the printed answer against what the picture holds.

`snapshot-models.mjs` maintains the fallback: it compares `lib/model/limits.js` with the OpenCode catalogue (`models.dev`), prints what changed — `new`, `changed`, `gone` — and, with `--write`, writes the catalogue's current rows into the current table, moves the rows it no longer lists into the delisted table, and moves `CAPABILITY_SOURCE` to the new date. Nothing measured is deleted from the file: a retired model's capacity stays readable to a session that still names it.

`check-cached-models.mjs` is the comparison that depends on a local file: it checks the measured context windows against the OpenCode catalogue this machine has cached, and says so when there is none. It is a script rather than an offline case because a fresh clone has no cache; a case there would count as a check while comparing nothing.

The catalog itself follows the same append-only rule. A new model arrives as a new row in `FALLBACK_MODELS`; a model the service retires keeps its row, marked `retired` with the successor the service named, rather than being deleted. The row is what lets a session still pinned to the id resolve its last measured figures and receive the service's own `MODEL_DEPRECATED` / `MODEL_UNAVAILABLE` instead of an unknown-model error, and only a later `GET /models` listing clears the mark. See [Retired models](models.md#retired-models).

## Architecture

```
lib/
├── index.js                  adapter class, registration, health check
├── client.js                 the browser half: the plugin's configuration page
├── config.js                 schema, defaults, validation
├── diagnostics/
│   └── log.js                the metadata-only failure log
├── error/
│   ├── errors.js             the failure type and brand helpers this plugin owns
│   └── mapping.js            HTTP status / transport failure → stable code
├── model/
│   ├── catalog.js            protocol preference order and record merging
│   ├── limits.js             the capacity, modality, and reasoning fallback snapshot
│   ├── cache.js              GET /models rows, memory + on-disk cache
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
└── usage/
    ├── store.js              what this route spent, per day and per model
    └── subscription.js       the plan's own quota, read from the service

scripts/
├── snapshot-models.mjs       refresh lib/model/limits.js from the catalogue
├── check-cached-models.mjs   compare the table with this machine's OpenCode cache
├── probe-protocols.mjs       measure which protocol each served model accepts
├── probe-image.mjs           measure the image request shape per protocol
├── check-pack.mjs            what `npm publish` would upload, read back
└── release.mjs               a version, a tag, and a changelog section

locale/
├── en.json                   the display metadata the Plugins page reads
└── zh.json                   the same sentence in Simplified Chinese
```

`locale/` is the one shipped surface the Harness reads **without activating the plugin**: it is the copy on the bundle's card and on the `opencode-go` row's header, resolved through the client's active language (English comes from the manifest as well, which is what npm and the plugin registry show).

Adding a fourth protocol means one new file under `protocol/` and one entry in the transport map. The configuration page is split the same way: `ui/bridge.js` owns the Host facts and the write paths, `client.js` owns the rendering, and the two agree on the endpoints in `ui/bridge.js` and the `<package>#<row>` slot key — both checked by the offline suites.
