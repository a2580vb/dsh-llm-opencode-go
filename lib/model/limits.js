/**
 * Model capacity and modality facts: the fallback table, measured from the
 * OpenCode catalogue.
 *
 * A deployment that discovers models reads `limit`, `modalities` and the
 * reasoning ladder from the `GET /models` rows themselves (see
 * `./catalog.js`); this table answers when discovery states nothing — a
 * `modelSource: config` deployment, an empty catalog, a cache file written
 * before the service published those facts, or a model the catalogue has never
 * described. Without it, a request that needs a context window would have only
 * one assumed figure to show, and a deployment with no egress would show none.
 *
 * The figures come from the catalogue OpenCode itself ships: `models.dev`,
 * whose `opencode-go` provider entry is the source of everything in
 * {@link MODEL_CAPABILITIES}. The table is a **snapshot**, taken deliberately
 * rather than fetched at runtime: a request must not wait on a third-party
 * endpoint, and `tests/suites/catalog.test.mjs` compares it against whatever
 * catalogue the machine has cached so drift is reported rather than absorbed.
 *
 * Refresh it with `node scripts/snapshot-models.mjs --write`, which reads
 * `https://models.dev/api.json` and rewrites the two tables below.
 *
 * @module dsh-llm-opencode-go/model/limits
 */

/**
 * Where {@link MODEL_CAPABILITIES} came from, and when.
 *
 * Reported through the catalog record's `capacitySource` field when this table
 * answers for a model, so a stale fallback is visible rather than silent. A
 * record filled from a live `/models` row names that row instead.
 */
export const CAPABILITY_SOURCE = 'models.dev/opencode-go@2026-11-08'

/**
 * One measured model: `id`, context window, output cap, and the provider's own
 * input modality list.
 *
 * `modalities` is what models.dev publishes, which is wider than the harness
 * vocabulary: `video`, `audio`, and `pdf` are real model abilities this adapter
 * has no wire representation for. They are kept so the difference between what
 * a model accepts and what a protocol here can carry stays visible. See
 * `model/capabilities.js`.
 *
 * @type {readonly [string, number, number, readonly string[]][]}
 */
export const MODEL_CAPABILITIES = Object.freeze([
  ['qwen3.8-max', 1_000_000, 131_072, ['text', 'image', 'video']],
  ['kimi-k3.1-pro', 1_048_576, 131_072, ['text', 'image', 'video']],
  ['gpt-5.6-luna', 1_050_000, 128_000, ['text', 'image', 'pdf']],
  ['hy4-preview', 1_024_000, 64_000, ['text']],
  ['kimi-k2.7-code', 262_144, 262_144, ['text', 'image', 'video']],
  ['mimo-v2.6-flash', 1_048_576, 131_072, ['text', 'image', 'audio', 'video']],
  ['mimo-v2.6-pro', 1_048_576, 131_072, ['text', 'image', 'audio', 'video']],
  ['glm-5.2', 1_000_000, 131_072, ['text']],
  ['cat-jam-free', 1_048_576, 131_072, ['text']],
  ['minimax-m3.1-flash-free', 1_000_000, 512_000, ['text', 'image', 'video']],
  ['iceman-contributor-free', 262_144, 131_072, ['text']],
  ['beam-free', 1_048_576, 131_072, ['text']],
  ['hy3', 256_000, 128_000, ['text']],
  ['minimax-m2.7', 204_800, 131_072, ['text']],
  ['glm-5.3', 1_000_000, 131_072, ['text']],
  ['mimo-v2.5-pro', 1_048_576, 128_000, ['text']],
  ['mimo-v2.5', 1_000_000, 128_000, ['text', 'image', 'audio', 'video']],
  ['claude-haiku-5-5', 1_000_000, 128_000, ['text', 'image', 'pdf']],
  ['longcat-2.0', 1_000_000, 131_072, ['text']],
  ['deepseek-v4-pro', 1_000_000, 384_000, ['text']],
  ['hy4', 1_048_576, 65_536, ['text', 'image']],
  ['gemini-4-argon-contributor', 1_048_576, 65_536, ['text', 'image', 'video', 'audio', 'pdf']],
  ['grok-4.7', 500_000, 500_000, ['text', 'image', 'pdf']],
  ['muse-spark-1.2-contributor', 1_048_576, 131_072, ['text', 'image', 'video', 'pdf', 'audio']],
  ['longcat-2.5-preview-free', 1_000_000, 131_072, ['text', 'image']],
  ['crouton-alpha-free', 1_048_576, 270_000, ['text', 'image', 'video', 'pdf']],
  ['muse-spark-1.3-contributor', 1_048_576, 131_072, ['text', 'image', 'video', 'pdf', 'audio']],
  ['step-5-preview-free', 1_000_000, 65_536, ['text', 'image', 'video']],
  ['deepseek-v4.1-flash', 1_000_000, 384_000, ['text', 'image']],
  ['minimax-m3.1-flash', 1_000_000, 512_000, ['text', 'image', 'video']],
  ['gpt-6-luna', 1_050_000, 128_000, ['text', 'image', 'pdf']],
  ['step-5-preview', 1_000_000, 65_536, ['text', 'image', 'video']],
  ['qwen3.7-plus', 1_000_000, 65_536, ['text', 'image', 'video']],
  ['minimax-m3', 1_000_000, 131_072, ['text', 'image', 'video']],
  ['gemini-4-argon', 1_048_576, 65_536, ['text', 'image', 'video', 'audio', 'pdf']],
  ['qwen3.8-flash', 1_000_000, 131_072, ['text', 'image', 'video']],
  ['kimi-k3', 1_048_576, 131_072, ['text', 'image', 'video']],
  ['glm-5.3-flash', 1_000_000, 131_072, ['text', 'image', 'video']],
  ['space-bunny', 1_048_576, 524_288, ['text', 'image', 'video']],
])

/**
 * Ids this plugin measured that the catalogue no longer lists under
 * `opencode-go`, kept so an existing conversation with one still resolves the
 * figures it had. `deepseek-flash` is a served id with no `opencode-go`
 * catalogue entry of its own, so its row comes from the two providers that do
 * describe the same upstream model.
 *
 * @type {readonly [string, number, number, readonly string[]][]}
 */
export const DELISTED_CAPABILITIES = Object.freeze([
  ['deepseek-flash', 1_000_000, 384_000, ['text', 'image']],
  ['deepseek-v4-flash', 1_000_000, 384_000, ['text']],
  ['deepseek-v4-flash-vision-exp', 1_000_000, 384_000, ['text', 'image']],
  ['gemini-3.1-pro-preview', 1_048_576, 65_536, ['text', 'image', 'video', 'audio', 'pdf']],
  ['glm-5', 202_752, 32_768, ['text']],
  ['glm-5.1', 202_752, 32_768, ['text']],
  ['grok-4.5', 500_000, 500_000, ['text', 'image']],
  ['grok-4.6', 500_000, 500_000, ['text', 'image']],
  ['kimi-k2.5', 262_144, 65_536, ['text', 'image', 'video']],
  ['kimi-k2.6', 262_144, 65_536, ['text', 'image', 'video']],
  ['mimo-v2-omni', 262_144, 128_000, ['text', 'image', 'audio', 'pdf']],
  ['mimo-v2-pro', 1_048_576, 128_000, ['text']],
  ['minimax-m2.5', 204_800, 65_536, ['text']],
  ['omen-alpha', 500_000, 128_000, ['text', 'image']],
  ['ox-alpha-free', 1_000_000, 131_072, ['text', 'image', 'video']],
  ['qwen3.5-plus', 262_144, 65_536, ['text', 'image', 'video']],
  ['qwen3.6-plus', 1_000_000, 65_536, ['text', 'image', 'video']],
  ['qwen3.7-max', 1_000_000, 65_536, ['text']],
  ['space-bunny-free', 1_048_576, 524_288, ['text', 'image', 'video']],
])

/** One measured row, indexed by exact model id. */
const TABLE = new Map(
  [...DELISTED_CAPABILITIES, ...MODEL_CAPABILITIES].map(([id, contextWindow, maxTokens, modalities]) => [
    id,
    Object.freeze({ id, contextWindow, maxTokens, modalities: Object.freeze(modalities), source: CAPABILITY_SOURCE }),
  ]),
)

/**
 * One family's measured figures, for an id the table does not name.
 *
 * A snapshot cannot know about a model released after it was taken, and every
 * member of a family shipped so far agrees on its ceiling, so a new `qwen3.9`
 * is better served by its family's measured window than by one global guess.
 * The match is explicit and ordered: a family is a stated prefix with its own
 * measured figures, never an inference from the id's shape.
 *
 * @type {readonly [string, number, number][]}
 */
const FAMILIES = Object.freeze([
  ['deepseek-', 1_000_000, 384_000],
  ['glm-', 1_000_000, 131_072],
  ['gpt-', 1_050_000, 128_000],
  ['grok-', 500_000, 500_000],
  ['kimi-', 262_144, 131_072],
  ['mimo-', 1_048_576, 131_072],
  ['minimax-', 1_000_000, 131_072],
  ['qwen', 1_000_000, 131_072],
  ['longcat-', 1_000_000, 131_072],
])

/**
 * The measured figures for one model id, or the closest stated match.
 *
 * @param {string} id - the model id.
 * @param {{contextWindow?: number, maxTokens?: number}} fallback - the values to
 *   use when neither the table nor a family names this id.
 * @returns {{contextWindow: number, maxTokens: number, modalities?: readonly string[], source: string, exact: boolean}}
 *   a frozen capability entry.
 */
export function capabilityFor(id, fallback) {
  const exact = TABLE.get(String(id))
  if (exact !== undefined) return Object.freeze({ ...exact, exact: true })

  for (const [prefix, contextWindow, maxTokens] of FAMILIES) {
    if (String(id).startsWith(prefix)) {
      return Object.freeze({
        id: String(id),
        contextWindow,
        maxTokens,
        modalities: undefined,
        source: `${CAPABILITY_SOURCE}#family:${prefix}`,
        exact: false,
      })
    }
  }

  return Object.freeze({
    id: String(id),
    contextWindow: fallback?.contextWindow,
    maxTokens: fallback?.maxTokens,
    modalities: undefined,
    source: 'assumed',
    exact: false,
  })
}

/** Whether the snapshot names this exact id. */
export function isMeasured(id) {
  return TABLE.has(String(id))
}

/** Every id the snapshot names, for tests and diagnostics. */
export function measuredIds() {
  return Object.freeze([...TABLE.keys()])
}
