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
 * The page deliberately keeps no client-side form model: the Host validates and
 * persists, the page renders what the Host reports back. The one exception is
 * the staged API-key input, whose value exists only in this component's state
 * and is cleared the moment the Host accepts or refuses it.
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
    const { useCallback, useEffect, useState } = React

    /** The Host bridge endpoints, browser-relative (no leading slash). */
    const ROUTES = {
      state: 'opencode-go/state',
      config: 'opencode-go/config',
      credential: 'opencode-go/credential',
    }

    /** The row this page configures: `<package name>#<row id>`. */
    const ROW_KEY = 'dsh-opencode-go#opencode-go'

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
        sectionModels: '模型目录',
        modelsCount: '已列出 {count} 个模型',
        modelsSourceDiscover: '自动发现（GET /models）',
        modelsSourceConfig: '来自配置',
        modelsUnavailable: '暂时无法读取模型目录',
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
        configReadonly: '配置为只读：{reason}',
        reasonNoEditor: '此部署没有 profile 配置编辑器',
        reasonNoEntry: '找不到该插件的 profile 条目',
        keyRequired: '请先填写 API 密钥。',
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
        sectionModels: 'Model catalog',
        modelsCount: '{count} models listed',
        modelsSourceDiscover: 'discovered (GET /models)',
        modelsSourceConfig: 'from configuration',
        modelsUnavailable: 'the model catalog is unavailable right now',
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
        configReadonly: 'Configuration is read-only: {reason}',
        reasonNoEditor: 'this deployment has no profile configuration editor',
        reasonNoEntry: 'no profile entry for this plugin was found',
        keyRequired: 'Enter an API key first.',
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

    /** One labelled row of read-only facts. */
    function Fact({ label, children }) {
      return h(React.Fragment, null, h('dt', { style: styles.term }, label), h('dd', { style: styles.value }, children))
    }

    /** The one-line summary the Plugins page renders when a description is absent. */
    function Summary({ t }) {
      return h('span', { style: styles.muted }, t('summary'))
    }

    /** The configuration page for one plugin row. */
    function ConfigPage(props) {
      const { t } = props
      const [state, setState] = useState({ phase: 'loading' })
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)

      const load = useCallback(async () => {
        const result = await call(ROUTES.state)
        if (result.ok && result.payload?.ok === true) setState({ phase: 'ready', data: result.payload })
        else setState({ phase: 'failed', status: result.status, message: result.payload?.message })
      }, [])

      useEffect(() => {
        let alive = true
        void (async () => {
          const result = await call(ROUTES.state)
          if (!alive) return
          if (result.ok && result.payload?.ok === true) setState({ phase: 'ready', data: result.payload })
          else setState({ phase: 'failed', status: result.status, message: result.payload?.message })
        })()
        return () => {
          alive = false
        }
      }, [])

      /** Turn a bridge answer into the message the page shows. */
      const report = useCallback((result, successKey) => {
        if (result.ok && result.payload?.ok === true) {
          setNotice({ kind: 'success', text: t(successKey) })
          return true
        }
        if (result.status === 401) setNotice({ kind: 'error', text: t('errUnauthorized') })
        else if (result.status === 403) setNotice({ kind: 'error', text: t('errForbidden') })
        else if (result.payload?.message !== undefined) setNotice({ kind: 'error', text: String(result.payload.message) })
        else setNotice({ kind: 'error', text: t('errHttp', { status: String(result.status) }) })
        return false
      }, [t])

      const save = useCallback(async () => {
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
          if (report(result, 'keySaved')) {
            setDraft('')
            await load()
          }
        } catch (error) {
          setNotice({ kind: 'error', text: t('errHttp', { status: String(error?.message ?? 'network') }) })
        } finally {
          setBusy(false)
        }
      }, [draft, load, report, t])

      const clear = useCallback(async () => {
        setBusy(true)
        try {
          const result = await call(ROUTES.credential, { method: 'DELETE' })
          if (report(result, 'keyCleared')) await load()
        } catch (error) {
          setNotice({ kind: 'error', text: t('errHttp', { status: String(error?.message ?? 'network') }) })
        } finally {
          setBusy(false)
        }
      }, [load, report, t])

      if (state.phase === 'loading') return h('p', { style: styles.muted }, t('loading'))
      if (state.phase === 'failed') {
        return h('div', null,
          h('p', { style: { ...styles.message, ...styles.error } }, t('failed', { message: state.message ?? t('errHttp', { status: String(state.status) }) })),
          h('button', { type: 'button', style: styles.button, onClick: load }, t('retry')))
      }

      const data = state.data
      const credential = data.credential
      const editable = data.config?.editable === true
      const configured = credential?.configured === true || data.environment?.present === true
      const writable = credential === null || credential === undefined ? false : credential.writable === true
      const dotColor = configured ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'

      return h('div', { 'data-opencode-go-config': true },
        h('p', { style: styles.hint }, t('intro')),

        h('section', { style: styles.section },
          h('h4', { style: styles.sectionTitle }, t('sectionConnection')),
          h('div', { style: styles.card },
            h('dl', { style: styles.rows },
              h(Fact, { label: t('fieldProvider') }, data.route.provider),
              h(Fact, { label: t('fieldBaseURL') }, data.route.baseURL),
              h(Fact, { label: t('fieldApiKeyEnv') }, data.route.apiKeyEnv)))),

        h('section', { style: styles.section },
          h('h4', { style: styles.sectionTitle }, t('sectionKey')),
          h('div', { style: styles.card },
            h('div', { style: styles.status },
              h('span', { style: { ...styles.dot, background: dotColor }, 'aria-hidden': true }),
              h('span', null, credentialText(t, credential, data.environment))),
            credential === null || credential === undefined
              ? null
              : writable
                ? null
                : h('p', { style: styles.hint }, t('keyReadonly')),
            h('div', { style: styles.inputRow },
              h('label', { htmlFor: 'opencode-go-api-key', style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)' } }, t('keyPlaceholder')),
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
              }, notice.text))),

        h('section', { style: styles.section },
          h('h4', { style: styles.sectionTitle }, t('sectionModels')),
          h('div', { style: styles.card },
            h('p', { style: styles.value },
              data.catalog?.count === undefined
                ? t('modelsUnavailable')
                : `${t('modelsCount', { count: String(data.catalog.count) })} · ${
                  data.catalog.source === 'config' ? t('modelsSourceConfig') : t('modelsSourceDiscover')}`))),

        editable
          ? null
          : h('p', { style: styles.hint },
            t('configReadonly', {
              reason: data.config?.reason === 'entry-not-found' ? t('reasonNoEntry') : t('reasonNoEditor'),
            })),
      )
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
