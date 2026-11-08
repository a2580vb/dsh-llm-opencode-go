# 模型

> 返回 [README](../README.zh-CN.md)。

本页描述模型目录：服务为每个模型公布了什么、适配器如何发起调用、哪些模型受训练数据政策门控，以及
目录上报的容量与输入模态。目录由 live 的 `GET /models` 行搭起，实测协议表与 `models.dev` 容量快照
作为它的兜底（`lib/model/catalog.js`、`lib/model/limits.js`）。

## 按模型选择协议

OpenCode Go 提供三种线格式协议。它的目录在每行的 `api` 映射里点名一个**首选入口**——
`chat-completions`、`responses` 或 `messages`——但那只是推荐，不是能力上限：2026-11-08 的探测中，
服务列出的每一个模型都接受了全部三种协议。所以每个模型携带的是一份有序协议列表，首选入口在前，
其余两个在它后面。如果调用仍然以这种方式被拒绝，它会回答：

```json
{"type":"error","error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}
```

适配器记录日志，并用该模型的下一个协议重试同一调用。按每行点名的入口分组，建模的顺序是：

| 模型 | 协议（按顺序） |
|---|---|
| `beam-free`、`deepseek-v4.1-flash`、`deepseek-v4-pro`、`glm-5.2`、`glm-5.3`、`glm-5.3-flash`、`hy3`、`hy4`、`hy4-preview`、`iceman-contributor-free`、`kimi-k2.7-code`、`kimi-k3`、`kimi-k3.1-pro`、`longcat-2.0`、`mimo-v2.6-flash`、`mimo-v2.6-pro`、`minimax-m3.1-flash`、`step-5-preview` | chat-completions、responses、anthropic |
| `crouton-alpha-free`、`gemini-4-argon`、`gpt-5.6-luna`、`gpt-6-luna`、`grok-4.7` | responses、chat-completions、anthropic |
| `claude-haiku-5-5`、`minimax-m3`、`qwen3.7-plus`、`qwen3.8-flash`、`qwen3.8-max` | anthropic、responses、chat-completions |
| `muse-spark-1.3-contributor`、`muse-spark-1.2-contributor` | responses、chat-completions、anthropic，且仅在 workspace 允许「用请求数据训练的 provider」时可用（见[会训练请求数据的模型](#会训练请求数据的模型)） |

内置目录为 `GET /models` 在 2026-11-08 列出的每一个 id 都有一行**在服**记录，所以没有在服模型
需要先失败一次才能发现自己的协议。这张表只增不删：服务不再提供某个模型时，它的行会保留下来并标上
`retired`，带着最后一次实测的协议列表——仍点名它的会话因此还能解析（见[已失效模型](#已失效模型)）。
服务变更后用[开发](development.zh-CN.md#重新实测线上事实)里描述的探针重新实测即可。

`api` 映射还会点名每种协议自己的 SDK base URL（`/inference/go/openai/…`、
`/inference/go/anthropic/…`、`/inference/go/google/…`）。那些是目录给 SDK 的入口；中继在统一的
`baseURL` 下同样服务这些协议，本插件用的就是后者，因此不需要换 host。唯一一行点名 Google
`generate-content` 的模型（`gemini-4-argon`）在这里同样走三种协议——本适配器没有 Google 传输层，
所以它的行以 responses 开头。

用 `protocolOverrides` 可以改某个模型的开场协议，该模型的其它协议仍留在后面作为回退：

```yaml
config:
  protocolOverrides:
    gpt-5.6-luna: chat-completions
```

目录没有描述的模型分两种情况：

- **服务列出了、但本插件没有内置行的 id**：它 live 行里的 `api` 入口先上，其余协议留在后面；
  行里没有本适配器能承载的入口时，用 `defaultProtocol` 开场，其余的同样留在后面。
- **哪里都找不到的 id**——新到 `GET /models` 都还没收录，或者走的是没有发现能力的网关：协议
  未知，会依次尝试每一个协议。

两种情况都不需要插件发新版本就能用上新模型。

## 已失效模型

内置目录只增不删。服务停止提供某个模型时，它的行不会被删除，而是标上 `retired`，保留最后一次作答
用的协议与它在 `lib/model/limits.js` 里的容量。已失效的行与「未知 id」正好相反——它被完整描述，
只有服务能拒掉它：

- **不在列表中。** 模型选择器不会出现已失效的 id。配置页仍显示它的行，带一个警告色的 `已失效`
  标签（服务点名了继任者时是 `已失效 → <继任者>`），复选框被禁用；如果部署自己的
  `hiddenModels` 也点了它，快照里的 `hiddenReason` 会报 `configured` 而不是 `retired`，
  因为那次选择更早。
- **仍可解析。** 仍点名该 id 的会话会解析出它最后的实测容量——`lib/model/limits.js` 里当前表或
  已下线表的那一行，两者都没有时用同族数字。解析一个已失效模型不是错误；错的只是线上调用。
- **由服务拒绝。** 调用会按该行最后一次的协议顺序尝试，并以服务自己的 `MODEL_DEPRECATED`
  （带它点名的继任者）或 `MODEL_UNAVAILABLE` 结束。不会再试别的协议，适配器也不会自己造一个
  「未知模型」错误——服务给什么答案，就是实际发生了什么。
- **由发现解除，不由配置解除。** 若之后的 `GET /models` 又列出了这个 id，它的行会自动恢复为
  在服。改 `models` 或 `modelOverrides` 都解不开这个标记：是否失效是关于服务的事实，不是部署的
  设置。

有六个已失效 id 给出了迁移目标：

| 已失效 id | 继任者 |
|---|---|
| `glm-5.1` | `glm-5.3` |
| `kimi-k2.6` | `kimi-k2.7-code` |
| `mimo-v2.5` | `mimo-v2.6-flash` |
| `mimo-v2.5-pro` | `mimo-v2.6-pro` |
| `minimax-m2.7` | `minimax-m3.1-flash` |
| `qwen3.7-max` | `qwen3.8-max` |

其余九个没有继任者：`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-flash`、
`grok-4.6`、`minimax-m2.5`、`qwen3.6-plus`、`space-bunny-free`、`longcat-2.5-preview-free`、
`omen-alpha`。

维护规则两个方向都一样：新出现的模型加一行，服务判定失效的模型做标记——任何一行都不会被删掉，
所以锁定某个 id 的会话永远能解析出它当时在用的东西。

## 会训练请求数据的模型

`muse-spark-1.3-contributor` 与 `muse-spark-1.2-contributor` 的 provider 会用请求的 prompt 与补全
训练后续模型。中继把它们的准入绑在 **workspace** 设置上，并在请求到达模型之前就拒掉：

```json
{"type":"error","error":{"type":"DataPolicyError","message":"This model collects data used to improve its quality and requires explicit opt in: https://opencode.ai/workspace/<workspace>/go"}}
```

有些部署会把上游服务的同一条拒绝透传成 `400`，带上 `Account.TrainingNotAllowed` 错误码和
「This Go model trains on request data…」这句话；两种写法本插件都认得。在管理员开启
**Allow models that train on request data** 之前，对这些 id 的每一次调用都会失败——在 OpenCode 里
也一样。开关在 workspace 的 Go 页面（`https://opencode.ai/workspace` → 该 workspace → Go →
Providers）；侧边栏里找不到它的 console 版本，用 `…/settings/privacy` 也能直达。

适配器对这类拒绝的处理：

- **单独分类，不去试别的协议。** 它以 `TRAINING_CONSENT_REQUIRED` 上报，消息里带上要开启的设置项
  和开启的位置，不报成 `INVALID_REQUEST`（请求本身没有任何问题）或 `AUTH`（凭据是好的）。这是
  账号级策略，换一个协议不可能得到不同答案。
- **在「被选中」的阶段就说明前提。** 被门控的模型在列表和解析出的元数据里都带一条说明，选择器可以
  在第一次调用之前就显示这个前提，而不是在调用被拒之后。
- **不代替部署修改设置。** 插件没有提供任何 header、body 字段或配置开关去翻这个开关；它只负责报告。
  目录组装时，它会为被门控的模型记一行日志。

开不了这个设置的部署——例如该模型在所在地区不提供，或一条路由被多个账号共用——可以把这些 id 从模型
列表里摘掉：

```yaml
config:
  hideTrainingModels: true
```

「隐藏」只影响列表，不影响路由：这些 id 依然能被解析、依然能发起流式调用，所以已经在用它的会话不会
中断，而之后开启 workspace 设置也不需要改插件。

## 容量与多模态

`GET /models` 会描述每一个模型。一行（裁到本适配器会读的字段）看起来像：

```json
{
  "id": "deepseek-v4.1-flash",
  "name": "DeepSeek V4.1 Flash",
  "description": "DeepSeek V4.1 Flash model for reasoning and agentic coding",
  "limit": { "context": 1000000, "output": 384000 },
  "modalities": { "input": ["text", "image/jpeg", "image/png"], "output": ["text"] },
  "capabilities": {
    "tools": { "supported": true },
    "reasoning": { "supported": true, "effort": ["low", "high", "max"] }
  },
  "api": { "chat-completions": { "base_url": "https://opencode.ai/inference/go/openai/v1" } }
}
```

live 行里的 `created` 是请求时刻，不是模型的发布时间；发布时间由 `release_date` 与
`last_updated` 表达。发现到的行是模型事实的第一来源：`limit` 给出上下文窗口与输出上限（少数模型
还有 `limit.input` 这个单次输入上限，本适配器不为它单独建模），`modalities` 给出 provider 的输入
列表，`capabilities.reasoning.effort` 给出思考阶梯，`api` 点名首选协议。发现路径把这些行保存进
缓存，所以快照之后才发布的模型也能报告自己的数字。

它背后还有一份快照。`lib/model/limits.js` 保存着在 `CAPABILITY_SOURCE` 所记日期
（`models.dev/opencode-go@2026-11-08`）从 OpenCode 目录（`models.dev`）实测来的同一组事实。
发现没有描述某个模型的时候由它作答——`modelSource: config` 模式下没有写容量的条目、没有网络的
部署、只回 id 的网关、或在行里带上这些事实之前写下的缓存文件——因为需要上下文窗口的调用不能等
一个第三方 endpoint，而没有外网的部署也得能显示真实上限。每个模型解析出的都是自己的数字：

| 模型 | 上下文 | 输出上限 | 模型输入 |
|---|---|---|---|
| `deepseek-v4.1-flash` | 1,000,000 | 384,000 | text、image |
| `gpt-5.6-luna` | 1,050,000 | 128,000 | text、image、pdf |
| `grok-4.7` | 500,000 | 500,000 | text、image、pdf |
| `claude-haiku-5-5` | 1,000,000 | 128,000 | text、image、pdf |
| `kimi-k2.7-code` | 262,144 | 262,144 | text、image、video |
| `mimo-v2.6-pro` | 1,048,576 | 131,072 | text、image、audio、video |
| `hy3` | 256,000 | 128,000 | text |

两个来源都没描述过的模型——两边之后才发布的那个——会先匹配到**同族**的实测数字（`qwen…`、
`glm-…`、`grok-…` 等），最后才退回 `defaultContextWindow`。会公布同一组字段的兼容网关也按同样的
方式读取；见[配置](configuration.zh-CN.md#调整目录)。行里的 `capabilities.reasoning.effort` 就是
该模型「对外公布的思考阶梯」，见[线协议](wire-protocol.zh-CN.md#推理)。

### 多模态：模型能接受什么，与一条路由能发什么

live 行用 MIME 类型列输入模态（`image/jpeg`、`application/pdf`、`video/mp4` 等）；快照用目录
词表列同样的能力（`image`、`pdf`、`video` 等）。两者都会归一化成同一份列表——归一之后，服务公布的
能力里仍有一些是这里任何线协议都没有对应字段的——`video`、`audio`、`pdf`——所以两个事实被分开
保存：

- **`providerModalities`** 是 provider 自己的列表，归一成这些名字后原样保留。
- **`inputModalities`** 是本适配器真正能放进请求里的东西。Harness 只建模两种，本适配器也只对两种
  有线路表达，所以解析出的模型只声明 `['text']` 或 `['text', 'image']`。

这个区分是可观察的：Harness 依据解析出的列表来投影持久的 image block——声明了 `image` 的路由会拿到
真实的 image block，并且必须解析出它的字节；没声明的只会拿到文本占位符。因此，「模型支持、但这条
路由发不出去」的能力会以一句说明的形式出现：

```
"description": "the model also accepts video, audio, which no protocol on this route can send"
```

`sendImages` 决定是否真的尝试发送图片字节：

| 取值 | 效果 |
|---|---|
| `auto`（默认） | 当**本部署能解析图片字节**（即挂载了 attachment seam）时，为视觉模型声明 `image`；否则报告为纯文本，并说明省略了什么。 |
| `always` | 只要该模型的行接受图片就声明 `image`，无论有没有挂载 seam。此时含图片的请求会带着原因失败，而不是静默地只发文本。 |
| `off` | 从不声明 `image`。 |

如果你的部署把图片挂在别处而不是 attachment seam，就设为 `always`：

```yaml
config:
  sendImages: always
```

声明之后三种协议都能携带图片：Chat Completions 与 Responses 收到 `data:` URL 部件，Messages 收到
base64 `source`。图片经两条路进到模型——贴在某一轮里，或由工具返回：`read_image` 的返回就是一段
文字加图片本身。Responses 与 Messages 把它**放在工具结果里**（`function_call_output` 的 `output`
部件，或 `tool_result` 的 `content`）；Chat Completions 则把结果发成字符串、把图片放在紧随其后的
那一轮里。这是对线上实测的结论，可用
[开发](development.zh-CN.md#重新实测线上事实)里的探针复核。
