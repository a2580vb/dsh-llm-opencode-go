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
        modelsGated: '训练门控',
        modelsHiddenHere: '已隐藏',
        modelsTrainingHint: '该模型要求 workspace 开启「允许使用会训练请求数据的模型」，与是否隐藏无关。',
        modelsCatalogSource: '目录来源：{source}',
        modelsSourceDiscover: '自动发现（GET /models）',
        modelsSourceConfig: '来自配置',
        modelsFetchedAt: '缓存于 {time}',
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
        modelsGated: 'training-gated',
        modelsHiddenHere: 'hidden',
        modelsTrainingHint: 'This model needs the workspace setting that allows models training on request data, whether or not it is hidden here.',
        modelsCatalogSource: 'Catalog source: {source}',
        modelsSourceDiscover: 'discovered (GET /models)',
        modelsSourceConfig: 'from configuration',
        modelsFetchedAt: 'cached {time}',
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
    function ModelsSection({ t, snapshot, busy, onSave, onReload, notice }) {
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
            ].filter((part) => part !== null).join(' · ')),

          h('div', { style: styles.toolbar },
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

    /** The configuration page for one plugin row. */
    function ConfigPage(props) {
      const { t } = props
      const [state, setState] = useState({ phase: 'loading' })
      const [snapshot, setSnapshot] = useState(null)
      const [modelsNotice, setModelsNotice] = useState(null)
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
       * Save the hidden set, then read the row back.
       *
       * Writing an ordinary config field reloads this plugin row, so the write
       * answer is the persisted override rather than a re-resolved snapshot.
       * The list is re-read after a beat, and once more if the reload is still
       * in flight; a list that stays unreadable is reported instead of being
       * shown stale.
       */
      const saveHidden = useCallback(async (hidden) => {
        setBusy(true)
        setModelsNotice({ kind: 'success', text: t('modelsReloading') })
        try {
          const result = await call(ROUTES.config, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set: { hiddenModels: hidden } }),
          })
          if (!(result.ok && result.payload?.ok === true)) {
            const text = result.status === 401 ? t('errUnauthorized')
              : result.status === 403 ? t('errForbidden')
                : result.payload?.message !== undefined ? String(result.payload.message)
                  : t('errHttp', { status: String(result.status) })
            setModelsNotice({ kind: 'error', text })
            return
          }
          await pause(RELOAD_DELAY_MS)
          if (!(await readModels())) {
            await pause(RELOAD_DELAY_MS * 2)
            if (!(await readModels())) setModelsNotice({ kind: 'error', text: t('modelsStale') })
            else setModelsNotice({ kind: 'success', text: t('modelsSaved') })
          } else {
            setModelsNotice({ kind: 'success', text: t('modelsSaved') })
          }
          await readState()
        } catch (error) {
          setModelsNotice({ kind: 'error', text: t('errHttp', { status: String(error?.message ?? 'network') }) })
        } finally {
          setBusy(false)
        }
      }, [readModels, readState, t])

      const reloadModels = useCallback(async () => {
        setBusy(true)
        try {
          if (await readModels()) setModelsNotice(null)
          else setModelsNotice({ kind: 'error', text: t('modelsStale') })
        } finally {
          setBusy(false)
        }
      }, [readModels, t])

      if (state.phase === 'loading') return h('p', { style: styles.muted }, t('loading'))
      if (state.phase === 'failed') {
        return h('div', null,
          h('p', { style: { ...styles.message, ...styles.error } }, t('failed', { message: state.message ?? t('errHttp', { status: String(state.status) }) })),
          h('button', { type: 'button', style: styles.button, onClick: load }, t('retry')))
      }

      const data = state.data
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
          notice: modelsNotice,
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
