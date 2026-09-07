# 模块四：工具调用协议与扩展生态

> 返回[总览](../README.md)。

**Q1. Code Plugin 与 Bundle-style Plugin 的本质区别是什么？（OpenClaw）**

Code Plugin 会在 Gateway 进程内**执行代码**，天然获得和核心代码同等的信任边界——官方文档原话是"a malicious native plugin is equivalent to arbitrary code execution inside the OpenClaw process"；Bundle-style Plugin 打包的是相对静止的外部能力（一组 Skill、一份 MCP 服务器配置），本质上是"元数据/内容包"，不是会被执行的运行时代码，信任边界窄得多。区分标准是"运行的是谁的代码"，而不是"这个插件听起来安不安全"——这条设计思路本身值得单独记一笔。

**Q2. dsh 的"能力接缝（capability seam）"三元结构具体是哪三元？**

**Service Definition**（声明契约是什么，比如一个抽象类定义"必须有一个 `saveText` 方法"）、**Service Provider**（具体实现契约怎么做，比如把内容存到本地文件系统）、**Consumer**（通过 Context 使用契约的一方，比如某个需要落盘长文本的工具）。三者可以合并在一个包里，也可以拆成三个独立的包——拆开的好处是换一个存储后端只需要换 Provider 包，Consumer 和 Definition 都不用动。

**Q3. Hermes 的 Footprint Ladder 六级框架解决了什么问题？**

它把"给这个项目加一项新能力，应该落在哪一层"这个原本靠个人经验拍脑袋的判断，变成一份可以逐级对照执行的清单：扩展已有代码 → CLI 命令+skill → `check_fn` 服务门控工具 → 插件 → MCP 服务器（编入目录）→ 新核心工具，层级越靠后代价越高、影响面越广。这条框架避免的是"每个人对同一类需求做出不一致的扩展面选型判断"这个真实的团队协作痛点。

**Q4. OpenHarness 为什么工具协议要"贴身复刻"Claude Code？这样做的代价是什么？**

好处是不需要从零验证工具协议设计是否合理——Claude Code 的工具集已经被大规模真实使用验证过；同时对已经熟悉 Claude Code 的用户/开发者几乎零学习成本。代价是创新空间受限：一旦复刻对象升级了工具协议，跟随成本会持续存在；另外"贴身复刻"容易让人误以为整个项目都是复刻，而实际上 `ohmo`、Autopilot 这类原创部分完全走的是另一条设计路径——这提醒我们评价一个"复刻型"项目时要分清哪部分是复刻、哪部分是原创。

**Q5. MCP 在这五个项目里分别扮演什么角色？（是否核心机制、是否唯一扩展路径）**

MCP 在这五个项目里普遍都是"众多扩展路径之一"，而不是唯一或核心机制——OpenClaw 的 VISION.md 说得最直接："pragmatic MCP support without duplicating existing agent/tool/ACPX/plugin/ClawHub paths"，明确表态不希望 MCP 变成一套平行的、和已有工具/插件体系割裂的扩展机制，而是让它折叠进已有的工具 profile/policy 管线。OpenHarness 同样把 MCP 作为 tools/skills/plugins 之外的第四条并行扩展面，而不是最优先的一条。这说明"支持 MCP"和"把 MCP 当作核心扩展路径"是两回事，候选人如果说"这几个项目都是靠 MCP 做扩展"，就是把"支持"和"依赖"混为一谈了。

**Q6.（陷阱题）Skill 和 Plugin 的边界在哪？如果一个能力可以两种方式实现，该怎么选？**

Skill 通常是"教模型怎么用已有工具的说明书"（Markdown 内容 + frontmatter 元数据），不需要运行任何代码；Plugin（尤其是 Code Plugin）则是要注册新的 provider/channel/工具/hook，需要在进程内运行代码。如果一个能力"只是告诉模型一套操作步骤"，优先做成 Skill；只有当能力本身依赖运行时钩子、需要注册新的运行时扩展点时，才需要 Plugin。VISION.md 给出的判断准则是可执行的："能用 bundle-style（Skill 这类）表达的能力，优先用 bundle-style，因为它接口更小、更稳定，安全边界也更好"。

**Q7. Skills 的"按需加载"具体是怎么做到的？（以 OpenHarness 为例）**

课程写作时动手验证过：system prompt 里只注入 Skill 的名字和一句话描述，完整的 Skill 内容并不会一开始就塞进上下文——只有当模型主动调用 `skill_tool` 请求这个 Skill 时，完整内容才会被读进来拼进对话。这种"先给目录、按需展开"的设计，直接决定了 Skill 数量增长不会线性拉高每次请求的 token 成本。

**Q8. 如果要新增一个工具，五个项目各自的最小改动路径大致是什么？**

- PI：写一个 TS Extension，声明工具 schema。
- dsh：新增一个 Tool 消费者，挂在已有或新的 Service Definition/Provider 上。
- Hermes：按 Footprint Ladder 判断落在哪一级——最轻量的情况只是加一个 CLI 命令+skill。
- OpenHarness：在 `tools/` 下新增一个继承 `base.py` 协议的工具文件。
- OpenClaw：判断这个工具是否需要运行时钩子——不需要就做成 Bundle-style（配置/Skill），需要就写一个声明 `openclaw.plugin.json` manifest 的 Code Plugin。

---

上一模块：[多模型 / Provider 抽象与 Failover](../03-多模型Provider抽象与Failover/README.md) ｜ 下一模块：[会话与状态持久化](../05-会话与状态持久化/README.md)
