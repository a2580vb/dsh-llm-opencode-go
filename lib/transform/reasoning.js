/**
 * Reasoning-effort mapping.
 *
 * The harness names a thinking level with a provider-neutral id
 * (`minimal`, `low`, `medium`, `high`, `max`, or anything a model advertises).
 * Every protocol spells that differently, and the relay validates the spelling:
 * Chat Completions rejects an unknown `reasoning_effort` outright, and the
 * Responses API has no `minimal` at all. Keeping the translation in one place
 * is what makes adding a model a catalog edit rather than an HTTP-code edit.
 *
 * @module dsh-opencode-go/transform/reasoning
 */

import { PROTOCOLS } from '../config.js'

/**
 * Levels the OpenAI-shaped endpoints accept, from the relay's own validation
 * error. `none` is supported upstream but is not a harness effort: turning
 * thinking off is expressed by omitting the parameter.
 */
export const OPENAI_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** The Responses API accepts this set; `minimal` is deliberately absent. */
export const RESPONSES_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Anthropic has no effort vocabulary; it takes a thinking-token budget. These
 * are the budgets each harness level maps to, chosen so the ladder is monotone
 * and the top of it leaves room inside a typical 32k output cap.
 */
export const ANTHROPIC_BUDGETS = Object.freeze({
  minimal: 1_024,
  low: 4_096,
  medium: 8_192,
  high: 16_384,
  xhigh: 32_768,
  max: 64_000,
})

/** The smallest budget the Messages API accepts. */
const MIN_BUDGET = 1_024

/**
 * The thinking-token budget for one effort, or undefined when the level has none.
 *
 * @param {string} effort - a harness reasoning-effort id.
 * @returns {number | undefined} a token budget.
 */
export function anthropicBudget(effort) {
  return ANTHROPIC_BUDGETS[String(effort)]
}

/**
 * Build the protocol-specific reasoning fields for one request.
 *
 * Returns plain fields to merge into the request body, so no caller has to
 * know which protocol carries effort as a string and which as a budget.
 *
 * @param {object} input - the mapping input.
 * @param {string} input.protocol - one of {@link PROTOCOLS}.
 * @param {string | undefined} input.effort - the resolved reasoning effort, if any.
 * @param {number | undefined} input.maxTokens - the request's output cap, when set.
 * @param {boolean} input.replayReasoning - whether reasoning history is sent back.
 * @returns {Record<string, unknown>} fields to merge into the request body.
 */
export function reasoningFields(input) {
  const { protocol, effort, maxTokens } = input

  switch (protocol) {
    case PROTOCOLS.CHAT: {
      if (effort === undefined) return {}
      return { reasoning_effort: chatEffort(effort) }
    }
    case PROTOCOLS.RESPONSES: {
      if (effort === undefined) return {}
      return { reasoning: { effort: responsesEffort(effort) } }
    }
    case PROTOCOLS.ANTHROPIC: {
      if (effort === undefined) return {}
      const requested = anthropicBudget(effort)
      if (requested === undefined) return {}
      // `budget_tokens` must stay strictly below `max_tokens`; the API rejects
      // equality, so an output cap that cannot hold even the smallest budget
      // means thinking is simply not available for this request.
      const budget = maxTokens === undefined ? requested : Math.min(requested, maxTokens - 1)
      if (budget < MIN_BUDGET) return {}
      return { thinking: { type: 'enabled', budget_tokens: budget } }
    }
    default:
      return {}
  }
}

/** Clamp one harness level onto what the Chat Completions endpoint accepts. */
function chatEffort(effort) {
  const level = String(effort)
  return OPENAI_EFFORTS.includes(level) ? level : 'medium'
}

/** Clamp one harness level onto what the Responses endpoint accepts. */
function responsesEffort(effort) {
  const level = String(effort)
  if (RESPONSES_EFFORTS.includes(level)) return level
  // `minimal` is a Chat Completions level; the nearest Responses level is `low`.
  return level === 'minimal' ? 'low' : 'medium'
}

/**
 * The harness reasoning-effort ids one protocol can actually serve.
 *
 * The runtime validates a requested effort against this set before any network
 * I/O, so it must not advertise a level the endpoint would refuse.
 *
 * @param {string} protocol - one of {@link PROTOCOLS}.
 * @param {readonly string[]} declared - the levels the model's catalog entry lists.
 * @returns {readonly string[]} the levels to advertise for this protocol.
 */
export function advertisedEfforts(protocol, declared) {
  const levels = Array.isArray(declared) && declared.length > 0
    ? declared
    : ['minimal', 'low', 'medium', 'high', 'max']
  switch (protocol) {
    case PROTOCOLS.CHAT:
      return Object.freeze(levels.filter((level) => OPENAI_EFFORTS.includes(level)))
    case PROTOCOLS.RESPONSES:
      return Object.freeze(levels.filter((level) => RESPONSES_EFFORTS.includes(level)))
    case PROTOCOLS.ANTHROPIC:
      return Object.freeze(levels.filter((level) => anthropicBudget(level) !== undefined))
    default:
      return Object.freeze([])
  }
}
