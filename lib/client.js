/**
 * The browser half of dsh-opencode-go: the plugin's own configuration page in
 * the Harness web client.
 *
 * The page is registered into the Plugins page's `plugins.row.config` slot,
 * keyed by `<package name>#<row id>`, which is what gives the `opencode-go` row
 * its **Configure** control. It is a plain-JavaScript bundle — no build step, no
 * Harness Client package — so it survives a harness upgrade that changes those
 * packages: React comes from the browser's platform module table, and every
 * other fact comes from this plugin's own HTTP bridge (`lib/ui/bridge.js`).
 *
 * The page keeps no durable form model: the Host validates and persists, and
 * the page renders what the Host reports back. Two things are staged in the
 * component and nowhere else — the API key being typed, and the set of models
 * hidden from the listing — because both are edits the user is still making.
 *
 * Registered surface, in the shape the Plugins page dispatches:
 *
 *   view: 'summary' -> one line, rendered when no package description exists
 *   view: 'page'    -> the page itself, which owns its save controls
 */

window.__ModuleLoader__.load({
  id: 'dsh-opencode-go',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    /** The Host bridge endpoints, browser-relative (no leading slash). */
    const ROUTES = {
      state: 'opencode-go/state',
      models: 'opencode-go/models',
      refresh: 'opencode-go/refresh',
      config: 'opencode-go/config',
      credential: 'opencode-go/credential',
    }

    /** The row this page configures: `<package name>#<row id>`. */
    const ROW_KEY = 'dsh-opencode-go#opencode-go'

    /** How long to wait for a row to reload before reading it back. */
    const RELOAD_DELAY_MS = 400

    const DICTIONARY = {
      zh: {
        summary: '配置密钥、模型与用量',
        title: 'OpenCode Go',
        intro: '这里的改动写入当前 profile 的插件配置，不需要重启；密钥保存在凭据存储中，不会出现在配置文件里。',
        loading: '正在读取…',
        failed: '读取失败：{message}',
        retry: '重试',
        sectionConnection: '连接',
        fieldProvider: 'Provider 路由',
        fieldBaseURL: '接口地址',
        fieldApiKeyEnv: '凭据引用',
        sectionKey: 'API 密钥',
        keyConfigured: '已配置',
        keyMissing: '未配置',
        keySource: '来源：{source}',
        keyReadonly: '该密钥由启动环境变量提供，无法在这里覆盖；请先清空启动环境中的该变量。',
        keyPlaceholder: '粘贴 OpenCode Go API 密钥',
        keySave: '保存',
        keyClear: '清除密钥',
        keySaved: '已保存；下一次请求就会使用新的密钥。',
        keyCleared: '已清除存储的密钥。',
        keyNoStore: '此部署没有凭据存储，请在启动环境中导出该变量。',
        errUnauthorized: '浏览器会话未认证，请刷新页面后重试。',
        errForbidden: '请求被本机安全策略拒绝。',
        errHttp: '请求失败（HTTP {status}）。',
        keyRequired: '请先填写 API 密钥。',
        sectionModels: '模型可见性',
        modelsSummary: '列表中有 {listed} 个，共 {total} 个模型',
        modelsHiddenCount: '本页隐藏 {count} 个',
        modelsTrainingCount: 'hideTrainingModels 门控 {count} 个',
        modelsFilter: '筛选模型（id 或名称）',
        modelsEmpty: '没有匹配的模型。',
        modelsEmptyCatalog: '模型目录为空。',
        modelsListed: '在列表中显示',
        modelsReload: '刷新列表',
        modelsShowAll: '全部显示',
        modelsHideAll: '全部隐藏',
        modelsSave: '保存可见性',
        modelsReset: '还原改动',
        modelsDirty: '有 {count} 处未保存的改动',
        modelsClean: '与已保存的配置一致。',
        modelsSaved: '已保存；插件行重载后生效，列表会自动刷新。',
        modelsReloading: '已保存，正在等待插件行重载后刷新列表…',
        modelsStale: '已保存，但列表暂时读不到；请稍后重试。',
        modelsFetch: '获取模型列表',
        modelsFetching: '正在向服务读取…',
        modelsFetched: '已重新读取，共 {count} 个模型：新增 {added}，消失 {removed}。',
        modelsFetchedSame: '已重新读取，共 {count} 个模型，与上一次相同。',
        modelsFetchAdded: '新增：{models}',
        modelsFetchRemoved: '消失：{models}',
        modelsFetchNotDiscovering: '此部署的模型目录来自配置（modelSource: config），没有可获取的列表。',
        modelsFetchFailed: '读取模型列表失败：{message}',
        modelsAge: '列表获取于 {time}',
        modelsGated: '训练门控',
        modelsHiddenHere: '已隐藏',
        modelsTrainingHint: '该模型要求 workspace 开启「允许使用会训练请求数据的模型」，与是否隐藏无关。',
        modelsCatalogSource: '目录来源：{source}',
        modelsSourceDiscover: '自动发现（GET /models）',
        modelsSourceConfig: '来自配置',
        modelsFetchedAt: '缓存于 {time}',
        sectionVariants: '模型变体',
        variantsIntro: '变体是同一个模型的另一套设置：以一个名字固定协议、思考等级、上下文窗口和输出上限，并在模型列表里作为独立条目出现（<模型>@<名字>）。它只是本地的别名——请求仍然按原模型发出。',
        variantsEmpty: '还没有变体。',
        variantsModel: '模型',
        variantsModelPlaceholder: '选择一个模型',
        variantsName: '变体名',
        variantsNamePlaceholder: '例如 fast（字母、数字、点、横线、下划线）',
        variantsLabel: '显示名',
        variantsLabelPlaceholder: '可选，例如 GLM 5.3 Turbo',
        variantsProtocol: '优先协议',
        variantsProtocolDefault: '沿用模型自身',
        variantsEffort: '默认思考等级',
        variantsEffortDefault: '沿用模型自身',
        variantsContext: '上下文窗口',
        variantsMaxTokens: '输出上限',
        variantsPlaceholderInherit: '沿用模型自身',
        variantsAdd: '添加变体',
        variantsRemove: '删除',
        variantsSave: '保存变体',
        variantsReset: '还原改动',
        variantsDirty: '有 {count} 处未保存的改动',
        variantsClean: '与已保存的配置一致。',
        variantsSaved: '已保存；插件行重载后出现在模型列表里。',
        variantsReloading: '已保存，正在等待插件行重载后刷新…',
        variantsStale: '已保存，但列表暂时读不到；请稍后重试。',
        variantsWithoutModel: '这些变体点名的模型不在目录里，因此不会被提供：{models}',
        variantsDuplicate: '变体 "{id}" 已经存在。',
        variantsNeedModel: '请先选择一个模型。',
        variantsNeedName: '请填写变体名。',
        variantsBadName: '变体名只能包含字母、数字、点、横线和下划线。',
        variantsEffortRequiresReasoning: '模型 {model} 不支持思考，因此不能设置思考等级。',
        configReadonly: '配置为只读：{reason}',
        reasonNoEditor: '此部署没有 profile 配置编辑器',
        reasonNoEntry: '找不到该插件的 profile 条目',
      },
      en: {
        summary: 'Configure the key, models, and usage',
        title: 'OpenCode Go',
        intro: 'Changes here are written to this profile\'s plugin configuration and apply without a restart; the key lives in the credential store, never in a configuration file.',
        loading: 'Loading…',
        failed: 'Could not read the plugin state: {message}',
        retry: 'Retry',
        sectionConnection: 'Connection',
        fieldProvider: 'Provider route',
        fieldBaseURL: 'API root',
        fieldApiKeyEnv: 'Credential reference',
        sectionKey: 'API key',
        keyConfigured: 'Configured',
        keyMissing: 'Not configured',
        keySource: 'Source: {source}',
        keyReadonly: 'The launching environment supplies this key; it cannot be replaced here. Clear that variable first.',
        keyPlaceholder: 'Paste the OpenCode Go API key',
        keySave: 'Save',
        keyClear: 'Clear key',
        keySaved: 'Saved; the next request uses the new key.',
        keyCleared: 'The stored key was removed.',
        keyNoStore: 'This deployment has no credential store; export the variable in the launching environment instead.',
        errUnauthorized: 'The browser session is not authenticated; reload the page and retry.',
        errForbidden: 'The local request policy refused this call.',
        errHttp: 'Request failed (HTTP {status}).',
        keyRequired: 'Enter an API key first.',
        sectionModels: 'Model visibility',
        modelsSummary: '{listed} of {total} models are listed',
        modelsHiddenCount: '{count} hidden on this page',
        modelsTrainingCount: '{count} gated by hideTrainingModels',
        modelsFilter: 'Filter models by id or name',
        modelsEmpty: 'No model matches the filter.',
        modelsEmptyCatalog: 'The model catalog is empty.',
        modelsListed: 'Listed',
        modelsReload: 'Reload list',
        modelsShowAll: 'List all',
        modelsHideAll: 'Hide all',
        modelsSave: 'Save visibility',
        modelsReset: 'Discard changes',
        modelsDirty: '{count} unsaved change(s)',
        modelsClean: 'Matches the saved configuration.',
        modelsSaved: 'Saved; the listing follows when this plugin row reloads, and the list refreshes itself.',
        modelsReloading: 'Saved; waiting for the plugin row to reload before refreshing the list…',
        modelsStale: 'Saved, but the list could not be read back yet; retry in a moment.',
        modelsFetch: 'Fetch the model list',
        modelsFetching: 'Reading the service…',
        modelsFetched: 'Re-read {count} models: {added} new, {removed} gone.',
        modelsFetchedSame: 'Re-read {count} models; nothing changed.',
        modelsFetchAdded: 'New: {models}',
        modelsFetchRemoved: 'Gone: {models}',
        modelsFetchNotDiscovering: 'This deployment builds its catalog from configuration (modelSource: config), so there is no list to fetch.',
        modelsFetchFailed: 'Could not read the model list: {message}',
        modelsAge: 'list fetched {time}',
        modelsGated: 'training-gated',
        modelsHiddenHere: 'hidden',
        modelsTrainingHint: 'This model needs the workspace setting that allows models training on request data, whether or not it is hidden here.',
        modelsCatalogSource: 'Catalog source: {source}',
        modelsSourceDiscover: 'discovered (GET /models)',
        modelsSourceConfig: 'from configuration',
        modelsFetchedAt: 'cached {time}',
        sectionVariants: 'Model variants',
        variantsIntro: 'A variant is one model\'s second set of settings: a name that fixes the protocol to lead with, the default thinking level, the context window, and the output cap, offered in the model list as its own entry (<model>@<name>). It is a local alias — the request still leaves as the model itself.',
        variantsEmpty: 'No variants yet.',
        variantsModel: 'Model',
        variantsModelPlaceholder: 'Pick a model',
        variantsName: 'Variant name',
        variantsNamePlaceholder: 'for example fast (letters, digits, dot, dash, underscore)',
        variantsLabel: 'Display name',
        variantsLabelPlaceholder: 'optional, for example GLM 5.3 Turbo',
        variantsProtocol: 'Protocol first',
        variantsProtocolDefault: 'as the model declares',
        variantsEffort: 'Default thinking level',
        variantsEffortDefault: 'as the model declares',
        variantsContext: 'Context window',
        variantsMaxTokens: 'Output cap',
        variantsPlaceholderInherit: 'inherit',
        variantsAdd: 'Add variant',
        variantsRemove: 'Remove',
        variantsSave: 'Save variants',
        variantsReset: 'Discard changes',
        variantsDirty: '{count} unsaved change(s)',
        variantsClean: 'Matches the saved configuration.',
        variantsSaved: 'Saved; it appears in the model list when this plugin row reloads.',
        variantsReloading: 'Saved; waiting for the plugin row to reload…',
        variantsStale: 'Saved, but the list could not be read back yet; retry in a moment.',
        variantsWithoutModel: 'These variants name models the catalog does not list, so they are not offered: {models}',
        variantsDuplicate: 'Variant "{id}" is already declared.',
        variantsNeedModel: 'Pick a model first.',
        variantsNeedName: 'Enter a variant name.',
        variantsBadName: 'A variant name may hold only letters, digits, dot, dash, and underscore.',
        variantsEffortRequiresReasoning: 'Model {model} does not support reasoning, so it cannot carry a thinking level.',
        configReadonly: 'Configuration is read-only: {reason}',
        reasonNoEditor: 'this deployment has no profile configuration editor',
        reasonNoEntry: 'no profile entry for this plugin was found',
      },
    }

    /** Shared control styles; every colour is a host theme token. */
    const styles = {
      section: { marginTop: '18px' },
      sectionTitle: {
        margin: '0 0 8px',
        fontSize: '13px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
      },
      rows: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', margin: 0 },
      term: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', margin: 0 },
      value: { color: 'var(--dsw-alias-label-primary)', fontSize: '12px', margin: 0, wordBreak: 'break-all' },
      status: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto' },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', margin: '8px 0 0' },
      inputRow: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' },
      input: {
        flex: '1 1 240px',
        minWidth: '180px',
        height: '30px',
        padding: '0 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
      },
      button: {
        height: '30px',
        padding: '0 12px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        cursor: 'pointer',
      },
      primaryButton: {
        height: '30px',
        padding: '0 14px',
        borderRadius: '6px',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        fontSize: '12px',
        cursor: 'pointer',
      },
      toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' },
      formRow: { display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '10px' },
      inlineField: { display: 'flex', flexDirection: 'column', gap: '4px' },
      select: {
        height: '30px',
        padding: '0 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        maxWidth: '240px',
      },
      variantRow: {
        marginTop: '10px',
        paddingTop: '10px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      variantHead: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' },
      list: { marginTop: '10px', maxHeight: '320px', overflowY: 'auto' },
      row: {
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        padding: '5px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      rowText: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 },
      modelName: { color: 'var(--dsw-alias-label-primary)', fontSize: '12px' },
      modelMeta: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' },
      badge: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      message: { marginTop: '10px', fontSize: '12px' },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      success: { color: 'var(--dsw-alias-state-success-primary)' },
      muted: { color: 'var(--dsw-alias-label-secondary)' },
    }

    /** One request to the plugin's own bridge. */
    async function call(path, init) {
      const response = await fetch(path, {
        ...init,
        headers: { accept: 'application/json', ...(init?.headers ?? {}) },
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      return { status: response.status, ok: response.ok, payload }
    }

    /** Wait one animation-free moment; a reloaded plugin row needs a beat. */
    const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

    /** Whether the credential resolves through the store now. */
    function credentialText(t, credential, environment) {
      if (credential === null || credential === undefined) return t('keyNoStore')
      if (credential.configured === true) {
        return credential.source === undefined
          ? t('keyConfigured')
          : `${t('keyConfigured')} · ${t('keySource', { source: String(credential.source) })}`
      }
      if (environment?.present === true) {
        return `${t('keyConfigured')} · ${t('keySource', { source: 'environment' })}`
      }
      return t('keyMissing')
    }

    /** A readable context-window figure. */
    function contextLabel(value) {
      if (typeof value !== 'number' || value <= 0) return undefined
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
      if (value >= 1_000) return `${Math.round(value / 1_000)}K`
      return String(value)
    }

    /**
     * A time the world can read.
     *
     * The locale service ships the page's language but not a date formatter, so
     * this uses the browser's own: the moment a list was fetched is exactly the
     * kind of fact a reader wants in their own format.
     */
    function timeLabel(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
      try {
        return new Date(value).toLocaleString()
      } catch {
        return undefined
      }
    }

    /** One labelled row of read-only facts. */
    function Fact({ label, children }) {
      return h(React.Fragment, null, h('dt', { style: styles.term }, label), h('dd', { style: styles.value }, children))
    }

    /** The one-line summary the Plugins page renders when a description is absent. */
    function Summary({ t }) {
      return h('span', { style: styles.muted }, t('summary'))
    }

    /** The read-only connection facts. */
    function ConnectionSection({ t, state }) {
      return h('section', { style: styles.section },
        h('h4', { style: styles.sectionTitle }, t('sectionConnection')),
        h('div', { style: styles.card },
          h('dl', { style: styles.rows },
            h(Fact, { label: t('fieldProvider') }, state.route.provider),
            h(Fact, { label: t('fieldBaseURL') }, state.route.baseURL),
            h(Fact, { label: t('fieldApiKeyEnv') }, state.route.apiKeyEnv))))
    }

    /** The API-key editor: status, input, and the two writes. */
    function CredentialSection({ t, state, onChanged }) {
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const credential = state.credential
      const configured = credential?.configured === true || state.environment?.present === true
      const writable = credential === null || credential === undefined ? false : credential.writable === true
      const dotColor = configured ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'

      const report = (result, successKey, onSuccess) => {
        if (result.ok && result.payload?.ok === true) {
          setNotice({ kind: 'success', text: t(successKey) })
          onSuccess()
          return
        }
        if (result.status === 401) setNotice({ kind: 'error', text: t('errUnauthorized') })
        else if (result.status === 403) setNotice({ kind: 'error', text: t('errForbidden') })
        else if (result.payload?.message !== undefined) setNotice({ kind: 'error', text: String(result.payload.message) })
        else setNotice({ kind: 'error', text: t('errHttp', { status: String(result.status) }) })
      }

      const save = async () => {
        if (draft.trim() === '') {
          setNotice({ kind: 'error', text: t('keyRequired') })
          return
        }
        setBusy(true)
        try {
          const result = await call(ROUTES.credential, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: draft }),
          })
          report(result, 'keySaved', () => {
            setDraft('')
            onChanged()
          })
        } catch (error) {
          setNotice({ kind: 'error', text: t('errHttp', { status: String(error?.message ?? 'network') }) })
        } finally {
          setBusy(false)
        }
      }

      const clear = async () => {
        setBusy(true)
        try {
          report(await call(ROUTES.credential, { method: 'DELETE' }), 'keyCleared', onChanged)
        } catch (error) {
          setNotice({ kind: 'error', text: t('errHttp', { status: String(error?.message ?? 'network') }) })
        } finally {
          setBusy(false)
        }
      }

      return h('section', { style: styles.section },
        h('h4', { style: styles.sectionTitle }, t('sectionKey')),
        h('div', { style: styles.card },
          h('div', { style: styles.status },
            h('span', { style: { ...styles.dot, background: dotColor }, 'aria-hidden': true }),
            h('span', null, credentialText(t, credential, state.environment))),
          credential === null || credential === undefined || writable
            ? null
            : h('p', { style: styles.hint }, t('keyReadonly')),
          h('div', { style: styles.inputRow },
            h('label', {
              htmlFor: 'opencode-go-api-key',
              style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)' },
            }, t('keyPlaceholder')),
            h('input', {
              id: 'opencode-go-api-key',
              type: 'password',
              autoComplete: 'new-password',
              spellCheck: false,
              placeholder: t('keyPlaceholder'),
              value: draft,
              disabled: busy || !writable,
              onChange: (event) => setDraft(event.target.value),
              style: styles.input,
            }),
            h('button', {
              type: 'button',
              style: styles.primaryButton,
              disabled: busy || !writable || draft.trim() === '',
              onClick: save,
            }, t('keySave')),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: busy || !writable || !configured,
              onClick: clear,
            }, t('keyClear'))),
          notice === null
            ? null
            : h('p', {
              role: 'status',
              style: { ...styles.message, ...(notice.kind === 'success' ? styles.success : styles.error) },
            }, notice.text)))
    }

    /** One model row: its switch, its identity, and why it may be gated. */
    function ModelRow({ t, model, listed, disabled, onToggle }) {
      const context = contextLabel(model.contextWindow)
      return h('div', { style: { ...styles.row, opacity: disabled ? 0.6 : 1 } },
        h('input', {
          type: 'checkbox',
          checked: listed,
          disabled,
          'aria-label': `${model.id}: ${t('modelsListed')}`,
          onChange: (event) => onToggle(model.id, event.target.checked),
        }),
        h('div', { style: styles.rowText },
          h('span', { style: styles.modelName }, model.name === undefined || model.name === '' ? model.id : model.name),
          h('span', { style: styles.modelMeta }, model.id),
          h('span', { style: styles.modelMeta }, model.protocols.join(' · ')),
          context === undefined ? null : h('span', { style: styles.modelMeta }, context),
          model.reasoning ? h('span', { style: styles.badge }, 'reasoning') : null,
          model.hidden && !listed ? h('span', { style: styles.badge }, t('modelsHiddenHere')) : null,
          model.trainingGated ? h('span', { style: styles.badge }, t('modelsGated')) : null))
    }

    /**
     * Model visibility: which models this deployment offers in the picker.
     *
     * The draft is the edit; the save writes `hiddenModels`. Hiding is a
     * listing decision — a hidden model stays callable — so the section explains
     * that rather than implying the model became unusable.
     */
    function ModelsSection({ t, snapshot, busy, onSave, onReload, onFetch, notice }) {
      const [draft, setDraft] = useState(null)
      const [saved, setSaved] = useState(null)
      const [filter, setFilter] = useState('')
      const [saving, setSaving] = useState(false)

      // A fresh snapshot is the new baseline: the row reloaded, so whatever was
      // saved is now what the Host reports.
      useEffect(() => {
        const hidden = Array.isArray(snapshot?.hidden) ? [...snapshot.hidden].sort() : null
        setSaved(hidden)
        setDraft(hidden === null ? null : [...hidden])
      }, [snapshot])

      const models = Array.isArray(snapshot?.models) ? snapshot.models : []
      const hiddenSet = useMemo(() => new Set(draft ?? []), [draft])
      const savedSet = useMemo(() => new Set(saved ?? []), [saved])
      // The draft difference is symmetric: a model added to the hidden set and
      // one removed from it are both one change.
      const changed = draft === null || saved === null
        ? 0
        : draft.filter((id) => !savedSet.has(id)).length + saved.filter((id) => !hiddenSet.has(id)).length
      const dirty = changed > 0
      const counts = snapshot?.counts ?? null
      const needle = filter.trim().toLowerCase()
      const visible = needle === ''
        ? models
        : models.filter((model) => model.id.toLowerCase().includes(needle)
          || String(model.name ?? '').toLowerCase().includes(needle))

      const toggle = (id, listed) => {
        setDraft((current) => {
          const next = new Set(current ?? [])
          if (listed) next.delete(id)
          else next.add(id)
          return [...next].sort()
        })
      }

      const setAll = (listed) => {
        setDraft(listed ? [] : models.map((model) => model.id).sort())
      }

      const save = async () => {
        setSaving(true)
        try {
          await onSave([...(draft ?? [])].sort())
        } finally {
          setSaving(false)
        }
      }

      const sourceLabel = snapshot?.source === 'config' ? t('modelsSourceConfig') : t('modelsSourceDiscover')
      const fetched = timeLabel(snapshot?.fetchedAt)

      return h('section', { style: styles.section },
        h('h4', { style: styles.sectionTitle }, t('sectionModels')),
        h('div', { style: styles.card },
          h('p', { style: styles.value }, counts === null
            ? t('modelsEmptyCatalog')
            : t('modelsSummary', { listed: String(counts.listed), total: String(counts.total) })),
          h('p', { style: styles.hint },
            [
              counts === null || counts.hidden === 0 ? null : t('modelsHiddenCount', { count: String(counts.hidden) }),
              counts === null || counts.hiddenByTraining === 0
                ? null
                : t('modelsTrainingCount', { count: String(counts.hiddenByTraining) }),
              t('modelsCatalogSource', { source: sourceLabel }),
              fetched === undefined ? null : t('modelsAge', { time: fetched }),
            ].filter((part) => part !== null).join(' · ')),

          h('div', { style: styles.toolbar },
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: busy,
              onClick: onFetch,
            }, t('modelsFetch')),
            h('label', {
              htmlFor: 'opencode-go-model-filter',
              style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)' },
            }, t('modelsFilter')),
            h('input', {
              id: 'opencode-go-model-filter',
              type: 'search',
              placeholder: t('modelsFilter'),
              value: filter,
              onChange: (event) => setFilter(event.target.value),
              style: { ...styles.input, flex: '1 1 200px' },
            }),
            h('button', { type: 'button', style: styles.button, disabled: draft === null, onClick: () => setAll(true) }, t('modelsShowAll')),
            h('button', { type: 'button', style: styles.button, disabled: draft === null, onClick: () => setAll(false) }, t('modelsHideAll')),
            h('button', {
              type: 'button',
              style: styles.primaryButton,
              disabled: !dirty || saving || busy,
              onClick: save,
            }, t('modelsSave')),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: !dirty || saving,
              onClick: () => setDraft(saved === null ? null : [...saved]),
            }, t('modelsReset'))),

          h('p', { style: styles.hint }, draft === null || saved === null
            ? t('loading')
            : dirty
              ? t('modelsDirty', { count: String(changed) })
              : t('modelsClean')),

          h('div', { style: styles.list },
            models.length === 0
              ? h('p', { style: styles.hint }, t('modelsEmptyCatalog'))
              : visible.length === 0
                ? h('p', { style: styles.hint }, t('modelsEmpty'))
                : visible.map((model) => h(ModelRow, {
                  key: model.id,
                  t,
                  model,
                  listed: !hiddenSet.has(model.id),
                  disabled: draft === null,
                  onToggle: toggle,
                }))),

          h('p', { style: styles.hint }, t('modelsTrainingHint')),
          h('div', { style: styles.toolbar },
            h('button', { type: 'button', style: styles.button, disabled: busy, onClick: onReload }, t('modelsReload'))),
          notice === null
            ? null
            : h('p', {
              role: 'status',
              style: { ...styles.message, ...(notice.kind === 'success' ? styles.success : styles.error) },
            }, notice.text)))
    }

    /**
     * Model variants: named presets of one model, each offered as its own entry.
     *
     * The draft is an array of entries in the shape the config field takes, so
     * save writes exactly what is on screen. An entry is only ever staged here:
     * the Host validates the list and the loader reloads the row, which is when
     * the new entries appear in the model list.
     */
    function VariantsSection({ t, snapshot, models, busy, onSave, onReload, notice }) {
      const [draft, setDraft] = useState(null)
      const [saved, setSaved] = useState(null)
      const [form, setForm] = useState({ model: '', name: '', label: '', protocol: '', effort: '' })
      const [problem, setProblem] = useState(null)

      // A fresh snapshot is the new baseline: the row reloaded, so what the
      // Host reports is what was saved.
      useEffect(() => {
        const declared = Array.isArray(snapshot?.variants) ? snapshot.variants : null
        const copy = declared === null ? null : declared.map((entry) => ({ ...entry }))
        setSaved(copy)
        setDraft(copy === null ? null : copy.map((entry) => ({ ...entry })))
      }, [snapshot])

      const baseModels = models.filter((model) => model.variant === null)
      const changeCount = draft === null || saved === null
        ? 0
        : draft.reduce((total, entry, index) => {
          const before = saved[index]
          return total + (JSON.stringify(entry) === JSON.stringify(before) ? 0 : 1)
        }, 0) + Math.abs(draft.length - saved.length)
      const dirty = changeCount > 0
      const missing = Array.isArray(snapshot?.variantsWithoutModel) ? snapshot.variantsWithoutModel : []

      const nameProblem = (model, name) => {
        if (name.trim() === '') return t('variantsNeedName')
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name.trim())) return t('variantsBadName')
        if (draft !== null && draft.some((entry) => entry.model === model && entry.name === name.trim())) {
          return t('variantsDuplicate', { id: `${model}@${name.trim()}` })
        }
        return undefined
      }

      const add = () => {
        const model = form.model
        const name = form.name.trim()
        if (model === '') {
          setProblem({ kind: 'error', text: t('variantsNeedModel') })
          return
        }
        const refused = nameProblem(model, name)
        if (refused !== undefined) {
          setProblem({ kind: 'error', text: refused })
          return
        }
        const entry = { model, name }
        if (form.label.trim() !== '') entry.label = form.label.trim()
        if (form.protocol !== '') entry.protocol = form.protocol
        if (form.effort !== '') entry.effort = form.effort
        setDraft((current) => [...(current ?? []), entry])
        setForm({ model: '', name: '', label: '', protocol: '', effort: '' })
        setProblem(null)
      }

      const update = (index, field, value) => {
        setDraft((current) => current.map((entry, at) => {
          if (at !== index) return entry
          if (value === '' || value === null || value === undefined) {
            const { [field]: _dropped, ...rest } = entry
            return rest
          }
          return { ...entry, [field]: value }
        }))
      }

      const remove = (index) => {
        setDraft((current) => current.filter((_entry, at) => at !== index))
        setProblem(null)
      }

      const selected = models.find((model) => model.id === form.model)
      const protocolOptions = [...new Set(models.flatMap((model) => model.protocols ?? []))]
      const effortOptions = selected?.reasoning === true ? selected.efforts ?? [] : []

      const numberField = (t, entry, index, field, label) => h('label', { style: styles.inlineField },
        h('span', { style: styles.term }, label),
        h('input', {
          type: 'number',
          min: '1',
          step: '1',
          value: entry[field] ?? '',
          placeholder: t('variantsPlaceholderInherit'),
          'aria-label': `${entry.model}@${entry.name} ${label}`,
          onChange: (event) => update(index, field, event.target.value === '' ? '' : Number(event.target.value)),
          style: { ...styles.input, flex: '0 0 110px', minWidth: '90px' },
        }))

      return h('section', { style: styles.section },
        h('h4', { style: styles.sectionTitle }, t('sectionVariants')),
        h('div', { style: styles.card },
          h('p', { style: styles.hint }, t('variantsIntro')),
          missing.length === 0
            ? null
            : h('p', { style: { ...styles.message, ...styles.error } }, t('variantsWithoutModel', { models: missing.join(', ') })),

          draft === null || draft.length === 0
            ? h('p', { style: styles.hint }, t('variantsEmpty'))
            : draft.map((entry, index) => h('div', { key: `${entry.model}@${entry.name}`, style: styles.variantRow },
              h('div', { style: styles.variantHead },
                h('span', { style: styles.modelName }, entry.label ?? `${entry.model} (${entry.name})`),
                h('span', { style: styles.modelMeta }, `${entry.model}@${entry.name}`),
                h('button', {
                  type: 'button',
                  style: styles.button,
                  onClick: () => remove(index),
                }, t('variantsRemove'))),
              h('div', { style: styles.toolbar },
                h('label', { style: styles.inlineField },
                  h('span', { style: styles.term }, t('variantsProtocol')),
                  h('select', {
                    value: entry.protocol ?? '',
                    'aria-label': `${entry.model}@${entry.name} ${t('variantsProtocol')}`,
                    onChange: (event) => update(index, 'protocol', event.target.value),
                    style: styles.select,
                  },
                  h('option', { value: '' }, t('variantsProtocolDefault')),
                  protocolOptions.map((protocol) => h('option', { key: protocol, value: protocol }, protocol)))),
                (models.find((model) => model.id === entry.model)?.reasoning === true)
                  ? h('label', { style: styles.inlineField },
                    h('span', { style: styles.term }, t('variantsEffort')),
                    h('select', {
                      value: entry.effort ?? '',
                      'aria-label': `${entry.model}@${entry.name} ${t('variantsEffort')}`,
                      onChange: (event) => update(index, 'effort', event.target.value),
                      style: styles.select,
                    },
                    h('option', { value: '' }, t('variantsEffortDefault')),
                    (models.find((model) => model.id === entry.model)?.efforts ?? []).map((level) => h('option', { key: level, value: level }, level))))
                  : h('span', { style: styles.hint }, t('variantsEffortRequiresReasoning', { model: entry.model })),
                numberField(t, entry, index, 'contextWindow', t('variantsContext')),
                numberField(t, entry, index, 'maxTokens', t('variantsMaxTokens'))))),

          h('div', { style: styles.formRow },
            h('label', { style: styles.inlineField },
              h('span', { style: styles.term }, t('variantsModel')),
              h('select', {
                value: form.model,
                'aria-label': t('variantsModel'),
                onChange: (event) => setForm({ ...form, model: event.target.value, effort: '' }),
                style: styles.select,
              },
              h('option', { value: '' }, t('variantsModelPlaceholder')),
              baseModels.map((model) => h('option', { key: model.id, value: model.id }, `${model.name} · ${model.id}`)))),
            h('label', { style: styles.inlineField },
              h('span', { style: styles.term }, t('variantsName')),
              h('input', {
                type: 'text',
                value: form.name,
                placeholder: t('variantsNamePlaceholder'),
                'aria-label': t('variantsName'),
                onChange: (event) => setForm({ ...form, name: event.target.value }),
                style: { ...styles.input, flex: '0 0 200px', minWidth: '140px' },
              })),
            h('label', { style: styles.inlineField },
              h('span', { style: styles.term }, t('variantsLabel')),
              h('input', {
                type: 'text',
                value: form.label,
                placeholder: t('variantsLabelPlaceholder'),
                'aria-label': t('variantsLabel'),
                onChange: (event) => setForm({ ...form, label: event.target.value }),
                style: { ...styles.input, flex: '0 0 200px', minWidth: '140px' },
              }))),
          h('div', { style: styles.formRow },
            h('label', { style: styles.inlineField },
              h('span', { style: styles.term }, t('variantsProtocol')),
              h('select', {
                value: form.protocol,
                'aria-label': t('variantsProtocol'),
                onChange: (event) => setForm({ ...form, protocol: event.target.value }),
                style: styles.select,
              },
              h('option', { value: '' }, t('variantsProtocolDefault')),
              protocolOptions.map((protocol) => h('option', { key: protocol, value: protocol }, protocol)))),
            effortOptions.length === 0
              ? null
              : h('label', { style: styles.inlineField },
                h('span', { style: styles.term }, t('variantsEffort')),
                h('select', {
                  value: form.effort,
                  'aria-label': t('variantsEffort'),
                  onChange: (event) => setForm({ ...form, effort: event.target.value }),
                  style: styles.select,
                },
                h('option', { value: '' }, t('variantsEffortDefault')),
                effortOptions.map((level) => h('option', { key: level, value: level }, level)))),
            h('button', { type: 'button', style: styles.button, disabled: draft === null, onClick: add }, t('variantsAdd'))),

          problem === null
            ? null
            : h('p', { role: 'status', style: { ...styles.message, ...styles.error } }, problem.text),

          h('div', { style: styles.toolbar },
            h('button', {
              type: 'button',
              style: styles.primaryButton,
              disabled: !dirty || busy,
              onClick: () => onSave(draft ?? []),
            }, t('variantsSave')),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: !dirty || busy,
              onClick: () => setDraft(saved === null ? null : saved.map((entry) => ({ ...entry }))),
            }, t('variantsReset')),
            h('button', { type: 'button', style: styles.button, disabled: busy, onClick: onReload }, t('modelsReload')),
            h('span', { style: styles.hint }, draft === null || saved === null
              ? t('loading')
              : dirty
                ? t('variantsDirty', { count: String(changeCount) })
                : t('variantsClean'))),

          notice === null
            ? null
            : h('p', {
              role: 'status',
              style: { ...styles.message, ...(notice.kind === 'success' ? styles.success : styles.error) },
            }, notice.text)))
    }

    /** The configuration page for one plugin row. */
    function ConfigPage(props) {
      const { t } = props
      const [state, setState] = useState({ phase: 'loading' })
      const [snapshot, setSnapshot] = useState(null)
      const [modelsNotice, setModelsNotice] = useState(null)
      const [variantsNotice, setVariantsNotice] = useState(null)
      const [busy, setBusy] = useState(false)

      const readModels = useCallback(async () => {
        const result = await call(ROUTES.models)
        if (result.ok && result.payload?.ok === true) {
          setSnapshot(result.payload)
          return true
        }
        return false
      }, [])

      const readState = useCallback(async () => {
        const result = await call(ROUTES.state)
        if (result.ok && result.payload?.ok === true) {
          setState({ phase: 'ready', data: result.payload })
          return true
        }
        setState({ phase: 'failed', status: result.status, message: result.payload?.message })
        return false
      }, [])

      const load = useCallback(async () => {
        await Promise.all([readState(), readModels()])
      }, [readModels, readState])

      useEffect(() => {
        let alive = true
        void (async () => {
          const [stateResult, modelsResult] = await Promise.all([call(ROUTES.state), call(ROUTES.models)])
          if (!alive) return
          if (stateResult.ok && stateResult.payload?.ok === true) setState({ phase: 'ready', data: stateResult.payload })
          else setState({ phase: 'failed', status: stateResult.status, message: stateResult.payload?.message })
          if (modelsResult.ok && modelsResult.payload?.ok === true) setSnapshot(modelsResult.payload)
        })()
        return () => {
          alive = false
        }
      }, [])

      /**
       * Write one managed config field, then read the row back.
       *
       * Writing an ordinary config field reloads this plugin row, so the write
       * answer is the persisted override rather than a re-resolved snapshot.
       * The catalog is re-read after a beat, and once more if the reload is
       * still in flight; a catalog that stays unreadable is reported instead of
       * being shown stale.
       */
      const saveField = useCallback(async (field, value, { setNotice, reloading, saved, stale }) => {
        setBusy(true)
        setNotice({ kind: 'success', text: t(reloading) })
        try {
          const result = await call(ROUTES.config, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set: { [field]: value } }),
          })
          if (!(result.ok && result.payload?.ok === true)) {
            const text = result.status === 401 ? t('errUnauthorized')
              : result.status === 403 ? t('errForbidden')
                : result.payload?.message !== undefined ? String(result.payload.message)
                  : t('errHttp', { status: String(result.status) })
            setNotice({ kind: 'error', text })
            return
          }
          await pause(RELOAD_DELAY_MS)
          if (!(await readModels())) {
            await pause(RELOAD_DELAY_MS * 2)
            setNotice(await readModels()
              ? { kind: 'success', text: t(saved) }
              : { kind: 'error', text: t(stale) })
          } else {
            setNotice({ kind: 'success', text: t(saved) })
          }
          await readState()
        } catch (error) {
          setNotice({ kind: 'error', text: t('errHttp', { status: String(error?.message ?? 'network') }) })
        } finally {
          setBusy(false)
        }
      }, [readModels, readState, t])

      const saveHidden = useCallback(
        (hidden) => saveField('hiddenModels', hidden, {
          setNotice: setModelsNotice,
          reloading: 'modelsReloading',
          saved: 'modelsSaved',
          stale: 'modelsStale',
        }),
        [saveField],
      )

      const saveVariants = useCallback(
        (variants) => saveField('modelVariants', variants, {
          setNotice: setVariantsNotice,
          reloading: 'variantsReloading',
          saved: 'variantsSaved',
          stale: 'variantsStale',
        }),
        [saveField],
      )

      const reloadModels = useCallback(async () => {
        setBusy(true)
        try {
          if (await readModels()) {
            setModelsNotice(null)
            setVariantsNotice(null)
          } else {
            setModelsNotice({ kind: 'error', text: t('modelsStale') })
          }
        } finally {
          setBusy(false)
        }
      }, [readModels, t])

      /**
       * Read the service's own model list, on request.
       *
       * This is the only call the page makes that reaches the provider, so its
       * answer is what a person sees: what appeared, what went away, and how
       * many models the service now lists. A failure keeps the catalog on
       * screen — the Host leaves it untouched — and says why.
       */
      const fetchModels = useCallback(async () => {
        setBusy(true)
        setModelsNotice({ kind: 'success', text: t('modelsFetching') })
        try {
          const result = await call(ROUTES.refresh, { method: 'POST' })
          const payload = result.payload
          if (payload?.catalog !== undefined && payload.catalog !== null) setSnapshot(payload.catalog)
          if (result.ok && payload?.ok === true) {
            const added = Array.isArray(payload.added) ? payload.added : []
            const removed = Array.isArray(payload.removed) ? payload.removed : []
            const count = String(payload.discovered ?? 0)
            const summary = added.length === 0 && removed.length === 0
              ? t('modelsFetchedSame', { count })
              : t('modelsFetched', { count, added: String(added.length), removed: String(removed.length) })
            const details = [
              added.length === 0 ? null : t('modelsFetchAdded', { models: added.join(', ') }),
              removed.length === 0 ? null : t('modelsFetchRemoved', { models: removed.join(', ') }),
            ].filter((part) => part !== null).join(' · ')
            setModelsNotice({ kind: 'success', text: details === '' ? summary : `${summary} ${details}` })
            await readState()
            return
          }
          if (result.status === 401) setModelsNotice({ kind: 'error', text: t('errUnauthorized') })
          else if (result.status === 403) setModelsNotice({ kind: 'error', text: t('errForbidden') })
          else if (payload?.error === 'not-discovering') {
            setModelsNotice({ kind: 'error', text: t('modelsFetchNotDiscovering') })
          } else {
            setModelsNotice({
              kind: 'error',
              text: t('modelsFetchFailed', {
                message: payload?.message ?? t('errHttp', { status: String(result.status) }),
              }),
            })
          }
        } catch (error) {
          setModelsNotice({
            kind: 'error',
            text: t('modelsFetchFailed', { message: String(error?.message ?? 'network') }),
          })
        } finally {
          setBusy(false)
        }
      }, [readState, t])

      if (state.phase === 'loading') return h('p', { style: styles.muted }, t('loading'))
      if (state.phase === 'failed') {
        return h('div', null,
          h('p', { style: { ...styles.message, ...styles.error } }, t('failed', { message: state.message ?? t('errHttp', { status: String(state.status) }) })),
          h('button', { type: 'button', style: styles.button, onClick: load }, t('retry')))
      }

      const data = state.data
      const models = Array.isArray(snapshot?.models) ? snapshot.models : []
      return h('div', { 'data-opencode-go-config': true },
        h('p', { style: styles.hint }, t('intro')),
        h(ConnectionSection, { t, state: data }),
        h(CredentialSection, { t, state: data, onChanged: load }),
        h(ModelsSection, {
          t,
          snapshot,
          busy,
          onSave: saveHidden,
          onReload: reloadModels,
          onFetch: fetchModels,
          notice: modelsNotice,
        }),
        h(VariantsSection, {
          t,
          snapshot,
          models,
          busy,
          onSave: saveVariants,
          onReload: reloadModels,
          notice: variantsNotice,
        }),
        data.config?.editable === true
          ? null
          : h('p', { style: styles.hint },
            t('configReadonly', {
              reason: data.config?.reason === 'entry-not-found' ? t('reasonNoEntry') : t('reasonNoEditor'),
            })))
    }

    /** The registered page: the row detail renders `summary`, the page renders `page`. */
    function PluginPage(props) {
      if (props.view === 'summary') return h(Summary, props)
      return h(ConfigPage, props)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register('opencodeGo', DICTIONARY),
          'opencode-go: configuration page dictionary',
        )
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: 'opencodeGo',
        }, PluginPage))
      },
    }
  },
})
