# Agent Harness 关键技术面试题库：五大开源项目横向对比

> 本文把五个真实开源 Agent Harness 项目——[PI](../PI/00-课程导读/README.md)、[DeepSeek Harness](../DeepSeek-Harness/00-课程导读/README.md)、[Hermes Agent](../Hermes-Agent/00-课程导读/README.md)、[OpenHarness](../OpenHarness/00-课程导读/README.md)、[OpenClaw](../OpenClaw/00-课程导读/README.md)——的课程内容，改写成一份以面试官视角出题的技术题库，按模块拆分成 12 个子目录、共 70+ 道题，覆盖架构哲学、核心循环、Provider 抽象、工具生态、会话与压缩、多智能体、安全沙箱、记忆系统、协议部署、工程规范、综合场景设计。每道题的参考答案都来自对应课程里已经过源码/官方文档验证的结论，不是印象或临场发挥；题目中标注"陷阱题"或"追问"的地方，往往对应课程写作过程中真实发现的"名字/直觉误解 vs 代码真实行为"的落差——这些恰恰是面试里最容易把候选人问住、也最能看出候选人是否真的读过代码的地方。想看某一题背后完整的源码级论证，请点进对应课程章节。

## 模块目录

| 模块 | 主题 | 题量 |
|---|---|---|
| [01](01-项目定位与架构哲学/README.md) | 项目定位与架构哲学 | 6 |
| [02](02-Agent核心循环执行模型/README.md) | Agent 核心循环执行模型 | 6 |
| [03](03-多模型Provider抽象与Failover/README.md) | 多模型 / Provider 抽象与 Failover | 6 |
| [04](04-工具调用协议与扩展生态/README.md) | 工具调用协议与扩展生态 | 8 |
| [05](05-会话与状态持久化/README.md) | 会话与状态持久化 | 6 |
| [06](06-上下文管理与压缩/README.md) | 上下文管理与压缩 | 6 |
| [07](07-多智能体协作与任务编排/README.md) | 多智能体协作与任务编排 | 7 |
| [08](08-权限审批与沙箱安全/README.md) | 权限、审批与沙箱安全 | 7 |
| [09](09-长期记忆与个性化/README.md) | 长期记忆与个性化 | 6 |
| [10](10-通信协议多端与部署形态/README.md) | 通信协议、多端与部署形态 | 6 |
| [11](11-工程规范测试与可观测性/README.md) | 工程规范、测试与可观测性 | 5 |
| [12](12-综合场景设计题/README.md) | 综合场景设计题（开放式） | 6 |

👉 从 [模块一：项目定位与架构哲学](01-项目定位与架构哲学/README.md) 开始，或直接跳到你感兴趣的模块。

## 延伸阅读

- 每个项目更完整的架构论证和真实代码引用，见各自课程的具体章节：[PI](../PI/00-课程导读/README.md) · [DeepSeek Harness](../DeepSeek-Harness/00-课程导读/README.md) · [Hermes Agent](../Hermes-Agent/00-课程导读/README.md) · [OpenHarness](../OpenHarness/00-课程导读/README.md) · [OpenClaw](../OpenClaw/00-课程导读/README.md)
- 每个项目的总结与对比章节：[PI](../PI/09-总结与延伸阅读/01-课程总结与进阶方向.md) · [DeepSeek Harness](../DeepSeek-Harness/09-总结与延伸阅读/01-课程总结与进阶方向.md) · [Hermes Agent](../Hermes-Agent/12-总结与延伸阅读/01-课程总结与三方对比.md) · [OpenHarness](../OpenHarness/10-总结与延伸阅读/01-课程总结与延伸阅读.md) · [OpenClaw](../OpenClaw/12-总结与延伸阅读/01-课程总结与延伸阅读.md)
- 五个项目的完整目录导航见仓库根目录的 [README.md](../README.md)
