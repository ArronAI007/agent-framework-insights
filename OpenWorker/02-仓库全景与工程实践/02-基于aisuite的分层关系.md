# 基于 aisuite 的分层关系

> README 里"Built on aisuite"这一节只有三句话,却是理解整个仓库依赖结构的钥匙:OpenWorker 的引擎构建在 `aisuite` 之上——一个提供"跨 LLM 厂商统一 chat-completions API + 带工具/工具包/MCP 支持的 agents 层"的轻量库;更耐人寻味的一句是"OpenWorker was originally developed inside the aisuite repository before moving to its own home here"——这两个项目本是一体,后来才分家。`pyproject.toml` 里把 `aisuite` 锁定到一个具体的 git commit 而不是 PyPI 版本号,这个细节本身就值得单独拆开讲。

## 学习目标

- 讲清楚 aisuite 和 OpenWorker 之间的职责边界:哪些能力来自 aisuite,哪些是 OpenWorker 自己叠加的。
- 用 `grep` 得到的真实依赖文件列表,归纳 OpenWorker 里"直接使用 aisuite 抽象"的代码分布在哪些子系统。
- 理解 `pyproject.toml` 里"pinned to the commit this repo was imported from"这条注释背后的版本管理策略与风险。
- 把这种"薄治理层 + 底层通用库"的分工方式,和本系列其他项目里"自建元框架"或"完全自研引擎"的路线做一次简短对比,建立起技术选型的参照系。

## 背景与设计动机

多数 Agent 框架要么完全自己造轮子(自己写 Provider 适配、自己写 tool-calling 协议、自己写 MCP 客户端),要么依赖一个成熟的通用库把"和模型对话"这件事的复杂度吃掉,自己只做产品化的那一层。OpenWorker 选择了后者,而且选择得非常干脆——它甚至坦白承认这段历史:这个项目最初就是在 `aisuite` 仓库里孵化出来的一个应用,后来才独立成仓库。README 直接写道:

> If you want to build your own agent harness rather than use ours, start there; this repo is a working reference for what aisuite can carry.

这句话把 OpenWorker 定位成"aisuite 能力的一个工作参考实现",而不是一个从零开始的独立引擎。理解这条边界,决定了你在读这个仓库时该往哪个方向归因:遇到一个基础的 tool-calling 循环、一个工具的 JSON Schema 转换逻辑,大概率是 aisuite 提供的;遇到一套审批链、一个连接器目录、一整套 Reviewer 评测体系,那是 OpenWorker 自己在这之上叠的东西。

## 核心机制详解

### aisuite 提供什么

从 README 的措辞和 `pyproject.toml` 的依赖注释可以拼出 aisuite 承担的三块能力:

1. **跨 Provider 的统一 chat-completions API**——同一套调用接口对接 OpenAI、Anthropic、Google 等不同厂商的模型,这也是为什么 `pyproject.toml` 里 `openai`、`anthropic`、`google-genai` 这几个原生 SDK 依然作为独立依赖并存(OpenWorker 自己的 `coworker/providers/` 子系统在 aisuite 之上又做了一层适配,后面会看到)。
2. **带工具/工具包(toolkit)支持的 agents 层**——`aisuite.agents` 模块导出的 `ToolMetadata`、`tool` 装饰器,是整个 OpenWorker 工具系统的地基。
3. **MCP 支持**——README 明确写了"an agents layer with tools, toolkits, and MCP support",呼应 OpenWorker 自己的 `coworker/mcp/` 客户端集成。

用 `grep -rl "^import aisuite\|from aisuite" coworker --include='*.py'` 能精确定位到 27 个直接依赖 aisuite 的文件,按它们所在的子系统分组:

| 子系统 | 依赖 aisuite 的文件 | 用法 |
|---|---|---|
| `coworker/tools/` | `files.py`、`directories.py`、`plan.py`、`toolreq.py`、`ask.py`、`git.py`、`search.py`、`shell.py`、`subagent.py`、`todo.py`、`registry.py` | 几乎每个内置工具都用 `import aisuite as ai` 或 `from aisuite.agents import ToolMetadata, tool` 声明工具元数据 |
| `coworker/connectors/` | `tools.py`、`browser_automation.py`、`email_tools.py`、`integration_tools.py` | 连接器暴露给模型的工具,同样走 aisuite 的工具装饰器 |
| `coworker/web/` | `fetch.py`、`tool.py` | 网页抓取工具 |
| `coworker/memory/`、`coworker/skills/`、`coworker/mcp/`、`coworker/automation/`、`coworker/teams/` | `tools.py`/`base.py`/`store.py` 各一 | 各子系统自己的工具集 |
| `coworker/catalog.py` | 顶层模块 | 把各子系统的工具函数收拢成"能力目录" |
| `coworker/server/manager.py` | 三处方法内 `import aisuite as ai`(`_post_chat_tool`、`_team_options_tool`、`_steer_tool`) | 治理层运行时动态组装团队协作工具 |

这张表本身就说明了分工的形状:**几乎所有"工具"最终都要落到 aisuite 的 `tool`/`ToolMetadata` 抽象上**——这是 OpenWorker 复用 aisuite 最彻底的地方。但复用不等于照搬,`coworker/tools/files.py` 顶部的 docstring 写得很直白:

```python
"""Line-numbered file reading (`read_file`) — replaces the aisuite toolkit's reader.

The toolkit's `read_file` returns raw text (the agent can't cite path:line without
counting) and raises outright on large files (the agent errors and guesses). This one
returns `cat -n`-style numbered lines, windows big files instead of failing, and tells
the agent how to continue reading. Read-only, workspace-scoped.
"""
```

`coworker/catalog.py` 里也有一句类似的注释:

```python
# These reproduce, exactly, what the Code and Cowork agent factories assembled by hand.
```

也就是说,OpenWorker 借用 aisuite 的**工具声明协议**(schema 生成、`ToolMetadata` 元数据结构),但工具的**具体实现**大多是自己重写的——原因通常是 aisuite 自带的默认实现太通用、不够贴合"给一个真实 Agent 用"的工程需求(比如大文件要能分页读、要能返回行号方便引用)。`coworker/tools/registry.py` 的 docstring 说得更明确:

```python
"""Schema generation is reused from aisuite (`Tools`) so we don't reimplement..."""
```

复用的是 schema 生成这类"重复劳动、没有差异化价值"的机械部分,自己动手的是行为逻辑本身。这是一条清晰的取舍原则:**协议层交给 aisuite,行为层自己掌控**。

### OpenWorker 在 aisuite 之上叠了什么

对照第 01 篇的目录/子系统清单,能看出 aisuite 完全没有覆盖、纯粹是 OpenWorker 自己搭建的几块:

- **治理系统**——`permissions.py`(687 行)、`risk.py`、`audit.py`、`provenance.py`、`overrides.py`,以及 README"Governed by design"整节描述的三层治理(硬性红线 / 分级自动批准 / 可追溯审计)。这是 OpenWorker 的核心卖点,aisuite 完全不涉及。
- **连接器生态**——`coworker/connectors/`(28 个文件、13561 行),对接 GitHub、Slack、Jira、Notion、Gmail、Google Calendar 等 25+ 集成,这是产品化层面的重头戏。
- **桌面 UI**——`surfaces/gui/` 的整个 React + Tauri 应用,以及配套的 `stt/` 语音输入 sidecar。
- **自动化调度**——`coworker/automation/` + 顶层的 `unattended.py`/`selfwake.py`,支撑"标准自动化"(定时晨报、周报、频道监控)。
- **多智能体 teams/board**——`coworker/teams/`(4096 行),这是"一个 lead 协调多个 worker coworker"的协作机制,`pyproject.toml` 里专门留了一条注释说明它的定位:

```toml
# The board as an open surface (OPE-100): `ocw board …` / `ocw journal …`,
# including `ocw board mcp` — the stdio MCP server external harnesses attach to.
ocw = "coworker.teams.cli:main"
```

这四块——治理、连接器、桌面壳、多智能体协作——共同构成了"aisuite 之上薄薄一层"里其实并不薄的产品化部分。换句话说,aisuite 负责让 OpenWorker 不用重新发明"怎么和不同厂商的模型对话、怎么声明一个工具",而 OpenWorker 自己承担了"怎么让这个 Agent 值得被放到桌面上、被信任去操作真实工具"的全部工程。

### pinned to the commit:一种谨慎但有风险的版本策略

`pyproject.toml` 里对 aisuite 的依赖声明是这样写的:

```toml
# aisuite (toolkits/tracing), pinned to the commit this repo was imported from;
# swap for a PyPI pin ("aisuite>=x.y") once the next aisuite release ships.
"aisuite @ git+https://github.com/andrewyng/aisuite.git@1b4bbf303ec21968230b1ec869a144d054e9b3c4",
```

这行配置传递了两个信息:

1. **OpenWorker 依赖的是 aisuite 尚未发布到 PyPI 的最新状态**——用 git URL + 精确的 commit hash(而不是分支名或版本号)锁定依赖,是比"依赖一个稳定发布版"更谨慎的做法:任何时候 `pip install` 拿到的都是完全相同的一份代码,不会因为上游主分支推进而意外引入不兼容的改动。这解决了"依赖一个还在快速迭代、尚未发布正式版本的上游库"这个真实存在的风险。
2. **这是一个明确的临时状态,而不是长期方案**——注释里直接写了"once the next aisuite release ships",说明维护者清楚这种 git commit 锁定不是终态,一旦 aisuite 发布到 PyPI,这条依赖就会换成正常的版本号约束。

这种策略的代价也很直观:`pip install` 这个依赖时需要走 git 协议而不是简单的包索引下载,CI/构建环境必须能访问 GitHub;而且升级 aisuite 版本时,不能简单改一个版本号,需要人工验证新 commit 之后再手动更新这行 hash——这是"依赖一个还没有稳定发布节奏的通用库"必须承受的维护成本,换来的是"随时能拿到上游最新能力,同时又不会被上游未经测试的改动突然打断"这一份确定性。

### 三种依赖底层能力的方式:对比其他姊妹项目的路线

把这种分工方式放到本系列已经覆盖的几个项目旁边看,会更清楚 OpenWorker 选的是哪一条路:

- **完全自研引擎**——某些项目选择从头写自己的模型调用层、工具协议、事件流,好处是没有外部依赖的版本风险和能力边界限制,代价是所有跨 Provider 的兼容性、工具协议的演进都要自己扛。
- **自建元框架**(例如 DeepSeek Harness 系列里的 Cordis 插件体系)——把"能力如何被注入、如何被替换"做成一套自己发明的抽象层,换来高度可扩展性,但学习成本和维护成本也完全压在自己团队身上。
- **薄治理层 + 底层交给专门的通用库**(OpenWorker 的路线)——把"怎么和模型对话、怎么声明一个工具"这类已经有专门开源项目在做、门槛高但没有差异化价值的部分外包给 aisuite,自己只保留真正决定产品体验和信任边界的那部分:审批链、连接器目录、多智能体协作、桌面 UI。

这条路线的合理性建立在一个前提上:aisuite 和 OpenWorker 出自同一个团队(Andrew Ng 的团队),甚至曾经是同一个仓库分家而来——这不是一次"选一个陌生第三方库"的常规技术选型,而更像是"把通用能力和产品化能力拆成两个仓库、两条发布节奏各自演进"的内部工程决策。这也是为什么依赖能被锁定到一个 git commit 而不是等待 PyPI 发布——两边团队沟通成本几乎为零,git commit 锁定只是权宜之计而不是长期风险敞口。

## 常见问题/易踩坑

- **不要把"用了 aisuite 的 `tool` 装饰器"等同于"工具实现也是 aisuite 写的"**:`coworker/tools/files.py`、`catalog.py` 等文件的 docstring 反复强调它们"replaces"或"reproduces"了 aisuite 默认工具的行为,协议复用不等于实现复用。
- **升级 aisuite 不是改个版本号那么简单**:当前是 git commit 锁定,想拿到上游新功能需要先验证新 commit 再手动更新 `pyproject.toml` 里的 hash,不能依赖常规的 `pip install --upgrade`。
- **`coworker/server/manager.py` 里的 `import aisuite` 出现在方法体内而不是模块顶部**,这不是代码风格随意,而是刻意的延迟导入(配合工具的运行时动态组装),读代码时不要因为没在文件顶部看到 import 就误以为该模块不依赖 aisuite。

## 小结

OpenWorker 把"和模型对话、声明工具"这类有专门开源项目在做的通用能力外包给了 aisuite——同一个团队孵化出来的姊妹项目,自己只保留治理、连接器、桌面 UI、多智能体协作这些真正决定产品体验的部分;`pyproject.toml` 里那行 git commit 锁定的依赖声明,精确记录了这种"共生但尚未完全独立发布"的关系。下一篇会转向另一条主线——这个仓库如何验证自己"足够安全、足够好用":从 `.venv/bin/pytest` 和 GUI 的 `npm test`/`npm run e2e`,到 `tests/corpora` 里那套专门评测 Auto-Approve Reviewer 的分层语料体系。
