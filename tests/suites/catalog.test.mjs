/** Model catalog: protocol mapping, override merging, and capability resolution. */

import { PROTOCOLS, normalizeProtocol, resolveConfig } from '../../lib/config.js'
import { catalogModelInfo, resolvedInputModalities, resolvedModelInfo, supportsImages, trainingConsentNote } from '../../lib/model/capabilities.js'
import { FALLBACK_MODELS, buildCatalog, displayName, preferredProtocol, requiresTrainingConsent } from '../../lib/model/catalog.js'
import { parseModelList } from '../../lib/model/cache.js'
import { CAPABILITY_SOURCE, capabilityFor, isMeasured, measuredIds } from '../../lib/model/limits.js'
import { orderAttempts } from '../../lib/index.js'
import { equal, is, ok } from '../helpers.mjs'

/** A read-only view of the cached OpenCode catalogue, when this machine has one. */
async function cachedCatalogue() {
  const { readFile } = await import('node:fs/promises')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const paths = [
    process.env.OC_MODELS_CACHE,
    join(homedir(), '.cache', 'opencode', 'models.json'),
  ].filter((path) => path !== undefined)
  for (const path of paths) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      const provider = parsed?.['opencode-go']
      if (provider?.models !== undefined) return provider.models
    } catch {
      // Try the next candidate; a missing catalogue just skips the comparison.
    }
  }
  return undefined
}

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
        equal(info.inputModalities, ['text'])
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
      name: 'the measured table gives every served model its own window and cap',
      run() {
        const records = buildCatalog(resolveConfig({}), [])
        const cases = [
          ['deepseek-v4.1-flash', 1_000_000, 384_000],
          ['gpt-5.6-luna', 1_050_000, 128_000],
          ['grok-4.7', 500_000, 500_000],
          ['minimax-m2.7', 204_800, 131_072],
          ['hy3', 256_000, 128_000],
          ['kimi-k2.7-code', 262_144, 262_144],
        ]
        for (const [id, contextWindow, maxTokens] of cases) {
          const record = records.get(id)
          ok(record !== undefined, `${id} is in the catalog`)
          is(record.contextWindow, contextWindow, `${id} context window`)
          is(record.maxTokens, maxTokens, `${id} output cap`)
        }
        // The old behaviour: one assumed window for every model.
        ok(
          new Set(cases.map(([id]) => records.get(id).contextWindow)).size > 1,
          'two models no longer report the same window',
        )
      },
    },
    {
      name: 'every fallback model carries a measured or stated capacity source',
      run() {
        for (const record of FALLBACK_MODELS) {
          ok(typeof record.capacitySource === 'string' && record.capacitySource !== '', `${record.id} names a source`)
          is(Number.isInteger(record.contextWindow), true, `${record.id} has an integer window`)
          is(Number.isInteger(record.maxTokens), true, `${record.id} has an integer cap`)
          is(isMeasured(record.id), true, `${record.id} is named by the measured table`)
        }
      },
    },
    {
      name: 'a model the table does not name falls back to its measured family',
      run() {
        const family = capabilityFor('qwen3.9-unreleased', { contextWindow: 1, maxTokens: 1 })
        is(family.exact, false)
        is(family.contextWindow, 1_000_000)
        is(family.maxTokens, 131_072)
        ok(String(family.source).includes('family:qwen'), 'the source names the family it used')

        const unmeasured = capabilityFor('brand-new-model', { contextWindow: 111, maxTokens: 222 })
        is(unmeasured.exact, false)
        is(unmeasured.contextWindow, 111)
        is(unmeasured.maxTokens, 222)
        is(unmeasured.source, 'assumed')

        // A family fallback never overrides a measured row.
        ok(isMeasured('qwen3.7-max'), 'the exact id is measured')
        is(capabilityFor('qwen3.7-max', {}).contextWindow, 1_000_000)
        is(capabilityFor('qwen3.7-max', {}).exact, true)
      },
    },
    {
      name: 'the snapshot still agrees with the OpenCode catalogue this machine caches',
      async run() {
        const models = await cachedCatalogue()
        if (models === undefined) {
          ok(true, 'no local OpenCode catalogue to compare against')
          return
        }
        const measured = new Set(measuredIds())
        const mismatches = []
        for (const id of Object.keys(models)) {
          if (!measured.has(id)) continue
          const entry = models[id]
          const context = entry?.limit?.context
          if (context === undefined) continue
          const record = capabilityFor(id, {})
          if (record.contextWindow !== context) {
            mismatches.push(`${id}: table ${record.contextWindow} vs catalogue ${context}`)
          }
        }
        equal(mismatches, [], `snapshot ${CAPABILITY_SOURCE} disagrees with the cached catalogue`)
      },
    },
    {
      name: 'provider modalities are kept whole while the harness list stays sendable',
      run() {
        const records = buildCatalog(resolveConfig({}), [])
        const mimo = records.get('mimo-v2.6-pro')
        // The catalogue lists abilities no protocol here can carry.
        equal([...mimo.providerModalities], ['text', 'image', 'audio', 'video'])
        // Nothing is declared for a route that cannot resolve image bytes.
        equal(resolvedInputModalities(mimo, { imageRoute: false, mode: 'auto' }), ['text'])
        equal(resolvedInputModalities(mimo, { imageRoute: true, mode: 'auto' }), ['text', 'image'])
        // The abilities left out are stated rather than dropped.
        const info = resolvedModelInfo('opencode-go', mimo, { imageRoute: false, mode: 'auto' })
        equal(info.inputModalities, ['text'])
        ok(
          String(info.description).includes('audio') && String(info.description).includes('video'),
          `the note names what the route cannot send: ${info.description}`,
        )
      },
    },
    {
      name: 'a text-only model is never reported as image-capable',
      run() {
        const records = buildCatalog(resolveConfig({}), [])
        const flash = records.get('deepseek-v4-flash')
        equal([...flash.providerModalities], ['text'])
        is(supportsImages(flash), false)
        is(resolvedInputModalities(flash, { imageRoute: true, mode: 'auto' }).includes('image'), false)
        is(resolvedInputModalities(flash, { imageRoute: true, mode: 'always' }).includes('image'), false)
      },
    },
    {
      name: 'sendImages off suppresses the modality even for a vision model on a ready route',
      run() {
        const records = buildCatalog(resolveConfig({}), [])
        const vision = records.get('deepseek-v4-flash-vision-exp')
        is(supportsImages(vision), true)
        equal(resolvedInputModalities(vision, { imageRoute: true, mode: 'off' }), ['text'])
        equal(resolvedInputModalities(vision, { imageRoute: false, mode: 'always' }), ['text', 'image'])
      },
    },
    {
      name: 'a config entry may paste a catalogue record limits and modalities verbatim',
      run() {
        const config = resolveConfig({
          modelSource: 'config',
          models: [{
            id: 'pasted',
            limit: { context: 1_050_000, output: 128_000 },
            modalities: { input: ['text', 'image', 'pdf'] },
          }],
        })
        const record = buildCatalog(config, []).get('pasted')
        is(record.contextWindow, 1_050_000)
        is(record.maxTokens, 128_000)
        equal([...record.providerModalities], ['text', 'image', 'pdf'])
        is(record.capacitySource, 'config')
      },
    },
    {
      name: 'an input list naming something unsendable is refused by name',
      run() {
        const config = resolveConfig({ modelSource: 'config', models: [{ id: 'bad', input: ['text', 'video'] }] })
        let error
        try {
          buildCatalog(config, [])
        } catch (thrown) {
          error = thrown
        }
        ok(error instanceof TypeError, 'a TypeError is thrown')
        ok(String(error.message).includes('video'), `the message names the field: ${error.message}`)
      },
    },
    {
      name: 'the catalog listing carries the id, name, capacity, and modalities',
      run() {
        const records = buildCatalog(resolveConfig({ modelSource: 'config', models: [{ id: 'x', name: 'X', input: ['text', 'image'] }] }), [])
        // With no deployment facts the listing is conservative: text-only, the
        // same answer `resolveModel` gives without an image route.
        equal(catalogModelInfo('opencode-go', records.get('x')), {
          provider: 'opencode-go',
          id: 'x',
          name: 'X',
          inputModalities: ['text'],
          contextWindow: 262_144,
          maxTokens: 32_768,
        })
        // A mounted seam and a model that takes images: the listing says so,
        // because the selector offers what the route can actually send.
        const withRoute = catalogModelInfo('opencode-go', records.get('x'), { imageRoute: true, imageMode: 'auto' })
        equal(withRoute.inputModalities, ['text', 'image'])
      },
    },
    {
      name: 'the Go contributor ids carry the workspace training-consent flag',
      run() {
        const records = buildCatalog(resolveConfig({}), [])
        for (const id of ['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor']) {
          is(records.get(id).trainingConsent, true, id)
          equal([...records.get(id).protocols], ['responses'], `${id} is Responses-only`)
          is(requiresTrainingConsent(id), true, id)
        }
        // The flag follows the service's own id list, so every other model — including
        // one the measured table knows nothing about — stays ungated.
        is(records.get('glm-5.3').trainingConsent, false, 'an ordinary model is not gated')
        is(requiresTrainingConsent('muse-spark-1.3'), false, 'the non-contributor sibling is a different model')
      },
    },
    {
      name: 'a config entry states or clears the consent requirement, and a merge keeps it',
      run() {
        const declared = buildCatalog(resolveConfig({
          modelSource: 'config',
          models: [{ id: 'gated', trainingConsent: true }, { id: 'open' }],
        }), [])
        is(declared.get('gated').trainingConsent, true, 'an entry can declare it')
        is(declared.get('open').trainingConsent, false, 'an unlisted id defaults to ungated')

        // A gateway that does not implement the gate can say so, and a plain
        // override of another field must not silently drop the measured one.
        const cleared = buildCatalog(resolveConfig({
          modelOverrides: { 'muse-spark-1.3-contributor': { trainingConsent: false } },
        }), [])
        is(cleared.get('muse-spark-1.3-contributor').trainingConsent, false, 'an override can clear it')

        const merged = buildCatalog(resolveConfig({
          modelOverrides: { 'muse-spark-1.3-contributor': { contextWindow: 4096 } },
        }), [])
        is(merged.get('muse-spark-1.3-contributor').trainingConsent, true, 'a merge keeps the derived flag')

        const overridden = buildCatalog(resolveConfig({
          protocolOverrides: { 'muse-spark-1.3-contributor': 'anthropic' },
        }), [])
        is(overridden.get('muse-spark-1.3-contributor').trainingConsent, true, 'a protocol override keeps it')
        // The override is preferred, not exclusive: the rest of the list follows.
        equal([...overridden.get('muse-spark-1.3-contributor').protocols], ['anthropic', 'responses'])
      },
    },
    {
      name: 'a trainingConsent that is not a boolean is refused by name',
      run() {
        const config = resolveConfig({
          modelSource: 'config',
          models: [{ id: 'bad', trainingConsent: 'yes' }],
        })
        let error
        try {
          buildCatalog(config, [])
        } catch (thrown) {
          error = thrown
        }
        ok(error instanceof TypeError, 'a TypeError is thrown')
        ok(String(error.message).includes('trainingConsent'), `the message names the field: ${error.message}`)
      },
    },
    {
      name: 'the consent note is stated for a gated model and absent otherwise',
      run() {
        const records = buildCatalog(resolveConfig({}), [])
        const gated = records.get('muse-spark-1.3-contributor')
        const note = trainingConsentNote(gated)
        ok(
          String(note).includes('Allow models that train on request data'),
          `the note names the workspace setting: ${note}`,
        )
        is(trainingConsentNote(records.get('glm-5.3')), undefined, 'an ungated model carries no note')
        // The note reaches both surfaces a caller reads, and neither drops the
        // other note: this model takes video, which no protocol here can send.
        ok(
          String(catalogModelInfo('opencode-go', gated).description).includes('train on request data'),
          'the listing carries it',
        )
        ok(
          String(resolvedModelInfo('opencode-go', gated).description).includes('train on request data'),
          'the resolved metadata carries it',
        )
        is(catalogModelInfo('opencode-go', records.get('glm-5.3')).description, undefined, 'an ungated listing has none')
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
