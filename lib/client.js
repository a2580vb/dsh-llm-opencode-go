/**
 * The browser half of dsh-llm-opencode-go: the plugin's own configuration page in
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
  id: 'dsh-llm-opencode-go',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** The Host bridge endpoints, browser-relative (no leading slash). */
    const ROUTES = {
      state: 'opencode-go/state',
      models: 'opencode-go/models',
      refresh: 'opencode-go/refresh',
      usage: 'opencode-go/usage',
      subscription: 'opencode-go/subscription',
      config: 'opencode-go/config',
      credential: 'opencode-go/credential',
    }

    /** The row this page configures: `<package name>#<row id>`. */
    const ROW_KEY = 'dsh-llm-opencode-go#opencode-go'

    /** The package the Plugins page lists, for the settings entry on the panel. */
    const PACKAGE_NAME = 'dsh-llm-opencode-go'

    /**
     * The central panel's own id.
     *
     * Two things name it and both must agree: the quota row's click selects this
     * panel by id, and the `main` slot dispatches on the same string. The
     * shortcut names it too, so a mismatch would be a control that does nothing
     * — which no type check and no build step would report.
     */
    const PANEL_ID = 'opencode-go-usage'

    /** The shortcut id, owned by this plugin the same way a service is. */
    const SHORTCUT_ID = 'opencode-go.usage'

    /**
     * The metered windows the sidebar's foot lists, in the order it lists them.
     *
     * Fixed rather than taken from the answer, because the row is a fixed grid:
     * one line per window, and a line's height is what keeps the whole block the
     * same height as the host's own footer rows. A window the service adds shows
     * up in the panel, which renders whatever arrives; the foot is a glance at
     * the three it can name. A window the service did *not* report keeps its line
     * and drops its arc, so a missing window reads as "not measured" rather than
     * as a limit that vanished.
     */
    const CAPSULE_WINDOWS = Object.freeze(['rolling', 'weekly', 'monthly'])

    /** How long to wait for a row to reload before reading it back. */
    const RELOAD_DELAY_MS = 400

    const DICTIONARY = {
      zh: {
        summary: '配置密钥、模型与用量',
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
        keySourceStore: '来自凭据存储',
        keySourceEnvironment: '来自启动环境变量',
        keySourceProjectEnv: '来自项目的 .env',
        keySourceUserEnv: '来自用户目录的 .env',
        keyReadonly: '该密钥的来源只读，无法从这里覆盖。',
        keyBlockedEnvironment: '启动环境变量 {variable} 提供了这个密钥，进程内无法覆盖或删除它；在那里取消设置后重启才能改变。',
        keyBlockedEnvFile: '.env 文件（{path}）提供了这个密钥，清除存储后它会立刻回来；请改该文件。',
        keyBlockedEnvFileUnknown: '路径未知',
        keyBlockedAdvice: '要绕开它，把下面的「凭据引用」改成另一个名字并保存密钥——那是一个普通配置字段，重载后立即生效，无需重启。',
        keyPlaceholder: '粘贴 OpenCode Go API 密钥',
        keySave: '保存',
        keyClear: '清除密钥',
        keySaved: '已保存；下一次请求就会使用新的密钥。',
        keyCleared: '已清除存储的密钥。',
        keyNoStore: '此部署没有凭据存储，请在启动环境中导出该变量。',
        referencePlaceholder: 'OPENCODE_GO_HOME_KEY',
        referenceSave: '保存引用',
        referenceHint: '设置插件读取环境变量中的 API key，保存后插件会重新加载。',
        referenceSaved: '已保存；本路由会在下一次请求时读取新的引用。',
        referenceRequired: '请先填写一个环境变量名。',
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
        modelsGated: '模型对话会用于训练',
        modelsHiddenHere: '已隐藏',
        modelsTrainingHint: '该模型要求 workspace 开启「允许使用会训练请求数据的模型」，与是否隐藏无关。',
        modelsCatalogSource: '目录来源：{source}',
        modelsSourceDiscover: '自动发现（GET /models）',
        modelsSourceConfig: '来自配置',
        sectionVariants: '模型变体',
        variantsIntro: '变体是模型的快捷配置，它能以一个名字固定协议、思考等级、上下文窗口和输出上限，并在模型列表里作为独立条目出现。',
        variantsEmpty: '变体列表为空。上面填一个模型即可添加。',
        variantsListTitle: '变体列表（{count} 个）',
        variantsAddTitle: '添加变体',
        variantsNameDefaultHint: '不填变体名时，会使用默认名：{id}',
        variantsNameDefaultGeneric: '<模型>@<思考等级>',
        variantsRemoveNamed: '删除变体 {id}',
        variantsModel: '模型',
        variantsModelPlaceholder: '选择一个模型',
        variantsName: '变体名',
        variantsNamePlaceholder: '例如 fast',
        variantsLabel: '显示名',
        variantsLabelPlaceholder: '可选',
        variantsNameRule: '变体名可用字母、数字、点、横线、下划线。',
        variantsProtocol: '优先协议',
        variantsProtocolDefault: '沿用模型自身',
        variantsEffort: '默认思考等级',
        variantsEffortDefault: '沿用模型自身',
        variantsContext: '上下文窗口',
        variantsMaxTokens: '输出上限',
        variantsPlaceholderInherit: '沿用模型自身',
        variantsAdd: '添加变体',
        variantsEdit: '编辑',
        variantsCollapse: '收起',
        variantsEditNamed: '编辑变体 {id}',
        variantsCollapseNamed: '收起变体 {id}',
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
        configReadonlyAdvice: '上面的信息仍然可读，用量仍然会记录；只是这个页面无法写回配置。',
        sectionUsage: '用量',
        usageIntro: '本地记录的调用和词元统计；按本机日期聚合，最多保留 {days} 天。只统计本插件路由的请求，模型供应商的账单可能另有差异。',
        usageWindow: '统计窗口',
        usageWindowDay: '今天',
        usageWindow7: '近 7 天',
        usageWindow30: '近 30 天',
        usageEmpty: '这段时间还没有调用记录。',
        usageTotals: '合计',
        usageRequests: '调用',
        usageFailures: '失败',
        usageInput: '未缓存输入',
        usageOutput: '输出 token',
        usageTotal: 'token 合计',
        usageCacheRead: '缓存命中',
        usageCacheWrite: '缓存写入',
        usageCacheHit: '命中率',
        usageCacheUnknown: '—',
        usageCacheNote: '命中率 = 缓存命中 ÷（未缓存输入 + 缓存命中）。服务从未回报缓存数字时显示「—」。',
        usageByModel: '按模型',
        usageByDay: '按天',
        usageRefresh: '刷新用量',
        usageElsewhere: '可以用快捷键 Ctrl/Cmd+U 打开用量面板。',
        usageUnavailable: '此部署没有记录用量。',
        usageFailed: '读取用量失败：{message}',
        usageColumnModel: '模型',
        usageColumnDay: '日期',
        subscriptionUsed: '已用 {percent}%',
        subscriptionLeft: '剩余 {percent}%',
        subscriptionAria: '{name}：已用 {used}%，剩余 {left}%',
        subscriptionResets: '重置于 {time}',
        subscriptionLegendSpent: '已用完',
        subscriptionLegendLeft: '剩余可用',
        subscriptionWindowRolling: '滚动窗口',
        subscriptionWindowWeekly: '本周',
        subscriptionWindowMonthly: '本月',
        subscriptionRefresh: '重新读取额度',
        subscriptionLoading: '正在读取订阅额度…',
        subscriptionResetUnknown: '重置时间未知',
        subscriptionCached: '读取于 {time}。',
        subscriptionUnavailable: '读不到订阅额度（{reason}）。本页上方的本地统计不受影响。',
        subscriptionReasonUnauthorized: '服务拒绝了这把密钥',
        subscriptionReasonUnsupported: '该服务或网关没有这个接口',
        subscriptionReasonUnreachable: '无法连接到服务',
        subscriptionReasonNoCredential: '没有可用的密钥',
        subscriptionReasonFailed: '服务返回了错误',
        reasonNoEditor: '此部署没有 profile 配置编辑器',
        reasonNoEntry: '找不到该插件的 profile 条目',
        // —— 快速入口（侧边栏胶囊、用量面板、快捷键）——
        capsuleLabel: 'OpenCode Go 用量',
        capsuleTitlePlain: 'OpenCode Go 用量',
        capsuleOpenHint: '点击查看用量',
        capsuleQuotaUnknown: '—',
        // The three window tags, kept to two characters: the foot shows all three
        // side by side, and the spelled-out names do not fit the sidebar's minimum
        // width. The full name still travels in the tooltip and the accessible name.
        // `5H` rather than `5h`: a lowercase `h` has the x-height of the CJK tags'
        // full em, so the Latin tag read lighter than the two beside it.
        capsuleWindowRolling: '5H',
        capsuleWindowWeekly: '周',
        capsuleWindowMonthly: '月',
        capsuleWindowAria: '{short}（{full}）',
        capsuleSettings: '打开插件配置页',
        panelTitle: 'OpenCode Go 用量',
        panelSettings: '插件配置',
        panelClose: '关闭面板',
        panelNoSettings: '此部署没有插件页：Plugins 页与它上面的配置入口没有挂载。',
        panelQuotaSection: '订阅额度',
        panelCountedSection: '本路由的计数',
        panelShortcut: '打开用量面板',
        panelUnavailable: '此部署没有可以切换的中央面板。',
      },
      en: {
        summary: 'Configure the key, models, and usage',
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
        keySourceStore: 'from the credential store',
        keySourceEnvironment: 'from the launching environment',
        keySourceProjectEnv: 'from the project .env',
        keySourceUserEnv: 'from the home .env',
        keyReadonly: 'This key\'s source is read-only; it cannot be replaced from here.',
        keyBlockedEnvironment: 'The launching environment variable {variable} supplies this key, and a running process cannot replace or remove it. Unset it there and restart to change that.',
        keyBlockedEnvFile: 'A .env file ({path}) supplies this key, so clearing the store would only bring it back. Edit that file instead.',
        keyBlockedEnvFileUnknown: 'path unknown',
        keyBlockedAdvice: 'To step around it, point the credential reference below at another name and store the key there — it is an ordinary config field, so it applies on reload without a restart.',
        keyPlaceholder: 'Paste the OpenCode Go API key',
        keySave: 'Save',
        keyClear: 'Clear key',
        keySaved: 'Saved; the next request uses the new key.',
        keyCleared: 'The stored key was removed.',
        keyNoStore: 'This deployment has no credential store; export the variable in the launching environment instead.',
        referencePlaceholder: 'OPENCODE_GO_HOME_KEY',
        referenceSave: 'Save reference',
        referenceHint: 'Set the API key the plugin reads from this environment variable; the plugin reloads after saving.',
        referenceSaved: 'Saved; the route reads the new reference on its next request.',
        referenceRequired: 'Enter an environment variable name first.',
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
        modelsGated: 'conversations used for training',
        modelsHiddenHere: 'hidden',
        modelsTrainingHint: 'This model needs the workspace setting that allows models training on request data, whether or not it is hidden here.',
        modelsCatalogSource: 'Catalog source: {source}',
        modelsSourceDiscover: 'discovered (GET /models)',
        modelsSourceConfig: 'from configuration',
        sectionVariants: 'Model variants',
        variantsIntro: 'A variant is a model\'s shortcut configuration: a name that fixes the protocol, the thinking level, the context window, and the output cap, offered in the model list as its own entry.',
        variantsEmpty: 'The variant list is empty; pick a model below to add one.',
        variantsListTitle: 'Variant list ({count})',
        variantsAddTitle: 'Add a variant',
        variantsNameDefaultHint: 'Leave the name blank and it becomes {id}.',
        variantsNameDefaultGeneric: '<model>@<thinking level>',
        variantsRemoveNamed: 'Remove variant {id}',
        variantsModel: 'Model',
        variantsModelPlaceholder: 'Pick a model',
        variantsName: 'Variant name',
        variantsNamePlaceholder: 'for example fast',
        variantsLabel: 'Display name',
        variantsLabelPlaceholder: 'optional',
        variantsNameRule: 'A variant name may hold letters, digits, dot, dash, and underscore.',
        variantsProtocol: 'Protocol first',
        variantsProtocolDefault: 'as the model declares',
        variantsEffort: 'Default thinking level',
        variantsEffortDefault: 'as the model declares',
        variantsContext: 'Context window',
        variantsMaxTokens: 'Output cap',
        variantsPlaceholderInherit: 'inherit',
        variantsAdd: 'Add variant',
        variantsEdit: 'Edit',
        variantsCollapse: 'Done',
        variantsEditNamed: 'Edit variant {id}',
        variantsCollapseNamed: 'Finish editing variant {id}',
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
        configReadonlyAdvice: 'Everything above is still readable and usage is still recorded; this page just cannot write configuration back.',
        sectionUsage: 'Usage',
        usageIntro: 'Calls and tokens recorded locally, grouped by this machine\'s calendar day and kept for {days} days. It counts this plugin\'s route only; the model provider\'s billing may differ.',
        usageWindow: 'Window',
        usageWindowDay: 'Today',
        usageWindow7: '7 days',
        usageWindow30: '30 days',
        usageEmpty: 'No calls were recorded in this window.',
        usageTotals: 'Total',
        usageRequests: 'Calls',
        usageFailures: 'Failed',
        usageInput: 'Uncached input',
        usageOutput: 'Output tokens',
        usageTotal: 'Total tokens',
        usageCacheRead: 'Cache read',
        usageCacheWrite: 'Cache write',
        usageCacheHit: 'Hit rate',
        usageCacheUnknown: '—',
        usageCacheNote: 'Hit rate = cache read ÷ (uncached input + cache read). A service that never reported a cache figure shows "—".',
        usageByModel: 'By model',
        usageByDay: 'By day',
        usageRefresh: 'Refresh usage',
        usageElsewhere: 'The keyboard shortcut Ctrl/Cmd+U opens the usage panel.',
        usageUnavailable: 'This deployment does not record usage.',
        usageFailed: 'Could not read usage: {message}',
        usageColumnModel: 'Model',
        usageColumnDay: 'Day',
        subscriptionUsed: '{percent}% used',
        subscriptionLeft: '{percent}% left',
        subscriptionAria: '{name}: {used}% used, {left}% left',
        subscriptionResets: 'Resets {time}',
        subscriptionLegendSpent: 'Used',
        subscriptionLegendLeft: 'Remaining',
        subscriptionWindowRolling: 'Rolling',
        subscriptionWindowWeekly: 'Weekly',
        subscriptionWindowMonthly: 'Monthly',
        subscriptionRefresh: 'Re-read quota',
        subscriptionLoading: 'Reading the subscription quota…',
        subscriptionResetUnknown: 'reset time unknown',
        subscriptionCached: 'Read at {time}.',
        subscriptionUnavailable: 'Could not read the subscription quota ({reason}). The local counters above are unaffected.',
        subscriptionReasonUnauthorized: 'the service refused this key',
        subscriptionReasonUnsupported: 'this service or gateway does not serve it',
        subscriptionReasonUnreachable: 'the service could not be reached',
        subscriptionReasonNoCredential: 'no key was available',
        subscriptionReasonFailed: 'the service answered with an error',
        reasonNoEditor: 'this deployment has no profile configuration editor',
        reasonNoEntry: 'no profile entry for this plugin was found',
        // —- Fast entries: the sidebar capsule, the usage panel, the shortcut —-
        capsuleLabel: 'OpenCode Go usage',
        capsuleTitlePlain: 'OpenCode Go usage',
        capsuleOpenHint: 'click to see usage',
        capsuleQuotaUnknown: '—',
        // The three window tags, kept short: the foot shows all three side by side,
        // and the spelled-out names do not fit the sidebar's minimum width. The full
        // name still travels in the tooltip and the accessible name. `5H` rather than
        // `5h` for the same reason as the Chinese dictionary: the taller glyph keeps
        // the three tags the same visual weight.
        capsuleWindowRolling: '5H',
        capsuleWindowWeekly: 'Wk',
        capsuleWindowMonthly: 'Mo',
        capsuleWindowAria: '{short} ({full})',
        capsuleSettings: 'Open the plugin configuration page',
        panelTitle: 'OpenCode Go usage',
        panelSettings: 'Plugin settings',
        panelClose: 'Close the panel',
        panelNoSettings: 'This deployment has no plugins page, so there is no configuration entry to open.',
        panelQuotaSection: 'Subscription quota',
        panelCountedSection: 'This route\'s counters',
        panelShortcut: 'Open the usage panel',
        panelUnavailable: 'This deployment has no central panel to switch to.',
      },
    }

    /**
     * The visual box every text control shares: no width, no flex basis, only
     * the height and the look.
     *
     * The split exists because a `flex: '0 1 200px'` shorthand means *width* in
     * a row container and *height* in a column one. A control that carried that
     * shorthand into an `inlineField` was 200px tall and clipped its own
     * placeholder. So the box holds what a control looks like and the two named
     * variants below decide how big it is, each for one direction.
     */
    const controlBox = {
      boxSizing: 'border-box',
      height: '30px',
      minHeight: '30px',
      lineHeight: '28px',
      padding: '0 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '12px',
    }

    /**
     * The two colours a quota bar is drawn with.
     *
     * Both are derived from theme tokens rather than written down as literal
     * colours, so the bar follows the theme it is rendered in. `state-idle` is
     * the theme's own inactive grey for what is spent; the green is its success
     * colour mixed down into the surface the bar sits on, which keeps it a
     * *pale* green in a light theme and a muted one in a dark theme instead of
     * glowing in either.
     *
     * `color-mix()` needs Chromium 111 or newer. The client half only ever runs
     * in the Harness window, which is Electron 44 / Chromium 152 on this
     * machine — checked in the shipped binary rather than assumed — so the mix
     * is understood everywhere this code can be loaded.
     */
    const QUOTA_SPENT = 'var(--dsw-alias-state-idle-primary)'
    const QUOTA_LEFT = 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, var(--dsw-alias-bg-layer-1))'

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
      // A control that is itself a flex item of a ROW (the key input beside its
      // buttons): a basis there is a width, so `flex` is the right way to size
      // it. Same visual box as `fieldInput` below, sized along the row.
      input: {
        ...controlBox,
        flex: '1 1 240px',
        minWidth: '180px',
      },
      // A control inside an `inlineField` COLUMN: it fills the width its label
      // was given and takes its height from the box, never from a flex basis.
      // `flex: 'none'` is the load-bearing part — it is what stops a stray
      // basis from being read as a height.
      fieldInput: {
        ...controlBox,
        width: '100%',
        minWidth: 0,
        flex: 'none',
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
      toolbar: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '10px' },
      formRow: { display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '10px' },
      // A labelled control is a column whose label wraps instead of pushing its
      // own control wider: a long label next to a fixed-width box is what
      // clipped the placeholder text.
      inlineField: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, flex: '0 1 auto' },
      fieldLabel: {
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '16px',
        whiteSpace: 'normal',
        overflowWrap: 'anywhere',
      },
      select: {
        ...controlBox,
        width: '100%',
        minWidth: 0,
        maxWidth: '170px',
        flex: 'none',
        cursor: 'pointer',
      },
      variantRow: {
        marginTop: '10px',
        paddingTop: '10px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      variantHead: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' },
      // The row's two controls, pushed to the far end so the names it belongs to
      // stay together on the left.
      variantActions: { display: 'flex', gap: '8px', marginLeft: 'auto' },
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
      // One badge warns rather than labels. Every other badge states a property
      // of the model — its protocol, its thinking level. This one states what
      // becomes of the conversation, which is the reader's reason to pause, so
      // it wears the warning colour: a pale amber fill under the state's own
      // text colour, rather than the neutral grey of the rest.
      badgeWarn: {
        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, var(--dsw-alias-bg-layer-1))',
        background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, var(--dsw-alias-bg-layer-1))',
        color: 'var(--dsw-alias-state-warn-primary)',
      },
      message: { marginTop: '10px', fontSize: '12px' },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      success: { color: 'var(--dsw-alias-state-success-primary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)' },
      good: { color: 'var(--dsw-alias-state-success-primary)' },
      // A quota bar: a channel, and the two shares inside it. The track is the
      // surface colour so an empty bar still reads as a bar rather than a gap.
      quotaList: { display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '12px' },
      quotaRow: { display: 'flex', flexDirection: 'column', gap: '5px' },
      quotaHead: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '12px',
        flexWrap: 'wrap',
      },
      quotaName: { color: 'var(--dsw-alias-label-primary)', fontSize: '12px' },
      quotaFigures: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      quotaSeparator: { margin: '0 6px' },
      quotaTrack: {
        display: 'flex',
        width: '100%',
        height: '10px',
        boxSizing: 'border-box',
        borderRadius: '5px',
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      quotaSegment: { display: 'block', height: '100%', flex: 'none' },
      quotaSpent: { background: QUOTA_SPENT },
      quotaRemaining: { background: QUOTA_LEFT },
      quotaReset: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' },
      quotaLegend: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        margin: '10px 0 0',
      },
      legendSwatch: {
        display: 'inline-block',
        width: '10px',
        height: '10px',
        borderRadius: '2px',
        marginRight: '5px',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      muted: { color: 'var(--dsw-alias-label-secondary)' },

      // —— The usage panel and the sidebar capsule ——
      //
      // The main panel is a column the shell lets scroll, at the same width
      // budget as a settings section, so the two surfaces read as one
      // application. Its own children are the header and the two sections.
      //
      // The column keeps no room above its first child: that space belongs to
      // the header, which is pinned to the top of the scroll (see below) and
      // takes the padding with it rather than leaving it behind.
      panel: {
        boxSizing: 'border-box',
        width: '100%',
        height: '100%',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '24px',
        padding: '0 clamp(24px, 4vw, 48px) 48px',
      },
      // The row stays put while the tables scroll under it. It is where the
      // panel's own name and both of its controls live, and mid-scroll is
      // exactly when a reader reaches for the way out — a title that scrolls
      // away is a page that stops saying which page it is. Being pinned is why
      // it paints the frame's own base colour: the sections pass beneath it,
      // and a transparent row would show them through the title.
      //
      // The width cap lives on the children rather than on the column, so the
      // scroll bar stays at the frame's edge where the shell puts it.
      panelHead: {
        position: 'sticky',
        top: 0,
        zIndex: 2,
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: '760px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: '16px',
        flexWrap: 'wrap',
        // The column's own headroom, held by the row so it is still there once
        // the row has taken hold against the scrollport's edge.
        paddingTop: '28px',
        // The band that hides what passes beneath the row, and the same band
        // cancelled again below: the two zero out, so what separates the header
        // from the first section stays the column's 24px gap.
        paddingBottom: '12px',
        marginBottom: '-12px',
        background: 'var(--dsw-alias-bg-base)',
      },
      panelTitle: {
        margin: 0,
        fontSize: '20px',
        fontWeight: 500,
        lineHeight: '28px',
        color: 'var(--dsw-alias-label-primary)',
      },
      panelHeadActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      // The × that leaves the panel. Square and the height of the text buttons
      // it sits beside, so the row's controls share one band, and framed like
      // `button` above because it is an ordinary control in that row rather than
      // a decoration — in the quieter label colour, since dismissing is not the
      // action the row is offering first.
      panelCloseButton: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '30px',
        height: '30px',
        padding: 0,
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      panelSection: {
        width: '100%',
        maxWidth: '760px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      panelSectionHead: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '12px',
        flexWrap: 'wrap',
      },
      // —— The sidebar foot, drawn to the host's own measurements ——
      //
      // The row beside Settings and the Cordis badge is 42px tall with a 12px
      // radius and 14px type, and it becomes a 36px round button on the rail.
      // Matching those numbers is the whole reason these are here rather than
      // invented: a control that picked its own height would read as a foreign
      // object in a column whose every other row is host-owned.
      capsule: {
        display: 'flex',
        alignItems: 'center',
        width: 'calc(100% + 4px)',
        margin: '0 -2px',
        minWidth: 0,
      },
      // One row, three windows: `◉ 5H 92% │ ◉ 周 58% │ ◉ 月 9%`. Kept the host row's
      // 42px so it sits in the foot at the height of the rows beside it, and the
      // width that three of these take is why the labels are abbreviated: spelled
      // out, "Rolling / Weekly / Monthly" does not fit the sidebar's minimum.
      //
      // `space-between` spreads the three across whatever width the sidebar has —
      // at its 264px minimum the groups would otherwise huddle before a long gap,
      // and a footer row that leaves its own right edge empty reads as three facts
      // that happen to sit together rather than as one readout. The dividers travel
      // with the gaps, so the spreading produces the separators instead of a
      // separate sizing rule.
      capsuleMain: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '6px',
        flex: '1 1 auto',
        minWidth: 0,
        height: '42px',
        padding: '0 8px',
        borderRadius: '12px',
        border: 'none',
        background: 'none',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '11px',
        lineHeight: '14px',
        cursor: 'pointer',
        textAlign: 'left',
        overflow: 'hidden',
      },
      // One window's readout: the ring, then which window it is, then what is left.
      // The label comes before the figure so each group reads as a sentence about
      // one window rather than as three bare numbers the reader has to attribute.
      capsuleItem: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        flex: 'none',
      },
      // The hairline between two windows: a theme border token, one pixel wide and
      // shorter than the row so it separates without ruling a box across the foot.
      // It is hidden from the accessible tree — the windows are three sentences, and
      // a divider is not one of them.
      capsuleDivider: {
        width: '1px',
        height: '12px',
        background: 'var(--dsw-alias-border-l2)',
        flex: 'none',
      },
      capsuleRing: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      },
      // The window tag is quiet and the figure is not: the tag is read once and the
      // number is what the reader came for.
      capsuleLabel: {
        fontSize: '11px',
        lineHeight: '14px',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
        flex: 'none',
      },
      // Tabular figures so 9% and 92% are the same width and the row does not
      // twitch as the numbers move. The caller layers the warning and error colours
      // on top of this, exactly as the panel's bars do.
      capsulePercent: {
        fontSize: '11px',
        lineHeight: '14px',
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-primary)',
        whiteSpace: 'nowrap',
        flex: 'none',
      },
      capsuleGear: {
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '28px',
        height: '28px',
        padding: 0,
        borderRadius: 'var(--dsw-radius-sm)',
        border: 'none',
        background: 'none',
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'pointer',
      },
      railGroup: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' },
      railButton: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '36px',
        height: '36px',
        padding: 0,
        borderRadius: '50%',
        border: 'none',
        background: 'none',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      // The ring is a block box, not an inline one: an inline SVG sits on its
      // line's text baseline, which is what rode high in the sidebar's rows.
      ring: { display: 'block', flex: 'none' },
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
    /**
     * The one line that says where the key comes from.
     *
     * The source is named in words a person can act on, because the three
     * layers need three different actions: a value from the launching
     * environment cannot be replaced from inside this process, a value from a
     * `.env` file comes back the moment the store is cleared, and a stored
     * value is the one this page owns.
     */
    function credentialText(t, credential, environment) {
      if (credential === null || credential === undefined) return t('keyNoStore')
      const source = credential.source ?? (environment?.present === true ? 'process' : undefined)
      if (credential.configured !== true && environment?.present !== true) return t('keyMissing')
      const where = source === 'process' || source === 'env'
        ? t('keySourceEnvironment')
        : source === 'project-env' ? t('keySourceProjectEnv')
          : source === 'user-env' ? t('keySourceUserEnv')
            : source === undefined ? undefined : t('keySourceStore')
      const at = where === undefined ? t('keyConfigured') : `${t('keyConfigured')} · ${where}`
      return environment?.path === undefined || environment?.path === null
        ? at
        : `${at} · ${environment.path}`
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

    /**
     * The API-key editor: status, input, the two writes, and the reference.
     *
     * The reference is editable here for one reason: a key supplied by the
     * launching environment cannot be replaced or removed from inside a running
     * process — the credential seam refuses both — so the only way out of a key
     * someone no longer wants is to point the route at a name that is not
     * shadowed and store a value there. That is one field the Loader applies on
     * the next reload, so it takes effect without a restart.
     */
    function CredentialSection({ t, state, onChanged }) {
      const [draft, setDraft] = useState('')
      const [reference, setReference] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const credential = state.credential
      const environment = state.environment
      const configured = credential?.configured === true || environment?.present === true
      const writable = credential === null || credential === undefined ? false : credential.writable === true
      const removable = credential?.removable === true
      const blockedBy = credential?.blockedBy ?? null
      const editable = state.config?.editable === true
      const currentReference = String(state.route?.apiKeyEnv ?? '')
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

      /** Point the route at another credential reference. */
      const saveReference = async () => {
        const value = (reference ?? '').trim()
        if (value === '') {
          setNotice({ kind: 'error', text: t('referenceRequired') })
          return
        }
        setBusy(true)
        try {
          const result = await call(ROUTES.config, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set: { apiKeyEnv: value } }),
          })
          report(result, 'referenceSaved', () => {
            setReference(null)
            onChanged()
          })
        } catch (error) {
          setNotice({ kind: 'error', text: t('errHttp', { status: String(error?.message ?? 'network') }) })
        } finally {
          setBusy(false)
        }
      }

      /**
       * What to say about a key this page cannot remove.
       *
       * Naming the layer is the point: "cannot clear" only helps with the one
       * place the value actually lives.
       */
      const blockedText = () => {
        if (!configured || removable) return null
        if (blockedBy === 'launching-environment') {
          return t('keyBlockedEnvironment', { variable: String(environment?.variable ?? credential?.reference ?? '') })
        }
        if (blockedBy === 'env-file') {
          return t('keyBlockedEnvFile', { path: String(environment?.path ?? t('keyBlockedEnvFileUnknown')) })
        }
        return null
      }

      const blocked = blockedText()

      return h('section', { style: styles.section },
        h('h4', { style: styles.sectionTitle }, t('sectionKey')),
        h('div', { style: styles.card },
          h('div', { style: styles.status },
            h('span', { style: { ...styles.dot, background: dotColor }, 'aria-hidden': true }),
            h('span', null, credentialText(t, credential, environment))),
          credential === null || credential === undefined || writable
            ? null
            : h('p', { style: styles.hint }, t('keyReadonly')),
          blocked === null
            ? null
            : h('div', { style: { ...styles.message, ...styles.warn } },
              h('p', { style: { margin: 0 } }, blocked),
              // The reference editor below is the way out of a shadowed value,
              // so the message points at it rather than only at the shell.
              h('p', { style: { margin: '6px 0 0' } }, t('keyBlockedAdvice'))),
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
              // Offered exactly when clearing would remove the value the route
              // uses: a button that cannot work is worse than an explanation.
              disabled: busy || !removable,
              onClick: clear,
            }, t('keyClear'))),

          h('div', { style: styles.formRow },
            h('label', { style: { ...styles.inlineField, flex: '1 1 220px' } },
              h('span', { style: styles.fieldLabel }, t('fieldApiKeyEnv')),
              h('input', {
                type: 'text',
                spellCheck: false,
                value: reference === null ? currentReference : reference,
                disabled: busy || !editable,
                placeholder: t('referencePlaceholder'),
                'aria-label': t('fieldApiKeyEnv'),
                onChange: (event) => setReference(event.target.value),
                style: styles.fieldInput,
              })),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: busy || !editable || reference === null
                || reference.trim() === '' || reference.trim() === currentReference,
              onClick: saveReference,
            }, t('referenceSave'))),
          h('p', { style: styles.hint }, t('referenceHint')),

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
          model.trainingGated ? h('span', { style: { ...styles.badge, ...styles.badgeWarn } }, t('modelsGated')) : null))
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
    /**
     * One variant as the configuration file holds it.
     *
     * The Host reports a variant with an `id` beside its fields, because the id
     * is what the model list offers; the config does not have that key, and
     * echoing the snapshot back verbatim would write it into `cordis.patch.yml`
     * on every save. So the write is built from the fields the config declares,
     * and only the ones this variant actually states.
     */
    function configVariant(entry) {
      const written = { model: entry.model, name: entry.name }
      for (const field of ['label', 'protocol', 'effort', 'contextWindow', 'maxTokens']) {
        const value = entry[field]
        if (value === undefined || value === null || value === '') continue
        written[field] = value
      }
      return written
    }

    /**
     * Model variants: one model's second set of settings, under a name.
     *
     * A variant is a local alias — the request still leaves as the model itself
     * — so the section says that rather than presenting the variant as a copy
     * of the model.
     */
    function VariantsSection({ t, snapshot, models, busy, onSave, onReload, notice }) {
      const [draft, setDraft] = useState(null)
      const [saved, setSaved] = useState(null)
      const [form, setForm] = useState({ model: '', name: '', label: '', protocol: '', effort: '' })
      const [problem, setProblem] = useState(null)
      // Which rows are open for editing. A row's six fields are its whole
      // substance, and showing them for every variant at once turns a list of
      // names into a wall of boxes; the row head carries the edit control
      // instead, and the fields appear for the row being worked on.
      const [expanded, setExpanded] = useState(() => new Set())
      // A row's own identity, which its id cannot serve as: the name is half of
      // the id and the reader types into it, so a name-keyed row would be
      // remounted — and its open fields closed — on the first keystroke. This
      // counter is local to the page and never reaches the config.
      const nextUid = useRef(0)

      // A fresh snapshot is the new baseline: the row reloaded, so what the
      // Host reports is what was saved.
      useEffect(() => {
        const declared = Array.isArray(snapshot?.variants) ? snapshot.variants : null
        const copy = declared === null
          ? null
          : declared.map((entry) => ({ ...entry, uid: `v${String(nextUid.current++)}` }))
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

      /**
       * The name a variant takes when the reader does not type one.
       *
       * A variant's name is the half after the `@` in `<model>@<name>`, so the
       * default states the thing that most distinguishes one preset from
       * another: the thinking level it sets. A variant that does not set one
       * falls back to the protocol it leads with, and then to a word that says
       * it restates nothing.
       */
      const defaultName = (effort, protocol) => {
        if (String(effort ?? '').trim() !== '') return String(effort).trim()
        if (String(protocol ?? '').trim() !== '') return String(protocol).trim()
        return 'default'
      }

      const add = () => {
        const model = form.model
        if (model === '') {
          setProblem({ kind: 'error', text: t('variantsNeedModel') })
          return
        }
        // An empty name is not a mistake: it takes the default the placeholder
        // has been showing, which is what "just add one" should do.
        const name = form.name.trim() === '' ? defaultName(form.effort, form.protocol) : form.name.trim()
        const refused = nameProblem(model, name)
        if (refused !== undefined) {
          setProblem({ kind: 'error', text: refused })
          return
        }
        const entry = { model, name, uid: `v${String(nextUid.current++)}` }
        if (form.label.trim() !== '') entry.label = form.label.trim()
        if (form.protocol !== '') entry.protocol = form.protocol
        if (form.effort !== '') entry.effort = form.effort
        setDraft((current) => [...(current ?? []), entry])
        // The row opens where it lands: a variant the reader just created is the
        // one they are about to give a cap and a window.
        setExpanded((current) => new Set(current).add(entry.uid))
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
        const going = (draft ?? [])[index]
        setDraft((current) => current.filter((_entry, at) => at !== index))
        if (going?.uid !== undefined) {
          setExpanded((current) => {
            const next = new Set(current)
            next.delete(going.uid)
            return next
          })
        }
        setProblem(null)
      }

      const toggleRow = (uid) => {
        setExpanded((current) => {
          const next = new Set(current)
          if (!next.delete(uid)) next.add(uid)
          return next
        })
      }

      const selected = models.find((model) => model.id === form.model)
      const protocolOptions = [...new Set(models.flatMap((model) => model.protocols ?? []))]
      const effortOptions = selected?.reasoning === true ? selected.efforts ?? [] : []
      // What the name box will actually use when it is left alone.
      const nameDefault = defaultName(form.effort, form.protocol)
      const defaultVariantId = form.model === '' ? nameDefault : `${form.model}@${nameDefault}`

      /**
       * Names the page will not write, checked across the whole list.
       *
       * The name is half of the variant's id, so a rename can collide with a
       * neighbour that was already there or with one a previous edit created.
       * Checking all of them at once keeps the list honest while a row is being
       * edited, instead of only at save time.
       */
      const nameIssues = (draft ?? []).flatMap((entry, index) => {
        const name = String(entry.name ?? '')
        if (name.trim() === '') return [`#${String(index + 1)} ${t('variantsNeedName')}`]
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name.trim())) {
          return [`#${String(index + 1)} ${t('variantsBadName')}`]
        }
        const clashes = (draft ?? []).filter(
          (other, at) => at !== index && other.model === entry.model && other.name === name.trim(),
        )
        return clashes.length === 0
          ? []
          : [`#${String(index + 1)} ${t('variantsDuplicate', { id: `${entry.model}@${name.trim()}` })}`]
      })

      const textField = (label, entry, index, field, options = {}) => h('label', {
        // The label is the flex item of the row, so the width belongs here and
        // the control inside simply fills it.
        style: { ...styles.inlineField, flex: '0 0 160px' },
      },
      h('span', { style: styles.fieldLabel }, label),
      h('input', {
        type: 'text',
        spellCheck: false,
        value: entry[field] ?? '',
        placeholder: options.placeholder ?? '',
        'aria-label': `${entry.model}@${entry.name} ${label}`,
        onChange: (event) => update(index, field, event.target.value),
        style: styles.fieldInput,
      }))

      const numberField = (t, entry, index, field, label) => h('label', {
        style: { ...styles.inlineField, flex: '0 0 120px' },
      },
      h('span', { style: styles.fieldLabel }, label),
      h('input', {
        type: 'number',
        min: '1',
        step: '1',
        value: entry[field] ?? '',
        placeholder: t('variantsPlaceholderInherit'),
        'aria-label': `${entry.model}@${entry.name} ${label}`,
        onChange: (event) => update(index, field, event.target.value === '' ? '' : Number(event.target.value)),
        style: styles.fieldInput,
      }))

      return h('section', { style: styles.section },
        h('h4', { style: styles.sectionTitle }, t('sectionVariants')),
        h('div', { style: styles.card },
          h('p', { style: styles.hint }, t('variantsIntro')),
          missing.length === 0
            ? null
            : h('p', { style: { ...styles.message, ...styles.error } }, t('variantsWithoutModel', { models: missing.join(', ') })),

          // The list is the thing being edited, so it is always on screen with
          // its own count: a variant that exists only as an unsaved field is
          // one a reader cannot find again.
          h('p', { style: { ...styles.sectionTitle, marginTop: '14px' } },
            t('variantsListTitle', { count: String((draft ?? []).length) })),
          draft === null
            ? h('p', { style: styles.hint }, t('loading'))
            : draft.length === 0
              ? h('p', { style: styles.hint }, t('variantsEmpty'))
              : draft.map((entry, index) => {
                const id = `${entry.model}@${entry.name}`
                const open = expanded.has(entry.uid)
                return h('div', { key: entry.uid, style: styles.variantRow },
                  h('div', { style: styles.variantHead },
                    h('span', { style: styles.modelName }, entry.label ?? `${entry.model} (${entry.name})`),
                    h('span', { style: styles.modelMeta }, id),
                    // The one setting worth carrying while the row is shut: it
                    // decides which protocol a call through this variant opens
                    // with, which is not something the name says.
                    entry.protocol === undefined
                      ? null
                      : h('span', { style: styles.modelMeta }, entry.protocol),
                    h('span', { style: styles.variantActions },
                      h('button', {
                        type: 'button',
                        style: styles.button,
                        'aria-expanded': open,
                        'aria-label': open
                          ? t('variantsCollapseNamed', { id })
                          : t('variantsEditNamed', { id }),
                        onClick: () => toggleRow(entry.uid),
                      }, open ? t('variantsCollapse') : t('variantsEdit')),
                      h('button', {
                        type: 'button',
                        style: styles.button,
                        'aria-label': t('variantsRemoveNamed', { id }),
                        onClick: () => remove(index),
                      }, t('variantsRemove')))),
                  open
                    ? h('div', { style: styles.toolbar },
                      textField(t('variantsName'), entry, index, 'name', { placeholder: t('variantsNamePlaceholder') }),
                      textField(t('variantsLabel'), entry, index, 'label', { placeholder: t('variantsLabelPlaceholder') }),
                      h('label', { style: styles.inlineField },
                        h('span', { style: styles.fieldLabel }, t('variantsProtocol')),
                        h('select', {
                          value: entry.protocol ?? '',
                          'aria-label': `${id} ${t('variantsProtocol')}`,
                          onChange: (event) => update(index, 'protocol', event.target.value),
                          style: styles.select,
                        },
                        h('option', { value: '' }, t('variantsProtocolDefault')),
                        protocolOptions.map((protocol) => h('option', { key: protocol, value: protocol }, protocol)))),
                      (models.find((model) => model.id === entry.model)?.reasoning === true)
                        ? h('label', { style: styles.inlineField },
                          h('span', { style: styles.fieldLabel }, t('variantsEffort')),
                          h('select', {
                            value: entry.effort ?? '',
                            'aria-label': `${id} ${t('variantsEffort')}`,
                            onChange: (event) => update(index, 'effort', event.target.value),
                            style: styles.select,
                          },
                          h('option', { value: '' }, t('variantsEffortDefault')),
                          (models.find((model) => model.id === entry.model)?.efforts ?? []).map((level) => h('option', { key: level, value: level }, level))))
                        : h('span', { style: styles.hint }, t('variantsEffortRequiresReasoning', { model: entry.model })),
                      numberField(t, entry, index, 'contextWindow', t('variantsContext')),
                      numberField(t, entry, index, 'maxTokens', t('variantsMaxTokens')))
                    : null)
              }),

          // A list of one-line names with its own add row, so adding and
          // removing a name is the same gesture as reading one.
          h('p', { style: { ...styles.sectionTitle, marginTop: '16px' } }, t('variantsAddTitle')),
          h('div', { style: styles.formRow },
            h('label', { style: { ...styles.inlineField, flex: '0 0 200px' } },
              h('span', { style: styles.fieldLabel }, t('variantsModel')),
              h('select', {
                value: form.model,
                'aria-label': t('variantsModel'),
                onChange: (event) => setForm({ ...form, model: event.target.value, effort: '' }),
                style: styles.select,
              },
              h('option', { value: '' }, t('variantsModelPlaceholder')),
              baseModels.map((model) => h('option', { key: model.id, value: model.id }, `${model.name} · ${model.id}`)))),
            h('label', { style: { ...styles.inlineField, flex: '0 0 200px' } },
              h('span', { style: styles.fieldLabel }, t('variantsName')),
              h('input', {
                type: 'text',
                value: form.name,
                // The default is visible before it is used, so leaving the box
                // alone is a choice rather than a guess.
                placeholder: nameDefault,
                'aria-label': t('variantsName'),
                onChange: (event) => setForm({ ...form, name: event.target.value }),
                style: styles.fieldInput,
              })),
            h('label', { style: { ...styles.inlineField, flex: '0 0 200px' } },
              h('span', { style: styles.fieldLabel }, t('variantsLabel')),
              h('input', {
                type: 'text',
                value: form.label,
                placeholder: t('variantsLabelPlaceholder'),
                'aria-label': t('variantsLabel'),
                onChange: (event) => setForm({ ...form, label: event.target.value }),
                style: styles.fieldInput,
              }))),
          h('div', { style: styles.formRow },
            h('label', { style: styles.inlineField },
              h('span', { style: styles.fieldLabel }, t('variantsProtocol')),
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
                h('span', { style: styles.fieldLabel }, t('variantsEffort')),
                h('select', {
                  value: form.effort,
                  'aria-label': t('variantsEffort'),
                  onChange: (event) => setForm({ ...form, effort: event.target.value }),
                  style: styles.select,
                },
                h('option', { value: '' }, t('variantsEffortDefault')),
                effortOptions.map((level) => h('option', { key: level, value: level }, level)))),
            h('button', { type: 'button', style: styles.button, disabled: draft === null, onClick: add }, t('variantsAdd'))),
          // Both name rules sit under the form rather than between its rows: a
          // note wedged in the middle draws a line through the form, and the
          // fields a reader fills in then read as two separate things.
          form.model === ''
            ? h('p', { style: styles.hint }, t('variantsNameDefaultHint', { id: t('variantsNameDefaultGeneric') }))
            : h('p', { style: styles.hint }, t('variantsNameDefaultHint', { id: defaultVariantId })),
          // The grammar rule belongs here as text rather than crammed into the
          // box, where it would be clipped and, at 12px, unreadable anyway.
          h('p', { style: styles.hint }, t('variantsNameRule')),

          problem === null && nameIssues.length === 0
            ? null
            : h('p', { role: 'status', style: { ...styles.message, ...styles.error } },
              problem === null ? nameIssues.join(' · ') : problem.text),

          h('div', { style: styles.toolbar },
            h('button', {
              type: 'button',
              style: styles.primaryButton,
              // A list holding a name the config would refuse is not offered
              // for saving: the refusal is already on screen, by row.
              disabled: !dirty || busy || nameIssues.length > 0,
              onClick: () => onSave((draft ?? []).map(configVariant)),
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

    /** The cell styles one usage table uses, so its three tables agree. */
    const usageCell = { padding: '3px 10px 3px 0', fontSize: '12px', color: 'var(--dsw-alias-label-primary)' }
    const usageHeadCell = { ...usageCell, color: 'var(--dsw-alias-label-secondary)' }

    /**
     * One usage table: a header row, then rows of already-rendered cells.
     *
     * Three of these appear together and they differ only in their columns, so
     * the shape lives here rather than three times over.
     */
    function UsageTable({ id, headers, rows }) {
      const head = { ...usageHeadCell, textAlign: 'left' }
      return h('table', { style: { borderCollapse: 'collapse', marginTop: '10px' } },
        h('thead', null, h('tr', null, headers.map((header, index) => h('th', {
          key: `${id}-head-${String(index)}`,
          style: index === 0 ? head : usageHeadCell,
        }, header)))),
        h('tbody', null, rows.map((row) => h('tr', { key: `${id}-${row.key}` },
          row.cells.map((cell, index) => h('td', {
            key: `${id}-${row.key}-${String(index)}`,
            style: index === 0 ? { ...usageCell, wordBreak: 'break-all' } : usageCell,
          }, cell))))))
    }

    /**
     * Usage: what this route spent, per day and per model.
     *
     * The numbers come from the adapter's own counting, so they cover this
     * route only. The page presents them as a report and nothing here is
     * presented as a bill — the provider's accounting is the authority on cost,
     * and a page that implied otherwise would be wrong about a fact people act
     * on.
     */
    /**
     * The subscription's own quota, as the service meters it.
     *
     * This is the provider's number rather than this route's own count, and it
     * is the one that answers "how much of the plan is left". It is read from
     * an endpoint the service does not document, so every way it can be absent
     * is a sentence rather than an error: a deployment whose gateway mirrors
     * only the model surface, a key the service rejects, and a service that
     * moved the route all leave the local tables above untouched.
     */
    /**
     * One metered window, as a bar and the figures behind it.
     *
     * Read left to right: what is **spent** fills from the left edge in grey,
     * and what is **left** is the pale green remainder. The bar is a
     * `progressbar` carrying its value in `aria-*`, so the same fact reaches a
     * screen reader as a number rather than as a colour — a bar whose whole
     * meaning is its hue is unreadable to anyone who cannot see it.
     */
    function QuotaBar({ t, slot }) {
      const used = Math.max(0, Math.min(100, Number(slot.percent) || 0))
      const left = 100 - used
      const name = t(subscriptionWindowKey(slot.name))
      const reset = timeLabel(Date.parse(slot.resetsAt))
      // Running out is the one thing this panel exists to warn about, so the
      // figure says so too; the bar's own shortening is the primary signal.
      const figure = used >= 100 ? styles.error : used >= 80 ? styles.warn : undefined
      return h('div', { style: styles.quotaRow },
        h('div', { style: styles.quotaHead },
          h('span', { style: styles.quotaName }, name),
          h('span', { style: styles.quotaFigures },
            h('span', { style: figure }, t('subscriptionUsed', { percent: String(used) })),
            h('span', { style: styles.quotaSeparator }, '·'),
            h('span', null, t('subscriptionLeft', { percent: String(left) })))),
        h('div', {
          style: styles.quotaTrack,
          role: 'progressbar',
          'aria-label': name,
          'aria-valuenow': used,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuetext': t('subscriptionAria', { name, used: String(used), left: String(left) }),
        },
        // Widths rather than flex growth. A basis in a row container is a width
        // too, but stating the width outright says the same thing without
        // depending on which axis the container happens to have.
        h('span', { style: { ...styles.quotaSegment, ...styles.quotaSpent, width: `${String(used)}%` } }),
        h('span', { style: { ...styles.quotaSegment, ...styles.quotaRemaining, width: `${String(left)}%` } })),
        h('span', { style: styles.quotaReset },
          reset === undefined ? t('subscriptionResetUnknown') : t('subscriptionResets', { time: reset })))
    }

    /**
     * The subscription's quota itself: the bars, or what happened instead.
     *
     * It carries no control of its own. The re-read that spends a provider call
     * belongs to the block's label, and a block that drew its own copy put two
     * of them on the same page — so every surface renders this panel under
     * `QuotaHead`, which is where the one button lives.
     */
    function SubscriptionPanel({ t, data }) {
      if (data === null || data === undefined) {
        return h('div', null, h('p', { style: styles.hint }, t('subscriptionLoading')))
      }
      if (data.ok !== true) {
        return h('div', null,
          h('p', { style: styles.hint }, t('subscriptionUnavailable', { reason: t(subscriptionReasonKey(data.reason)) })),
          data.message === undefined ? null : h('p', { style: styles.hint }, String(data.message)))
      }
      const windows = Array.isArray(data.windows) ? data.windows : []
      if (windows.length === 0) return h('div', null, h('p', { style: styles.hint }, t('subscriptionUnavailable', { reason: t(subscriptionReasonKey('unsupported')) })))
      return h('div', null,
        h('div', { style: styles.quotaList },
          windows.map((slot) => h(QuotaBar, { key: slot.name, t, slot }))),
        h('p', { style: styles.quotaLegend },
          h('span', { style: { ...styles.legendSwatch, background: QUOTA_SPENT } }),
          h('span', null, t('subscriptionLegendSpent')),
          h('span', { style: { ...styles.legendSwatch, background: QUOTA_LEFT, marginLeft: '12px' } }),
          h('span', null, t('subscriptionLegendLeft'))),
        data.cached === true && timeLabel(data.fetchedAt) !== undefined
          ? h('p', { style: styles.hint }, t('subscriptionCached', { time: timeLabel(data.fetchedAt) }))
          : null)
    }

    /**
     * The quota block's heading row: its own label, and the one control that
     * belongs to it.
     *
     * The re-read sits here rather than inside the block or up in the usage
     * panel's header: both of those places had one, which made the same action
     * look like two different ones — and a reader looking for "re-read the
     * quota" looks where the quota is named.
     *
     * `Tag` is the heading element the surface can afford: `h3` where this block
     * is a section of a usage page, `p` where it is a label inside the
     * configuration page's card, whose own title is already an `h4`.
     */
    function QuotaHead({ t, Tag = 'h3', busy, onRefresh }) {
      return h('div', { style: styles.panelSectionHead },
        h(Tag, { style: styles.sectionTitle }, t('panelQuotaSection')),
        h('button', { type: 'button', style: styles.button, disabled: busy, onClick: onRefresh }, t('subscriptionRefresh')))
    }

    /**
     * The subscription's quota, however many places on screen are showing it.
     *
     * The page, the panel, and the sidebar capsule all need the same answer, so
     * the read lives in one hook rather than three: the error mapping and the
     * cache-forcing query parameter then have exactly one implementation, and a
     * change to either reaches every surface at once.
     *
     * A refusal is stored as the raw reason rather than as a sentence, because
     * the sentence depends on the reader's language: the read does not depend on
     * `t`, so the effect below runs once and the wording is chosen at render.
     *
     * @returns {{data: object|null, busy: boolean, refresh: (force?: boolean) => Promise<void>}} the quota, whether a read is in flight, and how to read again.
     */
    function useSubscription() {
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState(false)
      const mounted = useRef(true)

      useEffect(() => () => {
        mounted.current = false
      }, [])

      /** Read the service's answer, cached on the Host for its configured lifetime. */
      const refresh = useCallback(async (force) => {
        setBusy(true)
        try {
          const result = await call(`${ROUTES.subscription}${force === true ? '?refresh=1' : ''}`)
          const payload = result.payload
          if (result.status === 401 || result.status === 403) setData({ ok: false, reason: 'unauthorized' })
          else if (payload !== null && payload !== undefined) setData(payload)
          else setData({ ok: false, reason: 'failed', message: `HTTP ${String(result.status)}` })
        } catch (error) {
          setData({ ok: false, reason: 'unreachable', message: String(error?.message ?? 'network') })
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [])

      return { data, busy, refresh }
    }

    /** The dictionary key naming one refusal reason. */
    function subscriptionReasonKey(reason) {
      if (reason === 'unauthorized') return 'subscriptionReasonUnauthorized'
      if (reason === 'unsupported') return 'subscriptionReasonUnsupported'
      if (reason === 'unreachable') return 'subscriptionReasonUnreachable'
      if (reason === 'no-credential') return 'subscriptionReasonNoCredential'
      if (reason === 'failed') return 'subscriptionReasonFailed'
      return 'subscriptionReasonUnsupported'
    }

    /** The dictionary key naming one metered window. */
    function subscriptionWindowKey(name) {
      if (name === 'rolling') return 'subscriptionWindowRolling'
      if (name === 'weekly') return 'subscriptionWindowWeekly'
      if (name === 'monthly') return 'subscriptionWindowMonthly'
      return name
    }

    function UsageSection({ t, table, subscription, subscriptionBusy, onSubscriptionRefresh, windowDays, busy, onWindow, onRefresh }) {
      const header = h('h4', { style: styles.sectionTitle }, t('sectionUsage'))
      // The label and its one control, then the quota itself: the same pairing
      // the panel and the settings tab draw, at the level this page can use —
      // its sections are `h4`, so the block's label is a paragraph.
      const panel = h(React.Fragment, null,
        h(QuotaHead, { t, Tag: 'p', busy: subscriptionBusy, onRefresh: onSubscriptionRefresh }),
        h(SubscriptionPanel, { t, data: subscription }))
      if (table === null || table === undefined) {
        return h('section', { style: styles.section }, header,
          h('div', { style: styles.card },
            // This section is not the only door to the counters, and the other
            // one is a keystroke away, so the page names the shortcut rather
            // than letting a reader assume this is all there is.
            h('p', { style: styles.hint }, t('usageElsewhere')),
            panel,
            h('p', { style: styles.hint }, t('loading'))))
      }
      if (table.error !== undefined) {
        return h('section', { style: styles.section }, header,
          h('div', { style: styles.card },
            h('p', { style: styles.hint }, t('usageElsewhere')),
            panel,
            h('p', { style: { ...styles.message, ...styles.error } }, table.error)))
      }

      const { totals } = table
      const windows = Array.isArray(table.windows) && table.windows.length > 0 ? table.windows : [1, 7, 30]
      const windowLabel = (value) => {
        if (value === 1) return t('usageWindowDay')
        if (value === 7) return t('usageWindow7')
        return t('usageWindow30')
      }
      const number = (value) => (typeof value === 'number' ? String(value) : '0')

      /**
       * The cache-hit share, or nothing at all.
       *
       * A hit rate is `cache read / the whole prompt`, and the whole prompt is
       * the uncached input plus the cache read — the input count alone would
       * understate it, since the mapper reports only the uncached part there.
       *
       * It is `null` when no call in the row carried a cache figure, because a
       * rate needs something to divide by: a service that says "no cache" and a
       * service that says nothing are different, and `0%` would state the first
       * when only the second is known. The page shows the difference in words
       * rather than in a zero that reads like a measurement.
       */
      const hitRate = (counters) => {
        const read = counters.cacheReadTokens ?? 0
        const prompt = (counters.inputTokens ?? 0) + read
        if ((counters.cacheReported ?? 0) === 0) return null
        if (prompt === 0) return null
        return Math.round((read / prompt) * 100)
      }
      const hitCell = (counters) => {
        const rate = hitRate(counters)
        if (rate === null) return t('usageCacheUnknown')
        return h('span', { style: rate === 0 ? undefined : rate >= 50 ? styles.good : undefined }, `${String(rate)}%`)
      }
      /** The columns every counter row shares, in one order for all three tables. */
      const counterHeaders = (first) => [
        first,
        t('usageRequests'),
        t('usageFailures'),
        t('usageInput'),
        t('usageOutput'),
        t('usageCacheRead'),
        t('usageCacheWrite'),
        t('usageCacheHit'),
        t('usageTotal'),
      ]
      const counterCells = (counters) => [
        number(counters.requests),
        number(counters.failures),
        number(counters.inputTokens),
        number(counters.outputTokens),
        number(counters.cacheReadTokens),
        number(counters.cacheWriteTokens),
        hitCell(counters),
        number(counters.totalTokens),
      ]

      return h('section', { style: styles.section },
        header,
        h('div', { style: styles.card },
          h('p', { style: styles.hint }, t('usageElsewhere')),
          panel,
          h('p', { style: styles.hint }, t('usageIntro', { days: number(table.retentionDays) })),
          h('div', { style: styles.toolbar },
            h('span', { style: styles.fieldLabel }, t('usageWindow')),
            windows.map((value) => h('button', {
              key: String(value),
              type: 'button',
              style: value === windowDays ? styles.primaryButton : styles.button,
              disabled: busy,
              onClick: () => onWindow(value),
            }, windowLabel(value))),
            h('button', { type: 'button', style: styles.button, disabled: busy, onClick: onRefresh }, t('usageRefresh'))),

          (totals.requests ?? 0) === 0
            ? h('p', { style: styles.hint }, t('usageEmpty'))
            : h('div', null,
              h(UsageTable, {
                id: 'totals',
                headers: counterHeaders(t('usageTotals')),
                rows: [{ key: 'total', cells: [t('usageTotals'), ...counterCells(totals)] }],
              }),

              h('p', { style: { ...styles.sectionTitle, marginTop: '14px' } }, t('usageByModel')),
              h(UsageTable, {
                id: 'model',
                headers: counterHeaders(t('usageColumnModel')),
                rows: (table.models ?? []).map((entry) => ({
                  key: entry.model,
                  cells: [entry.model, ...counterCells(entry.counters)],
                })),
              }),

              h('p', { style: { ...styles.sectionTitle, marginTop: '14px' } }, t('usageByDay')),
              h(UsageTable, {
                id: 'day',
                headers: counterHeaders(t('usageColumnDay')),
                rows: (table.days ?? []).map((entry) => ({
                  key: entry.day,
                  cells: [entry.day, ...counterCells(entry.counters)],
                })),
              }),

              // What a hit rate divides, and what a missing figure looks like:
              // both are conventions a reader cannot guess, and a wrong guess
              // makes the numbers look inconsistent.
              h('p', { style: styles.hint }, t('usageCacheNote')))))
    }

    /**
     * The usage panel's own header row: the title, and — where the deployment
     * has them — the way through to the plugin's configuration page and the
     * way out of the panel.
     *
     * Both controls are optional on purpose, and for the same reason: the
     * settings entry needs the Plugins page to exist, the dismissal needs the
     * shell's panel controller. Each is simply absent where the deployment
     * cannot honour it — a control that cannot work is not rendered rather than
     * rendered disabled, so nothing on screen offers an action that does
     * nothing.
     */
    function UsageHead({ t, openSettings, closeUsage }) {
      const controls = [
        openSettings === undefined
          ? null
          : h('button', {
            key: 'settings',
            type: 'button',
            style: styles.primaryButton,
            onClick: openSettings,
          }, t('panelSettings')),
        closeUsage === undefined
          ? null
          : h('button', {
            key: 'close',
            type: 'button',
            style: styles.panelCloseButton,
            title: t('panelClose'),
            'aria-label': t('panelClose'),
            onClick: closeUsage,
          }, h(CloseMark)),
      ].filter((control) => control !== null)

      return h(React.Fragment, null,
        h('div', { style: styles.panelHead },
          h('h2', { style: styles.panelTitle }, t('panelTitle')),
          controls.length === 0 ? null : h('div', { style: styles.panelHeadActions }, controls)),
        // The missing control is the one thing a reader cannot account for, so
        // the panel says why rather than leaving a gap where it would be.
        openSettings === undefined
          ? h('p', { style: { ...styles.hint, width: '100%', maxWidth: '760px' } },
            h('span', null, t('panelNoSettings')))
          : null)
    }

    /**
     * This route's own counters, for the panel.
     *
     * The same endpoint and the same tables as the configuration page's usage
     * section, but a different frame: this one is a section of a page whose
     * whole subject is usage, so it carries the window selector in its header
     * instead of reading as a sub-part of something larger.
     */
    function UsageCounters({ t }) {
      const [table, setTable] = useState(null)
      const [windowDays, setWindowDays] = useState(7)
      const [busy, setBusy] = useState(false)
      const mounted = useRef(true)

      useEffect(() => () => {
        mounted.current = false
      }, [])

      /** Read one window. A failure is stored raw and worded at render. */
      const read = useCallback(async (days) => {
        const result = await call(`${ROUTES.usage}?days=${String(days)}`)
        if (!mounted.current) return
        if (result.ok && result.payload?.ok === true) setTable(result.payload)
        else setTable({ failure: { status: result.status, message: result.payload?.message } })
      }, [])

      useEffect(() => {
        void read(7)
      }, [read])

      const choose = useCallback(async (days) => {
        setBusy(true)
        try {
          setWindowDays(days)
          await read(days)
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [read])

      const windows = Array.isArray(table?.windows) && table.windows.length > 0 ? table.windows : [1, 7, 30]
      const windowLabel = (value) => {
        if (value === 1) return t('usageWindowDay')
        if (value === 7) return t('usageWindow7')
        return t('usageWindow30')
      }

      const header = h('div', { style: styles.panelSectionHead },
        h('h3', { style: styles.sectionTitle }, t('panelCountedSection')),
        h('div', { style: styles.panelHeadActions },
          windows.map((value) => h('button', {
            key: String(value),
            type: 'button',
            style: value === windowDays ? styles.primaryButton : styles.button,
            disabled: busy,
            onClick: () => void choose(value),
          }, windowLabel(value))),
          h('button', { type: 'button', style: styles.button, disabled: busy, onClick: () => void choose(windowDays) }, t('usageRefresh'))))

      if (table === null) {
        return h('section', { style: styles.panelSection }, header,
          h('div', { style: styles.card }, h('p', { style: styles.hint }, t('loading'))))
      }
      if (table.failure !== undefined) {
        const message = table.failure.status === 503
          ? t('usageUnavailable')
          : t('usageFailed', {
            message: table.failure.message ?? t('errHttp', { status: String(table.failure.status) }),
          })
        return h('section', { style: styles.panelSection }, header,
          h('div', { style: styles.card }, h('p', { style: { ...styles.message, ...styles.error } }, message)))
      }

      const counters = table.totals ?? {}
      const number = (value) => (typeof value === 'number' ? String(value) : '0')
      /**
       * The cache-hit share, or nothing at all — the same two assertions the
       * configuration page makes, for the same reason: a service reporting no
       * cache and a service reporting nothing are different facts, and `—` is
       * the one that holds when it reported nothing.
       */
      const hitCell = (row) => {
        const read = row.cacheReadTokens ?? 0
        const prompt = (row.inputTokens ?? 0) + read
        if ((row.cacheReported ?? 0) === 0 || prompt === 0) return t('usageCacheUnknown')
        const rate = Math.round((read / prompt) * 100)
        return h('span', { style: rate === 0 ? undefined : styles.good }, `${String(rate)}%`)
      }
      const counterHeaders = (first) => [
        first,
        t('usageRequests'),
        t('usageFailures'),
        t('usageInput'),
        t('usageOutput'),
        t('usageCacheRead'),
        t('usageCacheWrite'),
        t('usageCacheHit'),
        t('usageTotal'),
      ]
      const counterCells = (row) => [
        number(row.requests),
        number(row.failures),
        number(row.inputTokens),
        number(row.outputTokens),
        number(row.cacheReadTokens),
        number(row.cacheWriteTokens),
        hitCell(row),
        number(row.totalTokens),
      ]

      return h('section', { style: styles.panelSection }, header,
        h('div', { style: styles.card },
          h('p', { style: styles.hint }, t('usageIntro', { days: String(table.retentionDays) })),
          (counters.requests ?? 0) === 0
            ? h('p', { style: styles.hint }, t('usageEmpty'))
            : h('div', null,
              h(UsageTable, {
                id: 'panel-totals',
                headers: counterHeaders(t('usageTotals')),
                rows: [{ key: 'total', cells: [t('usageTotals'), ...counterCells(counters)] }],
              }),

              h('p', { style: { ...styles.sectionTitle, marginTop: '14px' } }, t('usageByModel')),
              h(UsageTable, {
                id: 'panel-model',
                headers: counterHeaders(t('usageColumnModel')),
                rows: (table.models ?? []).map((entry) => ({
                  key: entry.model,
                  cells: [entry.model, ...counterCells(entry.counters)],
                })),
              }),

              h('p', { style: { ...styles.sectionTitle, marginTop: '14px' } }, t('usageByDay')),
              h(UsageTable, {
                id: 'panel-day',
                headers: counterHeaders(t('usageColumnDay')),
                rows: (table.days ?? []).map((entry) => ({
                  key: entry.day,
                  cells: [entry.day, ...counterCells(entry.counters)],
                })),
              }),

              // What a hit rate divides, and what a missing figure looks like:
              // both are conventions a reader cannot guess, and a wrong guess
              // makes the numbers look inconsistent.
              h('p', { style: styles.hint }, t('usageCacheNote')))))
    }

    /**
     * The usage panel: one page whose whole subject is what this route is using.
     *
     * It exists because the configuration page could not be the fast entry: that
     * page is reached through the Plugins page and a bundle's row, which is
     * three steps for a question asked several times a day. This panel is one
     * step from the sidebar and one keystroke away, and it owns the two things a
     * reader came for — the service's quota, and this route's own counters — in
     * the order they are asked.
     */
    function UsagePage({ t, openSettings, closeUsage }) {
      const { data, busy, refresh } = useSubscription()
      useEffect(() => {
        void refresh(false)
      }, [refresh])

      return h('div', { style: styles.panel },
        h(UsageHead, { t, openSettings, closeUsage }),
        h('section', { style: styles.panelSection },
          h(QuotaHead, { t, busy, onRefresh: () => void refresh(true) }),
          h('div', { style: styles.card },
            h(SubscriptionPanel, { t, data }))),
        h(UsageCounters, { t }))
    }

    /**
     * A button that answers the pointer the way the host's own rows do.
     *
     * The host draws hover with a stylesheet; a plugin that may not write one
     * (and whose three surfaces would each need it) can say the same thing with
     * one state and two handlers. Without it a footer row reads as a status
     * readout rather than as the control it is — the one thing this entry must
     * not look like.
     */
    function RowButton({ style, hoverStyle, ...rest }) {
      const [over, setOver] = useState(false)
      return h('button', {
        ...rest,
        type: 'button',
        style: over && hoverStyle !== undefined ? { ...style, ...hoverStyle } : style,
        onPointerEnter: () => setOver(true),
        onPointerLeave: () => setOver(false),
      })
    }

    /** The dictionary key naming one window in the foot's own short form. */
    function capsuleWindowKey(name) {
      if (name === 'rolling') return 'capsuleWindowRolling'
      if (name === 'weekly') return 'capsuleWindowWeekly'
      if (name === 'monthly') return 'capsuleWindowMonthly'
      return name
    }

    /**
     * One window's share, as the two numbers every readout here states.
     *
     * `undefined` for a window the service did not report, which is a different
     * fact from a window at zero: the callers draw a bare track and print a dash
     * rather than claiming an allowance is untouched.
     *
     * @param {object|undefined} slot - one window from the subscription answer.
     * @returns {{used: number, left: number} | undefined} the shares, or undefined when unreported.
     */
    function windowShares(slot) {
      if (slot === null || slot === undefined) return undefined
      const used = Math.max(0, Math.min(100, Number(slot.percent) || 0))
      return { used, left: 100 - used }
    }

    /**
     * One window's ring.
     *
     * The arc is what is *left*, clockwise from the top, so a shrinking arc means
     * a shrinking allowance and the ring states the same fact as the figure
     * beside it rather than its inverse. Its colour follows the panel's own
     * thresholds, so the foot and the page it opens agree about what is alarming.
     *
     * A window the service did not report leaves the track bare — the ring says
     * "not measured", never a zero it was not told — and a spent window draws no
     * arc for the same reason in reverse: there is nothing left to draw.
     */
    function QuotaRing({ slot, size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 12
      const stroke = edge >= 18 ? 2.4 : edge >= 16 ? 1.8 : 1.5
      const radius = edge / 2 - stroke
      const centre = edge / 2
      const circumference = 2 * Math.PI * radius
      const shares = windowShares(slot)
      const colour = shares === undefined
        ? undefined
        : shares.used >= 100
          ? 'var(--dsw-alias-state-error-primary)'
          : shares.used >= 80 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)'
      const drawn = shares === undefined || shares.left <= 0 ? null : (shares.left / 100) * circumference
      return h('svg', {
        width: edge,
        height: edge,
        viewBox: `0 0 ${String(edge)} ${String(edge)}`,
        focusable: 'false',
        style: styles.ring,
      },
      h('circle', {
        cx: centre,
        cy: centre,
        r: radius,
        fill: 'none',
        stroke: 'var(--dsw-alias-state-idle-primary)',
        strokeWidth: stroke,
        strokeLinecap: 'round',
      }),
      drawn === null ? null : h('circle', {
        cx: centre,
        cy: centre,
        r: radius,
        fill: 'none',
        stroke: colour,
        strokeWidth: stroke,
        strokeLinecap: 'round',
        // A dash the length of the remaining share, in a circle whose
        // circumference is `2πr`: the dash draws the share and the gap the rest.
        strokeDasharray: `${String(drawn)} ${String(circumference)}`,
        transform: `rotate(-90 ${String(centre)} ${String(centre)})`,
      }))
    }

    /**
     * One window of the foot's readout: its ring, its tag, and what is left.
     *
     * `◉ 5H 92%` — the tag before the figure, so each group reads as a statement
     * about one window instead of three numbers the reader has to attribute. The
     * figure is the share *left*, which is the direction the ring draws, and the
     * caller's flex rule spaces the three groups apart so they do not run together
     * into one string of digits.
     */
    function CapsuleItem({ t, name, slot }) {
      const shares = windowShares(slot)
      const figure = shares === undefined ? t('capsuleQuotaUnknown') : `${String(shares.left)}%`
      const alarm = shares === undefined ? undefined : shares.used >= 100 ? styles.error : shares.used >= 80 ? styles.warn : undefined
      return h('span', { style: styles.capsuleItem },
        // The ring and the figure are one statement; the row's accessible name is
        // what spells the numbers out, so neither needs saying twice here.
        h('span', { style: styles.capsuleRing, 'aria-hidden': 'true' }, h(QuotaRing, { slot, size: 12 })),
        h('span', { style: styles.capsuleLabel }, t(capsuleWindowKey(name))),
        h('span', { style: alarm === undefined ? styles.capsulePercent : { ...styles.capsulePercent, ...alarm } }, figure))
    }

    /**
     * The three windows, with a hairline between each pair.
     *
     * The dividers are ordinary nodes in the same flex row rather than border
     * rules on the groups, so `space-between` spreads all five and the separators
     * land in the middle of the gaps. Each is decoration: marked `aria-hidden`,
     * because the windows are three sentences and a divider is not one of them.
     *
     * @param {object} input - the groups and the translator.
     * @returns {readonly object[]} the row's children, in order.
     */
    function capsuleRow({ t, groups }) {
      const children = []
      groups.forEach(({ name, slot }, index) => {
        if (index > 0) children.push(h('span', { key: `${name}-divider`, style: styles.capsuleDivider, 'aria-hidden': 'true' }))
        children.push(h(CapsuleItem, { key: name, t, name, slot }))
      })
      return children
    }

    /**
     * The sidebar's foot: the plan's three windows, wherever the reader is.
     *
     * This is the entry that has to exist for the panel to be worth having. It
     * answers "how much of the plan is left" without a click, and it is the one
     * piece of this plugin that is visible while a session is working — which is
     * exactly when the answer matters.
     *
     * All three windows, because they fail on different clocks: the rolling one
     * resets within hours, so it runs out first, but a weekly window at 95% is the
     * same bad news arriving more slowly and a single figure could not show it at
     * all. One ring per window rather than three arcs in one circle, because an arc
     * has no room for a name — the reader would have to know which arc was which
     * window and read a length where a figure belongs. In a row rather than in
     * three lines, with two-character tags, because that is what fits the sidebar's
     * minimum width without the labels colliding.
     *
     * It follows the host's own foot pattern rather than inventing one: the host
     * row's height and radius when the sidebar is open, and the 36px round button
     * those rows become on the rail. Two actions in the open row, because "how much
     * is left" and "change a setting" are two different errands.
     */
    function UsageCapsule({ t, wide, openSettings, openUsage }) {
      const { data, refresh } = useSubscription()
      useEffect(() => {
        void refresh(false)
      }, [refresh])

      const reported = data?.ok === true && Array.isArray(data.windows) ? data.windows : []
      const byName = new Map(reported.map((slot) => [slot.name, slot]))
      const groups = CAPSULE_WINDOWS.map((name) => ({ name, slot: byName.get(name) ?? null }))
      // One sentence per window, from the same numbers the row shows, so the name a
      // screen reader announces and the figures a reader sees agree. Both spellings
      // are here — the two-character tag that is on screen, and the name the tag
      // abbreviates — because "5H" is what a speech user has to say to hit the row,
      // and the full name is what tells anyone else which window that is.
      const states = groups.map(({ name, slot }) => {
        const spoken = t('capsuleWindowAria', {
          short: t(capsuleWindowKey(name)),
          full: t(subscriptionWindowKey(name)),
        })
        const shares = windowShares(slot)
        return shares === undefined
          ? `${spoken} ${t('capsuleQuotaUnknown')}`
          : t('subscriptionAria', { name: spoken, used: String(shares.used), left: String(shares.left) })
      })
      const title = `${t('capsuleTitlePlain')} · ${states.join(' · ')} · ${t('capsuleOpenHint')}`
      const open = () => {
        const opened = openUsage === undefined ? false : openUsage()
        if (opened === false) openSettings?.()
      }

      // On the rail there is no room for words, and three unnamed rings would be
      // three identical circles: it carries the one window that runs out first —
      // the rolling window the plan meters in hours — and names it by tooltip.
      if (wide === false) {
        return h('div', { style: styles.railGroup, 'data-opencode-go-capsule': true },
          h(RowButton, {
            style: styles.railButton,
            hoverStyle: { background: 'var(--dsw-alias-interactive-bg-hover)' },
            title,
            'aria-label': states[0],
            onClick: open,
          }, h(QuotaRing, { slot: byName.get(CAPSULE_WINDOWS[0]) ?? null, size: 18 })),
          openSettings === undefined
            ? null
            : h(RowButton, {
              style: styles.railButton,
              hoverStyle: { background: 'var(--dsw-alias-interactive-bg-hover)' },
              title: t('capsuleSettings'),
              'aria-label': t('capsuleSettings'),
              onClick: openSettings,
            }, h(GearMark)))
      }

      return h('div', { style: styles.capsule, 'data-opencode-go-capsule': true },
        // The visible text is three abbreviated tags and three figures, so the name
        // stated here is the one that spells them out; every visible word and figure
        // is in it, which is what keeps the two in step (WCAG 2.5.3).
        h(RowButton, {
          style: styles.capsuleMain,
          hoverStyle: { background: 'var(--dsw-alias-interactive-bg-hover)' },
          title,
          'aria-label': title,
          onClick: open,
        }, capsuleRow({ t, groups })),
        openSettings === undefined
          ? null
          : h(RowButton, {
            style: styles.capsuleGear,
            hoverStyle: {
              background: 'var(--dsw-alias-interactive-bg-hover)',
              color: 'var(--dsw-alias-label-primary)',
            },
            title: t('capsuleSettings'),
            'aria-label': t('capsuleSettings'),
            onClick: openSettings,
          }, h(GearMark)))
    }

    /** The gear on the capsule's settings action, drawn to the icon's own box. */
    function GearMark() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', focusable: 'false' },
        h('circle', {
          cx: 7,
          cy: 7,
          r: 2.4,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
        }),
        h('circle', {
          cx: 7,
          cy: 7,
          r: 5.2,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeDasharray: '1.6 1.6',
          strokeLinecap: 'round',
        }))
    }

    /**
     * The × on the panel's dismissal, drawn rather than typed.
     *
     * A typed `×` would be a glyph the shell's own font stack decides the
     * weight and the baseline of, and the button around it would centre
     * whatever that stack produced. Two strokes of `currentColor` in a square
     * box are the same mark in every font, and still the theme's colour.
     */
    function CloseMark() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', focusable: 'false' },
        h('line', { x1: 2.5, y1: 2.5, x2: 9.5, y2: 9.5, stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('line', { x1: 9.5, y1: 2.5, x2: 2.5, y2: 9.5, stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    /**
     * The shell's cross-plugin panel controller, where this deployment has one.
     *
     * `layout` is optional, and the one place that says so: a deployment
     * without that service has no central panel to select, so every entry into
     * one — and every way out of one — is absent rather than a control that
     * would throw when pressed.
     *
     * @returns {object|undefined} the controller, or undefined where there is none.
     */
    function panelController(ctx) {
      const layout = ctx.get('layout')
      return layout === undefined || layout === null ? undefined : layout
    }

    /**
     * Select a panel, or the Conversation.
     *
     * `null` is the shell's own spelling for the Conversation, which is what
     * dismissing a plugin's panel means.
     *
     * @returns {(panelId: string|null) => boolean} whether this deployment can select a panel.
     */
    function panelOpener(ctx) {
      return (panelId) => {
        const layout = panelController(ctx)
        if (layout === undefined) return false
        layout.selectPanel(panelId)
        return true
      }
    }

    /** The configuration page for one plugin row. */
    function ConfigPage(props) {
      const { t } = props
      const [state, setState] = useState({ phase: 'loading' })
      const [snapshot, setSnapshot] = useState(null)
      const [modelsNotice, setModelsNotice] = useState(null)
      const [variantsNotice, setVariantsNotice] = useState(null)
      const [usage, setUsage] = useState(null)
      const [usageWindow, setUsageWindow] = useState(7)
      // The same reader the usage panel and the sidebar capsule use, so the
      // cache-forcing rule and the refusal mapping live in one place.
      const { data: subscription, busy: subscriptionBusy, refresh: readSubscription } = useSubscription()
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

      /**
       * Read the usage table for one window.
       *
       * A failure is stored as the raw outcome rather than as a sentence: the
       * message is decided at render, so this callback does not depend on `t`
       * and the mount effect below never restarts on a re-render.
       */
      const readUsage = useCallback(async (days) => {
        const result = await call(`${ROUTES.usage}?days=${String(days)}`)
        if (result.ok && result.payload?.ok === true) {
          setUsage(result.payload)
          return true
        }
        setUsage({ failure: { status: result.status, message: result.payload?.message } })
        return false
      }, [])

      /**
       * Read the subscription's own quota.
       *
       * The read itself lives in `useSubscription`, which the usage panel and
       * the sidebar capsule share, so the forced-refresh query parameter and
       * the mapping from a refusal to a named reason have one implementation
       * rather than three. This page only decides when to ask: on open, and when
       * the reader presses the button — never on a timer, and never as part of
       * another save.
       */

      // The first read. All four callbacks are stable, so this runs once and
      // the endpoints are read together rather than one after another.
      useEffect(() => {
        void readState()
        void readModels()
        void readUsage(7)
        void readSubscription(false)
      }, [readModels, readState, readSubscription, readUsage])

      /** Re-read what a credential write can have changed. */
      const load = useCallback(async () => {
        await Promise.all([readState(), readModels()])
      }, [readModels, readState])

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

      /**
       * Read the usage table for one window.
       *
       * The window is the page's own choice and the Host clamps it, so a window
       * this build does not offer falls back to the default rather than failing.
       * A failure leaves the previous table on screen and says why underneath.
       */
      const readUsageWindow = useCallback(async (days) => {
        setBusy(true)
        try {
          setUsageWindow(days)
          await readUsage(days)
        } finally {
          setBusy(false)
        }
      }, [readUsage])

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
      // A failed usage read is turned into a sentence here, in the reader's
      // language, from the raw outcome the read stored.
      const usageTable = usage?.failure === undefined
        ? usage
        : {
          error: usage.failure.status === 503
            ? t('usageUnavailable')
            : t('usageFailed', {
              message: usage.failure.message ?? t('errHttp', { status: String(usage.failure.status) }),
            }),
        }
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
        h(UsageSection, {
          t,
          table: usageTable,
          subscription,
          subscriptionBusy,
          onSubscriptionRefresh: () => readSubscription(true),
          windowDays: usageWindow,
          busy,
          onWindow: readUsageWindow,
          onRefresh: () => readUsageWindow(usageWindow),
        }),
        data.config?.editable === true
          ? null
          : h('div', { style: { ...styles.message, ...styles.warn } },
            h('p', { style: { margin: 0 } },
              t('configReadonly', {
                reason: data.config?.reason === 'entry-not-found' ? t('reasonNoEntry') : t('reasonNoEditor'),
              })),
            h('p', { style: { margin: '6px 0 0' } }, t('configReadonlyAdvice'))))
    }

    /** The registered page: the row detail renders `summary`, the page renders `page`. */
    function PluginPage(props) {
      if (props.view === 'summary') return h(Summary, props)
      return h(ConfigPage, props)
    }

    /** The settings tab's page: the panel's sections, with the header dropped. */
    function UsageTab(props) {
      const { t } = props
      const { data, busy, refresh } = useSubscription()
      useEffect(() => {
        void refresh(false)
      }, [refresh])
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px', width: '100%', maxWidth: '760px' } },
        h('section', { style: styles.panelSection },
          h(QuotaHead, { t, busy, onRefresh: () => void refresh(true) }),
          h('div', { style: styles.card },
            h(SubscriptionPanel, { t, data }))),
        h(UsageCounters, { t }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register('opencodeGo', DICTIONARY),
          'opencode-go: configuration page dictionary',
        )
        const t = ctx.locale.bind('opencodeGo')
        const selectPanel = panelOpener(ctx)

        /**
         * Where the settings entry leads, if this deployment has one.
         *
         * The plugin's own configuration page is hosted by the Plugins page, so
         * the shortest honest link to it is that page's door: `pluginNavigation`
         * opens the bundle whose row carries the Configure control. Without the
         * service there is no such page to reach, and the entry is not rendered
         * at all rather than pointing somewhere that does not exist.
         */
        const openSettings = () => {
          const navigation = ctx.get('pluginNavigation')
          if (navigation === undefined || navigation === null) return
          navigation.openBundle(PACKAGE_NAME)
        }

        /** The props an entry that offers the settings link hands its component. */
        const settingsEntry = () => {
          const navigation = ctx.get('pluginNavigation')
          if (navigation === undefined || navigation === null) return {}
          return { openSettings }
        }

        /**
         * The props the panel needs for its own dismissal.
         *
         * The shell has no per-panel hide: leaving a global panel is selecting
         * the Conversation, which is what `null` means to the controller. Where
         * there is no controller there is no panel to leave either, so the × is
         * left out rather than rendered inert.
         */
        const closeEntry = () => (panelController(ctx) === undefined
          ? {}
          : { closeUsage: () => { selectPanel(null) } })

        /** The props the sidebar capsule needs to reach both places it offers. */
        const capsuleEntry = () => ({ t, openUsage: () => selectPanel(PANEL_ID), ...settingsEntry() })

        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: 'opencodeGo',
        }, PluginPage))

        /**
         * The sidebar's foot: the quota beside Settings, one click from
         * anywhere. It is deliberately the first of the new entries — the panel
         * it opens is worth less than the number it shows without a click.
         */
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: PANEL_ID,
          order: 20,
          label: () => t('capsuleLabel'),
          locale: 'opencodeGo',
          inject: capsuleEntry,
        }, UsageCapsule))

        /**
         * The panel itself.
         *
         * It has no sidebar row of its own: the quota row below is the entry,
         * and it already answers the question the row would have carried. A
         * second sidebar entry holding the same number would be a second door
         * into one room, in a column whose remaining rows are the host's.
         */
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: 'opencodeGo',
          inject: () => ({ t, ...settingsEntry(), ...closeEntry() }),
        }, UsagePage))

        /**
         * The keyboard entry, registered inside the panel's own slot.
         *
         * Nesting it here is what makes the command honest: it can only exist
         * while there is a panel for it to open, and the registration lives and
         * dies with that slot rather than with the whole plugin.
         */
        ctx.slots.inject('main', () => {
          const shortcuts = ctx.get('shortcuts')
          if (shortcuts === undefined || shortcuts === null) return () => {}
          return ctx.effect(() => shortcuts.register({
            id: SHORTCUT_ID,
            label: () => t('panelShortcut'),
            aliases: ['opencode go', 'usage', 'quota'],
            // Both the desktop and the browser clients bind it. The browser
            // shell refuses a bare `primary+KeyU` and allows `primary+alt`, so
            // the two runtimes get the two spellings rather than one binding
            // that would be rejected for the whole client; Linux browsers can
            // set their own from Settings → Shortcuts.
            defaults: {
              'desktop:macos': { code: 'KeyU', modifiers: ['primary'] },
              'desktop:windows': { code: 'KeyU', modifiers: ['primary'] },
              'desktop:linux': { code: 'KeyU', modifiers: ['primary'] },
              'web:macos': { code: 'KeyU', modifiers: ['primary', 'alt'] },
              'web:windows': { code: 'KeyU', modifiers: ['primary', 'alt'] },
            },
            regions: ['page', 'editable', 'terminal'],
            modals: [],
            resolve: () => selectPanel(PANEL_ID) === false
              ? { status: 'blocked', reason: t('panelUnavailable') }
              : { status: 'handled', run: () => {} },
          }), 'opencode-go: usage shortcut')
        })

        /**
         * A page under Settings → Plugins, next to the built-in plugin list.
         *
         * Cheap and additive: it renders the panel's sections, so a reader who
         * looks for this in Settings finds it, and nothing here duplicates the
         * counters' own logic.
         */
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'opencode-go-usage',
          order: 20,
          label: () => t('capsuleLabel'),
          locale: 'opencodeGo',
          inject: () => ({ t }),
        }, UsageTab))
      },
    }
  },
})
