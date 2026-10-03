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
| **图形化配置** | Web 客户端 Plugins 列表里的独立页面：API 密钥、凭据引用、模型可见性、模型变体、获取模型列表、用量 |
| **快速入口** | 侧边栏底部的额度胶囊（每个窗口一枚环：`5H / 周 / 月`，各自显示剩余）、一个独立的用量面板（从该处或快捷键打开）、设置里的一个用量页 |
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

### 随时看用量

用量不该需要先经过 Plugins 页。侧边栏底部一直带着那个数字，另外两处带着细节：

| 入口 | 位置 |
|---|---|
| **侧边栏底部的额度胶囊** | Settings 旁边。一行三组——`◉ 5H 92% │ ◉ 周 58% │ ◉ 月 9%`——一眼就能看到；点这一行打开用量面板，右边的齿轮直接打开上面那个配置页。 |
| **用量面板** | 从胶囊那些行点开，或用快捷键（桌面端 `Ctrl/Cmd+U`）：订阅的三个窗口在上，本路由的计数在下，右上角有直达插件配置页的按钮。它不占侧边栏的条目——那个数字已经在胶囊上了，一个数字只该有一个门。 |
| **设置 → Plugins → OpenCode Go 用量** | 设置面板里的一个页签，内容与用量面板相同。 |

需要 Web 客户端（与配置页同一个前提）；没有 Web 客户端的部署里这三者都不存在，插件其余部分不变。
详见[配置](docs/configuration.zh-CN.md#快速入口)。

### 或者用插件自己的页面

侧边栏的 **Plugins** 页列出 `dsh-opencode-go` 组合包，其中 `opencode-go` 行上有 **配置**
（Configure）控件，打开插件自己的页面：API 密钥、密钥所在的凭据引用、目录里每个模型一个的
「是否在选择器中出现」开关、模型变体、一个重新读取服务端模型列表的控件，以及这条路由花掉了多少。
密钥写进凭据存储，永远不写进 `cordis.patch.yml`；只有提供 Web 客户端的部署才会提供这一页。详见
[配置](docs/configuration.zh-CN.md#图形化配置)。

如果你希望插件读取另一个名字的环境变量，把 `apiKeyEnv` 指向它：

```yaml
config:
  apiKeyEnv: OC_KEY
```

配置文件里读取的永远只是变量**名**，不是它的值。

## 文档

细节都在 [`docs/`](docs/models.zh-CN.md) 里，按需查阅：

- [模型](docs/models.zh-CN.md)——按模型选协议、训练数据门控、容量快照、text/image 划分
- [配置](docs/configuration.zh-CN.md)——完整字段表、塑造目录、图片输入
- [线协议](docs/wire-protocol.zh-CN.md)——endpoint 与鉴权、`x-opencode-session`、推理与工具调用翻译
- [可靠性](docs/reliability.zh-CN.md)——稳定错误码与限制
- [开发](docs/development.zh-CN.md)——验证套件、重测探针、目录结构

快速检查：

```sh
npm test          # 离线运行，不需要凭据
```

cordis 与 live 套件见[开发](docs/development.zh-CN.md)。

## 许可证

MIT
