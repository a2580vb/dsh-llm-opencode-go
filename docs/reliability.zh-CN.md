# 可靠性

> 返回 [README](../README.zh-CN.md)。

本页讲的都是可能出错的地方，以及插件明确不做的事：稳定的失败码，以及由实测协议、容量快照和 workspace 政策带来的限制。

## 失败

稳定的错误码，让使用方按 code 而不是按消息文本做分流：

`AUTH` · `QUOTA` · `RATE_LIMIT` · `CONTEXT_WINDOW_EXCEEDED` · `INVALID_REQUEST`
· `SERVER` · `TRANSPORT` · `ABORTED` · `TIMEOUT` · `MALFORMED_RESPONSE` ·
`STREAM_CLOSED` · `EMPTY_RESPONSE` · `UNSUPPORTED_CONTENT` · `UNSUPPORTED_OPTION`
· `PROTOCOL_UNSUPPORTED` · `TRAINING_CONSENT_REQUIRED` · `MISSING_CREDENTIAL` ·
`INVALID_CREDENTIAL`

凭据解析不出来时，会在任何网络 I/O 之前以 `MISSING_CREDENTIAL` 失败；凭据中含有 HTTP 请求头
无法承载的字符时以 `INVALID_CREDENTIAL` 失败。这两条消息都不包含密钥的任何部分。而重试无法绕过的
那种拒绝——workspace 尚未允许会训练请求数据的模型——是 `TRAINING_CONSENT_REQUIRED`，它的消息直接
点名要开启的设置项；见[会训练请求数据的模型](models.zh-CN.md#会训练请求数据的模型)。

适配器失败是按 Harness 读取的**形状**上报的——一个带有自有 `code` 和 `failure` 数据属性的
`Error`——而不是按类身份。这就是本插件可以定义自己的失败类型、且不依赖任何 Harness 包的原因：
Harness 类的跨包副本在 Harness 里本来也永远不会被 `instanceof` 认出来。

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
- **有两个模型被 workspace 策略门控，而不是被本插件门控。** 中继只在 workspace 允许「用请求数据
  训练的 provider」时才会服务 `…-contributor` 这两个 id，并且在请求到达模型之前就用自己的错误拒掉。
  适配器做的是：把这条拒绝单独归类（`TRAINING_CONSENT_REQUIRED`）、在消息里写清要开启的设置项及
  其位置、在模型元数据里给出说明，并为开不了该设置的部署提供 `hideTrainingModels`——但它永远不会
  替你去开启，因为这份同意不是客户端可以给出的。见[会训练请求数据的模型](models.zh-CN.md#会训练请求数据的模型)。
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
  永远不会声称支持。见[多模态](models.zh-CN.md#多模态模型能接受什么与一条路由能发什么)。
- **图片输入取决于部署，而不只取决于模型。** `sendImages` 默认 `auto`：只有当 attachment seam 被
  挂载时才为视觉模型声明 `image`。没有该 seam 的部署上，模型会报告为纯文本，并附一句说明这条
  路由发不出去什么。
- **`stop` 原样转发。** 某个模型是否遵守 stop 序列是模型自己的事；插件不做任何额外声称。
- **一次挂载一个路由。** 挂载两次插件需要两个 `provider` 名和两把 API key。
