# 开发

> 返回 [README](../README.zh-CN.md)。

本页写给贡献者：项目当前的状态、如何验证插件、如何重新实测线上事实、代码如何组织。

## 项目状态

| | |
|---|---|
| **版本** | 0.1.1（包名 `dsh-llm-opencode-go`） |
| **协议映射** | 对线上服务逐模型实测，写在 `lib/model/catalog.js` |
| **容量与模态** | 来自 OpenCode 目录（`models.dev`）的快照，日期记在 `lib/model/limits.js` 的 `CAPABILITY_SOURCE`（当前为 `models.dev/opencode-go@2026-10-02`） |
| **已知限制** | 见[可靠性](reliability.zh-CN.md#限制)与[模型](models.zh-CN.md) |

## 验证

```sh
npm test            # 349 项离线检查：配置、SSE 分帧、目录、三种协议、适配器、插件本体、配置桥接、客户端 bundle、显示元数据与版本一致性
npm run test:cordis # 43 项检查，把插件挂到 Harness 自己的 cordis 上
npm run test:live   # 对线上服务的实测套件；需要 OC_KEY
```

上面这个数字在两个 README 的徽章里各写了一次，本页与它的中文版各写了一次，两份更新日志里又各写了
一次，因此新增一个用例要改六个文件。
`release` 是那个让版本升级保持诚实的套件：它读 manifest，任何还写着旧版本号的地方
都会失败。

`npm test` 离线运行，不需要凭据。协议套件回放的是**从线上服务抓取**的响应体
（`tests/golden/`），所以一旦某个翻译器不再与 OpenCode Go 实际发送的内容一致，它们就会失败。
每个用例都用 Harness 自己的 block assembler 组装分片——agent loop 跑的正是同一份代码。其中一个
用例会把容量快照与这台机器缓存的 OpenCode 目录做比对，所以过期的 `lib/model/limits.js` 会被报
出来。

这些套件写下的磁盘文件落在 `.test-cache/`（未纳入版本控制的草稿区），路径由
`tests/suites/_scratch.mjs` 发放：每个用例一个自己的目录，用例结束即删除，目录名里带着本次运行
才生成的 token。因此即使某次运行在自己的清理之前就死掉，它留下的文件也不会是后来那次运行要打开
的那个。

覆盖配置页的套件同样离线运行：

- **桥接套件**用假的 request/response 驱动真实的 HTTP handler，所以路由、请求栅栏、校验以及每一条
  拒绝路径都能在没有 socket 的情况下被检查。
- **客户端套件**把 `lib/client.js` 放进 `node:vm` 沙箱编译——沙箱里的 `window` 就是模块加载器
  外壳——然后检查工厂 id、从 `cordis.patch.yml` 读出的 `<包名>#<行 id>` slot key、两种内置语言都
  完整的词典，以及它调用的 endpoint 恰好是桥接提供的那些。
- **页面套件**直接渲染页面：`tests/suites/_client-harness.mjs` 提供一个带可用 hooks 的 React 替身，
  所以套件能打开页面、在输入框里打字、按下控件，并读到一个人会看到的内容。它检查保存写回的是配置
  的形状而不是读到的快照、切换窗口读取的是读者选择的窗口、禁用的控件按不动、失败信息用读者自己的
  话说出来。

页面套件里还有两条检查是**结构性**的，它们同时也是新代码的规则——这里的样式是普通对象而不是 CSS，
错误容易写、却不容易看出来：

- **`flex` 的 basis 在行容器里是宽度，在列容器里是高度。** 所以不要给控件设 basis：给标签（行里的
  flex 项）定宽，让控件用 `styles.fieldInput`（`flex: 'none'`）填满它。套件会遍历渲染出的树，
  找出所有处于列祖先之下的控件，拒绝任何带着 basis 的。
- **塞不下的 placeholder 就是一句被截断的话。** 套件会按列声明的宽度估算每个 placeholder，过长的
  提示在这里就被抓住。关于「允许输入什么」的规则应该放在字段下方的提示文字里，那里能换行、能读。

`npm run test:live` 会消耗真实配额。它针对线上中继检查：模型发现与缓存、三种协议各自的往返、
每种协议的完整工具调用往返、协议回退恢复、重复 session id 上的缓存复用、历史中存在「被记录但
从未派发」的工具调用时请求仍被接受、每个模型都报告自己的实测上下文窗口与模态、每一个对外
公布的思考等级都被接受，以及被 workspace 门控的模型要么正常作答、要么被明确报成「需要该
workspace 的同意」。

```sh
OC_KEY=oc_sk_... npm run test:live
# 可选：OC_BASE、OC_CACHE 可让发现缓存不落在 ~/.dsh
```

`npm run test:cordis` 从 `app.asar` 里读出 Harness 自己的包，把插件挂到安装版**真实的** cordis
上，并检查：激活不产生告警、路由注册到真实的 LLM runtime 上、模型与思考等级能通过它解析、一次
流式调用端到端完成、卸载时释放路由，以及配置页的路由确实经由真实的 `ctx.inject(['webServer'], …)`
路径被认领、并通过 socket 应答。安装位置在别处时设置 `DSH_ASAR`；找不到安装时该套件会干净地跳过。

写插件时的一条约束：导出的 `Config` 不是自由形式的。cordis 在启动插件前会调用
`Config['~standard'].validate(raw)`，所以那里如果是个普通对象，激活就会以
`Cannot read properties of undefined (reading 'validate')` 失败——孤立的单元测试抓不到这一类错误，
`test:cordis` 能。

## 重新实测线上事实

关于这个服务有两类事实来自实测而非公布，各自都有一个纳入版本控制的探针。它们都需要 key 并消耗
真实配额：

```sh
OC_KEY=oc_sk_... node scripts/probe-protocols.mjs [model ...]   # 对每个在服务的模型逐个探测协议
OC_KEY=oc_sk_... node scripts/probe-image.mjs                   # 三种协议的图片请求形状
node scripts/snapshot-models.mjs [--write]                      # 容量快照与线上目录的差异
```

`probe-protocols.mjs` 会逐模型给出 `served=[…]`，`FALLBACK_MODELS` 就是照它写的。
`probe-image.mjs` 会把一张生成的 PNG 按每种协议发出去，验证模型是否真的能读图；它用到的图片写在
`.live-cache/probe-image.png`（未纳入版本控制的草稿区）。`snapshot-models.mjs` 会打印快照之后的
变化（`new`、`changed`、`gone`），加 `--write` 则重写两张表。

## 目录结构

```
lib/
├── index.js                  adapter 类、注册、健康检查
├── client.js                 浏览器半侧：插件自己的配置页
├── config.js                 schema、默认值、校验
├── error/
│   ├── errors.js             本插件自有的失败类型与 brand 辅助
│   └── mapping.js            HTTP 状态 / 传输失败 → 稳定错误码
├── model/
│   ├── catalog.js            实测得到的协议映射与记录合并
│   ├── limits.js             实测得到的容量与模态快照
│   ├── cache.js              GET /models，内存 + 磁盘缓存
│   ├── capabilities.js       记录 → Harness 模型元数据
│   └── images.js             持久引用 → 请求字节
├── protocol/
│   ├── shared.js             block 累积与终态排序
│   ├── chat-completions.js
│   ├── responses.js
│   └── anthropic-messages.js
├── session/headers.js        x-opencode-session 与请求身份
├── stream/sse.js             字节级 SSE 分帧
├── transform/
│   ├── messages.js           content block → 各协议的 messages
│   ├── tools.js              tool schema → 各协议的声明
│   └── reasoning.js          Harness 思考等级 → 各协议的拼写
├── ui/
│   ├── http.js               node:http 辅助与请求栅栏
│   └── bridge.js             配置页的 Host 半侧
└── usage/store.js            这条路由花掉了什么，按天、按模型

scripts/
├── snapshot-models.mjs       从目录刷新 lib/model/limits.js
├── probe-protocols.mjs       实测每个在服务的模型接受哪些协议
└── probe-image.mjs           实测每种协议的图片请求形状

locale/
├── en.json                   Plugins 页读的显示元数据
└── zh.json                   同一句话的简体中文
```

`locale/` 是唯一一处 Harness **不激活插件**就会读的随包表面：组合包卡片与 `opencode-go` 行页面上
的那句话就是它，按客户端当前的语言取用（英文同时也来自 manifest，npm 与插件目录里显示的就是那一份）。

增加第四种协议意味着在 `protocol/` 下加一个新文件、在 transport map 里加一个条目。配置页也是同样
的切法：`ui/bridge.js` 拥有 Host 事实与写入路径，`client.js` 拥有渲染，两者在 `ui/bridge.js` 里的
endpoint 与 `<包名>#<行 id>` slot key 上达成一致——这两点都由离线套件检查。
