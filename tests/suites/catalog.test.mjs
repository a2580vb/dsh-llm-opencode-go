/** Model catalog: protocol mapping, override merging, and capability resolution. */

import { PROTOCOLS, normalizeProtocol, resolveConfig } from '../../lib/config.js'
import { catalogModelInfo, resolvedModelInfo, supportsImages } from '../../lib/model/capabilities.js'
import { FALLBACK_MODELS, buildCatalog, displayName, preferredProtocol } from '../../lib/model/catalog.js'
import { parseModelList } from '../../lib/model/cache.js'
import { orderAttempts } from '../../lib/index.js'
import { equal, is, ok } from '../helpers.mjs'

export default {
  name: 'model/catalog',
  cases: [
    {
      name: 'protocol aliases normalize onto the three wire protocols',
      run() {
        is(normalizeProtocol('chat'), PROTOCOLS.CHAT)
        is(normalizeProtocol('openai-completions'), PROTOCOLS.CHAT)
        is(normalizeProtocol('openai-responses'), PROTOCOLS.RESPONSES)
        is(normalizeProtocol('messages'), PROTOCOLS.ANTHROPIC)
        is(normalizeProtocol('anthropic-messages'), PROTOCOLS.ANTHROPIC)
        is(normalizeProtocol('grpc'), undefined)
      },
    },
    {
      name: 'a readable label is derived from an id when nothing names one',
      run() {
        is(displayName('gpt-5.6-luna'), 'GPT 5.6 Luna')
        is(displayName('deepseek-v4-flash'), 'Deepseek V4 Flash')
      },
    },
    {
      name: 'the measured fallback maps every model family to the protocol it serves',
      run() {
        const records = new Map(FALLBACK_MODELS.map((record) => [record.id, record]))
        // Responses-only.
        is(preferredProtocol(records.get('gpt-5.6-luna')), PROTOCOLS.RESPONSES)
        is(preferredProtocol(records.get('grok-4.6')), PROTOCOLS.RESPONSES)
        // Chat Completions only.
        is(preferredProtocol(records.get('glm-5.3')), PROTOCOLS.CHAT)
        is(preferredProtocol(records.get('kimi-k2.7-code')), PROTOCOLS.CHAT)
        // Messages only.
        is(preferredProtocol(records.get('minimax-m2.7')), PROTOCOLS.ANTHROPIC)
        // Every protocol.
        equal(records.get('deepseek-v4-flash').protocols, [PROTOCOLS.RESPONSES, PROTOCOLS.CHAT, PROTOCOLS.ANTHROPIC])
      },
    },
    {
      name: 'a model that only serves one protocol is never offered another first',
      run() {
        const records = buildCatalog(resolveConfig({}), [])
        const attempts = orderAttempts(records.get('gpt-5.6-luna'), resolveConfig({}))
        equal(attempts, [PROTOCOLS.RESPONSES])
      },
    },
    {
      name: 'an unlisted model may try every protocol, because its protocol is unknown',
      run() {
        const config = resolveConfig({})
        equal(orderAttempts({ source: 'unlisted', protocols: [PROTOCOLS.CHAT] }, config), [
          PROTOCOLS.CHAT,
          PROTOCOLS.RESPONSES,
          PROTOCOLS.ANTHROPIC,
        ])
      },
    },
    {
      name: 'discovery adds ids the fallback does not describe',
      run() {
        const records = buildCatalog(resolveConfig({}), [{ id: 'brand-new-model', name: 'Brand New' }])
        const record = records.get('brand-new-model')
        ok(record !== undefined, 'the discovered id is in the catalog')
        is(record.name, 'Brand New')
        is(preferredProtocol(record), PROTOCOLS.CHAT)
        is(record.source, 'discovered')
      },
    },
    {
      name: 'a config entry overrides the fallback protocol for one model',
      run() {
        const config = resolveConfig({
          models: [{ id: 'gpt-5.6-luna', protocol: 'anthropic' }],
        })
        const records = buildCatalog(config, [])
        is(preferredProtocol(records.get('gpt-5.6-luna')), PROTOCOLS.ANTHROPIC)
        // The unmentioned models keep their measured mapping.
        is(preferredProtocol(records.get('glm-5.3')), PROTOCOLS.CHAT)
      },
    },
    {
      name: 'protocolOverrides is the terse form of the same change',
      run() {
        const config = resolveConfig({ protocolOverrides: { 'glm-5.3': 'anthropic' } })
        const records = buildCatalog(config, [])
        is(preferredProtocol(records.get('glm-5.3')), PROTOCOLS.ANTHROPIC)
      },
    },
    {
      name: 'an unusable protocolOverrides value is refused by model id',
      run() {
        const config = resolveConfig({ protocolOverrides: { 'glm-5.3': 'carrier-pigeon' } })
        let error
        try {
          buildCatalog(config, [])
        } catch (thrown) {
          error = thrown
        }
        ok(error !== undefined, 'it threw')
        ok(String(error.message).includes('glm-5.3'), 'the message names the model')
      },
    },
    {
      name: 'modelOverrides reshapes one model without replacing the catalog',
      run() {
        const config = resolveConfig({
          modelOverrides: { 'glm-5.3': { contextWindow: 999, maxTokens: 111, name: 'GLM Five Three' } },
        })
        const records = buildCatalog(config, [])
        const record = records.get('glm-5.3')
        is(record.contextWindow, 999)
        is(record.maxTokens, 111)
        is(record.name, 'GLM Five Three')
        is(preferredProtocol(record), PROTOCOLS.CHAT)
        ok(records.size > 10, 'the rest of the catalog survived')
      },
    },
    {
      name: 'modelSource=config replaces the catalog wholesale',
      run() {
        const config = resolveConfig({
          modelSource: 'config',
          models: [{ id: 'only-model', contextWindow: 1000, maxTokens: 100 }],
        })
        const records = buildCatalog(config, [{ id: 'ignored-model' }])
        equal([...records.keys()], ['only-model'])
      },
    },
    {
      name: 'a configured model defaults to the harness fallbacks',
      run() {
        const config = resolveConfig({ modelSource: 'config', models: [{ id: 'x' }] })
        const record = buildCatalog(config, []).get('x')
        is(record.contextWindow, 262_144)
        is(record.maxTokens, 32_768)
      },
    },
    {
      name: 'images are only declared when the entry asks for them',
      run() {
        const config = resolveConfig({
          modelSource: 'config',
          models: [{ id: 'plain' }, { id: 'sees', input: ['text', 'image'] }],
        })
        const records = buildCatalog(config, [])
        is(supportsImages(records.get('plain')), false)
        is(supportsImages(records.get('sees')), true)
        equal(records.get('sees').inputModalities, ['text', 'image'])
      },
    },
    {
      name: 'the resolved metadata carries the context window and reasoning ladder',
      run() {
        const records = buildCatalog(resolveConfig({ modelSource: 'config', models: [{ id: 'r', reasoning: true }] }), [])
        const info = resolvedModelInfo('opencode-go', records.get('r'))
        is(info.provider, 'opencode-go')
        is(info.context.contextWindow, 262_144)
        equal(info.inputModalities, undefined)
        equal(info.reasoning.efforts.map((effort) => String(effort.id)), ['minimal', 'low', 'medium', 'high', 'max'])
      },
    },
    {
      name: 'a Responses model never advertises the minimal effort the API rejects',
      run() {
        const records = buildCatalog(resolveConfig({}), [])
        const info = resolvedModelInfo('opencode-go', records.get('gpt-5.6-luna'))
        ok(!info.reasoning.efforts.some((effort) => String(effort.id) === 'minimal'), 'minimal is absent')
        ok(info.reasoning.efforts.some((effort) => String(effort.id) === 'low'), 'low is present')
      },
    },
    {
      name: 'a model without reasoning declares no reasoning metadata',
      run() {
        const records = buildCatalog(resolveConfig({ modelSource: 'config', models: [{ id: 'plain', reasoning: false }] }), [])
        is(resolvedModelInfo('opencode-go', records.get('plain')).reasoning, undefined)
      },
    },
    {
      name: 'the catalog listing carries the id, name, and modalities',
      run() {
        const records = buildCatalog(resolveConfig({ modelSource: 'config', models: [{ id: 'x', name: 'X', input: ['text', 'image'] }] }), [])
        equal(catalogModelInfo('opencode-go', records.get('x')), {
          provider: 'opencode-go',
          id: 'x',
          name: 'X',
          inputModalities: ['text', 'image'],
        })
      },
    },
    {
      name: 'a /models reply is parsed from the documented data array',
      run() {
        const rows = parseModelList({ object: 'list', data: [{ id: 'a' }, { id: 'b', name: 'B' }, { id: '' }, {}] })
        equal(rows, [{ id: 'a' }, { id: 'b', name: 'B' }])
      },
    },
    {
      name: 'an enriched models map is parsed too, because gateways publish both shapes',
      run() {
        const rows = parseModelList({ models: { a: { name: 'A' }, b: {} } })
        equal(rows, [{ id: 'a', name: 'A' }, { id: 'b' }])
      },
    },
    {
      name: 'an unrecognized payload yields no rows instead of throwing',
      run() {
        equal(parseModelList(null), [])
        equal(parseModelList({ data: 'nope' }), [])
      },
    },
  ],
}
