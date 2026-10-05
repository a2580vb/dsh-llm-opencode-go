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

每个请求还会带上：

```http
User-Agent: dsh-opencode-go/0.1.1
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

## 推理

每种协议对「思考」的拼写都不同，中继会校验拼写，翻译由一个函数统一负责：

| 协议 | 字段 | 接受的等级 |
|---|---|---|
| Chat Completions | `reasoning_effort` | `minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| Responses | `reasoning.effort` | `low`、`medium`、`high`、`xhigh`、`max`（`minimal` 会被拒绝） |
| Messages | `thinking.budget_tokens` | 由等级映射而来：1024 / 4096 / 8192 / 16384 / 32768 / 64000 |

模型解析出的元数据只公布其协议能表达的等级，因为运行时会在任何网络 I/O 之前用那个集合校验请求的
思考等级。Anthropic 的 budget 会被严格限制在 `max_tokens` 以下；如果输出上限连最小的 budget 都
装不下，就省略 thinking，而不是发一个 API 必然拒绝的请求。

**推理历史**只在协议支持的情况下回放：Chat Completions 接收 `reasoning_content`，Messages 接收
带 provider 签发签名的 thinking block（按 block 的确切文本寻址，在没有保留签名时降级为纯文本）。
Responses API 不回放推理历史，因为 reasoning item 会针对 Harness 并未保留的上游状态做校验。设置
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
整段历史，把没有配对的那一半省略。见[可靠性](reliability.zh-CN.md#限制)。
