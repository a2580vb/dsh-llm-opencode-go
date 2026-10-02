# dsh-opencode-go

[English](README.md) | **简体中文**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，
把 **OpenCode Go**（`https://opencode.ai/zen/go/v1`）作为 DSH 的原生模型 provider 接入。

它是一个完整的 LLM 适配器，而不是代理：OpenCode Go 提供的三种协议线格式全部由它自己实现，
把 Harness 的 messages、tools、reasoning 翻译成对应协议的请求，再把流式响应翻译回 DSH 的
`StreamChunk`。

```yaml
- insert:
    - id: opencode-go
      name: dsh-opencode-go
      config:
        apiKeyEnv: OPENCODE_GO_API_KEY
```

这就是全部必需配置。API Key 的值永远不会进入配置文件：`apiKeyEnv` 只是一个**凭据引用**，
每次请求都通过 Harness 的凭据接缝解析，所以在 Web 的「模型」页里写入的 key，下一次调用即刻生效，
无需重启。

## 它能做什么

| | |
|---|---|
| **Provider 路由** | `opencode-go`（可配置） |
| **协议** | OpenAI Responses、OpenAI 兼容 Chat Completions、Anthropic Messages |
| **模型发现** | `GET /models`，带内存缓存 + 磁盘缓存 |
| **会话亲和** | `x-opencode-session`，每个会话一个稳定 id |
| **工具调用** | 每一次已派发的调用都完整往返：定义、分片参数、工具结果、后续轮次 |
| **推理** | 按协议映射思考等级，包含 Anthropic thinking budget |
| **流式** | SSE → `StreamChunk`，带 usage、结束原因和空闲看门狗 |
| **失败** | 稳定的 provider 无关错误码（`AUTH`、`RATE_LIMIT`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED` 等） |
| **运行时依赖** | 无 |

## 安装

从当前检出目录安装：

```sh
dsh plugin --profile desktop add L:\e2\dsh-plugin\opencodego-transfrom
```

然后**完全重启**该 profile：bundle 层只在启动时读取。确认启动日志：

```
dsh-opencode-go: provider "opencode-go" ready at https://opencode.ai/zen/go/v1 (credential OPENCODE_GO_API_KEY, models discover)
```

### 给它一个 Key

可以在启动 DSH 的环境里导出 `OPENCODE_GO_API_KEY`，也可以走凭据接缝写入它——Web 的「模型」页
写的就是这里。插件按请求解析引用，所以两种方式都可用，且都不需要重启。

如果你希望插件读取另一个名字的环境变量，把 `apiKeyEnv` 指向它：

```yaml
config:
  apiKeyEnv: OC_KEY
```

配置文件里读取的永远只是变量**名**，不是它的值。

## 为什么协议要按模型选择

OpenCode Go 提供三种线格式协议，并且对**哪个模型能走哪个协议**非常严格。一个只会说
`/responses` 的模型不会降级到 `/chat/completions`，而是直接回答：

```json
{"type":"error","error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}
```

所以每个模型携带的是一份有序的协议列表，而不是一个全局的 endpoint 选择。当请求以这种方式被
拒绝时，适配器会记录日志，并用该模型的下一个协议重试同一调用。以下是逐个模型对线上实测的结果：

| 模型 | 提供的协议 |
|---|---|
| `deepseek-v4-pro`、`deepseek-v4-flash`、`deepseek-v4.1-flash`、`deepseek-flash`、`deepseek-v4-flash-vision-exp` | responses、chat-completions、anthropic |
| `gpt-6-luna`、`gpt-5.6-luna`、`grok-4.7`、`grok-4.6` | responses |
| `minimax-m2.7` | anthropic |
| `minimax-m2.5`、`minimax-m3`、`kimi-k3`、`qwen3.6-plus`、`qwen3.7-max`、`qwen3.8-max`、`qwen3.8-flash`、`qwen3.7-plus`、`space-bunny-free` | chat-completions、anthropic |
| `glm-5.3`、`glm-5.3-flash`、`glm-5.2`、`glm-5.1`、`kimi-k2.7-code`、`kimi-k2.6`、`mimo-v2.6-pro`、`mimo-v2.6-flash`、`mimo-v2.5-pro`、`mimo-v2.5`、`longcat-*`、`hy3`、`hy4-preview`、`omen-alpha` | chat-completions |
| `muse-spark-1.*-contributor` | 会列出，但对非 contributor 账号会被拒绝 |

`GET /models` 返回的每一个 id 在这张表里都有对应行，所以没有任何一个在服务的模型需要先失败一次
才能确定自己的协议。服务变更后用[如何验证](#如何验证)里描述的探针重新实测即可。

优先级顺序是 responses → chat-completions → anthropic。用 `protocolOverrides` 可以钉住另一个：

```yaml
config:
  protocolOverrides:
    deepseek-v4-flash: chat-completions
```

目录里没有描述的模型，按「究竟未知多少」分两种情况处理。服务列出了、但本插件从未实测过的
id，只会带上默认协议——「服务列出了它」本身就是插件掌握的一条事实。而**哪里都找不到**的
id——新到 `GET /models` 都还没收录，或者走的是没有发现能力的网关——才是协议真正未知的那一种，
它会依次尝试每一个协议。你永远不需要等插件发新版本才能用上新模型。

## 容量与多模态

`GET /models` 只公布 id：

```json
{"id":"deepseek-v4.1-flash","object":"model","created":1790899718,"owned_by":"opencode"}
```

没有上下文窗口、没有输出上限、也没有多模态信息。这些数字是存在的——就在 OpenCode 自己随包发布的
目录（`models.dev`）里——所以 `lib/model/limits.js` 以**快照**的形式带上它们，而不是每次请求去
拉：需要上下文窗口的调用不能等一个第三方 endpoint，没有外网的部署也得能显示真实上限。每个模型
解析出的都是自己的数字：

| 模型 | 上下文 | 输出上限 | 模型输入 |
|---|---|---|---|
| `deepseek-v4.1-flash` | 1,000,000 | 384,000 | text、image |
| `gpt-5.6-luna` | 1,050,000 | 128,000 | text、image、pdf |
| `grok-4.7` | 500,000 | 500,000 | text、image、pdf |
| `minimax-m2.7` | 204,800 | 131,072 | text |
| `kimi-k2.7-code` | 262,144 | 262,144 | text、image、video |
| `mimo-v2.6-pro` | 1,048,576 | 131,072 | text、image、audio、video |
| `hy3` | 256,000 | 128,000 | text |

快照完全没听说过的模型——比它更晚发布的——会先匹配到**同族**的实测数字（`qwen…`、`glm-…`、
`grok-…` 等），最后才退回 `defaultContextWindow`。经由会公布自身容量的网关接入的模型，则直接
从响应里读取；见[塑造目录](#塑造目录)。

### 多模态：模型能接受什么，与一条路由能发什么

目录里列出的能力，有些是这里任何线协议都没有对应字段的——`video`、`audio`、`pdf`——所以两个事实
被分开保存：

- **`providerModalities`** 是目录自己的列表，原样保留。
- **`inputModalities`** 是本适配器真正能放进请求里的东西。Harness 只建模两种，本适配器也只对两种
  有线路表达，所以解析出的模型只声明 `['text']` 或 `['text', 'image']`。

这个区分不是装饰性的。Harness 依据解析出的列表来投影持久的 image block：声明了 `image` 的路由会
拿到真实的 image block，并且必须解析出它的字节；没声明的只会拿到文本占位符。因此，「模型支持、但
这条路由发不出去」的能力会以一句说明的形式出现：

```
"description": "the model also accepts video, audio, which no protocol on this route can send"
```

`sendImages` 决定是否真的尝试发送图片字节：

| 取值 | 效果 |
|---|---|
| `auto`（默认） | 当**本部署能解析图片字节**（即挂载了 attachment seam）时，为视觉模型声明 `image`；否则报告为纯文本，并说明省略了什么。 |
| `always` | 只要目录条目接受图片就声明 `image`，无论有没有挂载 seam。此时含图片的请求会带着原因失败，而不是静默地只发文本。 |
| `off` | 从不声明 `image`。 |

如果你的部署把图片挂在别处而不是 attachment seam，就设为 `always`：

```yaml
config:
  sendImages: always
```

声明之后三种协议都能携带图片：Chat Completions 与 Responses 收到 `data:` URL 部件，Messages 收到
base64 `source`。这是对线上实测的结论，不是假设——见[如何验证](#如何验证)。

## 配置

每个键都是可选的。运行 `dsh --profile <name> --dump-config` 可以看到合成后的完整视图，或者读
插件里的 `Config` 拿到权威字段列表。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `opencode-go` | 请求通过 `GenerateOptions.provider` 选择的路由名 |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | 凭据**引用**，按请求解析 |
| `baseURL` | `https://opencode.ai/zen/go/v1` | API 根地址；接兼容网关只需要改这里 |
| `userAgentProduct` | `dsh-opencode-go` | 放在 `User-Agent` 最前面的产品标识 |
| `attribution` | 无 | 追加到 `User-Agent` 的额外产品标识，例如 `deepseek-harness/0.2.0` |
| `timeoutMs` | `600000` | 连接 + 响应头的截止时间 |
| `streamIdleTimeoutMs` | `300000` | 两次流读取之间允许的最大 provider 空闲时间 |
| `modelSource` | `discover` | `discover` = `GET /models` + 内置回退；`config` = 只用 `models` 列表 |
| `modelsCacheSeconds` | `21600` | 已发现目录的生存期 |
| `modelsCachePath` | `~/.dsh/cache/opencode-go-models.json` | 缓存文件；路径不可写时只告警 |
| `models` | `[]` | 提示性目录条目；当 `modelSource: config` 时它就是整个目录 |
| `modelOverrides` | `{}` | 重塑某一个目录模型，而不必重述其余的 |
| `protocolOverrides` | `{}` | `{"<模型 id>": "<协议>"}` 简写 |
| `defaultProtocol` | `chat-completions` | 未指定协议的条目所用的协议 |
| `defaultContextWindow` | `262144` | 未描述模型的能力回退值 |
| `defaultMaxTokens` | `32768` | 未描述模型的输出上限回退值 |
| `reasoningEfforts` | `[minimal, low, medium, high, max]` | 可选的思考等级；按协议收窄 |
| `sessionHeader` | `session-id` | `session-id` \| `uuid` \| `off` |
| `sendClientHeader` | `true` | 是否发送 `x-opencode-client` |
| `sendImages` | `auto` | `auto` \| `always` \| `off`——是否尝试发送图片字节（见[多模态](#多模态模型能接受什么与一条路由能发什么)） |
| `disableReasoningReplay` | `false` | 不再回传此前的 reasoning（见[推理](#推理)） |
| `healthCheck` | `off` | `startup` 会记录一份凭据 + 目录报告 |
| `retryPolicy` | normal，5 次重试 | 由重试执行器采用的 provider 自有策略 |

### 调整目录

`models` 条目在 `discover` 模式下**替换**它所点名 id 的目录记录，所以一条条目就是那个模型的全部
事实：它没有声明的字段取自顶层默认值，而不是取自实测得到的记录。如果只为 `gpt-5.6-luna` 写一条只
声明 `contextWindow` 的 `models` 条目，实测得到的 `[responses]` 协议列表和 `reasoning: true`
就都丢了，除非条目里重新声明。`modelOverrides` 是与之互补的**合并**形式：它只改自己点名的字段，
其余全部保留：

```yaml
config:
  models:
    - id: glm-5.3
      name: GLM 5.3
      contextWindow: 200000
      maxTokens: 131072
      reasoning: true
      efforts: [low, medium, high]
```

条目也可以直接粘贴目录记录：`limit: { context, output }` 是 `contextWindow` / `maxTokens` 的同义
写法，`modalities: { input: [...] }`（或裸的 `modalities: [...]`）记录 provider 自己的列表。本适配
器只认得 `text` 与 `image`，所以粘贴进来的列表会原样保留，而真正被声明出去的是其中可发送的子集。

当 `modelSource: config` 时，`models` 就是整个目录，`GET /models` 永远不会被调用——这正是接兼容
网关时该有的姿态。

### 图片输入

图片输入跟着模型走。在[容量表](#容量与多模态)里的视觉模型会声明 `image`，适配器随后通过挂载的
attachment seam 把每一处出现解析成请求部件：Chat Completions 与 Responses 用 `data:` URL，
Messages 用 base64 source。

这个声明是**跟着部署条件**的——见上面的 `sendImages`。一个持久化的 `ImageBlock` 携带的是附件的
*引用*，把它变成请求字节需要 `attachments` 服务，所以解析不出来的路由会报告为纯文本，而不是声明一
项自己兑现不了的能力。provider 自己的列表不会丢：解析出的 description 会点名这条路由发不出去的
部分。

也可以按模型覆盖其中任何一半：

```yaml
config:
  modelOverrides:
    # 为目录没有描述的模型强制打开图片输入。
    my-vision-model:
      input: [text, image]
    # 只记录 provider 的列表，不声明图片支持。
    some-model:
      modalities: { input: [text, image, video] }
```

## Endpoint 与鉴权

| 协议 | 路径 | 鉴权 |
|---|---|---|
| Chat Completions | `POST {baseURL}/chat/completions` | `Authorization: Bearer <key>` |
| Responses | `POST {baseURL}/responses` | `Authorization: Bearer <key>` |
| Messages | `POST {baseURL}/messages` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |

Messages 端点会以 `AuthError: Missing API key` 拒绝 bearer token；这就是它拥有自己一套请求头、
而不是继承共享请求头的原因。

每个请求还会带上：

```http
User-Agent: dsh-opencode-go/0.1.0
x-opencode-session: <每个会话一个稳定 id>
x-opencode-client: dsh-opencode-go
```

## `x-opencode-session`

OpenCode 的中继会把共享同一个 `x-opencode-session` 值的所有请求钉在同一个上游后端上，这正是
它在一次对话的多个轮次之间保持 prompt 缓存热度的方式。这个值只需要是**每个会话**不透明且稳定
的——一个固定值会让所有会话共用同一条缓存血缘，所以本插件用每次调用本就携带的 DSH session id
来派生它。

- `session-id`（默认）——直接使用 DSH session id：每个会话唯一，跨轮次、跨压缩、跨重试、跨进程
  重启都稳定。
- `uuid`——按 session id 派生一次的不透明随机 UUID，并在进程内记住；适合不希望外发 Harness id
  的部署。
- `off`——什么都不发。插件会在启动时告警，因为 OpenCode 可能因此拒绝请求或丢失缓存亲和。

没有 session id 的辅助调用（会话标题生成）仍然会得到一个进程级回退值，而不是缺失该请求头。

## 推理

每种协议对「思考」的拼写都不同，而中继会校验拼写，所以翻译由一个函数统一负责：

| 协议 | 字段 | 接受的等级 |
|---|---|---|
| Chat Completions | `reasoning_effort` | `minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| Responses | `reasoning.effort` | `low`、`medium`、`high`、`xhigh`、`max`（`minimal` 会被拒绝） |
| Messages | `thinking.budget_tokens` | 由等级映射而来：1024 / 4096 / 8192 / 16384 / 32768 / 64000 |

模型解析出的元数据只公布其协议能表达的等级，因为运行时会在任何网络 I/O 之前用那个集合校验请求的
思考等级。Anthropic 的 budget 会被严格限制在 `max_tokens` 以下；如果输出上限连最小的 budget 都
装不下，就干脆省略 thinking，而不是发一个 API 必然拒绝的请求。

**推理历史**只在协议支持的情况下回放：Chat Completions 接收 `reasoning_content`，Messages 接收
带 provider 签发签名的 thinking block（按 block 的确切文本寻址，在没有保留签名时降级为纯文本）。
Responses API 完全不接收，因为 reasoning item 会针对 Harness 并未保留的上游状态做校验。设置
`disableReasoningReplay: true` 可在任何协议上都不发送推理历史。

## 工具调用

工具按各协议自己的拼写过线——Responses 是扁平声明加 `function_call`/`function_call_output` 配对，
Chat Completions 是 `function` 包装加 `tool_calls` 与 `role: "tool"`，Messages 是
`tool_use`/`tool_result` 块——历史也按当初回答它的同样形状回放。

三种翻译都遵守同一条规则，因为三条线上都强制它：**调用与结果要么一起发出，要么都不发。**
Responses API 对没有结果的调用回 `400 No tool output found for tool call <id>`；Chat Completions
要求 assistant 发出 `tool_calls` 之后的那一轮必须回答它给出的每一个 id；Messages 拒绝没有
`tool_result` 跟随的 `tool_use` 块。历史里确实可能出现「有调用没结果」——Harness 记录了模型的
`tool-call`，而进程在派发之前就停了，于是永远没有追加结果——所以转换器在发出任何内容之前会先通读
整段历史，把没有配对的那一半省略。见[限制](#限制)。

## 失败

稳定的错误码，让使用方按 code 而不是按消息文本做分流：

`AUTH` · `QUOTA` · `RATE_LIMIT` · `CONTEXT_WINDOW_EXCEEDED` · `INVALID_REQUEST`
· `SERVER` · `TRANSPORT` · `ABORTED` · `TIMEOUT` · `MALFORMED_RESPONSE` ·
`STREAM_CLOSED` · `EMPTY_RESPONSE` · `UNSUPPORTED_CONTENT` · `UNSUPPORTED_OPTION`
· `PROTOCOL_UNSUPPORTED` · `MISSING_CREDENTIAL` · `INVALID_CREDENTIAL`

凭据解析不出来时，会在任何网络 I/O 之前以 `MISSING_CREDENTIAL` 失败；凭据中含有 HTTP 请求头
无法承载的字符时以 `INVALID_CREDENTIAL` 失败。这两条消息都不包含密钥的任何部分。

适配器失败是按 Harness 读取的**形状**上报的——一个带有自有 `code` 和 `failure` 数据属性的
`Error`——而不是按类身份。这就是本插件可以定义自己的失败类型、且不依赖任何 Harness 包的原因：
Harness 类的跨包副本在 Harness 里本来也永远不会被 `instanceof` 认出来。

## 如何验证

```sh
npm test          # 127 项离线检查：配置、SSE 分帧、目录、三种协议、适配器、插件本体
npm run test:cordis # 20 项检查，把插件挂到 Harness 自己的 cordis 上
npm run test:live # 19 项检查，打到真实服务；需要 OC_KEY
```

`npm test` 离线运行，不需要凭据。协议套件回放的是**从线上服务抓取**的响应体
（`tests/golden/`），所以一旦某个翻译器不再与 OpenCode Go 实际发送的内容一致，它们就会失败。
每个用例都用 Harness 自己的 block assembler 组装分片——agent loop 跑的正是同一份代码。其中一个
用例会把容量快照与这台机器缓存的 OpenCode 目录做比对，所以过期的 `lib/model/limits.js` 会被报
出来，而不是悄悄漂移。

`npm run test:live` 会消耗真实配额。它针对线上中继证明：模型发现与缓存、三种协议各自的往返、
每种协议的完整工具调用往返、协议回退恢复、重复 session id 上的缓存复用、历史中存在「被记录但
从未派发」的工具调用时请求仍被接受、每个模型都报告自己的实测上下文窗口与模态，以及每一个对外
公布的思考等级都被接受。

```sh
OC_KEY=oc_sk_... npm run test:live
# 可选：OC_BASE、OC_CACHE 可让发现缓存不落在 ~/.dsh
```

`npm run test:cordis` 是那个能抓到 loader 级错误的套件。它从 `app.asar` 里读出 Harness 自己的
包，把插件挂到安装版**真实的** cordis 上，并检查：激活不产生告警、路由注册到真实的 LLM runtime
上、模型与思考等级能通过它解析、一次流式调用端到端完成、以及卸载时释放路由。如果安装位置在别处，
设置 `DSH_ASAR`；找不到安装时该套件会干净地跳过。

这个套件之所以存在，是因为插件导出的 `Config` 不是自由形式的：cordis 在启动插件前会调用
`Config['~standard'].validate(raw)`，所以那里如果是个普通对象，激活就会以
`Cannot read properties of undefined (reading 'validate')` 失败。任何孤立的单元测试都抓不到这一点。

### 重新实测线上事实

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

## 限制

- **协议能力是实测出来的，不是官方公布的。** OpenCode Go 的 `/models` 响应只列 id，所以
  `lib/model/catalog.js` 里的映射来自对线上服务逐个端点的探测。模型换了协议就需要一条
  `protocolOverrides` 或重新实测。两种「未知」的程度并不相同：服务**列出了**、但本插件尚未
  实测的 id 只拿到 `defaultProtocol`，没有回退；而哪里都找不到的 id——既不在内置目录、也不在已
  发现的列表里——会依次尝试每一个协议，因为它的协议正是缺失的那一项。
- **容量是一份快照，不是订阅。** `lib/model/limits.js` 保存着在 `CAPABILITY_SOURCE` 所记日期从
  OpenCode 目录实测来的上下文窗口、输出上限和 provider 模态列表，用
  `node scripts/snapshot-models.mjs --write` 刷新。由此带来三个后果：
  - 快照之后发布的模型会先拿到**同族**的实测数字（`qwen…`、`glm-…`、`grok-…` 等），而不是全局
    假定值；
  - 同族也匹配不上的模型才取 `defaultContextWindow` 与 `defaultMaxTokens`，这也是这两个值唯一
    仍是猜测的情形；
  - 服务列出、目录却没描述的 id，可以用 `models` / `modelOverrides` 配置解决，无需等插件发版。
  上限到达线上的方式不同：Messages 总会发送一个（`max_tokens`，缺省时回退到模型的值），而
  Chat Completions 与 Responses 在调用没有声明上限时就省略该字段，所以这个决定权在中继而不是
  本插件。
- **推理不会回放到 Responses API。** reasoning item 会针对 Harness 并未保留的上游状态做校验，
  不匹配就是一个含义不明的 `400`，所以该协议的请求里直接丢弃此前的思考，而不是发出去然后随机被
  拒。Messages 协议确实会回放 thinking block，并使用 provider 签发的签名。
- **历史里无法被回答的工具调用会直接丢弃，而不是发出去。** assistant 消息可能记录了一次从未被
  派发的 `tool-call`——进程在模型给出回答之后、工具启动之前就停了——于是历史里没有任何结果可回放。
  三种协议都拒绝这种「半对」：Responses API 回 `400 No tool output found for tool call <id>`，
  Messages 拒绝没有 `tool_result` 跟随的 `tool_use` 块。因此转换器在发出请求前会先通读历史，把缺少
  配对的调用、以及缺少调用的结果一并省略——单独发出任何一半都会让整轮失败，而两者都无法被重建。
  历史中的一个空洞只会让那一次调用从对话记录里消失，不再让整个会话失败。
- **线路上只有 `text` 与 `image`。** 目录给若干模型标了 `video`、`audio`、`pdf` 输入。这些会被记录
  并上报，但这里没有任何协议有对应字段，所以没有请求会携带它们，模型声明的 `inputModalities` 也
  永远不会声称支持。见[多模态](#多模态模型能接受什么与一条路由能发什么)。
- **图片输入取决于部署，而不只取决于模型。** `sendImages` 默认 `auto`：只有当 attachment seam 被
  挂载时才为视觉模型声明 `image`。没有该 seam 的部署上，模型会报告为纯文本，并附一句说明这条
  路由发不出去什么。
- **`stop` 原样转发。** 某个模型是否遵守 stop 序列是模型自己的事；插件不做任何额外声称。
- **一次挂载一个路由。** 挂载两次插件需要两个 `provider` 名和两把 API key。

## 目录结构

```
lib/
├── index.js                  adapter 类、注册、健康检查
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
└── transform/
    ├── messages.js           content block → 各协议的 messages
    ├── tools.js              tool schema → 各协议的声明
    └── reasoning.js          Harness 思考等级 → 各协议的拼写

scripts/
├── snapshot-models.mjs       从目录刷新 lib/model/limits.js
├── probe-protocols.mjs       实测每个在服务的模型接受哪些协议
└── probe-image.mjs           实测每种协议的图片请求形状
```

增加第四种协议意味着在 `protocol/` 下加一个新文件、在 transport map 里加一个条目——而不是重写。

## 许可证

MIT
