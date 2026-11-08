# 可靠性

> 返回 [README](../README.zh-CN.md)。

本页列出插件的失败码，以及由实测协议、服务自己公布的容量数字和 workspace 政策带来的限制。

## 失败

稳定的错误码，让使用方按 code 而不是按消息文本做分流：

`AUTH` · `QUOTA` · `RATE_LIMIT` · `CONTEXT_WINDOW_EXCEEDED` · `INVALID_REQUEST`
· `SERVER` · `TRANSPORT` · `ABORTED` · `TIMEOUT` · `MALFORMED_RESPONSE` ·
`STREAM_CLOSED` · `EMPTY_RESPONSE` · `UNSUPPORTED_CONTENT` · `UNSUPPORTED_OPTION`
· `PROTOCOL_UNSUPPORTED` · `MODEL_DEPRECATED` · `MODEL_UNAVAILABLE` ·
`TRAINING_CONSENT_REQUIRED` · `MISSING_CREDENTIAL` · `INVALID_CREDENTIAL`

凭据解析不出来时，会在任何网络 I/O 之前以 `MISSING_CREDENTIAL` 失败；凭据中含有 HTTP 请求头
无法承载的字符时以 `INVALID_CREDENTIAL` 失败。这两条消息都不包含密钥的任何部分。重试无法绕过的
那种拒绝——workspace 尚未允许会训练请求数据的模型——是 `TRAINING_CONSENT_REQUIRED`，它的消息
直接点名要开启的设置项；见[会训练请求数据的模型](models.zh-CN.md#会训练请求数据的模型)。

服务已经下线的模型会按它自己的身份上报，而不是被当成「请求格式错误」：`410 ModelDeprecated`
成为 `MODEL_DEPRECATED`，消息里带上服务给出的替代 id；`400 Model is unavailable.` 成为
`MODEL_UNAVAILABLE`。这两种都不会换一个协议重试——模型在所有端点上都已经消失，再试一次只会
重复同一条拒绝。目录不会删掉已失效的行，而是把该模型标成 `retired`，所以仍点名它的会话还能
解析出最后的实测数字并真的到达服务；它拿到的是上面这条分类，而不是「未知模型」错误。只有之后的
`GET /models` 重新列出该 id 时才会解除标记；见[已失效模型](models.zh-CN.md#已失效模型)。

失败按 Harness 读取的**形状**上报：一个带有自有 `code` 和 `failure` 数据属性的 `Error`，而不是
按类身份。本插件因此定义自己的失败类型，不依赖任何 Harness 包。

一次调用能留下的只有一个错误码和一句话，这不足以事后解释它：`TRANSPORT` 失败自己的消息就是
`fetch failed`，而这次请求是根本没连上、还是流到一半断的，取决于只有那次尝试知道的事实。所以每次
失败的尝试还会往[诊断日志](configuration.zh-CN.md#诊断日志)追加一行纯元数据——阶段、耗时、
`cause` 链——一次调用除了这些之外不写到任何地方。

## 限制

- **协议偏好是公布的，协议接受面是实测的。** `GET /models` 在每行的 `api` 映射里点名一个线协议
  入口，调用就从那个入口开始。它不是能力上限：2026-11-08 服务列出的每一个模型实测都接受三种协议，
  所以记录把其余两个留在它后面，只在服务回 `400 ModelProtocolUnsupported` 时才换到下一个入口。
  服务变更后用 `scripts/probe-protocols.mjs` 重新实测。两种「未知」的应对方式不同：服务**列出了**、
  但内置目录没有行的 id，从它 live 行点名的入口开始（行里没点名时用 `defaultProtocol`），其余协议
  留在后面；而哪里都找不到的 id——既不在内置目录、也不在已发现的列表里——会依次尝试每一个协议。
- **容量来自服务，快照是它的兜底。** 发现到的行带着模型的 `limit`（上下文与输出上限，少数模型还有
  输入上限）、`modalities`、`capabilities`（含该模型自己的思考阶梯）与 `api`；
  `lib/model/cache.js` 保存这些行，目录直接读它们，所以快照之后发布的模型也能报告真实数字。
  `lib/model/limits.js` 保存着在 `CAPABILITY_SOURCE` 所记日期（`models.dev/opencode-go@2026-11-08`）
  从 OpenCode 目录实测来的同一组事实，在发现没有描述某个模型时作答：`modelSource: config` 下
  没有写容量的条目、没有网络、答案为空、或缓存是行里还没有这些事实之前写入的。两张表也会保留
  服务不再提供的模型的行，所以已失效的 id 仍能解析出最后的实测数字。由此带来三个后果：
  - 两个来源都没描述的模型会先拿到**同族**的实测数字（`qwen…`、`glm-…`、`grok-…` 等），而不是
    全局假定值；
  - 同族也匹配不上的模型才取 `defaultContextWindow` 与 `defaultMaxTokens`，这也是这两个值唯一
    仍是猜测的情形；
  - 服务列出、两个来源都没描述的 id，可以用 `models` / `modelOverrides` 配置解决，无需等插件发版。
  上限到达线上的方式不同：Messages 总会发送一个（`max_tokens`，缺省时回退到模型的值），而
  Chat Completions 与 Responses 在调用没有声明上限时就省略该字段，所以这个决定权在中继而不是
  本插件。
- **思考阶梯是逐模型的。** 服务在 `capabilities.reasoning.effort` 里公布每个模型自己的档位列表；
  解析出的元数据公布的就是这份列表，并按它首选协议能表达的等级收窄。`none` 是服务表达「可以关掉
  思考」的方式，本适配器用「省略参数」表达它，因此从不公布；`xhigh` 和其它档位一样是合法等级。
  服务给了 `supported: true` 却没给列表的模型，保留内置的那一份。
- **有两个模型被 workspace 策略门控，而不是被本插件门控。** 中继只在 workspace 允许「用请求数据
  训练的 provider」时才会服务 `…-contributor` 这两个 id，并且在请求到达模型之前就用自己的错误拒掉。
  适配器把这条拒绝单独归类（`TRAINING_CONSENT_REQUIRED`），在消息里写清要开启的设置项及其位置，
  在模型元数据里给出说明，并为开不了该设置的部署提供 `hideTrainingModels`；它不提供任何开关去
  代替部署给出这份同意。见[会训练请求数据的模型](models.zh-CN.md#会训练请求数据的模型)。
- **推理只在相应上游需要时才回放到 Responses API。** DeepSeek 的思考模式在请求带 tools 时，若没有
  把此前每一轮的推理交回就会拒绝，所以这些模型会在 assistant 消息之前收到一个纯文本 `reasoning` 项。
  同一条线路上的 OpenAI 与 xAI 上游会用自己保存的状态校验回放的 reasoning 项，不匹配就是一个含义
  不明的 `400`，因此它们的请求仍然一个都不发。这条判断是模型目录里的事实（`requiresReasoningReplay`），
  不是协议规则。Messages 协议会回放 thinking block，并使用 provider 签发的签名。
- **历史里无法被回答的工具调用会直接丢弃，而不是发出去。** assistant 消息可能记录了一次从未被
  派发的 `tool-call`——进程在模型给出回答之后、工具启动之前就停了——于是历史里没有任何结果可回放。
  三种协议都拒绝这种「半对」：Responses API 回 `400 No tool output found for tool call <id>`，
  Messages 拒绝没有 `tool_result` 跟随的 `tool_use` 块。因此转换器在发出请求前会先通读历史，把缺少
  配对的调用、以及缺少调用的结果一并省略：单独发出任何一半都会让整轮失败，而两者都无法被重建。
  历史中的一个空洞只会让那一次调用从对话记录里消失。
- **线路上只有 `text` 与 `image`。** 服务给若干模型标了 `video`、`audio`、`pdf` 输入。这些会被记录
  并上报，但这里没有任何协议有对应字段，所以没有请求会携带它们，模型声明的 `inputModalities` 也
  永远不会声称支持。见[多模态](models.zh-CN.md#多模态模型能接受什么与一条路由能发什么)。
- **图片输入取决于部署，而不只取决于模型。** `sendImages` 默认 `auto`：只有当 attachment seam 被
  挂载时才为视觉模型声明 `image`。没有该 seam 的部署上，模型会报告为纯文本，并附一句说明这条
  路由发不出去什么。
- **工具读到的图片会到模型手里，形状按协议来。** `read_image` 把它读到的画面写入会话，本适配器
  把图片交给 provider：Responses 与 Messages 放在结果里，Chat Completions 放在紧随其后的 `user`
  回合里——那里的 tool 消息是纯字符串。这类形状上的拒绝被归类为 `UNSUPPORTED_CONTENT`，而不是
  「请求格式错误」。读不了图片的路由仍会收到那段信封文字，以及一句点明「这张图没发出去」的说明，
  所以拒绝永远不会是静默的。
- **`stop` 原样转发。** 某个模型是否遵守 stop 序列是模型自己的事；插件不做任何额外声称。
- **大请求体的新连接是可选项。** 有些网络路径——包括透明代理的用户态 TCP 栈——会把「复用上一条
  keep-alive 连接」的大上传直接重置，而且发生在响应头之前。`freshConnectionOnLargeBody`
  （默认 `false`）会让请求体达到 `FRESH_CONNECTION_BYTES`（256 KiB）的每次尝试都要求
  `Connection: close`，使它走一条属于自己的连接；更小的调用保留已有连接。代价是每次大调用多一次
  握手，所以除非部署确实需要，它默认关闭。
- **一次挂载一个路由。** 挂载两次插件需要两个 `provider` 名和两把 API key。
