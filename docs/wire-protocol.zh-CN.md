# 线协议

> 返回 [README](../README.zh-CN.md)。

本页描述过线的内容：三个 endpoint 与鉴权、会话亲和的请求头，以及推理与工具调用按协议做的翻译。

## Endpoint 与鉴权

| 协议 | 路径 | 鉴权 |
|---|---|---|
| Chat Completions | `POST {baseURL}/chat/completions` | `Authorization: Bearer <key>` |
| Responses | `POST {baseURL}/responses` | `Authorization: Bearer <key>` |
| Messages | `POST {baseURL}/messages` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |

Messages 端点使用自己的一套请求头：它会以 `AuthError: Missing API key` 拒绝 bearer token。

三个端点都接受 `GET /models` 列出的每一个模型：目录的 `api` 映射点名的只是每个模型的首选入口，
不是白名单，2026-11-08 的探测中每个在服 id 的三种协议全部被接受。该映射还会点名每种协议自己的
SDK base URL（`/inference/go/openai/…`、`/inference/go/anthropic/…`）；中继在统一的 `{baseURL}`
下同样服务这三种协议，本插件用的就是后者。优先级顺序与 `ModelProtocolUnsupported` 时的回退见
[模型](models.zh-CN.md#按模型选择协议)。

每个请求还会带上：

```http
User-Agent: dsh-opencode-go/0.2.4
x-opencode-session: <每个会话一个稳定 id>
x-opencode-client: dsh-opencode-go
```

这两个产品标识是 `userAgentProduct` 的默认值，取值与包名 `dsh-llm-opencode-go` 不同；需要它们与包名
一致时，设置 `userAgentProduct`。

## `x-opencode-session`

OpenCode 的中继会把共享同一个 `x-opencode-session` 值的所有请求钉在同一个上游后端上，这样一次对话
的多个轮次能继续命中同一份 prompt 缓存。这个值只需是**每个会话**不透明且稳定的；固定同一个值会让
所有会话共用同一条缓存血缘。适配器从每次调用本就携带的 DSH session id 派生它：

- `session-id`（默认）——直接使用 DSH session id：每个会话唯一，跨轮次、跨压缩、跨重试、跨进程
  重启都稳定。
- `uuid`——按 session id 派生一次的不透明随机 UUID，并在进程内记住；适合不希望外发 Harness id
  的部署。
- `off`——什么都不发。插件会在启动时告警：OpenCode 可能因此拒绝请求或丢失缓存亲和。

没有 session id 的辅助调用（会话标题生成）仍然会得到一个进程级回退值，而不是缺失该请求头。

## 系统提示词

请求同时携带两类系统指引：一次性调用使用的 `GenerateOptions.system`，以及 Agent Loop 用来提供当前提示词
和计划模式策略的 `system` 消息；两者都不会被丢弃。Responses 与 Messages 按这个顺序把非空文本合并为顶层的
`instructions` 与 `system` 字段；Chat Completions 先发送请求级文本，再发送各条 system 消息。Responses
不会在 `input` 中生成 `system` 条目。

## 推理

每种协议对「思考」的拼写都不同，中继会校验拼写，翻译由一个函数统一负责：

| 协议 | 字段 | 接受的等级 |
|---|---|---|
| Chat Completions | `reasoning_effort` | `minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| Responses | `reasoning.effort` | `low`、`medium`、`high`、`xhigh`、`max`（`minimal` 会被拒绝） |
| Messages | `thinking.budget_tokens` | 由等级映射而来：1024 / 4096 / 8192 / 16384 / 32768 / 64000 |

模型解析出的元数据公布的是服务为该模型公布的那份档位列表（`capabilities.reasoning.effort`），
并按它首选协议能表达的等级收窄，因为运行时会在任何网络 I/O 之前用那个集合校验请求的思考等级。
`none` 是服务表达「关掉思考」的档位，这里用「省略参数」来表达，因此从不公布；`xhigh` 与其它
档位一样是合法等级。服务标了「支持思考」却没给列表的模型，保留内置的那一份。Anthropic 的 budget
会被严格限制在 `max_tokens` 以下；如果输出上限连最小的 budget 都装不下，就省略 thinking，而不是
发一个 API 必然拒绝的请求。

**推理历史**只在协议支持的情况下回放：Chat Completions 接收 `reasoning_content`，Messages 接收
带 provider 签发签名的 thinking block（按 block 的确切文本寻址，在没有保留签名时降级为纯文本）。
Responses 上则只为**上游要求**的模型回放——`deepseek-*` 家族的思考模式在请求带 `tools` 时，若没有
把此前每一轮的推理交回就会拒绝——以纯文本 `reasoning` 项、`summary` part 的形式，紧挨在它所属的
assistant 消息之前。同一条线路上的其他上游（OpenAI、xAI）自己保存推理状态，并会用该状态校验回放的
reasoning 项，所以那些请求仍然一个都不发；这条判断记在模型目录记录上（`requiresReasoningReplay`），
不在协议层。设置 `disableReasoningReplay: true` 可在任何协议上都不发送推理历史。

只有推理、没有正文也没有工具调用的 assistant 回合不会被回放：Chat Completions 拒绝既无
`content` 也无 `tool_calls` 的消息，Responses 上也没有可让推理项紧挨其前的 assistant 项。
被中断的步骤可能留下这样一条回合，它会被整条略过，推理也一并略过。

## 工具调用

工具按各协议自己的拼写过线——Responses 是扁平声明加 `function_call`/`function_call_output` 配对，
Chat Completions 是 `function` 包装加 `tool_calls` 与 `role: "tool"`，Messages 是
`tool_use`/`tool_result` 块——历史也按当初回答它的同样形状回放。

工具结果的 content 与用户那一轮走同一套转换，正因如此，工具才能把一张图片交回来：`read_image`
的返回是一段信封文字加图片本身。在 Responses 与 Messages 上，这张图**走在结果里面**——
`function_call_output` 条目的 `output` 部件，或 `tool_result` 的 `content` 块。Chat Completions
的 tool 消息是纯字符串，所以结果只带文字，图片改为跟在**并行结果组的最后一条之后**、单独一条
`user` 回合里。不带图片的结果在三条线上都是纯字符串。这两种形状都可以对着线上服务复核；见
[模型](models.zh-CN.md#多模态模型能接受什么与一条路由能发什么)。

三种翻译都遵守同一条规则，因为三条线上都强制它：**调用与结果要么一起发出，要么都不发。**
Responses API 对没有结果的调用回 `400 No tool output found for tool call <id>`；Chat Completions
要求 assistant 发出 `tool_calls` 之后的那一轮必须回答它给出的每一个 id；Messages 拒绝没有
`tool_result` 跟随的 `tool_use` 块。历史里确实可能出现「有调用没结果」——Harness 记录了模型的
`tool-call`，而进程在派发之前就停了，于是永远没有追加结果——所以转换器在发出任何内容之前会先通读
整段历史，把没有配对的那一半省略。见[可靠性](reliability.zh-CN.md#限制)。
