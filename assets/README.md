# Screenshots

The plugin market shows AppStore-style screenshots on a plugin's card and detail
view. This directory is where they live.

**Nothing here yet** — and that is deliberate. The market reads `screenshots.json`
next to `package.json`, and a path in that file that does not resolve renders as a
broken image on the card, which is worse than having no screenshots at all. So:

1. Take the shots below and save them here under exactly these names.
2. *Then* add `screenshots.json` to the repository root (content below) and commit
   both together.

## The shot list

| File | What is on screen | Why it is the one to take |
|---|---|---|
| `screenshot-1-quota.png` | The sidebar's foot with the quota capsule visible — `◉ 5H … │ ◉ 周 … │ ◉ 月 …` | This is the only picture that a reader understands without reading anything. It is also the first image on the card. |
| `screenshot-2-usage.png` | The usage panel open: the subscription's three windows above this route's counters. | Shows the panel is real, not a mockup. |
| `screenshot-3-config.png` | The plugin's own configuration page: API key field, credential reference, the per-model visibility switches, the model-variant controls. | Answers "what does it cost me to set up" before anyone asks. |
| `screenshot-4-models.png` | The model picker open, with OpenCode Go models listed under the route. | The actual promise: these models are selectable in this harness. |
| `screenshot-5-terminal.png` | The startup line in the console: `dsh-llm-opencode-go: provider "opencode-go" ready at …`. | Optional. Proof the install took, for the reader who does not trust the UI. |

Rules the catalog applies: **1–8 images**, Git-hosted only, and a relative path may
not leave this directory. Order matters — the first one is the card image.

Please redact before committing: a real API key, a session id you would rather not
publish, and any workspace path that names a client or an employer.

## `screenshots.json` at the repository root

```json
[
  "assets/screenshot-1-quota.png",
  "assets/screenshot-2-usage.png",
  "assets/screenshot-3-config.png",
  "assets/screenshot-4-models.png",
  "assets/screenshot-5-terminal.png"
]
```

List only the files that exist. Adding this file before the images is the one way
to make this go wrong.

## Putting them in a README

Directly under the feature table in `README.md` and `README.zh-CN.md`, so a reader
meets the picture before the configuration reference:

```markdown
![The quota capsule at the sidebar's foot](assets/screenshot-1-quota.png)
```

If the image does not render on the npm package page, replace the relative path
with the absolute one so both surfaces work:

```markdown
![The quota capsule at the sidebar's foot](https://raw.githubusercontent.com/a2580vb/dsh-llm-opencode-go/main/assets/screenshot-1-quota.png)
```
