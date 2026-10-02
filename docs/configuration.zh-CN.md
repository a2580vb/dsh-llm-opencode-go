# 配置

> 返回 [README](../README.zh-CN.md)。

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
| `usagePath` | `~/.dsh/cache/opencode-go-usage.json` | 用量计数所在文件；路径不可写时只告警 |
| `models` | `[]` | 提示性目录条目；当 `modelSource: config` 时它就是整个目录 |
| `modelOverrides` | `{}` | 重塑某一个目录模型，而不必重述其余的 |
| `protocolOverrides` | `{}` | `{"<模型 id>": "<协议>"}` 简写 |
| `defaultProtocol` | `chat-completions` | 未指定协议的条目所用的协议 |
| `defaultContextWindow` | `262144` | 未描述模型的能力回退值 |
| `defaultMaxTokens` | `32768` | 未描述模型的输出上限回退值 |
| `reasoningEfforts` | `[minimal, low, medium, high, max]` | 可选的思考等级；按协议收窄 |
| `sessionHeader` | `session-id` | `session-id` \| `uuid` \| `off` |
| `sendClientHeader` | `true` | 是否发送 `x-opencode-client` |
| `sendImages` | `auto` | `auto` \| `always` \| `off`——是否尝试发送图片字节（见[模型](models.zh-CN.md#多模态模型能接受什么与一条路由能发什么)） |
| `disableReasoningReplay` | `false` | 不再回传此前的 reasoning（见[线协议](wire-protocol.zh-CN.md#推理)） |
| `hideTrainingModels` | `false` | 把 provider 会用请求数据训练的模型从列表中摘掉（见[模型](models.zh-CN.md#会训练请求数据的模型)） |
| `hiddenModels` | `[]` | 本部署要从列表中摘掉的模型 id；隐藏永远不等于不可用 |
| `modelVariants` | `[]` | 某个模型的命名预设，各自以 `<模型>@<名字>` 作为独立条目出现 |
| `healthCheck` | `off` | `startup` 会记录一份凭据 + 目录报告 |
| `retryPolicy` | normal，5 次重试 | 由重试执行器采用的 provider 自有策略 |

## 图形化配置

插件在 Harness Web 客户端里自带一个配置页。打开侧边栏的 **Plugins** 页，进入 `dsh-opencode-go`
组合包，在 `opencode-go` 行上点 **配置**（Configure）。这一页覆盖那些「随部署而定、又经常改」的
事实：

| | |
|---|---|
| **API 密钥** | 通过凭据接缝只写不读地存到 `apiKeyEnv` 名下。页面只报告是否已配置、来源是什么、能否覆盖——永远不显示密钥本身。 |
| **凭据引用** | 密钥存在哪个 `apiKeyEnv` 名下。 |
| **模型可见性** | 目录里每个模型一个开关，写入 `hiddenModels`。页面显示**整个**目录（包括当前已被隐藏的模型），因为只显示「已显示」的列表无法提供回头路。 |
| **模型变体** | 某个模型的命名预设，写入 `modelVariants`。 |
| **获取模型列表** | 按需重新读取 `GET /models`，并报告新增与消失的模型。这是页面上唯一会打到 provider 的控件。 |
| **用量** | 本插件自己记录的调用与 token，按模型、按天。 |

## 获取模型列表

`modelSource: discover` 的部署会读取一次 `GET /models`，并在 `modelsCacheSeconds` 内一直使用这份
答案。配置页可以按需重新读取，这是页面唯一会消耗一次请求的动作：

- **它报告的是变化**，而且是按**列表**而不是按原始答案计算的：某个模型服务端不再列出、但内置目录
  也认识它，它依然会被提供——说它「消失」等于描述一个没人看得见的变化。
- **读取失败不会让目录付出代价。** 上一次的答案原样保留，页面说明失败原因，模型依旧可调用。发现
  失败不该成为一个正常部署丢掉模型的理由。
- **只有第一次读取会被等待。** 其余一切——启动、列表、页面自身的加载——都由内存或缓存文件作答，
  所以打开页面不产生请求。

`modelSource: config` 没有可获取的东西：目录就是部署写下的那些条目，控件会直说，而不是假装去读。

## 从列表中隐藏模型

`hiddenModels` 是本部署自己的菜单选择：被点名的 id 从模型选择器里消失，但仍然可解析、可调用，所以
已经锁定某个模型的会话继续可用。它是 `hideTrainingModels` 的按模型版本——后者是数据政策立场而非
偏好：那个字段会把所有「provider 会用请求数据训练」的模型摘出列表，不管单个开关怎么设。

```yaml
config:
  hiddenModels:
    - space-bunny-free
    - glm-5.2
```

目录里没有的 id 会被保留而不是丢弃，所以提前隐藏一个 OpenCode 还没公布的模型，会在它出现的那一刻
开始生效；启动时会有一条告警点名目录里匹配不到的 id，那通常是拼写错误。配置页写的就是这个字段，
两者之所以一致，是因为它们读同一份「是否在列表中」的判断。

## 用量

插件自己统计这条路由上发生的事情，因为别的组件做不到：Harness 只把 token 数报给发起调用的那一方，
而只有适配器知道某个 token 属于哪个模型、由哪个部署付费。页面把结果呈现为合计、按模型的表，以及
按天的序列。

```
~/.dsh/cache/opencode-go-usage.json
{
  "version": 1,
  "updatedAt": 1767225600000,
  "days": { "2026-01-15": { "glm-5.3": { "requests": 12, "failures": 0, "inputTokens": …, … } } }
}
```

| 事实 | 统计方式 |
|---|---|
| **一次调用** | 每次 Harness 调用算一次，不管它试了几种协议：先回退、后成功的那次请求是一次调用，不是两次。 |
| **一次失败** | 以错误结束的调用，包括 provider 在还没有流之前就拒绝的那种。一个只会失败的模型，正是这张表存在的意义。 |
| **模型** | Harness 请求的 id，所以变体会以自己的别名出现。 |
| **日期** | 本机的日历日，所以 23:00 花掉的 token 属于它被花掉的那个晚上。 |
| **窗口** | 1、7、30 天。页面只能要求这三种；30 天的保留窗口会在写文件时被裁剪掉。 |
| **写入** | 延迟数秒合并，并在卸载时冲出，所以流式过程永远不会等一次 `fs` 调用，插件重载也不会丢掉尾巴。 |

有三条性质是有意为之：

- **它是报告，不是账单。** 这些是服务端报给这个客户端的数字。workspace 实际花了多少，以 provider
  自己的账目为准；暗示相反的页面会在一个人会据此行动的数字上说错话。
- **丢掉它永远不是失败。** 文件读不出来只意味着「还没有历史」，写不进去只产生一条告警，一次调用
  永远不会因为 token 数没能保存而失败。
- **它属于单个部署。** 两个 profile、两台机器各记各的。这里没有任何共享，也没有任何数据发往别处。

调用方中途弃掉的流不计入：这张表统计的是这条路由花掉了什么，而没有人观察到的结果不值得编造。

## 模型变体

变体是同一个模型的另一套设置，挂在一个名字下。它会作为独立条目出现在模型列表里——
`<模型>@<名字>`——所以「在预设之间选择」和「在模型之间选择」是同一个动作，会话也可以锁定其中
一个。

```yaml
config:
  modelVariants:
    - model: gpt-5.6-luna
      name: fast            # 条目就是 gpt-5.6-luna@fast
      label: Luna Fast      # 可选；不写就是「<模型名> (fast)」
      protocol: chat-completions
      effort: low
      contextWindow: 200000
      maxTokens: 32768
```

| 键 | 含义 |
|---|---|
| `model` | 被变体的模型，必须是目录里的 id，且不能包含 `@`。 |
| `name` | 变体自己的名字；`模型@名字` 就是它对外出现的 id。 |
| `label` | 可选的显示名。 |
| `protocol` | 可选。通过该变体的调用优先使用这个协议；该模型的其它协议仍然留在后面作为回退。 |
| `effort` | 可选。通过该变体的调用默认使用的思考等级。模型必须支持思考，且必须提供这个等级。 |
| `contextWindow`、`maxTokens` | 可选。变体对外声明的容量，替代模型自身的数字。 |

写之前值得知道的几条规则：

- **变体只是本地别名。** Harness 选择并报告的是 `<模型>@<名字>`；线上请求里仍然是 `model`。
  对 provider 而言，这个模型的任何事实都没变。
- **变体继承所有它没有重述的东西**，包括基础模型的容量、模态、思考阶梯，以及其余协议。
- **`model` 不在目录里的变体不会被提供**，启动时会有一条告警点名这些 id。否则它会声明没有任何
  实测依据的容量，并在调用最远端失败。
- **变体是默认值，不是牢笼。** `effort` 和 `maxTokens` 决定一次调用以什么开始；请求自己给了值就
  以请求为准。
- **两处矛盾会在启动时被拒绝**（各自点名），而不是被吸收：给不支持思考的模型设思考等级，以及设置
  该模型并不提供的思考等级。
- **条目只能带上面列出的键。** 页面写回的是它读到的内容加上你的改动；配置没有声明的键——无论是拼写
  错误，还是快照里恰好带的字段——都会被点名拒绝，而不是写进 `cordis.patch.yml`。

其余字段——协议塑造、超时、重试策略、缓存路径——仍然留在 `cordis.patch.yml`：机器可读的值就写在
解释它的注释旁边。

有两点值得写清楚，因为它们决定一个部署能期待什么：

- **这一页在两个方向上都是可选的。** 只有当部署挂了 web server、并且为该组合包注册了客户端半侧
  时，它才会被提供。无头部署既没有这条路由也没有这一页，插件的行为完全相同。
- **它不是另一条鉴权旁路。** `/opencode-go/*` 只回答连接服务放行的请求——用的是整个 GUI 同一套
  Host/`Origin` 栅栏加浏览器会话校验。没有连接服务时，只有回环地址会被应答。

凭据引用只是一个**名字**，可以随意修改；背后的密钥存在凭据存储里。如果启动环境里已经提供了同名
变量，页面会把它报成只读、拒绝覆盖——请先在启动的 shell 里清掉那个变量。

## 调整目录

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

## 图片输入

图片输入跟着模型走。在[模型页](models.zh-CN.md#容量与多模态)里的视觉模型会声明 `image`，适配器随后通过挂载的
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
