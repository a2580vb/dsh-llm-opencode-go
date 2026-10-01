/**
 * Harness tool schemas to each protocol's declaration shape.
 *
 * A harness `ToolSchema` is `{name, description, parameters, deferLoading?}`,
 * where `parameters` is already a JSON Schema object. All three protocols carry
 * that object almost verbatim; they disagree only about the wrapper.
 *
 * @module dsh-opencode-go/transform/tools
 */

import { PROTOCOLS } from '../config.js'

/** A JSON Schema object, or a permissive stand-in when the schema is unusable. */
function parametersOf(tool) {
  const parameters = tool?.parameters
  if (parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters)) {
    return parameters
  }
  return { type: 'object', properties: {} }
}

/** A description the relay can read; the harness always supplies one. */
function descriptionOf(tool) {
  const description = tool?.description
  return typeof description === 'string' ? description : ''
}

/** Whether a declaration is usable at all: a tool without a name cannot be called. */
function usable(tool) {
  return typeof tool?.name === 'string' && tool.name.trim() !== ''
}

/**
 * Declare tools for one protocol.
 *
 * `deferLoading` is dropped: it is a harness-side scheduling hint about when a
 * tool definition becomes active, and the runtime resolves deferred
 * declarations into the active set before dispatch. A tool that reaches this
 * function is one the model should be offered.
 *
 * @param {readonly object[] | undefined} tools - the request's active tool schemas.
 * @param {string} protocol - one of {@link PROTOCOLS}.
 * @returns {object[] | undefined} wire declarations, or undefined when there are none.
 */
export function toToolDeclarations(tools, protocol) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const declared = tools.filter(usable)
  if (declared.length === 0) return undefined

  switch (protocol) {
    case PROTOCOLS.CHAT:
      return declared.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: descriptionOf(tool),
          parameters: parametersOf(tool),
        },
      }))
    case PROTOCOLS.RESPONSES:
      return declared.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: descriptionOf(tool),
        parameters: parametersOf(tool),
      }))
    case PROTOCOLS.ANTHROPIC:
      return declared.map((tool) => ({
        name: tool.name,
        description: descriptionOf(tool),
        input_schema: parametersOf(tool),
      }))
    default:
      return undefined
  }
}

/**
 * Whether the harness offered any tool the model can be told about.
 *
 * @param {readonly object[] | undefined} tools - the request's tool schemas.
 * @returns {boolean} true when at least one declaration would be sent.
 */
export function hasTools(tools) {
  return Array.isArray(tools) && tools.some(usable)
}
