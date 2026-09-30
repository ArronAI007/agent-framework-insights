# DeepSeek Harness 的仓库地图：三百多个包，怎么在里面不迷路

这一篇要回答的问题是：dsh 的仓库有 307 个可独立发布的叶子包，打开 `packages/` 应该怎么读，看到一个 `@deepseek-ai/dsh-*` 的包名，能不能立刻判断它是干什么的、住在哪里。

结论可以先说三句。第一，`packages/` 采用两级目录，一级目录只是给人浏览的"能力领域"标签，二级目录才是真正的构建、依赖和发布单元。第二，几乎每个领域都按"抽象座、本地或其他实现、模型工具"三层组织，包名前后缀基本就是角色说明。第三，307 个包共享同一个版本号，兼容性问题被降级成"这一次发布是否整体可用"。

本文对照的是 `0.1.7-alpha.1`。这个仓库迭代很快，包数量和分类目录都在变，文中的数字以你本地 `find packages -mindepth 2 -maxdepth 2 -type d | wc -l` 数出来的为准。

## 为什么不摊平，也不合并

设想两种极端做法。把全部代码塞进十几个大包，比如一个 `core`、一个 `tools`、一个 `client`，任何一次改动都要重建、重发、重新判断兼容性一个巨大的包，想单独替换"会话持久化用 SQLite 还是 JSONL"这种实现细节也没有边界可用。反过来，把 307 个包全部摊平在 `packages/` 下，`ls` 出来是一堵名字墙：`dsh-fs`、`dsh-fs-local`、`dsh-fs-sandbox`、`dsh-tool-fs`、`dsh-tool-fs-search`，它们之间的关系只能靠字符串前缀去猜。

dsh 的答案是两级目录。`fs/`、`shell/`、`subagent/` 这样的一级目录不参与构建，不对应发布单元，只按业务语境把包聚在一起；`fs/fs`、`fs/fs-local`、`fs/tool-fs` 这样的二级目录才是 npm 包，各有自己的 `package.json` 和 `tsconfig.json`。这一点直接体现在 workspace 定义上：根 `pnpm-workspace.yaml` 里写的是 `packages/*/*`，一级目录本身不是 workspace 成员。所以 `packages/fs/package.json` 并不存在，试图 `pnpm add` 一个一级目录名会失败，必须精确到叶子包，例如 `@deepseek-ai/dsh-fs`。

这套划分背后是贯穿全仓库的一条原则：能力座与实现分离。以 `fs` 分类为例，它下面有七个包：`fs` 定义 `ctx.fs` 服务契约，`fs-local` 是本地实现，`fs-sandbox` 是沙箱围栏实现，`fs-observation-policy` 管读前写策略，`tool-fs` 和 `tool-fs-search` 把能力包装成模型能调用的 read/write/edit 与 glob/grep 工具，`tool-str-replace-editor` 是另一种编辑工具变体。`tool-fs` 只依赖抽象的 `dsh-fs`，不知道背后跑的是本地实现还是沙箱实现。一级目录给人看，二级目录给构建工具、依赖解析和发布流程看，这条边界就是两级结构要保护的东西。

## 一张地图：从入口到框架层

workspace 的成员除了 `packages/*/*`，还有几个各司其职的顶层目录。`vendor/*` 是源码内置的 Cordis 框架层，下一篇之后会专门讲。`apps/*` 是产品层，现在有四个成员：`cli` 是唯一的命令行入口，`dsh` 这个 bin 就从这里出，同时承担 `dsh web` 的浏览器界面别名；`web` 是浏览器前端的构建壳；`desktop` 和 `desktop-host` 是 Electron 桌面应用和它私有的 Node 模式宿主进程。`native/system` 存放本地进程沙箱用的原生启动器，原名 `native/landlock-run`，改名是因为它承载的已经不只是 Linux Landlock 一种后端。`python/sdk-runtime` 不是代码，而是单文件可执行构建的部署根，一份纯依赖清单，`pnpm deploy` 据此算出的依赖闭包既是可执行文件打包的内容，也是 Python SDK 运行时分发的内容。另外还有文档站点 `website`，以及私有的 `benchmarks`，后者只是仓库级基准测试的依赖宿主。

把这些串起来，一条从用户到底层的链路是这样的。用户在终端、浏览器或桌面应用里启动 `apps/cli`；`packages/bundle/*` 以 `cordis.yml` 补丁层的形式把具体能力包组合成整机，`base` 是每个 profile 的第一层补丁，`headless` 在其上叠加"无 Host、无 HTTP、无浏览器"的一次性运行器，`web-app` 叠加浏览器面补丁和前端静态服务，另外还有面向 ACP 与 SDK profile 的 `acp-app`、`sdk-app`、`sdk-minimal`，共六种可发布的整机组合；再往下才是 `core`、`fs`、`shell`、`llm`、`session` 等能力叶子包，它们以 Cordis 插件的形式互相 inject 和 provide 服务；最底下是 `vendor/` 里的 Context、Fiber、Loader、Include 这些框架机制。

浏览器前端有一个值得记住的分工。`apps/web` 只是把 `@deepseek-ai/dsh-client-web` 这个壳库用 vite 构建成静态资源，前端真正的实现全在 `packages/client/*` 里，再由 `dsh web` 子命令通过 `packages/host/frontend-static` 提供服务。桌面版沿用同一种思路：Electron 壳负责界面，真正驱动运行时的是私有的 Node 宿主进程。

## 54 个领域分别管什么

一级分类目录共 54 个。不必逐个记忆，抓住几组关系就能定位大部分包。

核心骨架在 `core`（Agent 接口与注册表、Session 事件溯源存储、Tools 执行管线、System Prompt 组装）、`llm`（供应商中立的模型服务接口、DeepSeek 适配器、请求重试、Token 计量）、`session`（JSONL 与 SQLite 的持久化后端、投影缓存、标题生成，共 20 个叶子包）和 `compaction`（压缩策略、摘要后端、工具结果裁剪）。这几组决定了 Agent 循环怎么跑，前面讲循环与上下文的章节里出现的名字大多住在这里。

能力座与实现成对出现的领域最多：`fs`、`shell`（bash 与 pwsh 执行器座、本地与沙箱实现）、`sandbox`（进程沙箱抽象座及 bwrap、Landlock、macOS Seatbelt、Windows ACL 限制令牌几个本地后端）、`subprocess`、`terminal`、`credentials`、`web`（search 与 fetch 各供应商实现）、`subagent`（子代理座及 fork、spawn、ACP、Claude Code、Codex、dsh SDK 跨进程等后端，共 10 个包）。这些领域的共同点是都有一个不带后缀的抽象包，名字里带 `-local`、`-sandbox` 或供应商名的是实现。

面向外部协议和产品面的有 `acp`、`sdk`、`mcp`、`api`、`host`，以及 `client` 下的 59 个前端叶子包。`context`、`goal`、`plan`、`todo`、`schedule`、`skill`、`interaction` 是一批面向模型和用户交互的功能。`util` 是零依赖的工具原语，`test-support` 是测试基建（LLM mock server、回放插件等）。

近期增长最明显的方向有几处。`experimental` 一个目录就有 20 个包，装的是还在孵化的能力，比如 Agent Teams 多智能体协作、浏览器与 computer-use 的实验性供应商、语音输入和离线语音识别。`ssh` 有 4 个包，提供共享的 OpenSSH 连接以及基于它的远程文件系统、沙箱、子进程和终端 provider，这是一整条"远程执行"能力线。`webhook` 提供签名校验的 GitHub webhook 适配器。`ptc-runtime` 取代了原来的 `code-runtime`，抽象出进程化代码执行座，配沙箱化的 Node 进程实现。同时有几处被移除：E2B 云沙箱后端（`e2b` 分类）已从仓库彻底移走，`sandbox` 现在只保留同机进程级沙箱这一条路线；`examples` 这个 workspace 成员和分类也已不存在。如果你在别的章节遇到多智能体、浏览器自动化或语音输入的新概念，源码大概率在 `packages/experimental/*` 下。

## 从包名反推位置

包名与目录不总是一一对应，推断大致分两步。先看是否命中专属映射：`dsh-sdk-client` 在 `sdk/client`，`dsh-host-*` 系列在 `host/*`，`dsh-client-*` 系列在 `client/*`。专属映射存在例外，最典型的是 `@deepseek-ai/dsh-client-ui-cordis` 实际物理路径是 `packages/extensions/ui-cordis`，并不在 `client/` 下，所以 `dsh-client-*` 是给消费者看的产品分组，不等价于物理目录。命中不了专属映射时，落到通配规则：去掉 `dsh-` 前缀，在 `core/*`、`llm/*`、`shell/*` 等几十个候选一级目录下按"第一个匹配的目录名获胜"来解析。这个规则要成立，二级目录名在全仓库范围内就必须唯一，不能在两个分类下出现同名叶子包。具体映射写在 `tsconfig.base.json` 的路径配置里，下一篇会碰到它。

## 三百多个包，一个版本号

独立发布边界不意味着独立版本线。抽查 `dsh-agent`、`dsh-fs-local`、`dsh-brand`，它们此刻都是 `0.1.7-alpha.1`。这是 `scripts/release/bump.ts` 明确写死的策略：dsh family（所有 `@deepseek-ai/dsh-*` 包，连不对外发布的私有包和 workspace 根 `@deepseek-ai/dsh-root` 也算在内）共享一个版本号，用 `pnpm run release:dsh -- <major|minor|patch|x.y.z>` 一次性推进。`vendor/*` 下的九个包属于另一条 vendored family，各自保留自己的版本号语义，但每次发布要求整个族群一起推进，不允许只发布其中一部分。

这两件事并不矛盾，而是互补的。边界独立保证某个包可以被单独替换、单独依赖、单独测试；版本统一保证消费者不必去猜哪个 `dsh-fs` 版本兼容哪个 `dsh-tool-fs` 版本。任意时间点上这些包都处在同一条时间线上。

## 我的看法

这是基于上述材料的判断，不是官方结论。这套结构的代价，材料里其实自己露出了几处。分类和数量的变化速度很快：短时间内叶子包从 219 涨到 307，分类目录从 49 涨到 54，同时又有整批目录被移除，而文档里的具体断言（哪个目录是干什么的、哪个包在哪）会比代码更快过期，比如前面提到的 `e2b` 和 `examples` 就是文档滞后的例子。所以这张地图更适合当作导航习惯来用，而不是事实清单：遇到具体数字和路径，先在本地用 `find` 或 `grep` 核对。另一个可见的代价是 `dsh-client-*` 这类"名字与位置不一致"的例外需要专属映射表逐一维护，包名前缀不能完全信任。

## 小结

- 一级目录是给人看的领域地图，二级叶子包才是构建、依赖和发布单元，workspace 只收 `packages/*/*`。
- 抽象座、实现、工具三层是主要命名规律，加上 `apps`、`bundle`、`vendor`、`native/system`、`python/sdk-runtime` 各自的清晰角色，可以从入口一路下钻到任何一个能力包。
- 307 个包统一版本号，vendored 框架层独立成另一条版本线。

对应原课程篇目：`02-仓库全景与工程实践/01-Monorepo结构与包职责地图`。
