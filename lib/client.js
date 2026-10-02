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
      usage: 'opencode-go/usage',
      subscription: 'opencode-go/subscription',
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
        referenceHint: '改这里会让本路由去读另一个环境变量名；保存后插件行会重载。',
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
        modelsGated: '训练门控',
        modelsHiddenHere: '已隐藏',
        modelsTrainingHint: '该模型要求 workspace 开启「允许使用会训练请求数据的模型」，与是否隐藏无关。',
        modelsCatalogSource: '目录来源：{source}',
        modelsSourceDiscover: '自动发现（GET /models）',
        modelsSourceConfig: '来自配置',
        sectionVariants: '模型变体',
        variantsIntro: '变体是同一个模型的另一套设置：以一个名字固定协议、思考等级、上下文窗口和输出上限，并在模型列表里作为独立条目出现（<模型>@<名字>）。它只是本地的别名——请求仍然按原模型发出。',
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
        usageIntro: '本插件自己记录的调用与 token；按本机日期聚合，最多保留 {days} 天。它只统计这个路由的请求，provider 的账单可能另有差异。',
        usageWindow: '统计窗口',
        usageWindowDay: '今天',
        usageWindow7: '近 7 天',
        usageWindow30: '近 30 天',
        usageEmpty: '这段时间还没有调用记录。',
        usageTotals: '合计',
        usageRequests: '调用',
        usageFailures: '失败',
        usageInput: '输入 token',
        usageOutput: '输出 token',
        usageTotal: 'token 合计',
        usageCacheRead: '缓存读取',
        usageByModel: '按模型',
        usageByDay: '按天',
        usageRefresh: '刷新用量',
        usageUnavailable: '此部署没有记录用量。',
        usageFailed: '读取用量失败：{message}',
        usageColumnModel: '模型',
        usageColumnDay: '日期',
        subscriptionTitle: '订阅额度（来自 OpenCode Go 服务）',
        subscriptionIntro: '这是服务端计量的额度百分比，不是本插件的统计：它才是「计划还剩多少」的答案。',
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
        subscriptionCached: '读取于 {time}；再次读取会强制刷新。',
        subscriptionUnavailable: '读不到订阅额度（{reason}）。本页上方的本地统计不受影响。',
        subscriptionReasonUnauthorized: '服务拒绝了这把密钥',
        subscriptionReasonUnsupported: '该服务或网关没有这个接口',
        subscriptionReasonUnreachable: '无法连接到服务',
        subscriptionReasonNoCredential: '没有可用的密钥',
        subscriptionReasonFailed: '服务返回了错误',
        reasonNoEditor: '此部署没有 profile 配置编辑器',
        reasonNoEntry: '找不到该插件的 profile 条目',
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
        referenceHint: 'Changing this points the route at another environment variable name; the plugin row reloads after it is saved.',
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
        modelsGated: 'training-gated',
        modelsHiddenHere: 'hidden',
        modelsTrainingHint: 'This model needs the workspace setting that allows models training on request data, whether or not it is hidden here.',
        modelsCatalogSource: 'Catalog source: {source}',
        modelsSourceDiscover: 'discovered (GET /models)',
        modelsSourceConfig: 'from configuration',
        sectionVariants: 'Model variants',
        variantsIntro: 'A variant is one model\'s second set of settings: a name that fixes the protocol to lead with, the default thinking level, the context window, and the output cap, offered in the model list as its own entry (<model>@<name>). It is a local alias — the request still leaves as the model itself.',
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
        usageIntro: 'Calls and tokens this plugin counted itself, grouped by this machine\'s calendar day and kept for {days} days. It covers this route only; the provider\'s own billing may differ.',
        usageWindow: 'Window',
        usageWindowDay: 'Today',
        usageWindow7: '7 days',
        usageWindow30: '30 days',
        usageEmpty: 'No calls were recorded in this window.',
        usageTotals: 'Total',
        usageRequests: 'Calls',
        usageFailures: 'Failed',
        usageInput: 'Input tokens',
        usageOutput: 'Output tokens',
        usageTotal: 'Total tokens',
        usageCacheRead: 'Cache read',
        usageByModel: 'By model',
        usageByDay: 'By day',
        usageRefresh: 'Refresh usage',
        usageUnavailable: 'This deployment does not record usage.',
        usageFailed: 'Could not read usage: {message}',
        usageColumnModel: 'Model',
        usageColumnDay: 'Day',
        subscriptionTitle: 'Subscription quota (from the OpenCode Go service)',
        subscriptionIntro: 'These percentages are the service\'s own metering rather than this plugin\'s count: they are what answers "how much of the plan is left".',
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
        subscriptionCached: 'Read at {time}; asking again forces a fresh read.',
        subscriptionUnavailable: 'Could not read the subscription quota ({reason}). The local counters above are unaffected.',
        subscriptionReasonUnauthorized: 'the service refused this key',
        subscriptionReasonUnsupported: 'this service or gateway does not serve it',
        subscriptionReasonUnreachable: 'the service could not be reached',
        subscriptionReasonNoCredential: 'no key was available',
        subscriptionReasonFailed: 'the service answered with an error',
        reasonNoEditor: 'this deployment has no profile configuration editor',
        reasonNoEntry: 'no profile entry for this plugin was found',
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
      warn: { color: 'var(--dsw-alias-state-warn-primary)' },
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
              : draft.map((entry, index) => h('div', { key: `${entry.model}@${entry.name}#${String(index)}`, style: styles.variantRow },
                h('div', { style: styles.variantHead },
                  h('span', { style: styles.modelName }, entry.label ?? `${entry.model} (${entry.name})`),
                  h('span', { style: styles.modelMeta }, `${entry.model}@${entry.name}`),
                  h('button', {
                    type: 'button',
                    style: styles.button,
                    'aria-label': t('variantsRemoveNamed', { id: `${entry.model}@${entry.name}` }),
                    onClick: () => remove(index),
                  }, t('variantsRemove'))),
                h('div', { style: styles.toolbar },
                  textField(t('variantsName'), entry, index, 'name', { placeholder: t('variantsNamePlaceholder') }),
                  textField(t('variantsLabel'), entry, index, 'label', { placeholder: t('variantsLabelPlaceholder') }),
                  h('label', { style: styles.inlineField },
                    h('span', { style: styles.fieldLabel }, t('variantsProtocol')),
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
                      h('span', { style: styles.fieldLabel }, t('variantsEffort')),
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
          form.model === ''
            ? h('p', { style: styles.hint }, t('variantsNameDefaultHint', { id: t('variantsNameDefaultGeneric') }))
            : h('p', { style: styles.hint }, t('variantsNameDefaultHint', { id: defaultVariantId })),
          // The grammar rule belongs here as text rather than crammed into the
          // box, where it would be clipped and, at 12px, unreadable anyway.
          h('p', { style: styles.hint }, t('variantsNameRule')),
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

    function SubscriptionPanel({ t, data, busy, onRefresh }) {
      if (data === null || data === undefined) {
        return h('div', null, h('p', { style: styles.hint }, t('subscriptionLoading')))
      }
      const head = h('div', { style: styles.toolbar },
        h('span', { style: styles.fieldLabel }, t('subscriptionTitle')),
        h('button', { type: 'button', style: styles.button, disabled: busy, onClick: onRefresh }, t('subscriptionRefresh')))
      if (data.ok !== true) {
        return h('div', null, head,
          h('p', { style: styles.hint }, t('subscriptionUnavailable', { reason: t(subscriptionReasonKey(data.reason)) })),
          data.message === undefined ? null : h('p', { style: styles.hint }, String(data.message)))
      }
      const windows = Array.isArray(data.windows) ? data.windows : []
      if (windows.length === 0) return h('div', null, head, h('p', { style: styles.hint }, t('subscriptionUnavailable', { reason: t(subscriptionReasonKey('unsupported')) })))
      return h('div', null,
        head,
        h('p', { style: styles.hint }, t('subscriptionIntro')),
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
      const panel = h(SubscriptionPanel, {
        t,
        data: subscription,
        busy: subscriptionBusy,
        onRefresh: onSubscriptionRefresh,
      })
      if (table === null || table === undefined) {
        return h('section', { style: styles.section }, header,
          h('div', { style: styles.card }, panel, h('p', { style: styles.hint }, t('loading'))))
      }
      if (table.error !== undefined) {
        return h('section', { style: styles.section }, header,
          h('div', { style: styles.card }, panel,
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
      const figures = (counters) => [
        number(counters.requests),
        number(counters.failures),
        number(counters.inputTokens),
        number(counters.outputTokens),
        number(counters.totalTokens),
      ]

      return h('section', { style: styles.section },
        header,
        h('div', { style: styles.card },
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
                headers: [t('usageTotals'), t('usageRequests'), t('usageFailures'), t('usageInput'), t('usageOutput'), t('usageTotal'), t('usageCacheRead')],
                rows: [{ key: 'total', cells: [t('usageTotals'), ...figures(totals), number(totals.cacheReadTokens)] }],
              }),

              h('p', { style: { ...styles.sectionTitle, marginTop: '14px' } }, t('usageByModel')),
              h(UsageTable, {
                id: 'model',
                headers: [t('usageColumnModel'), t('usageRequests'), t('usageFailures'), t('usageInput'), t('usageOutput'), t('usageTotal')],
                rows: (table.models ?? []).map((entry) => ({
                  key: entry.model,
                  cells: [entry.model, ...figures(entry.counters)],
                })),
              }),

              h('p', { style: { ...styles.sectionTitle, marginTop: '14px' } }, t('usageByDay')),
              h(UsageTable, {
                id: 'day',
                headers: [t('usageColumnDay'), t('usageRequests'), t('usageFailures'), t('usageTotal')],
                rows: (table.days ?? []).map((entry) => ({
                  key: entry.day,
                  cells: [entry.day, number(entry.counters.requests), number(entry.counters.failures), number(entry.counters.totalTokens)],
                })),
              }))))
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
      const [subscription, setSubscription] = useState(null)
      const [subscriptionBusy, setSubscriptionBusy] = useState(false)
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
       * The one call on this page that reaches the provider for a fact the
       * provider owns, so it is read only when the reader opens the page or
       * asks again — never on a timer, and never as part of another save. A
       * refusal is stored as-is and turned into a sentence at render, the same
       * way the usage read does it.
       */
      const readSubscription = useCallback(async (force) => {
        setSubscriptionBusy(true)
        try {
          const result = await call(`${ROUTES.subscription}${force === true ? '?refresh=1' : ''}`)
          const payload = result.payload
          if (result.status === 401) setSubscription({ ok: false, reason: 'unauthorized' })
          else if (result.status === 403) setSubscription({ ok: false, reason: 'unauthorized' })
          else if (payload !== null && payload !== undefined) setSubscription(payload)
          else setSubscription({ ok: false, reason: 'failed', message: t('errHttp', { status: String(result.status) }) })
        } catch (error) {
          setSubscription({ ok: false, reason: 'unreachable', message: String(error?.message ?? 'network') })
        } finally {
          setSubscriptionBusy(false)
        }
      }, [t])

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
