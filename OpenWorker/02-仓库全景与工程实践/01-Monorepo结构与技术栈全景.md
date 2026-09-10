# Monorepo 结构与技术栈全景

> OpenWorker 的仓库看起来像一个典型的"后端 + 桌面壳"项目,但真正值得琢磨的是 `coworker/` 包内部的组织方式:53 个顶层条目里,有 37 个是直接挂在包根下的 `.py` 文件——`engine.py`、`agent.py`、`permissions.py`——同时又有 14 个正经的子目录——`connectors/`、`providers/`、`server/`。这不是疏忽,而是一份没有写在任何文档里的"体量地图":先有一批核心概念以单文件形式存在,后来体量涨到几千行、或者职责足够独立,才被挪进子目录。读懂这份地图,比记住 53 个名字更重要。

## 学习目标

- 能画出仓库顶层目录的职责边界:Python 后端、React+Tauri 桌面壳、Rust 语音 sidecar、打包脚本、测试套件、评测脚本与报告分别对应哪个目录。
- 理解 `coworker/` 包内"顶层模块 + 子目录子系统"并存的组织方式,以及这种混合布局可能反映的演化路径。
- 用真实的文件数、行数说明各子系统的相对体量,建立"connectors 最大、manager.py 单文件最大"这类具体直觉,而不是抽象印象。
- 知道 `docs/`、`scripts/`、`reports/` 这几个容易被忽略的目录分别是干什么用的,为后面章节(尤其是第 11 章)埋好线索。

## 背景与设计动机

OpenWorker 没有一份成体系的 `docs/*.md` 架构文档——`docs/` 目录里只有一份 `config.example.toml` 和一张示意图 `docs/assets/how-it-works.png`。这和本系列此前几个项目(尤其是文档极其丰富的 OpenClaw)形成了鲜明对比。原因不难猜:这是一个仍在"open beta"阶段、由 Andrew Ng 团队快速迭代的产品,工程说明被直接写进了代码本身——`pyproject.toml` 里密集的行内注释解释"为什么用这个库而不是那个库",各模块 docstring 解释设计意图。这意味着读这个仓库的正确姿势,是把 README、`pyproject.toml` 和源码当成一手资料通读,而不是指望一份独立的架构文档替你消化。

这也解释了为什么第一篇要花大量篇幅整理"目录职责地图"而不是直接跳进核心循环:没有现成的地图,就得自己画一张,后面几章的深挖(第 03 章 engine/agent、第 08 章 board/MCP、第 11 章 Reviewer 评测)都要用到这张地图上的坐标。

## 核心机制详解

### 顶层目录:六个各司其职的子系统

仓库根目录下,除了标准的 `.github/`、`LICENSE`、`README.md` 之外,有六个目录构成了整个工程的骨架:

| 目录 | 角色 | 关键事实 |
|---|---|---|
| `coworker/` | Python 后端主体 | 148 个 `.py` 文件,约 5.03 万行代码 |
| `surfaces/gui/` | React + Tauri 桌面壳 | `src/`、`src-tauri/`、`e2e/`(74 个 spec)、`e2e-live/` |
| `stt/` | 语音输入 sidecar | Rust crate `ocw-stt`,核心依赖 `whisper-rs`/`cpal` |
| `packaging/` | 安装包与分发 | DMG/Windows 构建脚本、自动更新清单生成、开发环境引导 |
| `tests/` | 后端测试套件 | 135 个 `test_*.py`(不含子目录),约 3.5 万行,外加 `tests/corpora/` |
| `scripts/` + `reports/` | 评测方法论 | 4 个评测/语料脚本 + 8 篇 `reviewer-eval-*.md` 报告 |

这六个目录里,前四个是"运行这个产品需要的东西",后两个是"验证这个产品足够安全、足够好用需要的东西"——这个二分在后面看 CI 工作流(`.github/workflows/ci.yml` 只有三个 job:`pytest`、`gui-unit`、`gui-e2e`)时会更清楚:评测报告不在 CI 里自动生成,而是人工按需跑出来再提交进仓库,这是第 03 篇要展开的细节。

`stt/` 值得单独说一句:它是一个独立的 Rust crate,`Cargo.toml` 里写着 `name = "ocw-stt"`、`description = "Local, offline speech-to-text engine for OpenWorker hosts"`,依赖 `whisper-rs` + `cpal`(跨平台音频采集)。它和 Python 后端、Tauri 前端都不共享构建体系,是一个纯粹通过进程边界(sidecar)接入桌面壳的独立组件——`Cargo.toml` 里甚至留了一条工程决策注释:

```toml
# Keep the v1 engine compatible with macOS releases that predate newer Metal
# APIs. We can add an opt-in Metal build once the packaged app has a verified
# minimum macOS target.
whisper-rs = "0.16"
```

这条注释和 `pyproject.toml` 里那些解释依赖选型的注释是同一种工程气质:决策连同它的权衡一起写进构建配置,而不是丢进一份容易过时的设计文档。

`packaging/` 下能看到打包链路的三个环节各自的落地文件:`setup_dev_env.sh`(README 里"一次性引导"提到的脚本)、`build_dmg.sh` / `build_windows.ps1`(两个平台的安装包构建)、`make_update_manifest.py`(自动更新清单生成)。`docs/` 除了那份配置示例,再没有别的——这进一步印证了"文档即代码注释"的策略。

### coworker/ 包内部:37 个顶层模块 + 14 个子系统目录

`coworker/` 包根目录下直接摆着 37 个 `.py` 文件,同时又有 14 个子目录。用 `find`/`wc -l` 量出的真实规模差异很大:

| 子目录 | 文件数 | 代码行数 | 一句话职责 |
|---|---:|---:|---|
| `connectors/` | 28 | 13561 | 外部工具/平台集成(GitHub、Slack、Gmail、HubSpot 等),仓库最大子系统 |
| `server/` | 4 | 9318 | FastAPI 服务(`app.py` 2882 行)+ 会话/治理管理器(`manager.py` 6257 行) |
| `providers/` | 15 | 5478 | 模型提供商适配层(Anthropic/OpenAI/Gemini/Bedrock/Vertex/Codex 等) |
| `teams/` | 12 | 4096 | 多智能体协作(board、journal、CLI `ocw`) |
| `tools/` | 12 | 1713 | 内置工具实现(文件、shell、git、search 等) |
| `personas/` | 4 | 1053 | 内置专家角色的清单与加载 |
| `mcp/` | 5 | 861 | MCP 客户端集成 |
| `automation/` | 5 | 807 | 定时/无人值守任务调度 |
| `skills/` | 3 | 785 | 技能的发现与存储 |
| `memory/` | 5 | 540 | 记忆读写 |
| `web/` | 5 | 553 | 网页抓取/工具 |
| `testing/` | 4 | 590 | 测试基础设施(FakeSlack 等测试替身) |
| `tui/` | 2 | 257 | 终端界面 |
| `agents/` | 7 | 286 | Agent 上下文与基类 |

而挂在包根上的 37 个顶层模块,行数跨度同样悬殊——从 3 行的 `__init__.py` 到单文件 **2164 行的 `engine.py`**(103139 字节),中间还有 `permissions.py`(687 行)、`cloud.py`(689 行)、`conversations.py`(625 行)、`agent.py`(621 行)、`compaction.py`(561 行)等一批 500 行上下的模块,以及 `sessions.py`(46 行)、`project.py`(40 行)这类只有几十行的小文件。

把这两组数字放在一起看,能读出一条明显的分界线:**`server/manager.py` 单文件就有 6257 行,比 `connectors/` 整个子系统(13561 行、28 个文件)的近一半还多,比 `providers/`、`teams/`、`tools/` 任何一个子目录的总行数都大**。换句话说,"是不是子目录"这件事,和"体量大不大"并不是简单的正相关——`manager.py` 体量惊人却仍是包根下的单文件,而 `agents/` 只有 286 行却已经是独立目录。

### 一种合理的解读:先有核心概念,后有专业子系统

把顶层模块和子目录对照着看,能看出一条更接近事实的演化线索:

- **包根上的单文件模块,大多是"一次对话生命周期"里贯穿全局的核心概念**——`engine.py`(核心循环)、`agent.py`(Agent 定义)、`permissions.py`(权限)、`risk.py`(风险分级)、`audit.py`(审计)、`provenance.py`(溯源)、`compaction.py`(上下文压缩)、`sessions.py`/`conversations.py`(会话与对话)、`overrides.py`(配置覆盖)、`reviewer.py`(Auto-Approve 审阅模型)。这些概念彼此紧密耦合、需要互相导入对方的类型,拆成子包反而会制造大量跨包循环引用,不如就近放在包根,靠模块级 docstring 和类型标注维持可读性。
- **子目录,大多是"往外扩展"的方向**——连接外部平台的 `connectors/`,适配不同模型厂商的 `providers/`,支持多智能体协作的 `teams/`,把内置工具能力封装成独立单元的 `tools/`。这些子系统的共同特点是:内部条目彼此并列、松耦合(一个 Slack 连接器和一个 GitHub 连接器互不依赖),数量还在持续增长(`connectors/` 28 个文件、`providers/` 15 个文件),自然需要目录边界来管理内聚。
- `automation/`(定时任务)、`unattended.py`/`selfwake.py`(顶层模块,处理无人值守场景下的自我唤醒)这一组是个有趣的中间态——`automation/` 已经是子目录,但和它紧密相关的 `unattended.py`、`selfwake.py`、`inbox.py`/`inbox_routing.py` 却还留在包根。这提示这套"自动化+无人值守"体系可能还在演化中,尚未收敛成一个边界清晰的独立子系统。

这不是一份可以在代码里直接验证的"历史记录"(仓库没有附带迁移日志),但作为一种阅读策略是可靠的:**遇到一个顶层模块,先假设它是核心循环强耦合的一部分;遇到一个子目录,先假设它是可以横向扩展的"插件集合"**。这条经验规则在后面读 `connectors/`(第 05-06 章)和 `providers/`(第 04 章附近)时会反复用到。

### server/ 里的两个巨型文件

`coworker/server/` 只有 4 个文件,却扛起了 9318 行代码,其中 `app.py`(2882 行)是 FastAPI 服务入口和路由层,`manager.py`(6257 行)是会话生命周期、权限治理、团队协作工具注入等逻辑的汇聚点——单看行数,`manager.py` 是全仓库最大的单一文件。从前面摘录的 `manager.py` 片段可以看到,它内部像 `_post_chat_tool`、`_team_options_tool`、`_steer_tool` 这类方法,直接在方法体内 `import aisuite as ai` 并用 `ai.tool(...)` 包装闭包函数——这是"治理层在运行时动态组装工具"的一种具体写法,第 02 篇会继续深挖 `aisuite` 在这里扮演的角色。

`run.py`(175 行)则是这个子系统里唯一的"薄"文件——它是 `openworker-server` 命令行入口对应的启动脚本,和 `app.py`/`manager.py` 的体量完全不在一个量级。

## 常见问题/易踩坑

- **不要以为"子目录 = 更重要/更大"**:`server/manager.py` 一个文件的行数就超过 `connectors/`、`providers/`、`teams/` 中的任何一个整体子系统,判断子系统权重要看行数和文件数的真实统计,而不是目录层级本身。
- **`docs/` 目录几乎是空的**:只有一份配置示例和一张图,不要指望在这里找到架构说明——一手资料是 README、`pyproject.toml` 的行内注释和源码 docstring。
- **顶层模块和子目录不是父子关系**:`automation/` 是独立子系统,但 `unattended.py`、`selfwake.py`、`inbox.py`、`inbox_routing.py` 这些和无人值守自动化密切相关的模块仍留在包根,读这部分代码时要同时打开包根和 `automation/` 两处。
- **`scripts/` 和 `reports/` 不是普通的开发脚本/测试报告**:它们是第 11 章要深挖的 Reviewer 评测方法论的落地物,这里先记住它们的存在和大致用途即可,不必现在就深入。

## 小结

OpenWorker 的顶层布局把"产品运行需要什么"(`coworker/`、`surfaces/gui/`、`stt/`、`packaging/`)和"产品可信需要什么"(`tests/`、`scripts/`+`reports/`)分得很清楚;而 `coworker/` 包内部"37 个顶层模块 + 14 个子系统目录"并存的布局,大概率反映了一条"核心概念先长在包根、往外扩展的能力才拆子目录"的演化路径——`connectors/` 体量最大但仍是横向并列的适配器集合,`server/manager.py` 单文件体量最大却仍安于包根级的子目录之内。下一篇会顺着 `pyproject.toml` 和 README 里"Built on aisuite"这一节继续往下挖:OpenWorker 到底在多大程度上依赖这个上游库,又在它之上叠加了什么。
