# dsh-llm-opencode-go

[English](README.md) | **简体中文**

[![npm 版本](https://img.shields.io/npm/v/dsh-llm-opencode-go)](https://www.npmjs.com/package/dsh-llm-opencode-go)
[![npm 下载量](https://img.shields.io/npm/dm/dsh-llm-opencode-go)](https://www.npmjs.com/package/dsh-llm-opencode-go)
[![离线检查](https://img.shields.io/badge/offline_checks-383-brightgreen)](docs/development.zh-CN.md)
[![ci](https://github.com/a2580vb/dsh-llm-opencode-go/actions/workflows/ci.yml/badge.svg)](https://github.com/a2580vb/dsh-llm-opencode-go/actions/workflows/ci.yml)
[![许可证](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 简介

![DeepSeek Harness Web 客户端里的用量面板：订阅的三个窗口在上，本路由的计数在下；左下是侧边栏底部的额度胶囊](https://raw.githubusercontent.com/a2580vb/dsh-llm-opencode-go/main/assets/screenshot-1-app.png)

*用量面板与侧边栏底部的额度胶囊，Web 客户端实拍。*

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，
把 **OpenCode Go**（`https://opencode.ai/zen/go/v1`）作为 DSH 的原生模型 provider 接入。

插件自己实现 OpenCode Go 提供的三种线格式：把 Harness 的 messages、tools、reasoning 翻译成
对应协议的请求，再把流式响应翻译回 DSH 的 `StreamChunk`。

```yaml
- insert:
    - id: opencode-go
      name: dsh-llm-opencode-go
      config:
        apiKeyEnv: OPENCODE_GO_API_KEY
```

这是全部必需配置。`apiKeyEnv` 是一个**凭据引用**，不是密钥值：密钥值不写进配置文件，插件每次请求
通过 Harness 的凭据接缝解析它，因此在 Web 的「模型」页写入的 key 对下一次调用即生效，无需重启。

## 功能

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
| **图形化配置** | Web 客户端里的一页，设置导航里有自己的一行，Plugins 页上本插件的行上也有配置控件：API 密钥、凭据引用、模型可见性、模型变体、获取模型列表、用量 |
| **快速入口** | 侧边栏底部的额度胶囊（每个窗口一枚环：`5H / 周 / 月`，各自显示剩余）、一个独立的用量面板（从该处或快捷键打开）、设置里的一个用量页 |
| **运行环境** | Node.js ≥ 20；无运行时依赖 |

## 安装使用方法

### 安装

```sh
dsh plugin add dsh-llm-opencode-go
```

安装后需要**完全重启**该 profile：bundle 层只在启动时读取。启动日志里应出现：

```
dsh-llm-opencode-go: provider "opencode-go" ready at https://opencode.ai/zen/go/v1 (credential OPENCODE_GO_API_KEY, models discover)
```

### 给它一个 Key

可以在启动 DSH 的环境里导出 `OPENCODE_GO_API_KEY`，也可以走凭据接缝写入它——Web 的「模型」页
写的就是这里。插件按请求解析这个引用，两种方式都可用，且都不需要重启。

### 查看用量

用量有三个入口，读的是同一份数据：

| 入口 | 位置 |
|---|---|
| **侧边栏底部的额度胶囊** | Settings 旁边。一行三组——`◉ 5H 92% │ ◉ 周 58% │ ◉ 月 9%`——不点击即可见；点这一行打开用量面板，点右边的齿轮打开插件配置页。 |
| **用量面板** | 从胶囊那一行点开，或用快捷键（桌面端 `Ctrl/Cmd+U`）：订阅的三个窗口在上，本路由的计数在下，标题行在滚动时留在原处——上面有直达插件配置页的按钮和回到对话的 **×**。 |
| **设置 → 内置插件** | 一个页签，内容与用量面板相同。 |

三者都需要 Web 客户端；没有 Web 客户端的部署里这三者都不存在，插件其余部分不变。详见
[配置](docs/configuration.zh-CN.md#快速入口)。

## 配置方法

上面那段 `config` 是必需的全部；其余每个键都是可选的。完整字段表、目录塑造与图片输入见
[配置](docs/configuration.zh-CN.md)。

**换一个凭据引用**，让插件读取另一个名字的环境变量：

```yaml
config:
  apiKeyEnv: OC_KEY
```

配置文件里读取的永远只是变量**名**，不是它的值。

**用 Web 界面改。** 设置里有一行自己的 **OpenCode Go 设置**，排在 Harness 自带的那些页面之后；
侧边栏的 **Plugins** 页也能到同一页——`dsh-llm-opencode-go` 组合包中 `opencode-go` 行上有
**配置**（Configure）控件。两扇门打开的都是插件自己的页面：API 密钥、密钥所在的凭据引用、目录里每个
模型一个的「是否在选择器中出现」开关、模型变体、一个重新读取服务端模型列表的控件，以及这条路由
花掉了多少。密钥写进凭据存储，不写进 `cordis.patch.yml`；这一页只有提供 Web 客户端的部署才会
挂载。详见[配置](docs/configuration.zh-CN.md#图形化配置)。

## 文档

细节都在 [`docs/`](docs/models.zh-CN.md) 里，按需查阅：

- [模型](docs/models.zh-CN.md)——按模型选协议、训练数据门控、容量快照、text/image 划分
- [配置](docs/configuration.zh-CN.md)——完整字段表、塑造目录、图片输入、图形化配置与快速入口
- [线协议](docs/wire-protocol.zh-CN.md)——endpoint 与鉴权、`x-opencode-session`、推理与工具调用翻译
- [可靠性](docs/reliability.zh-CN.md)——稳定错误码与限制
- [开发](docs/development.zh-CN.md)——项目状态、验证套件、重测探针、目录结构

## 许可证

MIT
