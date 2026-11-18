/**
 * Endpoint derivation: which base each protocol's path is appended to.
 *
 * The service documents a base per API (`/openai/v1`, `/anthropic/v1`), and
 * also still serves the unified base 0.2.x used. Which one a request posts to
 * is derived from `baseURL` alone, so these cases are the whole decision: the
 * acceptance URLs, the escape hatch that reproduces 0.2.x, and the shapes that
 * must not be mistaken for the documented base.
 */

import {
  DEFAULT_BASE_URL,
  LEGACY_BASE_URL,
  PROTOCOLS,
  endpointLayout,
  inferenceBase,
  resolveConfig,
} from '../../lib/config.js'
import { PATH as ANTHROPIC_PATH } from '../../lib/protocol/anthropic-messages.js'
import { PATH as CHAT_PATH } from '../../lib/protocol/chat-completions.js'
import { PATH as RESPONSES_PATH } from '../../lib/protocol/responses.js'
import { is } from '../helpers.mjs'

const OFFICIAL = 'https://opencode.ai/inference/go/v1'

/** The URL a call posts to: the derived base with the protocol's own path. */
function url(baseURL, protocol, path) {
  return `${inferenceBase(baseURL, protocol)}${path}`
}

export default {
  name: 'endpoint',
  cases: [
    {
      name: 'the default base is the documented per-API root',
      run() {
        is(DEFAULT_BASE_URL, OFFICIAL)
        is(resolveConfig(undefined).baseURL, OFFICIAL)
        is(endpointLayout(OFFICIAL), 'split')
      },
    },
    {
      name: 'the legacy base stays reachable as the escape hatch',
      run() {
        is(LEGACY_BASE_URL, 'https://opencode.ai/zen/go/v1')
        is(resolveConfig({ baseURL: LEGACY_BASE_URL }).baseURL, LEGACY_BASE_URL)
        is(endpointLayout(LEGACY_BASE_URL), 'unified')
      },
    },
    {
      name: 'the default base splits the three protocols',
      run() {
        is(
          url(OFFICIAL, PROTOCOLS.RESPONSES, RESPONSES_PATH),
          'https://opencode.ai/inference/go/openai/v1/responses',
        )
        is(
          url(OFFICIAL, PROTOCOLS.CHAT, CHAT_PATH),
          'https://opencode.ai/inference/go/openai/v1/chat/completions',
        )
        is(
          url(OFFICIAL, PROTOCOLS.ANTHROPIC, ANTHROPIC_PATH),
          'https://opencode.ai/inference/go/anthropic/v1/messages',
        )
      },
    },
    {
      name: 'a documented base without the trailing /v1 splits at the root it has',
      run() {
        is(endpointLayout('https://opencode.ai/inference/go'), 'split')
        is(
          url('https://opencode.ai/inference/go', PROTOCOLS.RESPONSES, RESPONSES_PATH),
          'https://opencode.ai/inference/go/openai/v1/responses',
        )
        is(
          url('https://opencode.ai/inference/go', PROTOCOLS.ANTHROPIC, ANTHROPIC_PATH),
          'https://opencode.ai/inference/go/anthropic/v1/messages',
        )
      },
    },
    {
      name: 'a trailing slash is dropped before the layout is decided',
      run() {
        is(resolveConfig({ baseURL: `${OFFICIAL}/` }).baseURL, OFFICIAL)
        is(endpointLayout(`${OFFICIAL}/`), 'split')
        // The two functions agree on the same input, so a raw slash cannot
        // become a doubled segment in the derived base.
        is(
          inferenceBase(`${OFFICIAL}/`, PROTOCOLS.RESPONSES),
          'https://opencode.ai/inference/go/openai/v1',
        )
      },
    },
    {
      name: 'an explicit zen base keeps the unified URLs of 0.2.x',
      run() {
        is(
          url(LEGACY_BASE_URL, PROTOCOLS.RESPONSES, RESPONSES_PATH),
          'https://opencode.ai/zen/go/v1/responses',
        )
        is(
          url(LEGACY_BASE_URL, PROTOCOLS.CHAT, CHAT_PATH),
          'https://opencode.ai/zen/go/v1/chat/completions',
        )
        is(
          url(LEGACY_BASE_URL, PROTOCOLS.ANTHROPIC, ANTHROPIC_PATH),
          'https://opencode.ai/zen/go/v1/messages',
        )
      },
    },
    {
      name: 'an http base is not the documented endpoint, however it is hosted',
      run() {
        const base = 'http://opencode.ai/inference/go/v1'
        is(endpointLayout(base), 'unified')
        is(url(base, PROTOCOLS.RESPONSES, RESPONSES_PATH), `${base}/responses`)
      },
    },
    {
      name: 'a self-hosted gateway keeps the base as the API root',
      run() {
        const base = 'https://gateway.example.test/v1'
        is(endpointLayout(base), 'unified')
        is(url(base, PROTOCOLS.CHAT, CHAT_PATH), `${base}/chat/completions`)
      },
    },
    {
      name: 'a port on the documented host is still that host',
      run() {
        const base = 'https://opencode.ai:443/inference/go/v1'
        is(endpointLayout(base), 'split')
        is(
          url(base, PROTOCOLS.RESPONSES, RESPONSES_PATH),
          'https://opencode.ai:443/inference/go/openai/v1/responses',
        )
      },
    },
    {
      name: 'a subdomain or a neighbouring path is not the documented base',
      run() {
        is(endpointLayout('https://api.opencode.ai/inference/go/v1'), 'unified')
        is(endpointLayout('https://opencode.ai/inference/go/v2'), 'unified')
        is(endpointLayout('https://opencode.ai/inference'), 'unified')
      },
    },
    {
      name: 'an unparseable base is passed through rather than thrown from',
      run() {
        is(endpointLayout('not a url'), 'unified')
        is(inferenceBase('not a url', PROTOCOLS.RESPONSES), 'not a url')
        is(inferenceBase('', PROTOCOLS.ANTHROPIC), '')
      },
    },
  ],
}
