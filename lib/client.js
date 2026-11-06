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
      activity: 'opencode-go/activity',
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

    /**
     * The quota schedule's bounds, until an answer says otherwise.
     *
     * The Host sends both on every answer, because they are its configuration;
     * these are the same defaults it resolves, kept here so a page that has not
     * read anything yet can still arm a clock. They are the last copy of the two
     * numbers in this bundle — see `subscriptionMinIntervalSeconds` in
     * `lib/config.js`.
     */
    const SUBSCRIPTION_MIN_INTERVAL_SECONDS = 30
    const SUBSCRIPTION_MAX_INTERVAL_SECONDS = 1_800

    /**
     * The page's copy, in both shipped locales.
     *
     * Native Harness settings pages say little and say it plainly: a short
     * label, a one-line explanation under a field, and a status sentence that
     * names what just happened. The same wording is used here, so the plugin's
     * page reads like the pages beside it in Settings. Every key must be read
     * through `t()` — `tests/suites/client.test.mjs` fails on a key nothing
     * looks up.
     */
    const DICTIONARY = {
      zh: {
        summary: 'API 密钥、模型与用量',
        pageTitle: 'OpenCode Go',
        pageIntro: '填入 API 密钥即可使用 OpenCode Go 的模型。',
        loading: '正在读取…',
        failed: '读取失败：{message}',
        retry: '重试',
        save: '保存',
        saving: '保存中…',
        saved: '已保存。',
        saveFailed: '保存失败：{message}',
        errUnauthorized: '浏览器会话未认证，请刷新页面后重试。',
        errForbidden: '请求被本机安全策略拒绝。',
        errHttp: '请求失败（HTTP {status}）。',

        // — 连接：只读事实 —
        sectionConnection: '连接',
        fieldProvider: '提供商 ID',
        fieldBaseURL: 'API 地址',
        fieldApiKeyEnv: '凭据引用',

        // — API 密钥 —
        sectionKey: 'API 密钥',
        keyConfigured: '已配置',
        keyMissing: '未配置',
        keySourceStore: '密钥来自凭据存储。',
        keySourceEnvironment: '密钥来自启动环境变量 {variable}。',
        keySourceProjectEnv: '密钥来自项目的 .env 文件（{path}）。',
        keySourceUserEnv: '密钥来自用户目录的 .env 文件（{path}）。',
        keyReadonly: '该密钥的来源只读，无法从这里修改。',
        keyBlockedEnvironment: '启动环境变量 {variable} 提供了这个密钥，运行中的进程无法覆盖它；请在该环境中取消设置后重启。',
        keyBlockedEnvFile: '.env 文件（{path}）提供了这个密钥，清除后它会立刻回来；请修改该文件。',
        keyBlockedEnvFileUnknown: '路径未知',
        keyBlockedAdvice: '要绕开它，请把下面的「凭据引用」改成另一个名字，并在那里保存密钥。',
        keyPlaceholder: '输入 API 密钥',
        keyClear: '清除密钥',
        keyCleared: '已清除存储的密钥。',
        keyNoStore: '该部署没有凭据存储，请在启动环境中设置该变量。',
        keyRequired: '请先填写 API 密钥。',
        referencePlaceholder: 'OPENCODE_GO_API_KEY',
        referenceHint: '插件从这个环境变量读取 API 密钥，修改后自动保存。',
        referenceRequired: '请先填写环境变量名。',

        // — 模型 —
        sectionModels: '模型',
        modelsIntro: '在模型选择器中显示哪些模型；隐藏的模型仍可在会话中直接指定。',
        modelsSummary: '共 {total} 个模型，列出 {listed} 个。',
        modelsHiddenCount: '已隐藏 {count} 个',
        modelsFilter: '搜索模型',
        modelsEmpty: '没有匹配的模型。',
        modelsEmptyCatalog: '模型目录为空。',
        modelsListed: '在列表中显示',
        modelsReload: '重新读取列表',
        modelsShowAll: '全部显示',
        modelsHideAll: '全部隐藏',
        modelsFetch: '获取可用模型',
        modelsFetching: '正在向服务读取…',
        modelsFetched: '已重新读取 {count} 个模型：新增 {added}，消失 {removed}。',
        modelsFetchedSame: '已重新读取 {count} 个模型，没有变化。',
        modelsFetchAdded: '新增：{models}',
        modelsFetchRemoved: '消失：{models}',
        modelsFetchNotDiscovering: '当前部署的模型目录来自配置，没有可获取的列表。',
        modelsFetchFailed: '读取模型列表失败：{message}',
        modelsStale: '已写入，但列表暂时读不回来；请稍后重试。',
        modelsAge: '获取于 {time}',
        modelsGated: '用于训练',
        modelsHiddenHere: '已隐藏',
        modelsReasoning: '推理',
        modelsTrainingHint: '标注「用于训练」的模型需要 workspace 允许使用会训练请求数据的模型。',
        modelsCatalogSource: '目录来源：{source}',
        modelsSourceDiscover: '自动发现',
        modelsSourceConfig: '来自配置',

        // — 变体 —
        sectionVariants: '变体',
        variantsIntro: '变体为模型固定协议、推理等级、上下文窗口和最大输出 token 数，在模型列表中作为独立条目出现。',
        variantsEmpty: '还没有变体。',
        variantsListTitle: '已添加 {count} 个',
        variantsAddTitle: '添加变体',
        variantsNameDefaultHint: '留空时使用 {id}。',
        variantsNameDefaultGeneric: '<模型>@<推理等级>',
        variantsNameDefaultPlain: '默认',
        variantsRemoveNamed: '删除变体 {id}',
        variantsModel: '模型',
        variantsModelPlaceholder: '选择模型',
        variantsName: '变体名',
        variantsNamePlaceholder: '例如 fast',
        variantsLabel: '显示名称',
        variantsLabelPlaceholder: '可选',
        variantsNameRule: '只能包含字母、数字、点和短横线。',
        variantsProtocol: '优先协议',
        variantsProtocolDefault: '沿用模型设置',
        variantsEffort: '推理等级',
        variantsEffortDefault: '沿用模型设置',
        variantsContext: '上下文窗口',
        variantsMaxTokens: '最大输出 token 数',
        variantsPlaceholderInherit: '沿用默认',
        variantsAdd: '添加变体',
        variantsEdit: '编辑',
        variantsCollapse: '完成',
        variantsEditNamed: '编辑变体 {id}',
        variantsCollapseNamed: '收起变体 {id}',
        variantsRemove: '删除',
        variantsWithoutModel: '这些变体引用的模型不在目录中：{models}',
        variantsDuplicate: '变体「{id}」已存在。',
        variantsNeedModel: '请先选择一个模型。',
        variantsNeedName: '请填写变体名。',
        variantsBadName: '变体名只能包含字母、数字、点和短横线。',
        variantsEffortRequiresReasoning: '模型 {model} 不支持推理，不能设置推理等级。',

        // — 额度刷新 —
        sectionSchedule: '额度刷新',
        scheduleIntro: '侧边栏的额度数字多久更新一次。',
        scheduleMin: '最短间隔（秒）',
        scheduleMax: '最长间隔（秒）',
        scheduleExample: '当前：最短 {min} 秒，最长 {max} 秒。',
        scheduleNotReported: '这一行没有报告刷新间隔：正在运行的插件比本页旧。重启 DSH 后再打开本页。',
        scheduleStale: '已写入，但没能读回配置；请稍后重试。',
        schedulePairOrder: '最短间隔不能大于最长间隔。',

        // — 传输与重试 —
        sectionTransport: '传输与重试',
        transportIntro: '请求超时、重试策略，以及大请求体使用的连接方式。',
        transportFreshConnection: '大请求体使用新连接',
        transportFreshConnectionHint: '请求体达到 256 KiB 时关闭连接复用，避免复用的连接被网络路径重置。',
        transportTimeout: '请求超时（秒）',
        transportStreamIdle: '流空闲超时（秒）',
        transportMaxRetries: '最大重试次数',
        transportInitialDelay: '首次重试延迟（毫秒）',
        transportMaxDelay: '最长重试延迟（毫秒）',
        transportDelayOrder: '首次重试延迟不能大于最长重试延迟。',
        transportNotReported: '这一行没有报告传输设置：正在运行的插件比本页旧。重启 DSH 后再打开本页。',
        transportStale: '已写入，但没能读回配置；请稍后重试。',
        configReadonly: '当前部署的设置配置为只读。',
        configReadonlyAdvice: '以上内容仍可查看，用量仍会记录。',
        configReadonlyReason: '原因：{reason}',
        reasonNoEditor: '没有配置编辑器',
        reasonNoEntry: '找不到这个插件的配置行',

        // — 用量 —
        sectionUsage: '用量与历史',
        usageIntro: '本路由在本机记录的调用与 token；服务商的账单可能不同。',
        usageHistoryNote: '合计与按模型跟随统计范围，按天汇总始终列出全部历史。',
        usageHistoryNotReported: '当前运行的插件尚未提供完整历史，按天汇总跟随统计范围；重启 DSH 后可恢复全部历史。',
        usageWindow: '统计范围',
        usageWindowHint: '选择合计与按模型的统计范围',
        usageWindowDay: '今天',
        usageWindow7: '近 7 天',
        usageWindow30: '近 30 天',
        usageWindowAll: '全部历史',
        usageEmpty: '当前范围没有调用记录。',
        usageTotals: '合计',
        usageRequests: '调用',
        usageFailures: '失败',
        usageInput: '未缓存输入',
        usageOutput: '输出 token',
        usageTotal: '合计 token',
        usageCacheRead: '缓存命中',
        usageCacheWrite: '缓存写入',
        usageCacheHit: '命中率',
        usageCacheUnknown: '—',
        usageCacheNote: '命中率 = 缓存命中 ÷（未缓存输入 + 缓存命中）；服务未回报缓存数字时显示「—」。',
        usageByModel: '按模型汇总',
        usageByDay: '按天汇总',
        usagePageSize: '每页天数',
        usagePageSizeHint: '选择每页显示的天数',
        usagePageSizeOption: '每页 {count} 天',
        usagePrevious: '上一页',
        usageNext: '下一页',
        usagePageStatus: '第 {page} / {pages} 页',
        usageNumberFormat: '数字格式',
        usageNumberFormatHint: '选择 token 数字的显示方式',
        usageNumbersExact: '完整数字',
        usageNumbersCompact: '显示单位',
        usageNumberFormatFailed: '数字格式保存失败：{message}',
        usageRefresh: '刷新用量',
        usageElsewhere: '按 Ctrl/Cmd+U 打开用量面板。',
        usageUnavailable: '此部署没有记录用量。',
        usageFailed: '读取用量失败：{message}',
        usageColumnModel: '模型',
        usageColumnDay: '日期',

        // — 订阅额度 —
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
        subscriptionUnavailable: '读不到订阅额度（{reason}）。本地统计不受影响。',
        subscriptionReasonUnauthorized: '服务拒绝了这把密钥',
        subscriptionReasonUnsupported: '该服务或网关没有这个接口',
        subscriptionReasonUnreachable: '无法连接到服务',
        subscriptionReasonNoCredential: '没有可用的密钥',
        subscriptionReasonFailed: '服务返回了错误',

        // — 用量面板 —
        panelTitle: 'OpenCode Go 用量',
        panelIntro: '订阅额度与本路由的调用记录。',
        panelSettings: '插件配置',
        panelClose: '关闭面板',
        panelNoSettings: '此部署没有可以打开配置页的入口：设置面板与 Plugins 页都没有挂载。',
        panelQuotaSection: '订阅额度',
        panelCountedSection: '本路由的计数',
        panelShortcut: '打开用量面板',
        panelUnavailable: '此部署没有可以切换的中央面板。',
        settingsNavLabel: 'OpenCode Go',

        // —— 快速入口（侧边栏胶囊）——
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
      },
      en: {
        summary: 'API key, models, and usage',
        pageTitle: 'OpenCode Go',
        pageIntro: 'Enter an API key to use models from OpenCode Go.',
        loading: 'Loading…',
        failed: 'Could not read the plugin state: {message}',
        retry: 'Retry',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved.',
        saveFailed: 'Could not save: {message}',
        errUnauthorized: 'The browser session is not authenticated; reload the page and retry.',
        errForbidden: 'The local request policy refused this call.',
        errHttp: 'Request failed (HTTP {status}).',

        // — Connection: read-only facts —
        sectionConnection: 'Connection',
        fieldProvider: 'Provider ID',
        fieldBaseURL: 'Base URL',
        fieldApiKeyEnv: 'Credential reference',

        // — API key —
        sectionKey: 'API key',
        keyConfigured: 'Configured',
        keyMissing: 'Not configured',
        keySourceStore: 'The key comes from the credential store.',
        keySourceEnvironment: 'The key comes from the launching environment variable {variable}.',
        keySourceProjectEnv: 'The key comes from the project .env file ({path}).',
        keySourceUserEnv: 'The key comes from the home .env file ({path}).',
        keyReadonly: 'This key\'s source is read-only and cannot be changed here.',
        keyBlockedEnvironment: 'The launching environment variable {variable} supplies this key, and a running process cannot replace it. Unset it there and restart.',
        keyBlockedEnvFile: 'A .env file ({path}) supplies this key, so clearing the store only brings it back. Edit that file instead.',
        keyBlockedEnvFileUnknown: 'path unknown',
        keyBlockedAdvice: 'To step around it, point Credential reference below at another name and store the key there.',
        keyPlaceholder: 'Enter your API key',
        keyClear: 'Clear key',
        keyCleared: 'The stored key was removed.',
        keyNoStore: 'This deployment has no credential store; set the variable in the launching environment.',
        keyRequired: 'Enter an API key first.',
        referencePlaceholder: 'OPENCODE_GO_API_KEY',
        referenceHint: 'The plugin reads its API key from this environment variable. Saved automatically.',
        referenceRequired: 'Enter an environment variable name.',

        // — Models —
        sectionModels: 'Models',
        modelsIntro: 'Choose which models appear in the model picker; hidden models can still be named directly in a session.',
        modelsSummary: '{listed} of {total} models are listed.',
        modelsHiddenCount: '{count} hidden',
        modelsFilter: 'Search models',
        modelsEmpty: 'No models match.',
        modelsEmptyCatalog: 'The model catalog is empty.',
        modelsListed: 'Listed',
        modelsReload: 'Reload list',
        modelsShowAll: 'Show all',
        modelsHideAll: 'Hide all',
        modelsFetch: 'Fetch available models',
        modelsFetching: 'Asking the provider…',
        modelsFetched: 'Re-read {count} models: {added} new, {removed} gone.',
        modelsFetchedSame: 'Re-read {count} models; nothing changed.',
        modelsFetchAdded: 'New: {models}',
        modelsFetchRemoved: 'Gone: {models}',
        modelsFetchNotDiscovering: 'This deployment builds its catalog from configuration, so there is no list to fetch.',
        modelsFetchFailed: 'Could not read the model list: {message}',
        modelsStale: 'Saved, but the list could not be read back yet; retry in a moment.',
        modelsAge: 'fetched {time}',
        modelsGated: 'Trains',
        modelsHiddenHere: 'Hidden',
        modelsReasoning: 'Reasoning',
        modelsTrainingHint: 'Models tagged Trains need the workspace setting that allows models training on request data.',
        modelsCatalogSource: 'Catalog source: {source}',
        modelsSourceDiscover: 'discovered',
        modelsSourceConfig: 'from configuration',

        // — Variants —
        sectionVariants: 'Variants',
        variantsIntro: 'A variant fixes a model\'s protocol, reasoning level, context window, and max output tokens, and appears in the model list as its own entry.',
        variantsEmpty: 'No variants yet.',
        variantsListTitle: '{count} added',
        variantsAddTitle: 'Add a variant',
        variantsNameDefaultHint: 'Leave blank to use {id}.',
        variantsNameDefaultGeneric: '<model>@<reasoning level>',
        variantsNameDefaultPlain: 'default',
        variantsRemoveNamed: 'Delete variant {id}',
        variantsModel: 'Model',
        variantsModelPlaceholder: 'Pick a model',
        variantsName: 'Variant name',
        variantsNamePlaceholder: 'for example fast',
        variantsLabel: 'Display name',
        variantsLabelPlaceholder: 'optional',
        variantsNameRule: 'Letters, digits, dot, and dash only.',
        variantsProtocol: 'Preferred protocol',
        variantsProtocolDefault: 'Use the model default',
        variantsEffort: 'Reasoning level',
        variantsEffortDefault: 'Use the model default',
        variantsContext: 'Context window',
        variantsMaxTokens: 'Max output tokens',
        variantsPlaceholderInherit: 'Default',
        variantsAdd: 'Add variant',
        variantsEdit: 'Edit',
        variantsCollapse: 'Done',
        variantsEditNamed: 'Edit variant {id}',
        variantsCollapseNamed: 'Finish editing variant {id}',
        variantsRemove: 'Delete',
        variantsWithoutModel: 'These variants name models the catalog does not list: {models}',
        variantsDuplicate: 'Variant "{id}" already exists.',
        variantsNeedModel: 'Pick a model first.',
        variantsNeedName: 'Enter a variant name.',
        variantsBadName: 'A variant name may hold only letters, digits, dot, and dash.',
        variantsEffortRequiresReasoning: 'Model {model} does not support reasoning, so it cannot set a reasoning level.',

        // — Quota refresh —
        sectionSchedule: 'Quota refresh',
        scheduleIntro: 'How often the quota figures refresh.',
        scheduleMin: 'Shortest interval (seconds)',
        scheduleMax: 'Longest interval (seconds)',
        scheduleExample: 'Now: {min}s shortest, {max}s longest.',
        scheduleNotReported: 'This row reported no refresh intervals: the running plugin is older than this page. Restart DSH and reopen this page.',
        scheduleStale: 'Saved, but the configuration could not be read back; retry in a moment.',
        schedulePairOrder: 'The shortest interval cannot be longer than the longest.',

        // — Transport and retries —
        sectionTransport: 'Transport and retries',
        transportIntro: 'Deadlines, retries, and the connection large bodies use.',
        transportFreshConnection: 'Large bodies use a fresh connection',
        transportFreshConnectionHint: 'Closes the connection for bodies of 256 KiB or more, so a reused socket cannot reset an upload.',
        transportTimeout: 'Request timeout (seconds)',
        transportStreamIdle: 'Stream idle timeout (seconds)',
        transportMaxRetries: 'Retry limit',
        transportInitialDelay: 'First retry delay (milliseconds)',
        transportMaxDelay: 'Longest retry delay (milliseconds)',
        transportDelayOrder: 'The first retry delay cannot be longer than the longest retry delay.',
        transportNotReported: 'This row reported no transport settings: the running plugin is older than this page. Restart DSH and reopen this page.',
        transportStale: 'Saved, but the configuration could not be read back; retry in a moment.',
        configReadonly: 'Configuration is read-only in this deployment.',
        configReadonlyAdvice: 'Everything above is still readable and usage is still recorded.',
        configReadonlyReason: 'Reason: {reason}',
        reasonNoEditor: 'no configuration editor',
        reasonNoEntry: 'no configuration row for this plugin',

        // — Usage —
        sectionUsage: 'Usage and history',
        usageIntro: 'Calls and tokens recorded locally for this route; the provider\'s billing may differ.',
        usageHistoryNote: 'Totals and models follow the selected range; the daily table always covers all history.',
        usageHistoryNotReported: 'The running plugin offers no complete daily history yet, so the daily table follows the selected range. Restart DSH to restore complete history.',
        usageWindow: 'Range',
        usageWindowHint: 'Choose the range for totals and per-model counters',
        usageWindowDay: 'Today',
        usageWindow7: '7 days',
        usageWindow30: '30 days',
        usageWindowAll: 'All history',
        usageEmpty: 'No calls were recorded in this range.',
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
        usageByModel: 'Totals by model',
        usageByDay: 'Totals by day',
        usagePageSize: 'Days per page',
        usagePageSizeHint: 'Choose how many days to show on each page',
        usagePageSizeOption: '{count} per page',
        usagePrevious: 'Previous page',
        usageNext: 'Next page',
        usagePageStatus: 'Page {page} of {pages}',
        usageNumberFormat: 'Number format',
        usageNumberFormatHint: 'Choose how token counts are displayed',
        usageNumbersExact: 'Full numbers',
        usageNumbersCompact: 'Show units',
        usageNumberFormatFailed: 'Could not save the number format: {message}',
        usageRefresh: 'Refresh usage',
        usageElsewhere: 'Ctrl/Cmd+U opens the usage panel.',
        usageUnavailable: 'This deployment does not record usage.',
        usageFailed: 'Could not read usage: {message}',
        usageColumnModel: 'Model',
        usageColumnDay: 'Day',

        // — Subscription quota —
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
        subscriptionUnavailable: 'Could not read the subscription quota ({reason}). The local counters are unaffected.',
        subscriptionReasonUnauthorized: 'the service refused this key',
        subscriptionReasonUnsupported: 'this service or gateway does not serve it',
        subscriptionReasonUnreachable: 'the service could not be reached',
        subscriptionReasonNoCredential: 'no key was available',
        subscriptionReasonFailed: 'the service answered with an error',

        // — Usage panel —
        panelTitle: 'OpenCode Go usage',
        panelIntro: 'The subscription quota and this route\'s call records.',
        panelSettings: 'Plugin settings',
        panelClose: 'Close the panel',
        panelNoSettings: 'This deployment offers no way to open the configuration page: neither the settings panel nor the Plugins page is mounted.',
        panelQuotaSection: 'Subscription quota',
        panelCountedSection: 'This route\'s counters',
        panelShortcut: 'Open the usage panel',
        panelUnavailable: 'This deployment has no central panel to switch to.',
        settingsNavLabel: 'OpenCode Go',

        // —- Fast entries: the sidebar capsule —-
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
      preferenceRow: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px',
        padding: '16px 0',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
      },
      preferenceText: { display: 'flex', flex: 1, flexDirection: 'column', gap: '4px', minWidth: 0, paddingRight: '48px' },
      preferenceLabel: { color: 'var(--dsw-alias-label-primary)', fontSize: '14px', fontWeight: 400, lineHeight: '22px' },
      preferenceHint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', fontWeight: 400, lineHeight: '18px' },
      preferenceControls: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' },
      menuRoot: { position: 'relative', display: 'inline-flex' },
      selector: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '12px',
        height: '36px',
        padding: '0 14px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '14px',
        lineHeight: '22px',
        cursor: 'pointer',
      },
      menuList: {
        position: 'absolute',
        top: 'calc(100% + 4px)',
        right: 0,
        zIndex: 100,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 'min(144px, calc(100vw - 24px))',
        maxWidth: 'min(360px, calc(100vw - 24px))',
        padding: '4px',
        border: 0,
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-menu-surface-fill)',
        backdropFilter: 'var(--dsw-menu-backdrop-filter)',
        boxShadow: 'var(--dsw-elevation-prominent)',
      },
      menuItem: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        width: '100%',
        minHeight: '34px',
        padding: '6px 8px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        textAlign: 'left',
        cursor: 'pointer',
      },
      menuItemLabel: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      menuIcon: { display: 'inline-flex', flex: 'none', width: '14px', height: '14px' },
      historyHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginTop: '14px' },
      pagination: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' },
      paginationStatus: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', whiteSpace: 'nowrap' },
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
        boxSizing: 'border-box',
        height: '36px',
        minHeight: '36px',
        lineHeight: '22px',
        padding: '0 32px 0 14px',
        borderRadius: 'var(--dsw-radius-md)',
        border: 'none',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '14px',
        minWidth: 0,
        maxWidth: '240px',
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
      // One row, three windows — `◉ 5H 92% │ ◉ Wk 58% │ ◉ Mo 9%` in English,
      // `◉ 5H 92% │ ◉ 周 58% │ ◉ 月 9%` in Chinese. Kept the host row's
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

    /**
     * The native settings design, in inline styles.
     *
     * Every measurement here is taken from the Harness's own settings pages —
     * the model list's section and editor CSS, the shared settings-form fields,
     * and the button/switch/tag primitives — so this page sits in Settings
     * without looking like a guest. Colours are theme tokens only, so the page
     * follows light and dark themes the way the host's pages do.
     */
    const native = {
      // Page column: the settings shell's options column is ~564px; 720px is
      // the host's own cap, which is what a wider window shows.
      page: {
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: '720px',
        display: 'flex',
        flexDirection: 'column',
        gap: '32px',
        color: 'var(--dsw-alias-label-primary)',
      },
      header: { display: 'flex', flexDirection: 'column', gap: '4px' },
      title: { margin: 0, fontSize: '16px', lineHeight: '24px', fontWeight: 500 },
      intro: { margin: 0, fontSize: '14px', lineHeight: '22px', color: 'var(--dsw-alias-label-tertiary)' },

      // One group of settings: heading block, then its content.
      group: { display: 'flex', flexDirection: 'column', gap: '12px' },
      groupHead: { display: 'flex', flexDirection: 'column', gap: '2px' },
      groupTitle: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 500 },
      groupIntro: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },

      // A settings card is the host's raised settings material; an inset editor
      // is the filled module surface a complex editor opens on.
      card: {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '12px 14px',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        borderRadius: 'var(--dsw-radius-xl)',
        background: 'var(--dsw-alias-settings-card-fill)',
      },
      inset: {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '14px 16px',
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-alias-bg-module-platform)',
      },

      // Fields follow SettingsValueField: label, control, hint, one rule apart.
      field: { display: 'flex', flexDirection: 'column', gap: '6px' },
      fieldHead: { display: 'flex', alignItems: 'center', gap: '8px', minHeight: '20px' },
      fieldLabel: {
        flex: '1',
        minWidth: 0,
        fontSize: '13px',
        fontWeight: 500,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary)',
      },
      required: { flex: 'none', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        height: '34px',
        padding: '0 12px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
      },
      // A selector in a settings field shares the text field's box and draws its
      // own chevron, the way the host's model editor does — no OS arrow.
      select: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        width: '100%',
        height: '34px',
        padding: '0 12px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        textAlign: 'left',
        cursor: 'pointer',
      },
      inputDisabled: {
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'default',
      },
      inputInvalid: { borderColor: 'var(--dsw-alias-state-error-primary)' },
      // Two labelled numeric fields sit side by side, the host's model-options
      // grid; a full-width field is a single column.
      fields: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px 16px' },
      hint: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      error: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)' },
      success: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-state-success-primary)' },
      notice: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-state-warn-label)' },
      caption: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      meta: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },

      // Read-only facts: label at the start, value at the end, one rule each.
      facts: { margin: 0, display: 'flex', flexDirection: 'column' },
      factRow: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '16px',
        minHeight: '44px',
        padding: '8px 2px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
      },
      factLabel: { flex: 'none', fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
      factValue: {
        minWidth: 0,
        margin: 0,
        fontSize: '13px',
        lineHeight: '20px',
        textAlign: 'end',
        overflowWrap: 'anywhere',
      },

      // Buttons: md 36px and sm 28px, an outline drawn as an inset hairline so
      // filled and outlined variants share one box.
      button: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        height: '36px',
        padding: '0 14px',
        margin: 0,
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '14px',
        lineHeight: '22px',
        cursor: 'pointer',
        boxShadow: 'inset 0 0 0 var(--dsh-hairline-width, 0.5px) var(--dsw-alias-border-l3)',
      },
      primaryButton: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        height: '36px',
        padding: '0 14px',
        margin: 0,
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        fontFamily: 'inherit',
        fontSize: '14px',
        lineHeight: '22px',
        cursor: 'pointer',
      },
      smallButton: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        height: '28px',
        padding: '0 10px',
        margin: 0,
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
        boxShadow: 'inset 0 0 0 var(--dsh-hairline-width, 0.5px) var(--dsw-alias-border-l3)',
      },
      dangerButton: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '36px',
        padding: '0 14px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        fontFamily: 'inherit',
        fontSize: '14px',
        lineHeight: '22px',
        cursor: 'pointer',
      },
      iconButton: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '28px',
        height: '28px',
        padding: 0,
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'pointer',
      },
      disabled: { opacity: 0.4, cursor: 'default' },

      // A footer row ends a group that commits together: dismiss left, commit
      // right — the host's editor footer.
      footer: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: '8px',
        paddingTop: '4px',
      },
      footerNote: {
        flex: '1',
        minWidth: 0,
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-tertiary)',
      },
      toolbar: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' },
      toolbarEnd: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginLeft: 'auto' },

      // Tags: the host's capsule geometry with the palette the tone needs.
      tag: {
        display: 'inline-flex',
        alignItems: 'center',
        flex: 'none',
        padding: '1px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        lineHeight: '17px',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      },
      tagNeutral: { background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-secondary)' },
      tagQuiet: { color: 'var(--dsw-alias-label-tertiary)' },
      tagSuccess: {
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      tagWarning: {
        background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)',
        color: 'var(--dsw-alias-state-warn-primary)',
      },
      tagDanger: {
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
        color: 'var(--dsw-alias-state-error-primary)',
      },

      // Switch: 36x20 track, 16px thumb, the host's own capsule shape.
      switch: {
        boxSizing: 'border-box',
        position: 'relative',
        flex: 'none',
        width: '36px',
        height: '20px',
        padding: '2px',
        border: 'none',
        borderRadius: '999px',
        background: 'var(--dsw-alias-border-l3)',
        cursor: 'pointer',
      },
      switchOn: { background: 'var(--dsw-alias-brand-primary)' },
      switchThumb: {
        display: 'block',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-label-primary-foreground)',
        transition: 'transform 120ms ease',
      },
      switchThumbOff: { background: 'var(--dsw-alias-switch-thumb)' },
      switchThumbOn: { transform: 'translateX(16px)' },

      // A preference row: title and explanation on the left, the control on the
      // right, one hairline between rows (the host's General settings).
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '16px 0',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
      },
      rowText: {
        flex: '1',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        paddingRight: '48px',
      },
      rowTitle: { fontSize: '14px', fontWeight: 400, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
      rowHint: { fontSize: '12px', fontWeight: 400, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      rowControls: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', flex: 'none' },

      // The host's selector pill: a filled module surface, no outline.
      selector: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '12px',
        height: '36px',
        padding: '0 14px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '14px',
        lineHeight: '22px',
        cursor: 'pointer',
      },
      selectorCompact: {
        height: '28px',
        padding: '0 10px',
        gap: '8px',
        borderRadius: 'var(--dsw-radius-sm)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      menuRoot: { position: 'relative', display: 'inline-flex' },
      menuList: {
        position: 'absolute',
        top: 'calc(100% + 4px)',
        right: 0,
        zIndex: 100,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 'min(144px, calc(100vw - 24px))',
        maxWidth: 'min(360px, calc(100vw - 24px))',
        padding: '4px',
        border: 0,
        borderRadius: 'var(--dsw-radius-lg)',
        maxHeight: '280px',
        overflowY: 'auto',
        background: 'var(--dsw-menu-surface-fill)',
        backdropFilter: 'var(--dsw-menu-backdrop-filter)',
        boxShadow: 'var(--dsw-elevation-prominent)',
      },
      menuItem: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        width: '100%',
        minHeight: '34px',
        padding: '6px 8px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        textAlign: 'left',
        cursor: 'pointer',
      },
      menuItemLabel: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      menuIcon: { display: 'inline-flex', flex: 'none', width: '14px', height: '14px' },

      // Tables: a header rule and one hairline per row, the host's page type.
      tableWrap: { width: '100%', overflowX: 'auto' },
      table: { width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' },
      th: {
        padding: '6px 8px 6px 0',
        textAlign: 'left',
        fontSize: '12px',
        lineHeight: '18px',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-secondary)',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        whiteSpace: 'nowrap',
      },
      td: {
        padding: '8px 8px 8px 0',
        fontSize: '13px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary)',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        verticalAlign: 'top',
        whiteSpace: 'nowrap',
      },
      tdWide: { whiteSpace: 'normal', overflowWrap: 'anywhere' },
      tdNumeric: { textAlign: 'right' },
      empty: {
        margin: 0,
        padding: '24px 0',
        textAlign: 'center',
        fontSize: '13px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-tertiary)',
      },

      // Quota bars: a channel and the two shares inside it.
      quotaList: { display: 'flex', flexDirection: 'column', gap: '14px' },
      quotaRow: { display: 'flex', flexDirection: 'column', gap: '5px' },
      quotaHead: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '12px',
        flexWrap: 'wrap',
      },
      quotaName: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '20px' },
      quotaFigures: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' },
      quotaSeparator: { margin: '0 6px' },
      quotaTrack: {
        display: 'flex',
        width: '100%',
        height: '8px',
        boxSizing: 'border-box',
        borderRadius: '4px',
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-3)',
      },
      quotaSegment: { display: 'block', height: '100%', flex: 'none' },
      quotaSpent: { background: QUOTA_SPENT },
      quotaRemaining: { background: QUOTA_LEFT },
      quotaReset: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
      quotaLegend: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '12px',
        lineHeight: '18px',
        margin: '2px 0 0',
      },
      legendSwatch: {
        display: 'inline-block',
        width: '10px',
        height: '10px',
        borderRadius: '2px',
        marginRight: '5px',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      good: { color: 'var(--dsw-alias-state-success-primary)' },

      // Section-heading seats shared by the usage block: the settings page
      // renders the same quota and counters the panel does, so the heading row
      // is part of the vocabulary rather than a panel-only shape.
      panelSectionHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        flexWrap: 'wrap',
      },
      sectionTitle: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 500 },
      sectionCount: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
    }

    /**
     * The usage panel's frame, on the main-slot page geometry (a 960px column,
     * 20px page title, 28px top inset). The sections inside it are the same
     * native vocabulary the settings page uses.
     */
    const panelStyles = {
      ...native,
      panel: {
        boxSizing: 'border-box',
        width: '100%',
        height: '100%',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '32px',
        padding: '0 clamp(24px, 4vw, 48px) 48px',
      },
      panelHead: {
        position: 'sticky',
        top: 0,
        zIndex: 2,
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: '960px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        gap: '16px',
        flexWrap: 'wrap',
        paddingTop: '28px',
        paddingBottom: '12px',
        marginBottom: '-12px',
        background: 'var(--dsw-alias-bg-base)',
      },
      panelHeading: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      panelTitle: { margin: 0, fontSize: '20px', fontWeight: 500, lineHeight: '28px' },
      panelIntro: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
      panelHeadActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      panelCloseButton: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '28px',
        height: '28px',
        padding: 0,
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      panelSection: {
        width: '100%',
        maxWidth: '960px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      },
      panelSectionHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        flexWrap: 'wrap',
      },
      sectionTitle: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 500 },
      sectionCount: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
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

    /** Field-level copy that a hint line speaks: where the key comes from. */
    function credentialSourceText(t, credential, environment, route) {
      if (credential === null || credential === undefined) return t('keyNoStore')
      const source = credential.source ?? (environment?.present === true ? 'process' : undefined)
      const configured = credential.configured === true || environment?.present === true
      if (!configured) return undefined
      const variable = String(environment?.variable ?? credential.reference ?? route?.apiKeyEnv ?? '')
      if (source === 'process' || source === 'env') return t('keySourceEnvironment', { variable })
      if (source === 'project-env') return t('keySourceProjectEnv', { path: String(environment?.path ?? t('keyBlockedEnvFileUnknown')) })
      if (source === 'user-env') return t('keySourceUserEnv', { path: String(environment?.path ?? t('keyBlockedEnvFileUnknown')) })
      if (source === 'store') return t('keySourceStore')
      return undefined
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

    /** Hover fills, the stylesheet's `@media (hover: hover)` rules without a stylesheet. */
    const hoverPlain = { background: 'var(--dsw-alias-interactive-bg-hover)' }
    const hoverPrimary = { background: 'var(--dsw-alias-button-primary-hover)' }
    const hoverDanger = { background: 'var(--dsw-alias-interactive-bg-hover-danger)' }

    /**
     * A button that answers the pointer the way the host's stylesheet does.
     *
     * Inline styles cannot express `:hover`, so the handlers paint the state
     * onto the node itself — no component state, and therefore no hook of its
     * own, which is what keeps a conditionally rendered action from disturbing
     * the hook order of the tree around it.
     */
    const hoverable = (style, hoverStyle) => (props, ...children) => h('button', {
      type: 'button',
      ...props,
      style,
      onPointerEnter: (event) => {
        const node = event?.currentTarget
        if (node === null || node === undefined || node.style === undefined) return
        node.dataset = node.dataset ?? {}
        node.dataset.opencodeGoBackground = node.style.background
        node.style.background = hoverStyle.background
      },
      onPointerLeave: (event) => {
        const node = event?.currentTarget
        if (node === null || node === undefined || node.style === undefined) return
        node.style.background = node.dataset?.opencodeGoBackground ?? ''
      },
    }, ...children)

    const plainAction = hoverable(native.button, hoverPlain)
    const primaryAction = hoverable(native.primaryButton, hoverPrimary)
    const smallAction = hoverable(native.smallButton, hoverPlain)
    const dangerAction = hoverable(native.dangerButton, hoverDanger)
    const closeAction = hoverable(panelStyles.panelCloseButton, hoverPlain)

    /** One tag, in one of the host's tones. */
    const tag = (tone, label) => h('span', { style: { ...native.tag, ...(tone === undefined ? null : native[tone]) } }, label)

    /** The sentence under a group's fields: success, failure, or a plain note. */
    function NoticeLine({ notice }) {
      if (notice === null || notice === undefined) return null
      const style = notice.kind === 'error' ? native.error : notice.kind === 'warn' ? native.notice : native.success
      return h('p', { role: 'status', style }, notice.text)
    }

    /** The host's switch, as a button that carries its own checked state. */
    function Switch({ checked, disabled = false, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        disabled,
        style: {
          ...native.switch,
          ...(checked ? native.switchOn : null),
          ...(disabled ? native.disabled : null),
        },
        onClick: () => onChange(!checked),
      },
      h('span', {
        style: {
          ...native.switchThumb,
          ...(checked ? native.switchThumbOn : native.switchThumbOff),
        },
        'aria-hidden': 'true',
      }))
    }

    /** One labelled row of read-only facts. */
    function Fact({ label, children }) {
      return h('div', { style: native.factRow },
        h('dt', { style: native.factLabel }, label),
        h('dd', { style: native.factValue }, children))
    }

    /** The one-line summary the Plugins page renders when a description is absent. */
    function Summary({ t }) {
      return h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('summary'))
    }

    /** The read-only connection facts. */
    function ConnectionSection({ t, state }) {
      return h('section', { style: native.group },
        h('h3', { style: native.groupTitle }, t('sectionConnection')),
        h('dl', { style: native.facts },
          h(Fact, { label: t('fieldProvider') }, state.route.provider),
          h(Fact, { label: t('fieldBaseURL') }, state.route.baseURL),
          h(Fact, { label: t('fieldApiKeyEnv') }, state.route.apiKeyEnv)))
    }

    /**
     * The API-key editor: the stored key's state, the write-only key field, and
     * the credential reference the route reads the key through.
     *
     * The key is the one thing on this page that is saved by a press rather than
     * by leaving its field: storing a secret silently is not a thing a settings
     * page should do. The reference is an ordinary config field, so it saves
     * when the field loses focus — the way the host's own preference rows apply.
     */
    function CredentialSection({ t, state, onChanged }) {
      const [draft, setDraft] = useState('')
      const [reference, setReference] = useState(null)
      const [busy, setBusy] = useState(false)
      const [keyNotice, setKeyNotice] = useState(null)
      const [referenceNotice, setReferenceNotice] = useState(null)
      const credential = state.credential
      const environment = state.environment
      const configured = credential?.configured === true || environment?.present === true
      const writable = credential === null || credential === undefined ? false : credential.writable === true
      const removable = credential?.removable === true
      const blockedBy = credential?.blockedBy ?? null
      const editable = state.config?.editable === true
      const currentReference = String(state.route?.apiKeyEnv ?? '')
      const sourceHint = credentialSourceText(t, credential, environment, state.route)

      const failureText = (result) => {
        if (result.status === 401) return t('errUnauthorized')
        if (result.status === 403) return t('errForbidden')
        if (result.payload?.message !== undefined) return String(result.payload.message)
        return t('errHttp', { status: String(result.status) })
      }

      const saveKey = async () => {
        if (draft.trim() === '') {
          setKeyNotice({ kind: 'error', text: t('keyRequired') })
          return
        }
        setBusy(true)
        setKeyNotice(null)
        try {
          const result = await call(ROUTES.credential, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: draft }),
          })
          if (result.ok && result.payload?.ok === true) {
            setDraft('')
            setKeyNotice({ kind: 'success', text: t('saved') })
            onChanged()
          } else {
            setKeyNotice({ kind: 'error', text: failureText(result) })
          }
        } catch (error) {
          setKeyNotice({ kind: 'error', text: t('errHttp', { status: String(error?.message ?? 'network') }) })
        } finally {
          setBusy(false)
        }
      }

      const clearKey = async () => {
        setBusy(true)
        setKeyNotice(null)
        try {
          const result = await call(ROUTES.credential, { method: 'DELETE' })
          if (result.ok && result.payload?.ok === true) {
            setKeyNotice({ kind: 'success', text: t('keyCleared') })
            onChanged()
          } else {
            setKeyNotice({ kind: 'error', text: failureText(result) })
          }
        } catch (error) {
          setKeyNotice({ kind: 'error', text: t('errHttp', { status: String(error?.message ?? 'network') }) })
        } finally {
          setBusy(false)
        }
      }

      /** Write a reference the reader changed; a blank field keeps what is set. */
      const saveReference = async () => {
        const value = (reference ?? '').trim()
        if (reference === null || value === currentReference) return
        if (value === '') {
          setReference(null)
          setReferenceNotice({ kind: 'error', text: t('referenceRequired') })
          return
        }
        setBusy(true)
        setReferenceNotice(null)
        try {
          const result = await call(ROUTES.config, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set: { apiKeyEnv: value } }),
          })
          if (result.ok && result.payload?.ok === true) {
            setReference(null)
            setReferenceNotice({ kind: 'success', text: t('saved') })
            onChanged()
          } else {
            setReferenceNotice({ kind: 'error', text: failureText(result) })
          }
        } catch (error) {
          setReferenceNotice({ kind: 'error', text: t('errHttp', { status: String(error?.message ?? 'network') }) })
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
      return h('section', { style: native.group },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('h3', { style: native.groupTitle }, t('sectionKey')),
          configured ? tag('tagSuccess', t('keyConfigured')) : tag('tagQuiet', t('keyMissing'))),
        h('div', { style: native.card },
          writable ? null : h('p', { style: native.hint }, t('keyReadonly')),
          h('div', { style: native.field },
            h('input', {
              id: 'opencode-go-api-key',
              type: 'password',
              'aria-label': t('sectionKey'),
              autoComplete: 'new-password',
              spellCheck: false,
              placeholder: t('keyPlaceholder'),
              value: draft,
              disabled: busy || !writable,
              onChange: (event) => setDraft(event.target.value),
              style: { ...native.input, ...(writable ? null : native.inputDisabled) },
            }),
            sourceHint === undefined ? null : h('p', { style: native.hint }, sourceHint),
            blocked === null
              ? null
              : h('div', null,
                h('p', { style: native.notice }, blocked),
                h('p', { style: native.hint }, t('keyBlockedAdvice'))),
            h('div', { style: native.footer },
              h(NoticeLine, { notice: keyNotice }),
              removable ? dangerAction({ disabled: busy, onClick: clearKey }, t('keyClear')) : null,
              primaryAction({
                disabled: busy || !writable || draft.trim() === '',
                onClick: saveKey,
              }, busy ? t('saving') : t('save')))),
          h('div', { style: { ...native.field, borderTop: '0.5px solid var(--dsw-alias-border-l2)', paddingTop: '12px' } },
            h('label', { htmlFor: 'opencode-go-api-key-env', style: native.fieldLabel }, t('fieldApiKeyEnv')),
            h('input', {
              id: 'opencode-go-api-key-env',
              type: 'text',
              'aria-label': t('fieldApiKeyEnv'),
              spellCheck: false,
              value: reference === null ? currentReference : reference,
              disabled: busy || !editable,
              placeholder: t('referencePlaceholder'),
              onChange: (event) => setReference(event.target.value),
              onBlur: saveReference,
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                void saveReference()
              },
              style: native.input,
            }),
            h('p', { style: native.hint }, t('referenceHint')),
            h(NoticeLine, { notice: referenceNotice }))))
    }

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
     * Models: which ones the picker lists, and the variants layered on them.
     *
     * The two are one group because they are one subject — what the model list
     * offers — and because they are written together: one save sends
     * `hiddenModels` and `modelVariants` in a single configuration change, which
     * the Loader applies as one row reload.
     */
    function ModelsSection({ t, snapshot, models, busy, onSave, onReload, onFetch, notice }) {
      const [hiddenDraft, setHiddenDraft] = useState(null)
      const [variantsDraft, setVariantsDraft] = useState(null)
      const [saved, setSaved] = useState({ hidden: null, variants: null })
      const [filter, setFilter] = useState('')
      const [saving, setSaving] = useState(false)
      const [saveNotice, setSaveNotice] = useState(null)
      const [form, setForm] = useState({ model: '', name: '', label: '', protocol: '', effort: '' })
      const [problem, setProblem] = useState(null)
      const [expanded, setExpanded] = useState(() => new Set())
      const nextUid = useRef(0)
      const savedRef = useRef(saved)
      savedRef.current = saved

      // A fresh snapshot is the new baseline: the row reloaded, so whatever was
      // saved is what the Host reports. A draft the reader is still editing is
      // left alone — an unrelated write elsewhere on the page also refreshes the
      // snapshot.
      useEffect(() => {
        const hidden = Array.isArray(snapshot?.hidden) ? [...snapshot.hidden].sort() : null
        const declared = Array.isArray(snapshot?.variants) ? snapshot.variants : null
        const variants = declared === null
          ? null
          : declared.map((entry) => ({ ...entry, uid: `v${String(nextUid.current++)}` }))
        const baseline = { hidden, variants }
        setSaved(baseline)
        setHiddenDraft((current) => (current === null || sameJson(current, savedRef.current.hidden) ? hidden : current))
        setVariantsDraft((current) => (current === null || sameJson(current, savedRef.current.variants) ? variants : current))
      }, [snapshot])

      const modelsById = useMemo(() => {
        const map = new Map()
        for (const model of models) map.set(model.id, model)
        return map
      }, [models])
      const hiddenSet = useMemo(() => new Set(hiddenDraft ?? []), [hiddenDraft])
      const savedHiddenSet = useMemo(() => new Set(saved.hidden ?? []), [saved.hidden])
      const hiddenChanges = hiddenDraft === null || saved.hidden === null
        ? 0
        : hiddenDraft.filter((id) => !savedHiddenSet.has(id)).length
          + saved.hidden.filter((id) => !hiddenSet.has(id)).length
      const variantChanges = variantsDraft === null || saved.variants === null
        ? 0
        : variantsDraft.reduce((total, entry, index) => (
          total + (sameJson(configVariant(entry), saved.variants[index] === undefined ? null : configVariant(saved.variants[index])) ? 0 : 1)
        ), 0) + Math.abs(variantsDraft.length - saved.variants.length)
      const dirty = hiddenChanges + variantChanges > 0
      const counts = snapshot?.counts ?? null
      const needle = filter.trim().toLowerCase()
      const visible = needle === ''
        ? models
        : models.filter((model) => model.id.toLowerCase().includes(needle)
          || String(model.name ?? '').toLowerCase().includes(needle))
      const baseModels = models.filter((model) => model.variant === undefined || model.variant === null)
      const missing = Array.isArray(snapshot?.variantsWithoutModel) ? snapshot.variantsWithoutModel : []

      const toggle = (id, listed) => {
        setHiddenDraft((current) => {
          const next = new Set(current ?? [])
          if (listed) next.delete(id)
          else next.add(id)
          return [...next].sort()
        })
        setSaveNotice(null)
      }
      const setAll = (listed) => {
        setHiddenDraft(listed ? [] : models.map((model) => model.id).sort())
        setSaveNotice(null)
      }
      const removeVariant = (index) => {
        const going = (variantsDraft ?? [])[index]
        setVariantsDraft((current) => current.filter((_entry, at) => at !== index))
        if (going?.uid !== undefined) {
          setExpanded((current) => {
            const next = new Set(current)
            next.delete(going.uid)
            return next
          })
        }
        setProblem(null)
        setSaveNotice(null)
      }
      const updateVariant = (index, field, value) => {
        setVariantsDraft((current) => current.map((entry, at) => {
          if (at !== index) return entry
          if (value === '' || value === null || value === undefined) {
            const { [field]: _dropped, ...rest } = entry
            return rest
          }
          return { ...entry, [field]: value }
        }))
        setSaveNotice(null)
      }
      const toggleRow = (uid) => {
        setExpanded((current) => {
          const next = new Set(current)
          if (!next.delete(uid)) next.add(uid)
          return next
        })
      }

      const nameProblem = (model, name) => {
        if (name.trim() === '') return t('variantsNeedName')
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name.trim())) return t('variantsBadName')
        if (variantsDraft !== null && variantsDraft.some((entry) => entry.model === model && entry.name === name.trim())) {
          return t('variantsDuplicate', { id: `${model}@${name.trim()}` })
        }
        return undefined
      }
      const defaultName = (effort, protocol) => {
        if (String(effort ?? '').trim() !== '') return String(effort).trim()
        if (String(protocol ?? '').trim() !== '') return String(protocol).trim()
        return t('variantsNameDefaultPlain')
      }
      const addVariant = () => {
        const model = form.model
        if (model === '') {
          setProblem({ kind: 'error', text: t('variantsNeedModel') })
          return
        }
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
        setVariantsDraft((current) => [...(current ?? []), entry])
        setExpanded((current) => new Set(current).add(entry.uid))
        setForm({ model: '', name: '', label: '', protocol: '', effort: '' })
        setProblem(null)
        setSaveNotice(null)
      }

      const selected = modelsById.get(form.model)
      const protocolOptions = [...new Set(models.flatMap((model) => model.protocols ?? []))]
      const effortOptions = selected?.reasoning === true ? selected.efforts ?? [] : []
      const nameDefault = defaultName(form.effort, form.protocol)
      const defaultVariantId = form.model === '' ? nameDefault : `${form.model}@${nameDefault}`
      const nameIssues = (variantsDraft ?? []).flatMap((entry, index) => {
        const name = String(entry.name ?? '')
        if (name.trim() === '') return [`#${String(index + 1)} ${t('variantsNeedName')}`]
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name.trim())) {
          return [`#${String(index + 1)} ${t('variantsBadName')}`]
        }
        const clashes = (variantsDraft ?? []).filter(
          (other, at) => at !== index && other.model === entry.model && other.name === name.trim(),
        )
        return clashes.length === 0
          ? []
          : [`#${String(index + 1)} ${t('variantsDuplicate', { id: `${entry.model}@${name.trim()}` })}`]
      })

      const save = async () => {
        setSaving(true)
        setSaveNotice(null)
        try {
          const result = await onSave({
            hiddenModels: [...(hiddenDraft ?? [])].sort(),
            modelVariants: (variantsDraft ?? []).map(configVariant),
          })
          if (result.ok === true) {
            setSaveNotice({ kind: result.stale === true ? 'warn' : 'success', text: result.stale === true ? t('modelsStale') : t('saved') })
          } else {
            setSaveNotice({ kind: 'error', text: t('saveFailed', { message: result.text }) })
          }
        } finally {
          setSaving(false)
        }
      }

      const sourceLabel = snapshot?.source === 'config' ? t('modelsSourceConfig') : t('modelsSourceDiscover')
      const fetched = timeLabel(snapshot?.fetchedAt)
      const metaParts = [
        counts === null || counts.hidden === 0 ? null : t('modelsHiddenCount', { count: String(counts.hidden) }),
        t('modelsCatalogSource', { source: sourceLabel }),
        fetched === undefined ? null : t('modelsAge', { time: fetched }),
      ].filter((part) => part !== null)

      const textField = (label, entry, index, field, options) => h('label', { style: native.field },
        h('span', { style: native.fieldLabel }, label),
        h('input', {
          type: 'text',
          spellCheck: false,
          value: entry[field] ?? '',
          placeholder: options?.placeholder ?? '',
          'aria-label': `${entry.model}@${entry.name} ${label}`,
          onChange: (event) => updateVariant(index, field, event.target.value),
          style: native.input,
        }))
      const numberField = (label, entry, index, field) => h('label', { style: native.field },
        h('span', { style: native.fieldLabel }, label),
        h('input', {
          type: 'number',
          min: '1',
          step: '1',
          value: entry[field] ?? '',
          placeholder: t('variantsPlaceholderInherit'),
          'aria-label': `${entry.model}@${entry.name} ${label}`,
          onChange: (event) => updateVariant(index, field, event.target.value === '' ? '' : Number(event.target.value)),
          style: native.input,
        }))
      const selectField = (label, entry, index, field, fallback, options) => h(SelectMenu, {
        id: `variant-${entry.uid}-${field}`,
        label,
        ariaLabel: `${entry.model}@${entry.name} ${label}`,
        layout: 'field',
        value: entry[field] ?? '',
        options: [{ value: '', label: fallback }, ...options.map((option) => ({ value: option, label: option }))],
        onChange: (next) => updateVariant(index, field, next),
        styles: native,
      })

      return h('section', { style: native.group },
        h('div', { style: native.groupHead },
          h('h3', { style: native.groupTitle }, t('sectionModels')),
          h('p', { style: native.groupIntro }, t('modelsIntro'))),
        h('div', { style: native.card },
          h('div', null,
            h('p', { style: native.rowTitle }, counts === null
              ? t('modelsEmptyCatalog')
              : t('modelsSummary', { listed: String(counts.listed), total: String(counts.total) })),
            h('p', { style: { ...native.meta, marginTop: '2px' } }, metaParts.join(' · '))),
          h('div', { style: native.toolbar },
            h('label', { htmlFor: 'opencode-go-model-filter', style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)' } }, t('modelsFilter')),
            h('input', {
              id: 'opencode-go-model-filter',
              type: 'search',
              placeholder: t('modelsFilter'),
              value: filter,
              onChange: (event) => setFilter(event.target.value),
              style: { ...native.input, flex: '1 1 220px', width: 'auto' },
            }),
            h('div', { style: native.toolbarEnd },
              smallAction({ disabled: hiddenDraft === null, onClick: () => setAll(true) }, t('modelsShowAll')),
              smallAction({ disabled: hiddenDraft === null, onClick: () => setAll(false) }, t('modelsHideAll')),
              plainAction({ disabled: busy, onClick: onFetch }, t('modelsFetch')),
              smallAction({ disabled: busy, onClick: onReload }, t('modelsReload')))),
          h('div', { style: { display: 'flex', flexDirection: 'column', maxHeight: '320px', overflowY: 'auto', overflowX: 'hidden', paddingRight: '4px' } },
            models.length === 0
              ? h('p', { style: native.empty }, t('modelsEmptyCatalog'))
              : visible.length === 0
                ? h('p', { style: native.empty }, t('modelsEmpty'))
                : visible.map((model) => {
                  const context = contextLabel(model.contextWindow)
                  const name = model.name === undefined || model.name === '' ? model.id : model.name
                  const details = [model.id, model.protocols.join(' · '), context].filter((part) => part !== undefined && part !== '').join(' · ')
                  return h('label', {
                    key: model.id,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '8px 0',
                      borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
                      cursor: hiddenDraft === null ? 'default' : 'pointer',
                      opacity: hiddenDraft === null ? 0.6 : 1,
                    },
                  },
                  h('input', {
                    type: 'checkbox',
                    checked: !hiddenSet.has(model.id),
                    style: { accentColor: 'var(--dsw-alias-brand-primary)' },
                    disabled: hiddenDraft === null,
                    'aria-label': `${model.id}: ${t('modelsListed')}`,
                    onChange: (event) => toggle(model.id, event.target.checked),
                  }),
                  h('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: '2px', flex: '1' } },
                    h('span', { style: { fontSize: '14px', lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' } }, name),
                    h('span', { style: native.meta }, details)),
                  model.reasoning ? tag('tagQuiet', t('modelsReasoning')) : null,
                  model.hidden && hiddenSet.has(model.id) ? tag('tagNeutral', t('modelsHiddenHere')) : null,
                  model.trainingGated ? tag('tagWarning', t('modelsGated')) : null)
                })),
          h('p', { style: native.hint }, t('modelsTrainingHint')),

          // — Variants: one model's second set of settings, under a name —
          h('div', { style: native.inset },
            h('div', null,
              h('h4', { style: { ...native.groupTitle, margin: 0 } }, t('sectionVariants')),
              h('p', { style: { ...native.hint, marginTop: '2px' } }, t('variantsIntro'))),
            missing.length === 0 ? null : h('p', { style: native.notice }, t('variantsWithoutModel', { models: missing.join(', ') })),
            h('p', { style: native.caption }, t('variantsListTitle', { count: String((variantsDraft ?? []).length) })),
            variantsDraft === null
              ? h('p', { style: native.hint }, t('loading'))
              : variantsDraft.length === 0
                ? h('p', { style: native.empty }, t('variantsEmpty'))
                : variantsDraft.map((entry, index) => {
                  const id = `${entry.model}@${entry.name}`
                  const open = expanded.has(entry.uid)
                  const variantModel = modelsById.get(entry.model)
                  return h('div', {
                    key: entry.uid,
                    style: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '10px', borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
                  },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                    h('span', { style: { fontSize: '14px', lineHeight: '22px', fontWeight: 500 } }, entry.label ?? `${entry.model} (${entry.name})`),
                    h('span', { style: native.meta }, id),
                    entry.protocol === undefined ? null : h('span', { style: native.meta }, entry.protocol),
                    h('span', { style: { display: 'flex', gap: '8px', marginLeft: 'auto' } },
                      smallAction({
                        'aria-expanded': open,
                        'aria-label': open ? t('variantsCollapseNamed', { id }) : t('variantsEditNamed', { id }),
                        onClick: () => toggleRow(entry.uid),
                      }, open ? t('variantsCollapse') : t('variantsEdit')),
                      smallAction({ 'aria-label': t('variantsRemoveNamed', { id }), onClick: () => removeVariant(index) }, t('variantsRemove')))),
                  open
                    ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                      h('div', { style: native.fields },
                        textField(t('variantsName'), entry, index, 'name', { placeholder: t('variantsNamePlaceholder') }),
                        textField(t('variantsLabel'), entry, index, 'label', { placeholder: t('variantsLabelPlaceholder') }),
                        selectField(t('variantsProtocol'), entry, index, 'protocol', t('variantsProtocolDefault'), protocolOptions),
                        variantModel?.reasoning === true
                          ? selectField(t('variantsEffort'), entry, index, 'effort', t('variantsEffortDefault'), variantModel.efforts ?? [])
                          : h('p', { style: native.hint }, t('variantsEffortRequiresReasoning', { model: entry.model })),
                        numberField(t('variantsContext'), entry, index, 'contextWindow'),
                        numberField(t('variantsMaxTokens'), entry, index, 'maxTokens')))
                    : null)
                }),

            // A list of one-line names with its own add row, so adding and
            // removing a name is the same gesture as reading one.
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '0.5px solid var(--dsw-alias-border-l2)', paddingTop: '12px' } },
              h('h4', { style: { ...native.groupTitle, margin: 0 } }, t('variantsAddTitle')),
              h('div', { style: native.fields },
                h(SelectMenu, {
                  id: 'variant-add-model',
                  label: t('variantsModel'),
                  layout: 'field',
                  value: form.model,
                  options: [
                    { value: '', label: t('variantsModelPlaceholder') },
                    ...baseModels.map((model) => ({ value: model.id, label: `${model.name} · ${model.id}` })),
                  ],
                  onChange: (next) => setForm({ ...form, model: next, effort: '' }),
                  styles: native,
                }),
                h('label', { style: native.field },
                  h('span', { style: native.fieldLabel }, t('variantsName')),
                  h('input', {
                    type: 'text',
                    value: form.name,
                    placeholder: nameDefault,
                    'aria-label': t('variantsName'),
                    onChange: (event) => setForm({ ...form, name: event.target.value }),
                    style: native.input,
                  })),
                h('label', { style: native.field },
                  h('span', { style: native.fieldLabel }, t('variantsLabel')),
                  h('input', {
                    type: 'text',
                    value: form.label,
                    placeholder: t('variantsLabelPlaceholder'),
                    'aria-label': t('variantsLabel'),
                    onChange: (event) => setForm({ ...form, label: event.target.value }),
                    style: native.input,
                  })),
                h(SelectMenu, {
                  id: 'variant-add-protocol',
                  label: t('variantsProtocol'),
                  layout: 'field',
                  value: form.protocol,
                  options: [
                    { value: '', label: t('variantsProtocolDefault') },
                    ...protocolOptions.map((protocol) => ({ value: protocol, label: protocol })),
                  ],
                  onChange: (next) => setForm({ ...form, protocol: next }),
                  styles: native,
                }),
                effortOptions.length === 0
                  ? null
                  : h(SelectMenu, {
                    id: 'variant-add-effort',
                    label: t('variantsEffort'),
                    layout: 'field',
                    value: form.effort,
                    options: [
                      { value: '', label: t('variantsEffortDefault') },
                      ...effortOptions.map((level) => ({ value: level, label: level })),
                    ],
                    onChange: (next) => setForm({ ...form, effort: next }),
                    styles: native,
                  })),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                plainAction({ disabled: variantsDraft === null, onClick: addVariant }, t('variantsAdd'))),
              form.model === ''
                ? h('p', { style: native.hint }, t('variantsNameDefaultHint', { id: t('variantsNameDefaultGeneric') }))
                : h('p', { style: native.hint }, t('variantsNameDefaultHint', { id: defaultVariantId })),
              h('p', { style: native.hint }, t('variantsNameRule')),
              problem === null && nameIssues.length === 0
                ? null
                : h('p', { role: 'status', style: native.error }, problem === null ? nameIssues.join(' · ') : problem.text))),

          h('div', { style: native.footer },
            h(NoticeLine, { notice: saveNotice === null ? notice : saveNotice }),
            primaryAction({
              disabled: !dirty || saving || busy || nameIssues.length > 0,
              onClick: save,
            }, saving ? t('saving') : t('save')))))
    }

    /** Whether two JSON-shaped values are the same draft. */
    function sameJson(left, right) {
      return JSON.stringify(left) === JSON.stringify(right)
    }


    /**
     * The quota schedule: how often the capsule checks the subscription's quota.
     *
     * An ordinary numeric setting, so it saves when its field loses focus (or on
     * Enter), the way the host's own settings rows apply. The pair is validated
     * here before the write: a floor above the ceiling describes a schedule with
     * no valid interval, and the resolution would silently lift the ceiling.
     */
    function ScheduleSection({ t, values, busy, onSave }) {
      const saved = useMemo(() => ({
        min: numberOrNull(values?.subscriptionMinIntervalSeconds),
        max: numberOrNull(values?.subscriptionMaxIntervalSeconds),
      }), [values])
      const [draft, setDraft] = useState(saved)
      const savedRef = useRef(saved)
      // A fresh read is the new baseline, but an unrelated reload must not
      // overwrite a field the reader is still typing in: adopt it only while
      // the draft still matches the baseline it was written against.
      useEffect(() => {
        const previous = savedRef.current
        savedRef.current = saved
        setDraft((current) => (sameJson(current, previous) ? saved : current))
      }, [saved])
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState(null)

      const ready = saved.min !== null && saved.max !== null
      const reported = values !== undefined && values !== null
      const complete = numberOrNull(draft.min) !== null && numberOrNull(draft.max) !== null
      const ordered = !complete || draft.min <= draft.max

      const commit = async () => {
        if (saving || !complete || !ordered || !ready) return
        if (draft.min === saved.min && draft.max === saved.max) return
        setSaving(true)
        setNotice(null)
        try {
          const result = await onSave({
            subscriptionMinIntervalSeconds: draft.min,
            subscriptionMaxIntervalSeconds: draft.max,
          })
          setNotice(result.ok === true
            ? (result.stale === true ? { kind: 'warn', text: t('scheduleStale') } : { kind: 'success', text: t('saved') })
            : { kind: 'error', text: t('saveFailed', { message: result.text }) })
          if (result.ok !== true) setDraft(saved)
        } finally {
          setSaving(false)
        }
      }

      const field = (key, label) => h('label', { style: native.field },
        h('span', { style: native.fieldLabel }, label),
        h('input', {
          type: 'number',
          min: '1',
          step: '1',
          value: draft[key] ?? '',
          'aria-label': label,
          disabled: busy || saving,
          onChange: (event) => {
            setDraft((current) => ({
              ...current,
              [key]: event.target.value === '' ? null : Number(event.target.value),
            }))
            setNotice(null)
          },
          onBlur: () => { void commit() },
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (typeof event.currentTarget?.blur === 'function') event.currentTarget.blur()
            else void commit()
          },
          style: {
            ...native.input,
            ...(complete && !ordered ? native.inputInvalid : null),
          },
        }))

      return h('section', { style: native.group },
        h('div', { style: native.groupHead },
          h('h3', { style: native.groupTitle }, t('sectionSchedule')),
          h('p', { style: native.groupIntro }, t('scheduleIntro'))),
        h('div', { style: native.card },
          ready
            ? h('p', { style: native.hint }, t('scheduleExample', { min: String(saved.min), max: String(saved.max) }))
            : h('p', { style: native.hint }, t(reported ? 'scheduleNotReported' : 'loading')),
          h('div', { style: native.fields },
            field('min', t('scheduleMin')),
            field('max', t('scheduleMax'))),
          ordered ? null : h('p', { style: native.error }, t('schedulePairOrder')),
          saving ? h('p', { style: native.hint, role: 'status' }, t('saving')) : h(NoticeLine, { notice })))
    }

    /**
     * Transport and retry settings: how one request travels, and how long the
     * route is willing to wait for it.
     *
     * These are ordinary settings applied on the spot: the switch commits when
     * it is toggled, and each number commits when its field loses focus or
     * Enter is pressed. The two deadlines are typed in seconds and written in
     * milliseconds — the resolution's unit — so the reader works in the unit
     * they think in without the config moving to it.
     */
    function TransportSection({ t, values, busy, onSave }) {
      const saved = useMemo(() => ({
        freshConnectionOnLargeBody: values?.freshConnectionOnLargeBody === true,
        timeoutSeconds: secondsOrNull(values?.timeoutMs),
        streamIdleSeconds: secondsOrNull(values?.streamIdleTimeoutMs),
        maxRetries: numberOrNull(values?.retryPolicy?.maxRetries),
        initialDelayMs: numberOrNull(values?.retryPolicy?.initialDelayMs),
        maxDelayMs: numberOrNull(values?.retryPolicy?.maxDelayMs),
      }), [values])
      const [draft, setDraft] = useState(saved)
      const savedRef = useRef(saved)
      // A fresh read is the new baseline, but an unrelated reload must not
      // overwrite a field the reader is still typing in: adopt it only while
      // the draft still matches the baseline it was written against.
      useEffect(() => {
        const previous = savedRef.current
        savedRef.current = saved
        setDraft((current) => (sameJson(current, previous) ? saved : current))
      }, [saved])
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState(null)

      const reported = values !== undefined && values !== null
      const ready = saved.timeoutSeconds !== null && saved.streamIdleSeconds !== null
        && saved.maxRetries !== null && saved.initialDelayMs !== null && saved.maxDelayMs !== null
      const complete = numberOrNull(draft.timeoutSeconds) !== null
        && numberOrNull(draft.streamIdleSeconds) !== null
        && numberOrNull(draft.maxRetries) !== null
        && numberOrNull(draft.initialDelayMs) !== null
        && numberOrNull(draft.maxDelayMs) !== null
      const ordered = !complete || draft.initialDelayMs <= draft.maxDelayMs

      const commit = async (next = draft) => {
        if (saving || !ready || !complete || !ordered) return
        if (sameJson(next, saved)) return
        setSaving(true)
        setNotice(null)
        try {
          const result = await onSave({
            freshConnectionOnLargeBody: next.freshConnectionOnLargeBody,
            timeoutMs: Number(next.timeoutSeconds) * 1000,
            streamIdleTimeoutMs: Number(next.streamIdleSeconds) * 1000,
            retryPolicy: {
              ...(values?.retryPolicy ?? {}),
              maxRetries: Number(next.maxRetries),
              initialDelayMs: Number(next.initialDelayMs),
              maxDelayMs: Number(next.maxDelayMs),
            },
          })
          setNotice(result.ok === true
            ? (result.stale === true ? { kind: 'warn', text: t('transportStale') } : { kind: 'success', text: t('saved') })
            : { kind: 'error', text: t('saveFailed', { message: result.text }) })
          if (result.ok !== true) setDraft(saved)
        } finally {
          setSaving(false)
        }
      }

      const field = (key, label, options = {}) => h('label', { style: native.field },
        h('span', { style: native.fieldLabel }, label),
        h('input', {
          type: 'number',
          min: options.min ?? '1',
          step: '1',
          value: draft[key] ?? '',
          'aria-label': label,
          disabled: busy || saving,
          onChange: (event) => {
            setDraft((current) => ({
              ...current,
              [key]: event.target.value === '' ? null : Number(event.target.value),
            }))
            setNotice(null)
          },
          onBlur: () => { void commit(draft) },
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (typeof event.currentTarget?.blur === 'function') event.currentTarget.blur()
            else void commit(draft)
          },
          style: {
            ...native.input,
            ...(complete && !ordered ? native.inputInvalid : null),
          },
        }))

      return h('section', { style: native.group },
        h('div', { style: native.groupHead },
          h('h3', { style: native.groupTitle }, t('sectionTransport')),
          h('p', { style: native.groupIntro }, t('transportIntro'))),
        h('div', { style: native.card },
          ready
            ? null
            : h('p', { style: native.hint }, t(reported ? 'transportNotReported' : 'loading')),
          h('div', { style: native.row },
            h('div', { style: { ...native.rowText, paddingRight: 0 } },
              h('span', { style: native.rowTitle }, t('transportFreshConnection')),
              h('span', { style: native.rowHint }, t('transportFreshConnectionHint'))),
            h(Switch, {
              checked: draft.freshConnectionOnLargeBody,
              disabled: busy || saving || !ready,
              label: t('transportFreshConnection'),
              onChange: (checked) => {
                const next = { ...draft, freshConnectionOnLargeBody: checked }
                setDraft(next)
                setNotice(null)
                void commit(next)
              },
            })),
          h('div', { style: native.fields },
            field('timeoutSeconds', t('transportTimeout')),
            field('streamIdleSeconds', t('transportStreamIdle')),
            field('maxRetries', t('transportMaxRetries'), { min: '0' }),
            field('initialDelayMs', t('transportInitialDelay')),
            field('maxDelayMs', t('transportMaxDelay'))),
          ordered ? null : h('p', { style: native.error }, t('transportDelayOrder')),
          saving ? h('p', { style: native.hint, role: 'status' }, t('saving')) : h(NoticeLine, { notice })))
    }

    /**
     * One usage table: a header row, then rows of already-rendered cells.
     *
     * Three of these appear together and they differ only in their columns, so
     * the shape lives here rather than three times over. The host's page type is
     * the host's: a 12/18 secondary header over 13/20 figures, one hairline a
     * row, tabular figures so columns line up while numbers move.
     */
    function UsageTable({ id, headers, rows }) {
      return h('div', { style: panelStyles.tableWrap },
        h('table', { style: panelStyles.table },
          h('thead', null, h('tr', null, headers.map((header, index) => h('th', {
            key: `${id}-head-${String(index)}`,
            style: index === 0 ? panelStyles.th : { ...panelStyles.th, textAlign: 'right' },
          }, header)))),
          h('tbody', null, rows.map((row) => h('tr', { key: `${id}-${row.key}` },
            row.cells.map((cell, index) => h('td', {
              key: `${id}-${row.key}-${String(index)}`,
              style: index === 0 ? panelStyles.td : { ...panelStyles.td, ...panelStyles.tdNumeric },
            }, cell)))))))
    }

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
      const figure = used >= 100 ? panelStyles.error : used >= 80 ? { color: 'var(--dsw-alias-state-warn-primary)' } : undefined
      return h('div', { style: panelStyles.quotaRow },
        h('div', { style: panelStyles.quotaHead },
          h('span', { style: panelStyles.quotaName }, name),
          h('span', { style: panelStyles.quotaFigures },
            h('span', { style: figure }, t('subscriptionUsed', { percent: String(used) })),
            h('span', { style: panelStyles.quotaSeparator }, '·'),
            h('span', null, t('subscriptionLeft', { percent: String(left) })))),
        h('div', {
          style: panelStyles.quotaTrack,
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
        h('span', { style: { ...panelStyles.quotaSegment, ...panelStyles.quotaSpent, width: `${String(used)}%` } }),
        h('span', { style: { ...panelStyles.quotaSegment, ...panelStyles.quotaRemaining, width: `${String(left)}%` } })),
        h('span', { style: panelStyles.quotaReset },
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
    function SubscriptionPanel({ t, data, styles: surface = panelStyles }) {
      if (data === null || data === undefined) {
        return h('div', null, h('p', { style: surface.hint }, t('subscriptionLoading')))
      }
      if (data.ok !== true) {
        return h('div', null,
          h('p', { style: surface.hint }, t('subscriptionUnavailable', { reason: t(subscriptionReasonKey(data.reason)) })),
          data.message === undefined ? null : h('p', { style: surface.hint }, String(data.message)))
      }
      const windows = Array.isArray(data.windows) ? data.windows : []
      if (windows.length === 0) return h('div', null, h('p', { style: surface.hint }, t('subscriptionUnavailable', { reason: t(subscriptionReasonKey('unsupported')) })))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { style: surface.quotaList },
          windows.map((slot) => h(QuotaBar, { key: slot.name, t, slot }))),
        h('p', { style: surface.quotaLegend },
          h('span', { style: { ...surface.legendSwatch, background: QUOTA_SPENT } }),
          h('span', null, t('subscriptionLegendSpent')),
          h('span', { style: { ...surface.legendSwatch, background: QUOTA_LEFT, marginLeft: '12px' } }),
          h('span', null, t('subscriptionLegendLeft'))),
        data.cached === true && timeLabel(data.fetchedAt) !== undefined
          ? h('p', { style: surface.hint }, t('subscriptionCached', { time: timeLabel(data.fetchedAt) }))
          : null)
    }

    /**
     * The quota block's heading row: its own label, and the one control that
     * belongs to it.
     *
     * `Tag` is the heading element the surface can afford: `h3` where the block
     * is a section of a usage page, `h4` where it sits inside the settings
     * page's card.
     */
    function QuotaHead({ t, Tag = 'h3', busy, onRefresh, styles: surface = panelStyles }) {
      return h('div', { style: surface.panelSectionHead },
        h(Tag, { style: surface.sectionTitle }, t('panelQuotaSection')),
        smallAction({ disabled: busy, onClick: onRefresh }, t('subscriptionRefresh')))
    }

    /**
     * The subscription's quota, as one answer every surface on screen shares.
     *
     * Four surfaces draw this quota — the configuration page, the usage panel,
     * the settings tab, and the sidebar capsule — and they are four separate
     * React trees, so an answer held in component state is an answer each of them
     * reads for itself and tells nobody about. That is what a reader saw: press
     * *re-read quota* on the panel and the capsule went on showing the numbers it
     * had read when it mounted, two figures for one limit, differing by however
     * much the plan had moved. The answer therefore lives outside every
     * component, and every surface subscribes to it: one read publishes to all of
     * them, whether a reader asked for it or a surface did as it mounted.
     *
     * A store rather than a shared service, because this bundle has no build step
     * and may require nothing outside the platform module table: a snapshot, the
     * listeners, and the read in flight are the whole of it.
     *
     * ## When this store looks again
     *
     * The quota moves only when a call is made, so the schedule is driven by
     * whether one was — not by the clock. Two intervals bound it, both set on the
     * Host and both carried on every answer (`subscriptionMinIntervalSeconds`,
     * `subscriptionMaxIntervalSeconds`), and the timer runs only while a surface
     * is mounted, so a closed panel costs nothing:
     *
     *   - **the floor** — the shortest wait between two *checks*. A running
     *     session finishes a call every few seconds, and each of those is a reason
     *     to look; without a floor, a long turn would read the quota on every call
     *     it made.
     *   - **the ceiling** — the longest an answer may go unchecked. What the
     *     plugin cannot see is the plan being spent elsewhere — another machine,
     *     another session — so the answer is never trusted indefinitely, however
     *     quiet this route is.
     *
     * Between the two, the store wakes on the floor and asks the Host a question
     * that costs nothing: has anything been spent since this answer was read
     * (`GET /opencode-go/activity`, which reads the reader's memory and no more).
     * The quota itself is read only when that says yes — or when the answer is
     * already old enough to be worth distrusting on the ceiling's account. So a
     * running session pays one memory round trip per floor and one quota read per
     * floor at most, while a quiet one pays a memory round trip per floor and a
     * quota read per ceiling.
     *
     * The check has to be its own call rather than a property of the last answer.
     * Activity that arrives after a read cannot be seen in that read's answer,
     * and a schedule that could only learn by reading would have to read on every
     * floor to notice it — which would make the ceiling unreachable and the floor
     * a poll.
     *
     * @returns {{get: () => object, subscribe: (listener: Function) => Function, read: (force?: boolean) => Promise<object>, revive: Function, hold: Function}} the store.
     */
    function createSubscriptionStore() {
      /** The snapshot every surface renders, replaced rather than mutated. */
      let state = { data: null, busy: false }
      /** The read in flight, so a burst of mounts spends one request. */
      let inflight = undefined
      /** When the last check ran, which is what the floor measures. */
      let askedAt = 0
      /** The surface the running schedule is serving, and its timer. */
      let held = 0
      let timer = undefined
      const listeners = new Set()

      /** The floor and the ceiling, from the last answer that carried them. */
      const bounds = () => ({
        floor: (Number(state.data?.minIntervalSeconds) || SUBSCRIPTION_MIN_INTERVAL_SECONDS) * 1000,
        ceiling: (Number(state.data?.maxIntervalSeconds) || SUBSCRIPTION_MAX_INTERVAL_SECONDS) * 1000,
      })

      /** Whether the last read is one a reader can act on. */
      const known = () => state.data !== null && state.data.ok === true

      const publish = (patch) => {
        state = { ...state, ...patch }
        // Over a copy: a listener may unsubscribe itself while being told.
        for (const listener of [...listeners]) listener(state)
      }

      /**
       * The one request.
       *
       * A refusal is stored as the raw reason rather than as a sentence, because
       * the sentence depends on the reader's language: this does not depend on
       * `t`, so the wording is chosen where it is rendered.
       */
      const ask = async (force) => {
        let answer
        try {
          const result = await call(`${ROUTES.subscription}${force === true ? '?refresh=1' : ''}`)
          const payload = result.payload
          if (result.status === 401 || result.status === 403) answer = { ok: false, reason: 'unauthorized' }
          else if (payload !== null && payload !== undefined) answer = payload
          else answer = { ok: false, reason: 'failed', message: `HTTP ${String(result.status)}` }
        } catch (error) {
          answer = { ok: false, reason: 'unreachable', message: String(error?.message ?? 'network') }
        }
        publish({ data: answer, busy: false })
        schedule()
        return answer
      }

      /** Begin the one quota read. */
      const start = (force) => {
        askedAt = Date.now()
        publish({ busy: true })
        const request = ask(force).finally(() => {
          if (inflight === request) inflight = undefined
        })
        inflight = request
        return request
      }

      /** Forget the timer; something is about to arrange a new one. */
      const disarm = () => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
      }

      /**
       * One wake-up: check whether the answer has gone old, and read if it has.
       *
       * The check is what the floor paces — a memory round trip to a route on
       * this machine, which is why the floor can be 30 seconds rather than
       * minutes. The read is what the ceiling paces, plus whatever the check
       * turns up. A check that fails is treated as "there is a reason to look":
       * the page has lost its cheap way to find out, and the honest response is
       * to read rather than to assume the answer is still good.
       */
      const check = async () => {
        askedAt = Date.now()
        let activity = false
        try {
          const result = await call(ROUTES.activity)
          activity = result.ok && result.payload?.activity === true
        } catch {
          activity = true
        }
        const aging = Date.now() - lastReadAt() >= bounds().ceiling
        if (activity || aging || !known()) {
          await start(false)
          return
        }
        schedule()
      }

      /** When the answer on file was read, as the Host stamped it. */
      const lastReadAt = () => {
        const stamped = Number(state.data?.fetchedAt)
        return Number.isFinite(stamped) ? stamped : askedAt
      }

      /**
       * Arrange the next check, if there is a surface left to check for.
       *
       * Every wait is measured from the last *attempt*, not from the answer's own
       * timestamp: a quota read served from the Host's cache carries the original
       * stamp and would never get older, so timing from it would drive the
       * interval to zero and turn the schedule into a poll.
       *
       * @returns {void}
       */
      const schedule = () => {
        disarm()
        if (held <= 0 || state.data === null) return
        const waited = Date.now() - askedAt
        timer = setTimeout(() => {
          timer = undefined
          void check()
        }, Math.max(1_000, bounds().floor - waited))
      }

      return {
        /** The snapshot, for a surface that is about to render. */
        get: () => state,
        /** Follow the answer: a new snapshot object is what re-renders a surface. */
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /**
         * Read the quota, sharing one request with whoever asks at the same time.
         *
         * `force` is a reader pressing *re-read quota*, which asks the service
         * rather than the Host's cache. A forced read that arrives while a plain
         * one is out waits for it and then asks on its own: handing back the
         * answer already on its way would leave the button looking broken.
         */
        read(force) {
          if (inflight === undefined) return start(force)
          return force === true
            ? inflight.then(() => start(true), () => start(true))
            : inflight
        },
        /**
         * A surface has mounted: the schedule runs while any surface is showing.
         *
         * Counted rather than flagged, because the capsule and a panel can both be
         * up at once and the first of them to unmount must not stop the other's
         * clock.
         */
        revive() {
          held += 1
          schedule()
        },
        /** A surface has gone: stop the clock once the last of them has. */
        hold() {
          held = Math.max(0, held - 1)
          if (held === 0) disarm()
        },
      }
    }

    /** The quota this page holds, shared by every surface that draws it. */
    const subscription = createSubscriptionStore()

    /**
     * The subscription's quota, however many places on screen are showing it.
     *
     * Every surface that draws the quota goes through this one hook, so the error
     * mapping and the cache-forcing query parameter have exactly one
     * implementation, and one read reaches all of them.
     *
     * Mounting is also what arms the store's clock — see the schedule on
     * `createSubscriptionStore` — and the first read here is what gives it an
     * answer to schedule against.
     *
     * @returns {{data: object|null, busy: boolean, refresh: (force?: boolean) => Promise<object>}} the quota, whether a read is in flight, and how to read again.
     */
    function useSubscription() {
      const [state, setState] = useState(() => subscription.get())
      useEffect(() => {
        // The store can have moved between this render and this effect, so the
        // subscription catches up first. Handing back the snapshot it already
        // holds is a no-op, which is what keeps that from looping.
        setState(subscription.get())
        const release = subscription.subscribe(() => {
          setState(subscription.get())
        })
        subscription.revive()
        return () => {
          subscription.hold()
          release()
        }
      }, [])
      useEffect(() => {
        void subscription.read(false)
      }, [])
      return { data: state.data, busy: state.busy, refresh: subscription.read }
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

    /** The windows the Host serves, and the one a surface opens on. */
    const USAGE_WINDOWS = Object.freeze([1, 7, 30, 'all'])
    const USAGE_WINDOW_DEFAULT = 7

    /**
     * The counters this route has spent, as one answer per window.
     *
     * Three surfaces draw these tables — the configuration page's usage section,
     * the panel, and the settings tab — and they are three separate React trees,
     * so a table held in component state was a table each of them read for itself
     * and told nobody about: press *refresh usage* on one and the others kept the
     * numbers they had read when they mounted.
     *
     * What is shared here is the answer **for a window**: one read publishes to
     * every surface showing that window, and two surfaces asking for the same
     * window at the same moment spend one request. What is deliberately not
     * shared is **which window a surface shows** — a reader who opens 30 days on
     * the panel has asked a different question from the one the settings tab is
     * showing, and those two tables are different facts rather than two copies of
     * one. Each surface keeps its own window; the store is keyed by it.
     *
     * @returns {{get: Function, subscribe: Function, read: Function}} the store.
     */
    function createUsageStore() {
      /** window -> `{ table, failure, busy }`, replaced rather than mutated. */
      const entries = new Map()
      /** window -> the read in flight, so a burst of asks spends one request. */
      const inflight = new Map()
      const listeners = new Set()
      /** What a window nothing has been read for reports. */
      const UNREAD = Object.freeze({ table: null, failure: undefined, busy: false })
      /** The display preference is shared, and persisted through the Host. */
      let numberFormat = 'compact'
      let formatBusy = false
      let formatFailure
      let formatVersion = 0

      const notify = () => {
        // Over a copy: a listener may unsubscribe itself while being told.
        for (const listener of [...listeners]) listener()
      }
      const publish = (days, patch) => {
        entries.set(days, { ...(entries.get(days) ?? UNREAD), ...patch })
        notify()
      }

      /**
       * The one request for one window.
       *
       * A failure is stored as the raw outcome rather than as a sentence, because
       * the sentence depends on the reader's language: this does not depend on
       * `t`, so the wording is chosen where it is rendered.
       */
      const ask = async (days) => {
        const version = formatVersion
        let patch
        try {
          const result = await call(`${ROUTES.usage}?days=${String(days)}`)
          if (result.ok && result.payload?.ok === true) {
            if (version === formatVersion && ['compact', 'full'].includes(result.payload.numberFormat)) {
              numberFormat = result.payload.numberFormat
              formatFailure = undefined
            }
            patch = { table: result.payload, failure: undefined }
          } else patch = { table: null, failure: { status: result.status, message: result.payload?.message } }
        } catch (error) {
          // A bridge that cannot be reached is a failed read like any other: the
          // counters are a report, never the thing a page needs in order to
          // render. Held here rather than in each surface, this is also the one
          // place that keeps a dead fetch from becoming an unhandled rejection.
          patch = { table: null, failure: { status: 0, message: String(error?.message ?? 'network') } }
        }
        publish(days, { ...patch, busy: false })
      }

      return {
        /** One window's entry and the shared number format, for a surface about to render. */
        get: (days) => ({ ...(entries.get(days) ?? UNREAD), numberFormat, formatBusy, formatFailure }),
        /** Follow every window and the shared number format. */
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /** Read one window, sharing the request with whoever asks at once. */
        read(days) {
          const existing = inflight.get(days)
          if (existing !== undefined) return existing
          publish(days, { busy: true })
          const request = ask(days).finally(() => {
            if (inflight.get(days) === request) inflight.delete(days)
          })
          inflight.set(days, request)
          return request
        },
        /** Persist the shared display preference, rolling it back if the write fails. */
        async writeNumberFormat(format) {
          if (!['compact', 'full'].includes(format) || formatBusy) return
          if (format === numberFormat && formatFailure === undefined) return
          const previous = numberFormat
          const version = ++formatVersion
          numberFormat = format
          formatBusy = true
          formatFailure = undefined
          notify()
          let failure
          try {
            const result = await call(ROUTES.config, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ set: { usageNumberFormat: format } }),
            })
            if (!(result.ok && result.payload?.ok === true)) {
              failure = String(result.payload?.message ?? `HTTP ${String(result.status)}`)
            }
          } catch (error) {
            failure = String(error?.message ?? 'network')
          }
          if (version !== formatVersion) return
          formatBusy = false
          if (failure !== undefined) {
            numberFormat = previous
            formatFailure = { message: failure }
          }
          notify()
        },
      }
    }

    /** The counters this page holds, shared by every surface that draws one. */
    const usageStore = createUsageStore()

    /**
     * One surface's view of the counters.
     *
     * The window is this hook's own state, so each surface opens on the default
     * and changes only its own; the table for a window comes from the shared
     * store, so a read in one surface reaches every other surface showing that
     * window. The two travel in one state object rather than two, which is what
     * keeps a table from ever being drawn under a window button it was not read
     * for: a switch replaces both at once.
     *
     * @returns {{days: number | 'all', table: object|null, failure: object|undefined, busy: boolean, compact: boolean, formatBusy: boolean, formatFailure: object|undefined, choose: Function, chooseNumberFormat: Function, refresh: Function}} the surface's window, its table, and its display controls.
     */
    function useUsageTable() {
      const [state, setState] = useState(() => ({ days: USAGE_WINDOW_DEFAULT, entry: usageStore.get(USAGE_WINDOW_DEFAULT) }))
      useEffect(() => {
        // The store can have moved between this render and this effect, so the
        // subscription catches up first — read against the window this surface is
        // on at that moment, not the one it was on when the effect was created.
        const sync = () => setState((previous) => ({ days: previous.days, entry: usageStore.get(previous.days) }))
        sync()
        return usageStore.subscribe(sync)
      }, [])
      useEffect(() => {
        void usageStore.read(state.days)
      }, [state.days])
      return {
        days: state.days,
        table: state.entry.table,
        failure: state.entry.failure,
        busy: state.entry.busy === true,
        compact: state.entry.numberFormat === 'compact',
        formatBusy: state.entry.formatBusy === true,
        formatFailure: state.entry.formatFailure,
        chooseNumberFormat: (compact) => usageStore.writeNumberFormat(compact ? 'compact' : 'full'),
        choose: (days) => {
          setState({ days, entry: usageStore.get(days) })
          // Asked for outright, rather than left to the effect below: pressing
          // the window already showing is how a reader re-reads it, and the
          // window they are on is by definition not a dependency change.
          void usageStore.read(days)
        },
        refresh: () => usageStore.read(state.days),
      }
    }

    /**
     * A number a field holds, or `null` for one it cannot.
     *
     * `Number('')` is 0 and `Number('abc')` is NaN — so an empty box has to be
     * told apart from a zero the reader meant, and neither may reach the write
     * as a schedule interval.
     */
    function numberOrNull(value) {
      if (value === null || value === undefined || value === '') return null
      const parsed = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(parsed) ? parsed : null
    }

    /**
     * A millisecond setting as the whole seconds a reader types.
     *
     * The resolution stores these deadlines in milliseconds; the page shows
     * seconds because that is the unit the numbers are discussed in. Rounding
     * rather than truncating keeps 90 000 ms reading as 90 s, not 89.
     */
    function secondsOrNull(value) {
      const milliseconds = numberOrNull(value)
      if (milliseconds === null || milliseconds <= 0) return null
      return Math.round(milliseconds / 1000)
    }

    /** The dictionary key naming one counters window. */
    function usageWindowKey(value) {
      if (value === 1) return 'usageWindowDay'
      if (value === 7) return 'usageWindow7'
      if (value === 'all') return 'usageWindowAll'
      return 'usageWindow30'
    }

    /** The sentence one failed counters read gets, in the reader's language. */
    function usageFailureText(t, failure) {
      return failure.status === 503
        ? t('usageUnavailable')
        : t('usageFailed', { message: failure.message ?? t('errHttp', { status: String(failure.status) }) })
    }

    /** Decimal token suffixes, independent of the interface's language. */
    const compactTokens = new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 2,
    })

    /** A token count as its full value or a K/M/B/T shorthand. */
    function tokenNumber(value, compact) {
      const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0
      const exact = String(amount)
      if (!compact) return exact
      return h('span', { title: exact, 'aria-label': exact }, compactTokens.format(amount))
    }

    /** The down chevron on a DSH-style menu trigger. */
    function ChevronDownMark() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', focusable: 'false', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3 5.5 7 9.5 11 5.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))
    }

    /** The trailing check on the selected menu row. */
    function CheckMark() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', focusable: 'false', 'aria-hidden': 'true' },
        h('path', {
          d: 'm2.5 7.5 3 3 6-7',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))
    }

    /** One menu row, with the same hover/focus fill and trailing check as DSH. */
    function UsageMenuOption({ option, selected, onSelect, styles: surface = panelStyles }) {
      const [active, setActive] = useState(false)
      return h('button', {
        type: 'button',
        role: 'menuitem',
        value: String(option.value),
        'aria-current': selected ? 'true' : undefined,
        onClick: () => onSelect(option.value),
        onPointerEnter: () => setActive(true),
        onPointerLeave: () => setActive(false),
        onFocus: () => setActive(true),
        onBlur: () => setActive(false),
        style: {
          ...surface.menuItem,
          ...(active ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : {}),
        },
      },
      h('span', { style: surface.menuItemLabel }, option.label),
      selected ? h('span', { style: surface.menuIcon, 'aria-hidden': 'true' }, h(CheckMark)) : null)
    }

    /**
     * A DSH-style selector, without a runtime UI dependency.
     *
     * One implementation for every dropdown on the plugin's surfaces — the usage
     * range and the variants editor's model, protocol, and reasoning pickers
     * included — so the trigger, the menu surface, and the keyboard behaviour
     * cannot drift between two lists a reader sees side by side.
     *
     * Three layouts cover the three seats: `field` is a settings field (label
     * above, the trigger sharing the text field's box), `inline` puts the label
     * and the pill on one line, and the default `row` is the host's preference
     * row (label over explanation, control at the end).
     */
    function SelectMenu({ id, label, ariaLabel = label, hint, options, value, onChange, disabled = false, action, layout = 'row', styles: surface = panelStyles }) {
      const [open, setOpen] = useState(false)
      const [hover, setHover] = useState(false)
      const root = useRef(null)
      const trigger = useRef(null)
      const menuId = `${id}-menu`
      const selected = options.find((option) => option.value === value) ?? options[0]
      const field = layout === 'field'
      const inline = layout === 'inline'

      useEffect(() => {
        if (disabled) setOpen(false)
      }, [disabled])
      useEffect(() => {
        if (!open || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const pointer = (event) => {
          if (root.current?.contains?.(event.target) !== true) setOpen(false)
        }
        const keyboard = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
            trigger.current?.focus?.()
            return
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          const rows = Array.from(root.current?.querySelectorAll?.('button[role="menuitem"]') ?? [])
          if (rows.length === 0) return
          const current = rows.indexOf(document.activeElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
            : current < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
          event.preventDefault()
          rows[next]?.focus?.()
        }
        document.addEventListener('pointerdown', pointer)
        document.addEventListener('keydown', keyboard)
        return () => {
          document.removeEventListener('pointerdown', pointer)
          document.removeEventListener('keydown', keyboard)
        }
      }, [open])

      const choose = (next) => {
        onChange(next)
        setOpen(false)
        trigger.current?.focus?.()
      }

      const triggerStyle = field
        ? {
          ...surface.select,
          ...(hover && !disabled ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : {}),
          ...(disabled ? surface.disabled : null),
        }
        : {
          ...surface.selector,
          ...(inline ? surface.selectorCompact : null),
          ...(hover && !disabled ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : {}),
          ...(disabled ? surface.disabled : null),
        }

      const control = h('div', {
        ref: root,
        style: { ...surface.menuRoot, ...(field ? { width: '100%' } : null) },
      },
      h('button', {
        id,
        ref: trigger,
        type: 'button',
        value: String(value),
        disabled,
        'aria-label': ariaLabel,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
        onClick: () => setOpen((current) => !current),
        onKeyDown: (event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        },
        onPointerEnter: () => setHover(true),
        onPointerLeave: () => setHover(false),
        style: triggerStyle,
      },
      h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, selected?.label ?? ''),
      h('span', { style: surface.menuIcon, 'aria-hidden': 'true' }, h(ChevronDownMark))),
      open
        ? h('div', {
          id: menuId,
          role: 'menu',
          'aria-label': ariaLabel,
          style: {
            ...surface.menuList,
            ...(field ? { left: 0, right: 'auto', minWidth: '100%' } : null),
          },
        },
        options.map((option) => h(UsageMenuOption, {
          key: String(option.value),
          option,
          selected: option.value === value,
          onSelect: choose,
          styles: surface,
        })))
        : null)

      if (field) {
        return h('div', { style: surface.field },
          h('div', { style: surface.fieldHead },
            h('label', { htmlFor: id, style: surface.fieldLabel }, label)),
          control,
          hint === undefined ? null : h('p', { style: surface.hint }, hint))
      }
      if (inline) {
        return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' } }, label),
          control,
          action ?? null)
      }
      return h('div', { style: surface.row },
        h('div', { style: surface.rowText },
          h('label', { htmlFor: id, style: surface.rowTitle }, label),
          h('span', { style: surface.rowHint }, hint)),
        h('div', { style: surface.rowControls },
          control,
          action ?? null))
    }

    /**
     * The three counter tables, or the sentence that stands in for them.
     *
     * One implementation, because both frames draw the same nine columns in the
     * same order — and two copies of this had already drifted: the panel coloured
     * every non-zero hit rate green while the page reserved that for a rate of
     * half or better, so the same figure was a judgement in one place and a fact
     * in the other. The stricter reading is the one that survived.
     *
     * @param {object} input - the table, and the id prefix its keys are built on.
     */
    function CounterTables({ t, id, table, compact, formatBusy, formatFailure, onNumberFormat, styles: surface = panelStyles }) {
      const counters = table.totals ?? {}
      const number = (value) => (typeof value === 'number' ? String(value) : '0')
      const [dayPage, setDayPage] = useState(1)
      const [dayPageSize, setDayPageSize] = useState(10)
      const history = [...(table.historyDays ?? table.days ?? [])].reverse()
      const pageCount = Math.max(1, Math.ceil(history.length / dayPageSize))
      const currentPage = Math.min(dayPage, pageCount)
      const pageStart = (currentPage - 1) * dayPageSize
      const pageDays = history.slice(pageStart, pageStart + dayPageSize)
      useEffect(() => setDayPage(1), [table.window])
      useEffect(() => {
        if (dayPage > pageCount) setDayPage(pageCount)
      }, [dayPage, pageCount])

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
      const hitRate = (row) => {
        const read = row.cacheReadTokens ?? 0
        const prompt = (row.inputTokens ?? 0) + read
        if ((row.cacheReported ?? 0) === 0 || prompt === 0) return null
        return Math.round((read / prompt) * 100)
      }
      const hitCell = (row) => {
        const rate = hitRate(row)
        if (rate === null) return t('usageCacheUnknown')
        return h('span', { style: rate >= 50 ? surface.good : undefined }, `${String(rate)}%`)
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
      const counterCells = (row) => [
        number(row.requests),
        number(row.failures),
        tokenNumber(row.inputTokens, compact),
        tokenNumber(row.outputTokens, compact),
        tokenNumber(row.cacheReadTokens, compact),
        tokenNumber(row.cacheWriteTokens, compact),
        hitCell(row),
        tokenNumber(row.totalTokens, compact),
      ]

      const numberControls = h(SelectMenu, {
        id: `${id}-number-format`,
        label: t('usageNumberFormat'),
        hint: t('usageNumberFormatHint'),
        value: compact,
        onChange: onNumberFormat,
        disabled: formatBusy,
        layout: 'inline',
        options: [
          { value: false, label: t('usageNumbersExact') },
          { value: true, label: t('usageNumbersCompact') },
        ],
        styles: surface,
      })
      const formatError = formatFailure === undefined ? null : h('p', {
        style: { ...surface.error },
      }, t('usageNumberFormatFailed', { message: formatFailure.message }))

      if ((counters.requests ?? 0) === 0) {
        return h('div', null, numberControls, formatError, h('p', { style: surface.hint }, t('usageEmpty')))
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        numberControls,
        formatError,
        h(UsageTable, {
          id: `${id}-totals`,
          headers: counterHeaders(t('usageTotals')),
          rows: [{ key: 'total', cells: [t('usageTotals'), ...counterCells(counters)] }],
        }),

        h('p', { style: surface.sectionTitle }, t('usageByModel')),
        h(UsageTable, {
          id: `${id}-model`,
          headers: counterHeaders(t('usageColumnModel')),
          rows: (table.models ?? []).map((entry) => ({
            key: entry.model,
            cells: [entry.model, ...counterCells(entry.counters)],
          })),
        }),

        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' } },
          h('p', { style: surface.sectionTitle }, t('usageByDay')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            smallAction({
              disabled: currentPage <= 1,
              onClick: () => setDayPage((page) => Math.max(1, page - 1)),
            }, t('usagePrevious')),
            h('span', { style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' } }, t('usagePageStatus', {
              page: String(currentPage),
              pages: String(pageCount),
            })),
            smallAction({
              disabled: currentPage >= pageCount,
              onClick: () => setDayPage((page) => Math.min(pageCount, page + 1)),
            }, t('usageNext')))),
        h(SelectMenu, {
          id: `${id}-page-size`,
          label: t('usagePageSize'),
          hint: t('usagePageSizeHint'),
          value: dayPageSize,
          onChange: (size) => {
            setDayPageSize(size)
            setDayPage(1)
          },
          layout: 'inline',
          options: [10, 30, 100].map((count) => ({
            value: count,
            label: t('usagePageSizeOption', { count: String(count) }),
          })),
          styles: surface,
        }),
        h(UsageTable, {
          id: `${id}-day`,
          headers: counterHeaders(t('usageColumnDay')),
          rows: pageDays.map((entry) => ({
            key: entry.day,
            cells: [entry.day, ...counterCells(entry.counters)],
          })),
        }),

        // What a hit rate divides, and what a missing figure looks like: both are
        // conventions a reader cannot guess, and a wrong guess makes the numbers
        // look inconsistent.
        h('p', { style: surface.hint }, t('usageCacheNote')))
    }

    /**
     * This route's counters, as a section of the configuration page.
     *
     * The window it shows is its own: this page opens on 7 days whatever the
     * panel or the settings tab is showing, and switching here moves no other
     * surface. The table behind it is shared — see `useUsageTable`.
     */
    function UsageSection({ t, subscription, subscriptionBusy, onSubscriptionRefresh }) {
      const usage = useUsageTable()
      const header = h('div', { style: native.groupHead },
        h('h3', { style: native.groupTitle }, t('sectionUsage')),
        h('p', { style: native.groupIntro }, t('usageIntro')))
      const panel = h(React.Fragment, null,
        h(QuotaHead, { t, Tag: 'h4', busy: subscriptionBusy, onRefresh: onSubscriptionRefresh, styles: native }),
        h(SubscriptionPanel, { t, data: subscription, styles: native }))
      const rangeRow = h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '8px', flexWrap: 'wrap' } },
        h(SelectMenu, {
          id: 'usage-range',
          label: t('usageWindow'),
          hint: t('usageWindowHint'),
          value: usage.days,
          onChange: usage.choose,
          disabled: usage.busy,
          layout: 'inline',
          options: (Array.isArray(usage.table?.windows) && usage.table.windows.length > 0 ? usage.table.windows : USAGE_WINDOWS)
            .map((value) => ({ value, label: t(usageWindowKey(value)) })),
          styles: native,
        }),
        smallAction({ disabled: usage.busy, onClick: usage.refresh }, t('usageRefresh')))

      if (usage.failure !== undefined) {
        return h('section', { style: native.group }, header,
          h('div', { style: native.card }, rangeRow,
            h('p', { style: native.error }, usageFailureText(t, usage.failure))))
      }
      if (usage.table === null) {
        return h('section', { style: native.group }, header,
          h('div', { style: native.card }, rangeRow, h('p', { style: native.hint }, t('loading'))))
      }

      const table = usage.table
      const windows = Array.isArray(table.windows) && table.windows.length > 0 ? table.windows : USAGE_WINDOWS
      const historyNote = t(windows.includes('all') ? 'usageHistoryNote' : 'usageHistoryNotReported')

      return h('section', { style: native.group }, header,
        h('div', { style: native.card },
          h('p', { style: native.hint }, t('usageElsewhere')),
          panel,
          h('p', { style: native.hint }, historyNote),
          rangeRow,
          h(CounterTables, {
            t,
            id: 'usage',
            table,
            compact: usage.compact,
            formatBusy: usage.formatBusy,
            formatFailure: usage.formatFailure,
            onNumberFormat: usage.chooseNumberFormat,
            styles: native,
          })))
    }

    /**
     * The usage panel's own header row: the title with its one line of context,
     * and — where the deployment has them — the way through to the plugin's
     * configuration page and the way out of the panel.
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
          : plainAction({ key: 'settings', onClick: openSettings }, t('panelSettings')),
        closeUsage === undefined
          ? null
          : closeAction({
            key: 'close',
            title: t('panelClose'),
            'aria-label': t('panelClose'),
            onClick: closeUsage,
          }, h(CloseMark)),
      ].filter((control) => control !== null)

      return h(React.Fragment, null,
        h('div', { style: panelStyles.panelHead },
          h('div', { style: panelStyles.panelHeading },
            h('h2', { style: panelStyles.panelTitle }, t('panelTitle')),
            h('p', { style: panelStyles.panelIntro }, t('panelIntro'))),
          controls.length === 0 ? null : h('div', { style: panelStyles.panelHeadActions }, controls)),
        // The missing control is the one thing a reader cannot account for, so
        // the panel says why rather than leaving a gap where it would be.
        openSettings === undefined
          ? h('p', { style: { ...panelStyles.hint, width: '100%', maxWidth: '960px' } },
            h('span', null, t('panelNoSettings')))
          : null)
    }

    /**
     * This route's own counters, for the panel.
     *
     * The same endpoint and the same tables as the configuration page's usage
     * section, but a different frame: this one is a section of a page whose
     * whole subject is usage. The window is this component's own — mount it
     * twice and the two instances are two different windows — while the table
     * behind each window is the shared one.
     */
    function UsageCounters({ t, id = 'panel' }) {
      const usage = useUsageTable()
      const windows = Array.isArray(usage.table?.windows) && usage.table.windows.length > 0
        ? usage.table.windows
        : USAGE_WINDOWS
      const historyNote = t(windows.includes('all') ? 'usageHistoryNote' : 'usageHistoryNotReported')

      const header = h('div', { style: panelStyles.panelSectionHead },
        h('h3', { style: panelStyles.sectionTitle }, t('panelCountedSection')),
        smallAction({ disabled: usage.busy, onClick: usage.refresh }, t('usageRefresh')))
      const range = h(SelectMenu, {
        id: `${id}-range`,
        label: t('usageWindow'),
        hint: t('usageWindowHint'),
        value: usage.days,
        onChange: usage.choose,
        disabled: usage.busy,
        layout: 'inline',
        options: windows.map((value) => ({ value, label: t(usageWindowKey(value)) })),
        styles: panelStyles,
      })

      // The failure is worded before the loading state is considered: a read that
      // failed leaves no table for this window, which would otherwise be drawn as
      // one still on its way.
      if (usage.failure !== undefined) {
        return h('section', { style: panelStyles.panelSection }, header, range,
          h('div', { style: panelStyles.card },
            h('p', { style: panelStyles.error }, usageFailureText(t, usage.failure))))
      }
      if (usage.table === null) {
        return h('section', { style: panelStyles.panelSection }, header, range,
          h('div', { style: panelStyles.card }, h('p', { style: panelStyles.hint }, t('loading'))))
      }

      return h('section', { style: panelStyles.panelSection }, header, range,
        h('div', { style: panelStyles.card },
          h('p', { style: panelStyles.hint }, t('usageIntro')),
          h('p', { style: panelStyles.hint }, historyNote),
          h(CounterTables, {
            t,
            id,
            table: usage.table,
            compact: usage.compact,
            formatBusy: usage.formatBusy,
            formatFailure: usage.formatFailure,
            onNumberFormat: usage.chooseNumberFormat,
            styles: panelStyles,
          })))
    }

    /**
     * The usage panel: one page whose whole subject is what this route is using.
     *
     * It exists because the configuration page could not be the fast entry: that
     * page is reached through the settings dialog or the Plugins page, which is
     * more steps than a question asked several times a day. This panel is one
     * step from the sidebar and one keystroke away, and it owns the two things a
     * reader came for — the service's quota, and this route's own counters — in
     * the order they are asked.
     */
    function UsagePage({ t, openSettings, closeUsage }) {
      const { data, busy, refresh } = useSubscription()
      useEffect(() => {
        void refresh(false)
      }, [refresh])

      return h('div', { style: panelStyles.panel },
        h(UsageHead, { t, openSettings, closeUsage }),
        h('section', { style: panelStyles.panelSection },
          h(QuotaHead, { t, busy, onRefresh: () => void refresh(true) }),
          h('div', { style: panelStyles.card },
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
      // The same reader the usage panel and the sidebar capsule use, so the
      // cache-forcing rule and the refusal mapping live in one place.
      const { data: subscription, busy: subscriptionBusy, refresh: readSubscription } = useSubscription()
      // The page's own busy flag covers the reads and writes of the model group
      // and the two actions that reload the model list.
      const [busy, setBusy] = useState(false)
      // The page is the same component under two doors; only the door that is a
      // settings page draws its own title (the Plugins page draws one itself).
      const standalone = props.view !== 'page'

      const failureText = useCallback((result) => {
        if (result.status === 401) return t('errUnauthorized')
        if (result.status === 403) return t('errForbidden')
        if (result.payload?.message !== undefined) return String(result.payload.message)
        return t('errHttp', { status: String(result.status) })
      }, [t])

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

      // The first read. These callbacks are stable, so this runs once and the
      // endpoints are read together rather than one after another. The counters
      // are not in this list: their section reads its own window when it mounts.
      useEffect(() => {
        void readState()
        void readModels()
        void readSubscription(false)
      }, [readModels, readState, readSubscription])

      /** Re-read what a credential write can have changed. */
      const load = useCallback(async () => {
        await Promise.all([readState(), readModels()])
      }, [readModels, readState])

      /**
       * Write one configuration change and read the row back.
       *
       * Every config write reloads this plugin row, so the answer is the
       * persisted override rather than a re-resolved snapshot, and the page
       * observes the new resolution by reading state again. The model group
       * writes two fields in one change (the bridge accepts a set of fields), so
       * one save is one reload rather than a window with half an edit applied.
       */
      const writeConfig = useCallback(async (fields, { models = false } = {}) => {
        setBusy(true)
        try {
          const result = await call(ROUTES.config, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set: fields }),
          })
          if (!(result.ok && result.payload?.ok === true)) {
            return { ok: false, text: failureText(result) }
          }
          await pause(RELOAD_DELAY_MS)
          let reread = true
          if (models) {
            reread = await readModels()
            if (!reread) {
              await pause(RELOAD_DELAY_MS * 2)
              reread = await readModels()
            }
          }
          await readState()
          return reread ? { ok: true } : { ok: true, stale: true }
        } catch (error) {
          return { ok: false, text: t('errHttp', { status: String(error?.message ?? 'network') }) }
        } finally {
          setBusy(false)
        }
      }, [failureText, readModels, readState, t])

      const saveModels = useCallback(
        (fields) => writeConfig(fields, { models: true }),
        [writeConfig],
      )
      const saveSchedule = useCallback(
        (intervals) => writeConfig(intervals),
        [writeConfig],
      )
      const saveTransport = useCallback(
        (settings) => writeConfig(settings),
        [writeConfig],
      )

      const reloadModels = useCallback(async () => {
        setBusy(true)
        try {
          if (await readModels()) setModelsNotice(null)
          else setModelsNotice({ kind: 'error', text: t('modelsStale') })
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

      if (state.phase === 'loading') {
        return h('p', { style: { ...native.hint, fontSize: '14px', lineHeight: '22px' } }, t('loading'))
      }
      if (state.phase === 'failed') {
        return h('div', { style: native.group },
          h('p', { style: native.error }, t('failed', { message: state.message ?? t('errHttp', { status: String(state.status) }) })),
          h('div', null, plainAction({ onClick: load }, t('retry'))))
      }

      const data = state.data
      const models = Array.isArray(snapshot?.models) ? snapshot.models : []
      const reason = data.config?.reason === 'entry-not-found' ? t('reasonNoEntry') : t('reasonNoEditor')
      return h('div', { 'data-opencode-go-config': true, style: native.page },
        standalone
          ? h('div', { style: native.header },
            h('h2', { style: native.title }, t('pageTitle')),
            h('p', { style: native.intro }, t('pageIntro')))
          : null,
        h(ConnectionSection, { t, state: data }),
        h(CredentialSection, { t, state: data, onChanged: load }),
        h(ModelsSection, {
          t,
          snapshot,
          models,
          busy,
          onSave: saveModels,
          onReload: reloadModels,
          onFetch: fetchModels,
          notice: modelsNotice,
        }),
        h(ScheduleSection, {
          t,
          values: data.config?.values,
          busy,
          onSave: saveSchedule,
        }),
        h(TransportSection, {
          t,
          values: data.config?.values,
          busy,
          onSave: saveTransport,
        }),
        h(UsageSection, {
          t,
          subscription,
          subscriptionBusy,
          onSubscriptionRefresh: () => readSubscription(true),
        }),
        data.config?.editable === true
          ? null
          : h('div', { style: native.group },
            h('p', { style: native.notice }, t('configReadonly')),
            h('p', { style: native.hint }, t('configReadonlyReason', { reason })),
            h('p', { style: native.hint }, t('configReadonlyAdvice'))))
    }

    /**
     * The plugin's page, under both of the doors that open it.
     *
     * The Plugins row dispatches on `view`, because one row is summarized in the
     * bundle's list and opened as a page from it. The settings section renders
     * its entry as a page and passes no view, so it gets the page. Both doors
     * register this same component rather than a page-shaped copy of it: one
     * page, and no way for an edit to reach only one of the two.
     */
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
      return h('div', { style: native.page },
        h('section', { style: native.group },
          h(QuotaHead, { t, Tag: 'h4', busy, onRefresh: () => void refresh(true), styles: native }),
          h('div', { style: native.card },
            h(SubscriptionPanel, { t, data, styles: native }))),
        h(UsageCounters, { t, id: 'settings' }))
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
         * The settings dialog's own marker, and where its nav rows live in it.
         *
         * The panel carries the `data-shortcut-modal` marker the shell's modal
         * and shortcut machinery reads, and every `settings.section` entry is a
         * `<button>` inside that panel's `<nav>`. The shell projects no id onto
         * the row, so this plugin's own row is the one whose text is the label
         * this plugin passed in — the same string, in the same locale, that the
         * shell is showing.
         */
        const SETTINGS_PANEL = '[data-shortcut-modal="settings"]'

        /**
         * How long to keep looking for that row, in 25 ms steps.
         *
         * The dialog mounts on the commit after the click that asked for it, so
         * the row cannot be in the DOM on the first look; half a second is ample
         * for the render that follows and still short enough that a shell which
         * has moved on is noticed rather than waited on.
         */
        const SETTINGS_ROW_TRIES = 20

        /**
         * The shell's own way into the settings dialog, whatever shape it has.
         *
         * The dialog has no service behind it: its state is a slot store only
         * the shell renders, and its `settings.open` command is reachable only
         * through the shell's keyboard layer. So the honest way in is to press
         * what a reader presses, and the anchor for that is the keyboard
         * shortcut the shell itself publishes: every control that opens the
         * dialog — the sidebar's own trigger, and the *Settings* item inside the
         * account launcher when a package has taken that seat — announces the
         * same combination as `aria-keyshortcuts`.
         *
         * Two shapes follow from that. Where the shell's trigger is the launcher
         * seat's fallback, it is on screen and one press opens the dialog. Where
         * the account package occupies the seat, the trigger is replaced by a
         * menu button whose *Settings* row is not rendered until the menu is
         * open — so that shape is two presses, and the row is still found by the
         * shortcut rather than by its localized label.
         */
        const settingsShortcut = () => {
          const catalog = ctx.get('shortcuts')?.catalog
          const rows = typeof catalog?.getSnapshot === 'function' ? catalog.getSnapshot() : []
          const row = (Array.isArray(rows) ? rows : []).find((item) => item?.id === 'settings.open')
          return typeof row?.aria === 'string' && row.aria !== '' ? row.aria : undefined
        }

        /**
         * The controls that open the settings dialog, in the order to try them.
         *
         * Climbing from the capsule is what keeps the search honest: a menu or a
         * dialog button anywhere else on the page belongs to something else. The
         * capsule carries an attribute of this plugin's own, and both controls
         * sit beside it in the sidebar's foot, so no class name of the shell's is
         * involved:
         *
         *  - the shell's own trigger, where no package has taken the launcher
         *    seat — the shape that opens the dialog in one press;
         *  - the launcher's menu button, where the account package has taken it.
         *
         * A deployment that mounts the page without this plugin's capsule still
         * has the shell's trigger somewhere, so a document-wide look for it is
         * the last attempt.
         */
        const settingsOpeners = () => {
          const capsule = document.querySelector('[data-opencode-go-capsule]')
          for (let node = capsule?.parentElement; node !== null && node !== undefined; node = node.parentElement) {
            const found = node.querySelector('button[aria-haspopup="dialog"]')
            if (found !== null && found !== undefined) return { trigger: found }
            // The last one, not the first: the shell renders its settings seat
            // *after* the footer actions this capsule shares a row with, so if a
            // future shell puts a menu of its own in that row, the settings seat
            // is still the one further down.
            const menus = [...node.querySelectorAll('button[aria-haspopup="menu"]')]
            if (menus.length > 0) return { launcher: menus[menus.length - 1] }
          }
          const trigger = document.querySelector('button[aria-haspopup="dialog"]')
          return trigger === null ? {} : { trigger }
        }

        /**
         * Where the settings entry leads: this plugin's page, in one step.
         *
         * The presses are the shell's own — the control that opens the dialog,
         * then the nav row this plugin's `settings.section` contribution
         * becomes. That lands on the page directly, rather than on the Plugins
         * page with a row to find and a **Configure** control to press. Every
         * step belongs to the shell, so every step is best-effort: where the
         * opener is not there, or the dialog never appears, the Plugins page —
         * the one door the shell publishes as an API — is what it falls back to.
         */
        const openSettings = () => {
          const navigation = ctx.get('pluginNavigation')
          const pluginsPage = () => {
            if (navigation !== undefined && navigation !== null) navigation.openBundle(PACKAGE_NAME)
          }
          if (typeof document === 'undefined') return pluginsPage()
          const label = t('settingsNavLabel')
          const dialog = () => document.querySelector(SETTINGS_PANEL)
          // The row is read inside the dialog, and the label is this plugin's
          // own: the same string, in the same locale, the shell is showing.
          const row = () => {
            const panel = dialog()
            if (panel === null) return undefined
            return [...panel.querySelectorAll('nav button')]
              .find((button) => String(button.textContent ?? '').trim() === label)
          }
          // The dialog mounts on the render its opener causes, so the first look
          // cannot find it: this is the wait for that render, and it is also
          // what gives up when there is nothing to wait for.
          const pressRow = (tries) => {
            const found = row()
            if (found !== undefined) {
              found.click()
              return
            }
            if (tries > 0) {
              setTimeout(() => pressRow(tries - 1), 25)
              return
            }
            // The dialog never came up, so neither of the shell's doors is
            // answering here: take the one that is a published API.
            if (dialog() === null) pluginsPage()
          }
          // A dialog already on screen is one press away from the page.
          if (dialog() !== null) return pressRow(0)
          const { trigger, launcher } = settingsOpeners()
          if (trigger !== undefined) {
            trigger.click()
            return pressRow(SETTINGS_ROW_TRIES)
          }
          if (launcher === undefined) return pluginsPage()
          // Behind the launcher. Its *Settings* row is not in the document until
          // the menu is open, and the shortcut is what identifies that row: it is
          // the shell's own published aria, so no localized label is guessed.
          const aria = settingsShortcut()
          if (aria === undefined) return pluginsPage()
          launcher.click()
          const pressItem = (tries) => {
            const item = [...document.querySelectorAll('[aria-keyshortcuts]')]
              .find((node) => node.getAttribute('aria-keyshortcuts') === aria)
            if (item !== undefined) {
              item.click()
              return pressRow(SETTINGS_ROW_TRIES)
            }
            if (tries > 0) {
              setTimeout(() => pressItem(tries - 1), 25)
              return
            }
            pluginsPage()
          }
          pressItem(SETTINGS_ROW_TRIES)
        }

        /**
         * The props an entry that offers the settings link hands its component.
         *
         * Either route reaches the page: the settings dialog, whose trigger a
         * browser client always has, or the Plugins page that hosts the same
         * page. This process has neither, and there the control is left out
         * rather than rendered inert.
         */
        const settingsEntry = () => {
          const navigation = ctx.get('pluginNavigation')
          const reachable = (navigation !== undefined && navigation !== null)
            || typeof document !== 'undefined'
          return reachable ? { openSettings } : {}
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
         * The plugin's own page, as a row of Settings' navigation.
         *
         * Reaching this page used to take three steps — the sidebar's Plugins
         * page, the bundle, the row's Configure control — which is the right
         * door for someone browsing what is installed and the wrong one for
         * someone who has already decided to change a setting. Settings is
         * where a reader looks for a plugin's own page, so it is contributed
         * there, beside the pages the shell ships.
         *
         * It registers the very component the row does rather than a
         * page-shaped copy of it: two doors into one page cannot drift, and a
         * field's edit cannot land on only one of them.
         *
         * The order puts it after the shipped pages and the marketplace: an
         * addition follows what the shell already has, and the nav's own
         * sorted ledger is what places it.
         */
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'opencode-go',
          order: 50,
          label: () => t('settingsNavLabel'),
          locale: 'opencodeGo',
          inject: () => ({ t }),
        }, PluginPage))

        /**
         * A tab in Settings' Built-in plugins section, next to the plugin list.
         *
         * Cheap and additive: it renders the panel's sections, so a reader who
         * looks for the counters in Settings finds them, and nothing here
         * duplicates the counters' own logic.
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
