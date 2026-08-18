# Agent Framework Insights

> 两套面向"彻底剖析"的中文技术课程,分别系统性拆解两个真实开源 Agent Harness 项目的架构：先会用，再懂原理，最后能扩展。每篇文章都摘录真实源码并逐段讲解设计动机，而不是停留在使用文档层面。

## 课程一：PI（[earendil-works/pi](https://github.com/earendil-works/pi)）

一个极简终端编码 Agent 项目：核心保持精简，几乎所有能力都通过 TypeScript 扩展、Skills、Prompt 模板挂载；统一多模型层覆盖 OpenAI/Anthropic/Google/Bedrock。

👉 从 [PI/00-课程导读/README.md](PI/00-课程导读/README.md) 开始。

<details>
<summary>展开完整目录（30 篇）</summary>

- **00-课程导读**：[README](PI/00-课程导读/README.md)
- **01-快速上手**：[安装指南](PI/01-快速上手/01-安装指南.md) · [快速开始](PI/01-快速上手/02-快速开始.md) · [交互模式与 CLI 命令](PI/01-快速上手/03-交互模式与CLI命令.md) · [Provider 与模型配置](PI/01-快速上手/04-Provider与模型配置.md) · [配置与个性化](PI/01-快速上手/05-配置与个性化.md)
- **02-仓库全景与工程实践**：[Monorepo 结构与包职责地图](PI/02-仓库全景与工程实践/01-Monorepo结构与包职责地图.md) · [构建测试与开发流程](PI/02-仓库全景与工程实践/02-构建测试与开发流程.md) · [发布流程与供应链安全](PI/02-仓库全景与工程实践/03-发布流程与供应链安全.md) · [安全模型与容器化沙箱](PI/02-仓库全景与工程实践/04-安全模型与容器化沙箱.md)
- **03-Agent 核心原理**：[Agent 运行时架构总览](PI/03-Agent核心原理/01-Agent运行时架构总览.md) · [工具调用 Tool Calling 机制](PI/03-Agent核心原理/02-工具调用ToolCalling机制.md) · [对话循环与消息状态机](PI/03-Agent核心原理/03-对话循环与消息状态机.md) · [会话 Session 与持久化](PI/03-Agent核心原理/04-会话Session与持久化.md) · [上下文压缩 Compaction 与分支摘要](PI/03-Agent核心原理/05-上下文压缩Compaction与分支摘要.md) · [Agent 扩展点 Hook 与事件系统](PI/03-Agent核心原理/06-Agent扩展点Hook与事件系统.md)
- **04-多模型统一层 pi-ai**：[统一 LLM 接口设计原理](PI/04-多模型统一层-pi-ai/01-统一LLM接口设计原理.md) · [Provider 适配器实现剖析](PI/04-多模型统一层-pi-ai/02-Provider适配器实现剖析.md) · [模型元数据生成与维护机制](PI/04-多模型统一层-pi-ai/03-模型元数据生成与维护机制.md)
- **05-Coding Agent CLI 实战**：[内置工具全解析](PI/05-Coding-Agent-CLI实战/01-内置工具全解析.md) · [扩展 Extension 开发指南](PI/05-Coding-Agent-CLI实战/02-扩展Extension开发指南.md) · [Skills 与 Prompt Templates](PI/05-Coding-Agent-CLI实战/03-Skills与Prompt-Templates.md) · [Pi Package 生态与分发](PI/05-Coding-Agent-CLI实战/04-Pi-Package生态与分发.md)
- **06-终端 UI pi-tui**：[差分渲染架构与组件模型](PI/06-终端UI-pi-tui/01-差分渲染架构与组件模型.md)
- **07-协议服务化与遥测**：[RPC 模式与 JSON 事件流](PI/07-协议服务化与遥测/01-RPC模式与JSON事件流.md) · [SDK 嵌入式集成](PI/07-协议服务化与遥测/02-SDK嵌入式集成.md) · [Protocol Server Client 架构](PI/07-协议服务化与遥测/03-Protocol-Server-Client架构.md) · [Telemetry 遥测体系设计](PI/07-协议服务化与遥测/04-Telemetry遥测体系设计.md)
- **08-测试与评估体系**：[测试策略 Faux Provider 与 Evals](PI/08-测试与评估体系/01-测试策略Faux-Provider与Evals.md)
- **09-总结与延伸阅读**：[课程总结与进阶方向](PI/09-总结与延伸阅读/01-课程总结与进阶方向.md)

</details>

## 课程二：DeepSeek Harness（`dsh`）

DeepSeek AI 开源的 agent harness：整个运行时构建在 Cordis 这个"万物皆插件"的元框架之上并将其源码 vendor 进仓库；几乎每类能力都拆成"Service Definition → Provider → Tool"三元结构（capability seam）；Host（Node 宿主进程）与 Client（浏览器）在类型和构建上物理分离，靠编译期生成的 RPC 契约通信；还有纯 C11 手写的 Linux Landlock 沙箱内核和让 Python 把整个运行时当子进程驱动的 NDJSON-RPC SDK。

👉 从 [DeepSeek-Harness/00-课程导读/README.md](DeepSeek-Harness/00-课程导读/README.md) 开始。

<details>
<summary>展开完整目录（32 篇）</summary>

- **00-课程导读**：[README](DeepSeek-Harness/00-课程导读/README.md)
- **01-快速上手**：[安装与环境准备](DeepSeek-Harness/01-快速上手/01-安装与环境准备.md) · [快速开始：CLI 与 Web UI](DeepSeek-Harness/01-快速上手/02-快速开始-CLI与Web-UI.md) · [CLI 命令与 Profile 机制](DeepSeek-Harness/01-快速上手/03-CLI命令与Profile机制.md) · [Provider 与模型配置](DeepSeek-Harness/01-快速上手/04-Provider与模型配置.md) · [权限预设与个性化配置](DeepSeek-Harness/01-快速上手/05-权限预设与个性化配置.md)
- **02-仓库全景与工程实践**：[Monorepo 结构与包职责地图](DeepSeek-Harness/02-仓库全景与工程实践/01-Monorepo结构与包职责地图.md) · [构建体系：Host 与 Client 双面构建](DeepSeek-Harness/02-仓库全景与工程实践/02-构建体系-Host与Client双面构建.md) · [测试策略与 CI 门禁](DeepSeek-Harness/02-仓库全景与工程实践/03-测试策略与CI门禁.md) · [Vendoring 策略与供应链治理](DeepSeek-Harness/02-仓库全景与工程实践/04-Vendoring策略与供应链治理.md)
- **03-Cordis 插件框架基石**：[核心概念：Context / Service / Plugin](DeepSeek-Harness/03-Cordis插件框架基石/01-核心概念-Context-Service-Plugin.md) · [Typed Events 与四种派发模式](DeepSeek-Harness/03-Cordis插件框架基石/02-Typed-Events与四种派发模式.md) · [Registrations are Effects：可逆卸载](DeepSeek-Harness/03-Cordis插件框架基石/03-Registrations-are-Effects可逆卸载.md) · [Profile / Bundle / Preset 装配机制](DeepSeek-Harness/03-Cordis插件框架基石/04-Profile-Bundle-Preset装配机制.md)
- **04-Agent 核心循环**：[ReactLoopAgent 总览：kick / turn / step](DeepSeek-Harness/04-Agent核心循环/01-ReactLoopAgent总览-kick-turn-step.md) · [会话事件溯源：SessionEventLog 与 Surface](DeepSeek-Harness/04-Agent核心循环/02-会话事件溯源-SessionEventLog与Surface.md) · [流式输出管道：从 StreamChunk 到 UI](DeepSeek-Harness/04-Agent核心循环/03-流式输出管道-从StreamChunk到UI.md) · [上下文压缩 Compaction 与 Checkpoint 持久化](DeepSeek-Harness/04-Agent核心循环/04-上下文压缩Compaction与Checkpoint持久化.md) · [错误处理、重试与取消机制](DeepSeek-Harness/04-Agent核心循环/05-错误处理重试与取消机制.md)
- **05-能力扩展范式 Capability Seam**：[Seam 三元结构精讲：以 shell 为例](DeepSeek-Harness/05-能力扩展范式CapabilitySeam/01-Seam三元结构精讲-以shell为例.md) · [工具注册与执行管线](DeepSeek-Harness/05-能力扩展范式CapabilitySeam/02-工具注册与执行管线.md) · [权限审批与沙箱体系](DeepSeek-Harness/05-能力扩展范式CapabilitySeam/03-权限审批与沙箱体系.md) · [内置工具全解析](DeepSeek-Harness/05-能力扩展范式CapabilitySeam/04-内置工具全解析.md)
- **06-跨语言边界与部署形态**：[Native 沙箱内核 landlock-run](DeepSeek-Harness/06-跨语言边界与部署形态/01-Native沙箱内核landlock-run.md) · [Python SDK 与 NDJSON-RPC 桥接](DeepSeek-Harness/06-跨语言边界与部署形态/02-Python-SDK与NDJSON-RPC桥接.md) · [Host-Client 分离与 Typert RPC 生成](DeepSeek-Harness/06-跨语言边界与部署形态/03-Host-Client分离与Typert-RPC生成.md) · [对外协议：SDK、ACP 与生态兼容 Hooks](DeepSeek-Harness/06-跨语言边界与部署形态/04-对外协议SDK-ACP与生态兼容Hooks.md)
- **07-多智能体与工作流**：[Subagent 委派与协作模型](DeepSeek-Harness/07-多智能体与工作流/01-Subagent委派与协作模型.md) · [Workflow 引擎与 Ralph 循环](DeepSeek-Harness/07-多智能体与工作流/02-Workflow引擎与Ralph循环.md) · [Skill 技能系统与动态插件扩展](DeepSeek-Harness/07-多智能体与工作流/03-Skill技能系统与动态插件扩展.md)
- **08-工程质量与文档治理**：[测试哲学：Verify the World, not the Self-report](DeepSeek-Harness/08-工程质量与文档治理/01-测试哲学-Verify-the-World-not-the-Self-report.md) · [AGENTS.md 治理规范与文档体系](DeepSeek-Harness/08-工程质量与文档治理/02-AGENTS-md治理规范与文档体系.md) · [Postmortem 与防御性编程模式](DeepSeek-Harness/08-工程质量与文档治理/03-Postmortem与防御性编程模式.md)
- **09-总结与延伸阅读**：[课程总结与进阶方向](DeepSeek-Harness/09-总结与延伸阅读/01-课程总结与进阶方向.md)

</details>

## 两个项目的架构哲学速览

| | PI | DeepSeek Harness |
|---|---|---|
| 扩展方式 | 精简核心 + TypeScript Extension / Skills / Prompt 模板 | 万物皆插件（Cordis），能力按 Service Definition / Provider / Tool 三元结构组织 |
| 框架依赖 | 无独立元框架，扩展机制内建于 `coding-agent` 包 | 依赖 vendor 进仓库的 Cordis 生态（源码自持，可审计可打补丁） |
| 多模型层 | `pi-ai` 统一接口 | `packages/llm/*` seam + `llm-deepseek`/`llm-pi-ai` 双 Provider 对照验证 |
| 会话表示 | JSONL append 日志 | 事件溯源日志（`SessionEventMap`）+ Surface 投影，压缩靠 `replace` 而非删除 |
| 沙箱 | 依赖外部容器化 | 自建多平台沙箱（bwrap / Seatbelt / 纯 C 手写 Landlock / Windows ACL）+ E2B 远程 |
| 部署/进程形态 | 单一 CLI 进程 | Host（Node）/ Client（浏览器）类型与构建物理分离，Typert 编译期生成 RPC 契约 |

建议先学完其中一套课程建立整体直觉，再对照阅读另一套——两个项目解决的是同一类问题，几乎处处做出了不同的架构选择，对照阅读收获会比单读一套更大。

---

MIT License，见 [LICENSE](LICENSE)。
