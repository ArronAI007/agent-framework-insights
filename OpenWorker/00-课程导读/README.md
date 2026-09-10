# 课程导读

> 本课程是对开源项目 [andrewyng/openworker](https://github.com/andrewyng/openworker)（CLI/包名是 `openworker`/`coworker`，Andrew Ng 团队开源的桌面 AI "coworker"）的系统性整理，写法与姊妹课程 [PI](../../PI/00-课程导读/README.md)、[DeepSeek Harness](../../DeepSeek-Harness/00-课程导读/README.md)、[Hermes Agent](../../Hermes-Agent/00-课程导读/README.md)、[OpenHarness](../../OpenHarness/00-课程导读/README.md)、[OpenClaw](../../OpenClaw/00-课程导读/README.md) 一致：先建立整体地图，再逐层拆开源码，每一篇都会摘录真实代码并讲清楚设计动机，而不是停留在使用文档层面。

## 什么是 OpenWorker，以及一处一手资料上的差异

OpenWorker 的产品定位和这套课程系列前五个项目都不一样——它不是一个"终端里的编码 Agent"，而是一个"住在你桌面上、交付真实成品而不只是聊天"的 AI coworker：代码审查带着修复方案、一份排好版的文档、一条带着数据的 Slack 回复、一个已经分诊好的收件箱。README 的原话是"**AI that gets your everyday tasks done**"。它首发的是专精安全类工作的"专家 coworker"（appsec、cloud-posture、dep-audit 等），团队的判断是"攻击者已经在用 AI 了，防守方也该有同等的杠杆，但必须是被治理的"。

核心是一个约 5 万行的 Python 后端（`coworker/`），桌面壳是 React + Tauri（`surfaces/gui/`），还有一个 Rust 写的语音输入模块（`stt/`，编译期静态链接进同一个二进制，而不是独立的 sidecar 进程）。整个 Agent 引擎构建在 Andrew Ng 团队另一个开源库 **aisuite**（跨 Provider 统一 chat-completions API + 带工具/MCP 支持的 agents 层）之上——`pyproject.toml` 用一个精确的 git commit 锁定版本，README 说得很直白："this repo is a working reference for what aisuite can carry"。

写这门课程时有一处和前五套课程都不同的地方值得先说清楚：OpenWorker **没有** OpenClaw 那种成百篇的 `docs/*.md` 文档库，`docs/` 目录只有一份配置示例和几张图。所以这门课程的一手资料来源和姊妹课程不太一样——主要依赖 README.md、SECURITY.md、`pyproject.toml` 里大量解释"为什么这么选"的行内注释，以及源码本身（包括 docstring 和行内注释）。这也意味着这门课程在验证环节格外重要：写作过程中反复出现"从文件名/README 描述先建立一个假设，再读代码发现假设不成立、必须改写"的情况——比如 `catalog.py` 其实是工具能力目录而不是模型目录、`matrix.py` 其实不是一张交叉表、`toolchain.py` 只管几个被固定版本校验的 CLI 扫描器而不是整个会话的工具装配、`interactions.py` 管的是消息平台上的审批按钮而不是任务中途插话、`dialect.py` 抽象的是"团队看板存在哪里"而不是"队员之间怎么通信"。这些落差不是课程的疏漏，而是深入一个真实代码库时必然会遇到的东西，课程选择如实记录而不是抹平。

围绕这个核心，OpenWorker 最有分量、也是本课程用力最多的部分是它的**治理系统**——README 用整整一节"Governed by design"讲清楚：治理是架构本身而不是一个可选插件，三层机制（一组操作永远只能人类批准的硬底线、一把"自主权阶梯"外加 auto-approve 模式下的 reviewer 审查模型、一条能回答"谁做的、为什么"的审计轨迹）共同构成了让一个能真正干活的 Agent 保持可控的骨架。围绕这套治理，团队还搭了一整套独立的、数据驱动的评测方法论去持续验证 reviewer 模型本身的表现——这在这套课程系列覆盖的六个项目里是独有的内容。

## 课程设计思路

课程延续"先会用，再懂原理，最后能扩展"的主线，全课程分为十二条主线：

1. **快速上手**（第 01 章）：安装与桌面应用速览、从源码运行与开发环境、模型配置速览、权限模式与治理速览——建立第一手直觉。
2. **仓库全景与工程实践**（第 02 章）：Monorepo 结构与技术栈全景、基于 aisuite 的分层关系、测试与评测体系。
3. **Agent 核心循环与会话**（第 03 章）：Engine 总览、Session 与对话数据模型、上下文压缩 Compaction、事件流与流式输出。
4. **治理系统：三层门槛与审批**（第 04 章）：本课程分量最重的一章——权限模式总览、Permissions 与 Risk 风险评估、Reviewer 自动审查模型、Provenance 与 Audit 审计追踪、Overrides 常驻规则与 Allowlist 晋升机制。
5. **模型与 Provider 生态**（第 05 章）：Provider 抽象与统一接口、代表性 Provider 实现对照、模型目录 Catalog 与能力矩阵。
6. **工具 / Skills / MCP 与 Toolchain**（第 06 章）：内置工具全解析、Skills 机制与内置技能包、MCP 集成、Toolchain 装配与 Web 工具。
7. **Connectors 连接器生态**（第 07 章）：Connector 契约与 Gateway 架构、代表性 Connector 实现对照、浏览器自动化与邮件工具、OAuth 与 Cloud 代理服务。
8. **Personas 与 Teams：多智能体协作**（第 08 章）：Persona 清单与专家 Coworker 设计、Teams/Board/Journal 多智能体协作、Subagent 委派与 MCP 开放接口。
9. **记忆与自动化**（第 09 章）：Memory 记忆系统、Automation 调度与常驻自动化、无人值守运行与自我唤醒机制。
10. **桌面应用与语音输入**（第 10 章）：GUI/Tauri 桌面壳架构、语音输入模块与跨技术栈工程。
11. **安全模型与 Reviewer 评测方法论**（第 11 章）：SECURITY.md 与整体安全态势、Reviewer 模型评测方法论。
12. **总结与延伸阅读**（第 12 章）：把 OpenWorker 放回 PI / DeepSeek Harness / Hermes Agent / OpenHarness / OpenClaw 的坐标系里做一次六方对照。

## 适合谁学

- 已经在用或考虑用 OpenWorker（或者对"能交付真实成品的桌面 AI coworker"这类产品感兴趣）的用户，想理解它到底是怎么把治理、多 Provider、连接器、多智能体这几件事拼在一起的；
- 想给自己的 Agent 系统设计一套"既要自主性、又要可控"的治理体系、又不想从零发明审批模型和熔断机制的工程师——这一章的三层门槛设计是一份很扎实的参考实现；
- 想给 OpenWorker 贡献新连接器、新 Persona、新 Provider 适配器的贡献者；
- 对"分层信任的多 Provider 抽象""专家角色（Persona）驱动的产品设计""桌面应用怎么把 Python/React/Rust 三种技术栈拼装成一个可分发产品"这些主题感兴趣的人；
- 已经学过姊妹课程（[PI](../../PI/00-课程导读/README.md)、[DeepSeek Harness](../../DeepSeek-Harness/00-课程导读/README.md)、[Hermes Agent](../../Hermes-Agent/00-课程导读/README.md)、[OpenHarness](../../OpenHarness/00-课程导读/README.md)、[OpenClaw](../../OpenClaw/00-课程导读/README.md)）的读者——六个项目解决的是同一类问题，OpenWorker 在"依赖一个共享的通用底层库、自己只做治理与产品化"这条路线上走得比其他五个项目都更彻底，对照阅读收获会更大。

## 前置知识

- 具备基本的 Python 阅读能力；
- 了解大语言模型（LLM）的基本概念（对话、system prompt、工具调用/function calling、流式输出）；
- 不需要提前了解 OpenWorker 或 aisuite 本身，本课程会从零开始介绍；如果你对 Rust/Tauri 桌面开发完全陌生，第 10 章会尽量把跨技术栈的部分讲得平易一些。

## 学习方式建议

- 每篇文章涉及源码解读的地方都会标注具体文件路径（如 `coworker/engine.py`），建议对照本地克隆的仓库边读边操作；
- 这个项目没有丰富的官方 `docs/*.md`，`pyproject.toml` 里大量解释性的行内注释其实是被低估的一手资料，值得留意；
- 各章相对独立：只关心治理/权限设计可以直接从第 04 章开始；只关心多智能体协作可以直接从第 08 章开始；只关心怎么把一个 Agent 引擎打包成桌面产品可以直接从第 10 章开始；
- 课程里多处会诚实指出源码/文档/命名之间的出入——这些不是疏漏，而是深入真实代码库时必然会遇到的东西，也是这门课程反复强调的方法论：先假设、再验证、发现不成立就改写。

## 课程目录

完整的目录导航见仓库根目录的 [README.md](../../README.md)。
