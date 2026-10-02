# 模型

> 返回 [README](../README.zh-CN.md)。

本页讲的都是模型目录：每个模型走哪种线协议、哪些模型受训练数据政策门控、目录上报的容量与输入模态。这三份事实来自同一组实测量（`lib/model/catalog.js`、`lib/model/limits.js`）。

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
| `muse-spark-1.3-contributor`、`muse-spark-1.2-contributor` | responses，且仅在 workspace 允许「用请求数据训练的 provider」时可用（见[会训练请求数据的模型](#会训练请求数据的模型)） |

`GET /models` 返回的每一个 id 在这张表里都有对应行，所以没有任何一个在服务的模型需要先失败一次
才能确定自己的协议。服务变更后用[开发](development.zh-CN.md#重新实测线上事实)里描述的探针重新实测即可。

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

## 会训练请求数据的模型

Go 上有两个模型——`muse-spark-1.3-contributor` 与 `muse-spark-1.2-contributor`——便宜的原因不是价格
而是数据政策：它们的 provider 会用你的 prompt 与补全训练后续模型。因此中继把它们的准入绑在
**workspace** 设置上，并且在请求到达模型之前就拒掉：

```json
{"type":"error","error":{"type":"DataPolicyError","message":"This model collects data used to improve its quality and requires explicit opt in: https://opencode.ai/workspace/<workspace>/go"}}
```

有些部署会把上游服务的同一条拒绝透传成 `400`，带上 `Account.TrainingNotAllowed` 错误码和
「This Go model trains on request data…」这句话；两种写法本插件都认得。在管理员开启
**Allow models that train on request data** 之前，对这些 id 的每一次调用都会失败——在 OpenCode 里
也一样。开关在 workspace 的 Go 页面（`https://opencode.ai/workspace` → 该 workspace → Go →
Providers）；侧边栏里找不到它的 console 版本，用 `…/settings/privacy` 也能直达。

由此得出三条本适配器的行为准则，其中没有一条是「再问一次服务」：

- **这条拒绝被单独命名，而不是被泛化。** 它以 `TRAINING_CONSENT_REQUIRED` 上报，消息里带上要开启
  的设置项和开启的位置，而不是报成 `INVALID_REQUEST`（请求本身没有任何问题）或 `AUTH`（凭据是好的）。
  它也不会去试别的协议：这是账号级策略，换一个协议不可能得到不同答案。
- **模型在「被选中」的阶段就说明自己的前提。** 被门控的模型在列表和解析出的元数据里都带一条说明，
  选择器可以在第一次调用之前就显示这个前提，而不是在调用被拒之后。
- **插件永远不会替你给出这份同意。** 你的 prompt 是否可以用于训练第三方的模型，是 workspace 所有者的
  决定，所以这里没有任何 header、body 字段或配置开关去翻它；适配器只负责报告。它会在目录组装时把被
  门控的模型记一行日志——比第一次被拒更早。

开不了这个设置的部署——例如该模型在所在地区不提供，或一条路由被多个账号共用——可以把这些 id 从模型
列表里摘掉：

```yaml
config:
  hideTrainingModels: true
```

「隐藏」只影响列表，不影响路由：这些 id 依然能被解析、依然能发起流式调用，所以已经在用它的会话不会
中断，而之后开启 workspace 设置也不需要改插件。

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
从响应里读取；见[配置](configuration.zh-CN.md#调整目录)。

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
base64 `source`。这是对线上实测的结论，不是假设——见[开发](development.zh-CN.md#重新实测线上事实)。
