/**
 * Model capability records to the metadata the LLM service resolves.
 *
 * `resolveModel()` and `listModels()` both answer from this one conversion, so
 * the model selector, the call-config validator, and the adapter's own request
 * building cannot disagree about what a model is.
 *
 * Capacity — the context window and output cap — comes from the measured table
 * in `./limits.js`, so a listing shows the figure the provider publishes instead
 * of one assumed window shared by every model.
 *
 * The capability record keeps two modality facts apart on purpose:
 *
 *   - `providerModalities` is what the provider publishes for the model, which
 *     is wider than this harness models — the OpenCode catalogue gives several
 *     models `video`, `audio`, or `pdf` input, and no protocol here has a wire
 *     for those.
 *   - `inputModalities` is what this adapter can actually put in a request.
 *
 * {@link resolvedModelInfo} answers from the second, because the harness
 * projects durable image blocks on the strength of it: a route that declares
 * `image` is handed real image blocks and must resolve their bytes, while one
 * that does not gets a text placeholder instead. Declaring an ability the
 * request path lacks would turn a projection into a failure. The provider's
 * wider list is not lost: it becomes the resolved model's description.
 *
 * @module dsh-opencode-go/model/capabilities
 */

import { TRAINING_CONSENT_SETTING } from '../config.js'
import { ReasoningEffortId } from '../error/errors.js'
import { advertisedEfforts } from '../transform/reasoning.js'
import { preferredProtocol } from './catalog.js'

/**
 * Human guidance shown beside each effort, so a selector can explain the ladder.
 * Levels without an entry are still selectable; they just carry no description.
 */
const EFFORT_HINTS = Object.freeze({
  minimal: 'Shortest thinking, for mechanical edits',
  low: 'Little thinking, for straightforward changes',
  medium: 'Balanced thinking',
  high: 'Extended thinking, for hard problems',
  xhigh: 'Very extended thinking',
  max: 'Most thinking the model offers',
})

/**
 * Whether a record says the model itself accepts images.
 *
 * @param {object} record - a catalog record.
 * @returns {boolean} true when the provider list or a config entry names `image`.
 */
export function supportsImages(record) {
  if (record?.inputModalities?.includes('image') === true) return true
  return record?.providerModalities?.includes('image') === true
}

/**
 * The input modalities to declare for one record.
 *
 * @param {object} record - a catalog record.
 * @param {object} input - the deployment facts.
 * @param {boolean} input.imageRoute - whether this adapter can resolve image
 *   bytes in this deployment, which is what makes an image occurrence sendable.
 * @param {string} input.mode - `sendImages`: `auto`, `always`, or `off`.
 * @returns {readonly string[]} `['text']`, or `['text', 'image']` when the model
 *   takes images and this deployment can send them.
 */
export function resolvedInputModalities(record, input) {
  if (input.mode === 'off') return Object.freeze(['text'])
  if (!supportsImages(record)) return Object.freeze(['text'])
  if (input.mode === 'always' || input.imageRoute) return Object.freeze(['text', 'image'])
  return Object.freeze(['text'])
}

/**
 * A human summary of what a model accepts and what this route can carry.
 *
 * Reading metadata should not need a debugger: `video`, `audio`, and `pdf` are
 * real model abilities with no wire here, and the resolved list hides them, so
 * they are stated instead of dropped.
 *
 * @param {object} record - a catalog record.
 * @param {readonly string[]} declared - the modalities this route declares.
 * @returns {string | undefined} a sentence when the two differ, else undefined.
 */
export function modalityNote(record, declared) {
  const provider = record?.providerModalities
  if (!Array.isArray(provider) || provider.length === 0) return undefined
  const unsendable = provider.filter((modality) => modality !== 'text' && !declared.includes(modality))
  if (unsendable.length === 0) return undefined
  return `the model also accepts ${unsendable.join(', ')}, which no protocol on this route can send`
}

/**
 * A note stating the one workspace setting a gated model needs.
 *
 * A model whose provider trains on request data is served only while the
 * workspace allows that, and the relay answers `TRAINING_CONSENT_REQUIRED` —
 * with its remedy — until it does. Knowing the requirement is the whole
 * difference for a reader choosing a model: the note puts the constraint in the
 * selector, where the choice is made, rather than after a refused call. It is a
 * note and not a block, because the model works the moment the workspace allows
 * it, and the consent belongs to the workspace rather than to this plugin.
 *
 * @param {object} record - a catalog record.
 * @returns {string | undefined} a sentence for a gated model, else undefined.
 */
export function trainingConsentNote(record) {
  if (record?.trainingConsent !== true) return undefined
  return `the model's provider trains on request data, so the relay serves it only while the workspace`
    + ` enables "${TRAINING_CONSENT_SETTING}" (OpenCode console → the workspace → Go → Providers)`
}

/**
 * The `LlmModelInfo` a catalog listing needs.
 *
 * The capacity and modality fields are what a model selector shows, so they come
 * from the same conversion `resolveModel()` uses: a listing and a resolved call
 * cannot report different windows or different modalities for one model. The
 * modality fields follow the request path for the same reason they do there — a
 * selector must not offer an attachment the route would refuse.
 *
 * @param {string} provider - the provider route.
 * @param {object} record - a catalog record.
 * @param {object} [input] - the deployment facts.
 * @param {boolean} [input.imageRoute] - whether image bytes can be resolved here.
 * @param {string} [input.imageMode] - `sendImages`: `auto`, `always`, or `off`.
 * @returns {object} listing metadata.
 */
export function catalogModelInfo(provider, record, input) {
  const modalities = resolvedInputModalities(record, {
    imageRoute: input?.imageRoute === true,
    mode: input?.imageMode ?? 'auto',
  })
  const note = modalityNote(record, modalities)
  const consent = trainingConsentNote(record)
  const description = [record.description, note, consent].filter((part) => part !== undefined).join(' — ')
  return {
    provider,
    id: record.id,
    name: record.name,
    ...(description === '' ? {} : { description }),
    inputModalities: modalities,
    ...(Number.isInteger(record.contextWindow) ? { contextWindow: record.contextWindow } : {}),
    ...(Number.isInteger(record.maxTokens) ? { maxTokens: record.maxTokens } : {}),
  }
}

/**
 * The `LlmResolvedModelInfo` one exact model resolves to.
 *
 * `inputModalities` is the load-bearing field: the runtime projects durable
 * image references into placeholders for a route that does not declare
 * `image`, and hands real image blocks to one that does. It is therefore only
 * declared for a model whose images this deployment can actually resolve — see
 * {@link resolvedInputModalities}. When the provider publishes abilities beyond
 * that (`video`, `audio`, `pdf`), the resolved info carries a note naming them,
 * so the difference between the model and the route stays visible.
 *
 * @param {string} provider - the provider route.
 * @param {object} record - a catalog record.
 * @param {object} [input] - the deployment facts.
 * @param {boolean} [input.imageRoute] - whether image bytes can be resolved here.
 * @param {string} [input.imageMode] - `sendImages`: `auto`, `always`, or `off`.
 * @returns {object} resolved model metadata.
 */
export function resolvedModelInfo(provider, record, input) {
  const protocol = preferredProtocol(record)
  const modalities = resolvedInputModalities(record, {
    imageRoute: input?.imageRoute === true,
    mode: input?.imageMode ?? 'auto',
  })
  const note = modalityNote(record, modalities)
  const consent = trainingConsentNote(record)
  const info = {
    provider,
    id: record.id,
    name: record.name,
    context: { contextWindow: record.contextWindow },
    defaultMaxTokens: record.maxTokens,
    inputModalities: modalities,
  }
  const description = [record.description, note, consent].filter((part) => part !== undefined).join(' — ')
  if (description !== '') info.description = description
  if (record.reasoning === true) {
    const levels = advertisedEfforts(protocol, record.reasoningEfforts)
    if (levels.length > 0) {
      info.reasoning = {
        efforts: levels.map((level) => ({
          id: ReasoningEffortId(level),
          name: level,
          ...(EFFORT_HINTS[level] === undefined ? {} : { description: EFFORT_HINTS[level] }),
        })),
        ...(record.defaultEffort === undefined || !levels.includes(record.defaultEffort)
          ? {}
          : { defaultEffort: ReasoningEffortId(record.defaultEffort) }),
      }
    }
  }
  return info
}
