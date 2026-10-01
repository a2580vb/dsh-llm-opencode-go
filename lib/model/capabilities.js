/**
 * Model capability records to the metadata the LLM service resolves.
 *
 * `resolveModel()` and `listModels()` both answer from this one conversion, so
 * the model selector, the call-config validator, and the adapter's own request
 * building cannot disagree about what a model is.
 *
 * @module dsh-opencode-go/model/capabilities
 */

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
 * Whether a record declares image input.
 *
 * @param {object} record - a catalog record.
 * @returns {boolean} true when `input` listed `image`.
 */
export function supportsImages(record) {
  return record?.inputModalities?.includes('image') === true
}

/**
 * The `LlmModelInfo` a catalog listing needs.
 *
 * @param {string} provider - the provider route.
 * @param {object} record - a catalog record.
 * @returns {object} listing metadata.
 */
export function catalogModelInfo(provider, record) {
  return {
    provider,
    id: record.id,
    name: record.name,
    ...(record.description === undefined ? {} : { description: record.description }),
    inputModalities: record.inputModalities,
  }
}

/**
 * The `LlmResolvedModelInfo` one exact model resolves to.
 *
 * `inputModalities` is the load-bearing field: the runtime projects durable
 * image references into placeholders for a route that does not declare
 * `image`, and hands real image blocks to one that does. It is therefore only
 * declared for a model whose config opted in, because the adapter can only send
 * an image it can resolve real bytes for.
 *
 * @param {string} provider - the provider route.
 * @param {object} record - a catalog record.
 * @returns {object} resolved model metadata.
 */
export function resolvedModelInfo(provider, record) {
  const protocol = preferredProtocol(record)
  const info = {
    provider,
    id: record.id,
    name: record.name,
    context: { contextWindow: record.contextWindow },
    defaultMaxTokens: record.maxTokens,
    inputModalities: record.inputModalities,
  }
  if (record.description !== undefined) info.description = record.description

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
