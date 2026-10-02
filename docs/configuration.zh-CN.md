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
