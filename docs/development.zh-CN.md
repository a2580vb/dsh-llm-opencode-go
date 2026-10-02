# 开发

> 返回 [README](../README.zh-CN.md)。

本页写给贡献者：如何验证插件、代码如何组织。只做配置的用户读到[配置](configuration.zh-CN.md)即可。

## 如何验证

```sh
npm test          # 312 项离线检查：配置、SSE 分帧、目录、三种协议、适配器、插件本体、配置桥接与客户端 bundle
npm run test:cordis # 43 项检查，把插件挂到 Harness 自己的 cordis 上
npm run test:live # 20 项检查，打到真实服务；需要 OC_KEY
```

`npm test` 离线运行，不需要凭据。协议套件回放的是**从线上服务抓取**的响应体
（`tests/golden/`），所以一旦某个翻译器不再与 OpenCode Go 实际发送的内容一致，它们就会失败。
每个用例都用 Harness 自己的 block assembler 组装分片——agent loop 跑的正是同一份代码。其中一个
用例会把容量快照与这台机器缓存的 OpenCode 目录做比对，所以过期的 `lib/model/limits.js` 会被报
出来，而不是悄悄漂移。

覆盖配置页的两个套件同样离线运行。桥接套件用假的 request/response 驱动真实的 HTTP handler，所以
路由、请求栅栏、校验以及每一条拒绝路径都能在没有 socket 的情况下被检查。客户端套件把
`lib/client.js` 放进 `node:vm` 沙箱编译——沙箱里的 `window` 就是模块加载器外壳——然后检查那些
只有用户真正打开页面时浏览器才会暴露的事实：工厂 id、从 `cordis.patch.yml` 读出的
`<包名>#<行 id>` slot key、两种内置语言都完整的词典，以及它调用的 endpoint 恰好是桥接提供的那些。

第三个页面套件更进一步，直接**渲染**页面：`tests/suites/_client-harness.mjs` 提供一个带可用
hooks 的 React 替身，所以套件能打开页面、在输入框里打字、按下控件，并读到一个人会看到的内容。
页面关于自身的那些断言就是这样被检查的：保存写回的是配置的形状而不是读到的快照、切换窗口读取
的是读者选择的窗口、禁用的控件按不动、失败信息用读者自己的话说出来。

该套件里有两条检查是**结构性**的而不是行为性的，两条都源于「真实的缺陷逃过了所有行为断言」。
这里的样式是普通对象而不是 CSS，所以错误容易写、却不容易看出来：

- **`flex` 的 basis 在行容器里是宽度，在列容器里是高度。** 一个带着 `flex: '0 0 200px'` 的文本
  控件跑进包裹它的带标签列之后，会变成 **200px 高**，并把自己的文字裁掉。套件现在遍历渲染出的
  树，找出所有处于列祖先之下的控件，拒绝任何带着 basis 的。新代码的规则：给标签（行里的 flex
  项）定宽，让控件用 `styles.fieldInput` 填满它——那里是**故意**设成 `flex: 'none'` 的。
- **塞不下的 placeholder 就是一句被截断的话。** 套件会按列声明的宽度估算每个 placeholder，于是
  过长的提示在这里就被抓住，而不是等读者来发现。关于「允许输入什么」的规则应该放在字段下方的
  提示文字里，那里能换行、能读。

`npm run test:live` 会消耗真实配额。它针对线上中继证明：模型发现与缓存、三种协议各自的往返、
每种协议的完整工具调用往返、协议回退恢复、重复 session id 上的缓存复用、历史中存在「被记录但
从未派发」的工具调用时请求仍被接受、每个模型都报告自己的实测上下文窗口与模态、每一个对外
公布的思考等级都被接受，以及被 workspace 门控的模型要么正常作答、要么被明确报成「需要该
workspace 的同意」。

```sh
OC_KEY=oc_sk_... npm run test:live
# 可选：OC_BASE、OC_CACHE 可让发现缓存不落在 ~/.dsh
```

`npm run test:cordis` 是那个能抓到 loader 级错误的套件。它从 `app.asar` 里读出 Harness 自己的
包，把插件挂到安装版**真实的** cordis 上，并检查：激活不产生告警、路由注册到真实的 LLM runtime
上、模型与思考等级能通过它解析、一次流式调用端到端完成、卸载时释放路由，以及配置页的路由确实经由
真实的 `ctx.inject(['webServer'], …)` 路径被认领、并通过 socket 应答。如果安装位置在别处，
设置 `DSH_ASAR`；找不到安装时该套件会干净地跳过。

这个套件之所以存在，是因为插件导出的 `Config` 不是自由形式的：cordis 在启动插件前会调用
`Config['~standard'].validate(raw)`，所以那里如果是个普通对象，激活就会以
`Cannot read properties of undefined (reading 'validate')` 失败。任何孤立的单元测试都抓不到这一点。

## 重新实测线上事实

关于这个服务有两类事实是实测而非公布的，各自都有一个纳入版本控制的探针。它们都需要 key 并消耗
真实配额：

```sh
OC_KEY=oc_sk_... node scripts/probe-protocols.mjs [model ...]   # 对每个在服务的模型逐个探测协议
OC_KEY=oc_sk_... node scripts/probe-image.mjs                   # 三种协议的图片请求形状
node scripts/snapshot-models.mjs [--write]                      # 容量快照与线上目录的差异
```

`probe-protocols.mjs` 会逐模型给出 `served=[…]`，`FALLBACK_MODELS` 就是照它写的。
`probe-image.mjs` 会把一张生成的 PNG 按每种协议发出去，验证模型是否真的能读图——这才让 `image`
声明站得住脚；它用到的图片写在 `.live-cache/probe-image.png`（未纳入版本控制的草稿区）。
`snapshot-models.mjs` 会打印快照之后的变化（`new`、`changed`、`gone`），加 `--write` 则重写两张表。

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
└── ui/
│   ├── http.js               node:http 辅助与请求栅栏
│   └── bridge.js             配置页的 Host 半侧
└── usage/store.js            这条路由花掉了什么，按天、按模型

scripts/
├── snapshot-models.mjs       从目录刷新 lib/model/limits.js
├── probe-protocols.mjs       实测每个在服务的模型接受哪些协议
└── probe-image.mjs           实测每种协议的图片请求形状
```

增加第四种协议意味着在 `protocol/` 下加一个新文件、在 transport map 里加一个条目——而不是重写。
配置页也是同样的切法：`ui/bridge.js` 拥有 Host 事实与写入路径，`client.js` 拥有渲染，两者在
`ui/bridge.js` 里的 endpoint 与 `<包名>#<行 id>` slot key 上达成一致——这两点都由离线套件检查。
