# DeepSeek Harness 课程 v2

这是对 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 `dsh`）的重写版课程。内容来源与 `DeepSeek-Harness/` 原课程相同，写法不同：每篇围绕一个真实问题，先讲要解决什么，再讲具体机制，最后讲为什么这样设计、代价是什么。以连贯的段落为主，源码只留最关键的几行。

课程导读见 [00-课程导读/README.md](00-课程导读/README.md)。

## 目录

**01 快速上手**
- [01 安装与环境准备](01-快速上手/01-安装与环境准备.md)
- [02 快速开始：CLI 与 Web UI](01-快速上手/02-快速开始-CLI与Web-UI.md)
- [03 CLI 命令与 Profile 机制](01-快速上手/03-CLI命令与Profile机制.md)
- [04 Provider 与模型配置](01-快速上手/04-Provider与模型配置.md)
- [05 权限预设与个性化配置](01-快速上手/05-权限预设与个性化配置.md)

**02 仓库全景与工程实践**
- [01 Monorepo 结构与包职责地图](02-仓库全景与工程实践/01-Monorepo结构与包职责地图.md)
- [02 构建体系：Host 与 Client 双面构建](02-仓库全景与工程实践/02-构建体系-Host与Client双面构建.md)
- [03 测试策略与 CI 门禁](02-仓库全景与工程实践/03-测试策略与CI门禁.md)
- [04 Vendoring 策略与供应链治理](02-仓库全景与工程实践/04-Vendoring策略与供应链治理.md)

**03 Cordis 插件框架基石**
- [01 核心概念：Context、Service、Plugin](03-Cordis插件框架基石/01-核心概念-Context-Service-Plugin.md)
- [02 Typed Events 与五种派发模式](03-Cordis插件框架基石/02-Typed-Events与五种派发模式.md)
- [03 Registrations are Effects：可逆卸载](03-Cordis插件框架基石/03-Registrations-are-Effects可逆卸载.md)
- [04 Profile、Bundle、Preset 装配机制](03-Cordis插件框架基石/04-Profile-Bundle-Preset装配机制.md)

**04 Agent 核心循环**
- [01 ReactLoopAgent 总览：kick、turn、step](04-Agent核心循环/01-ReactLoopAgent总览-kick-turn-step.md)
- [02 会话事件溯源：Session Event Log 与 Surface](04-Agent核心循环/02-会话事件溯源-SessionEventLog与Surface.md)
- [03 流式输出管道：从 StreamChunk 到 UI](04-Agent核心循环/03-流式输出管道-从StreamChunk到UI.md)
- [04 上下文压缩 Compaction 与 Checkpoint 持久化](04-Agent核心循环/04-上下文压缩Compaction与Checkpoint持久化.md)
- [05 错误处理、重试与取消机制](04-Agent核心循环/05-错误处理重试与取消机制.md)

**05 能力扩展范式 Capability Seam**
- [01 Seam 三元结构精讲：以 shell 为例](05-能力扩展范式CapabilitySeam/01-Seam三元结构精讲-以shell为例.md)
- [02 工具注册与执行管线](05-能力扩展范式CapabilitySeam/02-工具注册与执行管线.md)
- [03 权限审批与沙箱体系](05-能力扩展范式CapabilitySeam/03-权限审批与沙箱体系.md)
- [04 内置工具全解析](05-能力扩展范式CapabilitySeam/04-内置工具全解析.md)

**06 跨语言边界与部署形态**
- [01 Native 沙箱内核 landlock-run](06-跨语言边界与部署形态/01-Native沙箱内核landlock-run.md)
- [02 Python SDK 与 NDJSON-RPC 桥接](06-跨语言边界与部署形态/02-Python-SDK与NDJSON-RPC桥接.md)
- [03 Host/Client 分离与 Typert RPC 生成](06-跨语言边界与部署形态/03-Host-Client分离与Typert-RPC生成.md)
- [04 对外协议：SDK、ACP 与生态兼容 Hooks](06-跨语言边界与部署形态/04-对外协议SDK-ACP与生态兼容Hooks.md)

**07 多智能体与工作流**
- [01 Subagent 委派与协作模型](07-多智能体与工作流/01-Subagent委派与协作模型.md)
- [02 Workflow 引擎与 Ralph 循环](07-多智能体与工作流/02-Workflow引擎与Ralph循环.md)
- [03 Skill 技能系统与动态插件扩展](07-多智能体与工作流/03-Skill技能系统与动态插件扩展.md)

**08 工程质量与文档治理**
- [01 测试哲学：Verify the World, not the Self-report](08-工程质量与文档治理/01-测试哲学-Verify-the-World-not-the-Self-report.md)
- [02 AGENTS.md 治理规范与文档体系](08-工程质量与文档治理/02-AGENTS-md治理规范与文档体系.md)
- [03 Postmortem 与防御性编程模式](08-工程质量与文档治理/03-Postmortem与防御性编程模式.md)

**09 总结与延伸阅读**
- [01 课程总结与进阶方向](09-总结与延伸阅读/01-课程总结与进阶方向.md)

## 关于内容的说明

- 事实依据是 `DeepSeek-Harness/` 原课程，没有直接读取上游仓库源码。原课程里相互矛盾或未核实的地方，新稿要么只保留有依据的一侧，要么标注"课程材料中未展开"。
- 部分篇目有"我的看法"小节，是基于材料的判断，不是官方结论。
- 包数量、版本号等数字随上游变化很快，以上游仓库当前状态为准。
