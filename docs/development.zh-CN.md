# 开发

> 返回 [README](../README.zh-CN.md)。

本页写给贡献者：项目当前的状态、如何验证插件、如何重新实测线上事实、代码如何组织。

## 项目状态

| | |
|---|---|
| **版本** | 0.2.1（包名 `dsh-llm-opencode-go`） |
| **协议映射** | 对线上服务逐模型实测，写在 `lib/model/catalog.js` |
| **容量与模态** | 来自 OpenCode 目录（`models.dev`）的快照，日期记在 `lib/model/limits.js` 的 `CAPABILITY_SOURCE`（当前为 `models.dev/opencode-go@2026-10-02`） |
| **已知限制** | 见[可靠性](reliability.zh-CN.md#限制)与[模型](models.zh-CN.md) |

## 验证

```sh
npm test            # 392 项离线检查：配置、SSE 分帧、目录、三种协议、适配器、插件本体、配置桥接、客户端 bundle、显示元数据、版本一致性，以及本仓库自己的 CI
npm run test:cordis # 43 项检查，把插件挂到 Harness 自己的 cordis 上
npm run test:live   # 对线上服务的实测套件；需要 OC_KEY
npm run check:pack  # `npm publish` 会真正上传的那个 tarball
```

上面这个数字在两个 README 的徽章里各写了一次，本页与它的中文版各写了一次，两份更新日志里又各写了
一次，因此新增一个用例要改六个文件——而且只有**最新那一版**的更新日志段会动，旧段里的数字是历史。
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
  话说出来。它只求值一次 bundle、也只物化一次工厂——和浏览器的模块加载器缓存一个包的做法一样——
  并给每个注册进去的 slot 各自一份 hook 存储，正因如此，用例才能看到某个面读到的东西传到了另一个
  画着同一事实的面上。
- 页面的**时钟归套件所有**。页面最多等一秒的延时——写回之后那一拍——照旧自己跑；更长的要等
  `page.advance(ms)`，它按到期顺序走完被安排的活儿，所以用例能问出额度节奏在 30 秒、半小时、
  或十分钟忙碌会话上分别做了什么。`page.surface(name).close()` 是这件事的另一半：它把一个面卸载，
  于是用例能看到最后一个面消失时什么停了下来。

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

那个归档只是这些包的**打包方式**，并不是这套检查成立的原因：同样的库在 npm 上就是同样的版本，
所以找不到安装时，该套件会改从 `node_modules` 里加载——CI 就是这么跑的，用的是锁文件钉住的版本，
而不是某台机器上恰好装了什么。`DSH_BUNDLE` 可以同时覆盖两者；两者都没有的机器会跳过。

`npm run check:pack` 真的打一个 tarball 再读它，因为 `files` 是允许清单，而它的两种失败都是静默的：
仓库里有的文档、清单漏了，就是包没有这份文档；某条 `files` 什么都没匹配到，就等于什么都没发布。
它断言包里带着两个 README、两份更新日志、Loader 要读的 patch、客户端的两半和两个语言文件；不带任何
测试、脚本、workflow 或缓存目录；没有任何已发布文件落在允许清单之外；并且每个 `docs/*.md` 都和它的
`.zh-CN.md` 配对一起发布。

## 持续集成

`.github/workflows/ci.yml` 在每次推送到 `main` 和每个 pull request 上运行：语法检查、离线套件，
以及打包检查——后者只在矩阵的一行上跑而不是四行，因为四种组合产出的字节是一样的。另一个 job 在
Node 20、22、24 上跑激活套件。实测套件不在其中：它需要凭据，并且消耗真实配额。

action 钉在大版本上，而这个大版本是**保持跟进**的，不只是「可复现」：它决定这个 action 认为自己
跑在哪个 Node 上。GitHub 已经弃用 Node 20 作为 action 运行时，而仍然指向它的 action 照跑不误——
被强制换到 Node 24，并在每个 job 上带一条警告。这里面真正有分量的是 `setup-node`：v7 之前它会导出
一个 dummy 的 `NODE_AUTH_TOKEN`；维护者的说法是「不是破坏，只是一个无效 token」，而发布路径恰恰是
OIDC + `registry-url` + 不存 token——正是一个来路不明的 token 最容易造成困惑的地方。

workflow 本身也在被检查，由 `ci` 套件负责。除此之外没有任何东西读它们，而写错的 workflow 只在
GitHub 上跑、不在任何别处跑——在那里，一个笔误就是一个安静地从不做它该做之事的 job。所以该套件会
拒绝：制表符（YAML 不允许，而在编辑器里看不见）、钉在分支而不是版本上的 action、一个可能在比对
tag 与 manifest 之前就发布的 release、仓库里存着的 npm token、调用了不存在的 npm 脚本的步骤，
以及指向仓库里并不存在的文件的打包锚点。

那个套件吃过两次亏，现在各自是一条用例：

- **克隆不等于工作区。** `.test-cache/`、`.live-cache/`、`.npm-cache/` 和 `promotion/` 都在
  `.gitignore` 里，所以它们只存在于造出它们的机器上，任何克隆里都没有。于是「断言某个路径**存在**」
  的用例对写它的人永远通过、在 CI 上必然失败——打包检查那条禁止目录的守卫正是如此：本地绿，却让
  矩阵四行全红。
- **一份检出也不等于另一份检出。** `core.autocrlf` 在 Windows 上默认为 true，于是同一份文件在
  Windows 上是 CRLF、在 Linux runner 上是 LF。用 `$` 锚定的解析器在 CRLF 文件里**什么都匹配不到**——
  `.` 吃不下那个 `\r`，`$` 也不肯在它前面匹配——于是「workflow 跑没跑测试」在一个平台上答「没跑」，
  而报错信息里一个字都没提换行符。现在两种都能解析，并有一条用例断言两者给出同一答案。

## 发布

一次发布就是一个标签。人手动要做的，仍然是版本升级本来就需要的三件事——把九个地方的版本号挪一遍、
开一段更新日志、跑套件——其余交给标签。

`scripts/release.mjs` 装着发布这件事自己的判断，因为 release workflow 是一个谁也没法在本地试跑的
环境里的 shell 脚本：反馈会在打了标签之后、在公开场合、在已经尝试过发布之后才到。所以凡是「要做决定」
的部分都放在套件每次 push 都会跑到的地方，workflow 只留下 shell 无法避免的那些步骤。

```sh
node scripts/release.mjs version          # package.json 里的版本
node scripts/release.mjs check-tag v0.2.1 # 标签所指的版本，或一次拒绝
node scripts/release.mjs notes 0.2.1      # 那段更新日志，作为发布说明正文
```

其中要紧的是 `check-tag`：标签是唯一一个由人输入、而不是由 manifest 声明的版本，因此也是唯一一个
可能错得没别的东西能发现的地方。它拒绝任何不是 `v<版本>` 的标签——从分支发起的 dispatch 拿到的 ref
名会是 `main` 这种——也拒绝版本与 `package.json` 不一致的标签，因为那意味着标签打在了错误的提交上。

`.github/workflows/release.yml` 由 `v*` 标签触发，其余的事它做完：解析版本、在被打标签的提交上重跑
语法检查、离线套件与打包检查、读出说明、带 provenance 发布到 npm，然后建 release。它通过 npm 的
**可信发布**认证：workflow 用自己的一次性 OIDC token 换取短期的发布凭据，所以本仓库（以及任何别处）
都不存 npm token。`workflow_dispatch` 用来收尾一次中途失败的发布——它会检出自己点名的那个标签，所以
发出去的仍然是那个被打标签的提交——版本已在 npm 上时会跳过发布那一步，这正是重跑安全的原因。

npm 那一侧有两个一次性设置：包必须在 **Trusted Publishers** 里指名本仓库与 `release.yml`，workflow
必须跑在 npm 11.5.1 或更新版本上——这就是它在发布前先升级 npm 的原因。凭据交换是自己写入 token 的，
所以 `actions/setup-node` 留在 `.npmrc` 里那行 `registry-url` 不会挡路。

`prepublishOnly` 仍会跑语法检查和离线套件，这在 workflow 里是重复的，而且是刻意的：人在自己机器上
发布时，靠的正是它。

## 重新实测线上事实

关于这个服务有两类事实来自实测而非公布，各自都有一个纳入版本控制的探针。它们都需要 key 并消耗
真实配额：

```sh
OC_KEY=oc_sk_... node scripts/probe-protocols.mjs [model ...]   # 对每个在服务的模型逐个探测协议
OC_KEY=oc_sk_... node scripts/probe-image.mjs                   # 三种协议的图片请求形状
node scripts/snapshot-models.mjs [--write]                      # 容量快照与线上目录的差异
```

`probe-protocols.mjs` 会逐模型给出 `served=[…]`，`FALLBACK_MODELS` 就是照它写的。
`probe-image.mjs` 会把一张 PNG 按每种协议发出去，验证模型是否真的能读图——每种协议发两次：一次图片
在用户那一轮，一次图片在工具结果里，因为这是两种不同的形状，而只有后一种才承载 `read_image`
的返回。用 `OC_IMAGE=path/to.png` 可以换任意一张图（默认的 `.live-cache/probe-image.png` 是未纳入
版本控制的草稿区），把打印出来的回答与图片内容对一遍即可。`snapshot-models.mjs` 会打印快照之后的
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
├── probe-image.mjs           实测每种协议的图片请求形状
├── check-pack.mjs            把 `npm publish` 会传的东西打出来再读一遍
└── release.mjs               一个版本号、一个标签、一段更新日志

locale/
├── en.json                   Plugins 页读的显示元数据
└── zh.json                   同一句话的简体中文
```

`locale/` 是唯一一处 Harness **不激活插件**就会读的随包表面：组合包卡片与 `opencode-go` 行页面上
的那句话就是它，按客户端当前的语言取用（英文同时也来自 manifest，npm 与插件目录里显示的就是那一份）。

增加第四种协议意味着在 `protocol/` 下加一个新文件、在 transport map 里加一个条目。配置页也是同样
的切法：`ui/bridge.js` 拥有 Host 事实与写入路径，`client.js` 拥有渲染，两者在 `ui/bridge.js` 里的
endpoint 与 `<包名>#<行 id>` slot key 上达成一致——这两点都由离线套件检查。
