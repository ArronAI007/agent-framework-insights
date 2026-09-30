# DeepSeek Harness 的供应链治理：为什么把 Cordis 源码拷进仓库

这一篇要回答的问题是：大多数项目对上游框架都是 npm 依赖加 lockfile，dsh 为什么要把 Cordis 及其基础库的源码原样拷进 `vendor/`、改名、并逐条记录本地补丁，以及围绕它还有哪些治理手段。

结论先说。第一，vendoring 换来的是框架层的可审计、可打补丁、版本钉死，代价是同步维护成本，dsh 把这些代价都显式化了：manifest 表记录来源，本地修改日志记录偏离和理由，同步流程强制回顾每条偏离。第二，落到依赖解析层，靠 `workspace:^` 协议加 `pnpm-workspace.yaml` 的 `overrides`，保证解析到的永远是仓库里的源码。第三，对不值得整份 vendor 的第三方依赖，还有 `patchedDependencies` 和 `allowBuilds` 两道手段，治理精神一致：默认不信任，每个例外都有名字、有理由、留在版本控制里。

## 为什么不直接 npm 依赖

如果在 `package.json` 里写一个 `cordis` 的版本范围，会失去三样东西。审计边界：框架层每次行为都经过 `node_modules` 里一份不受版本控制的代码，想知道某个版本改了什么只能翻 CHANGELOG。补丁能力：发现框架本身的 bug，比如插件卸载时的竞态，只能等上游发版，或用 `patch-package` 在 `node_modules` 层打运行时补丁，而这类补丁的内容和理由通常不进代码评审，团队里没人真正知道自己在跑一份被改过的框架。升级节奏：依赖版本号意味着整包接受，挑不出自己需要的那部分改动。

反过来，自己手写一份"需要的那部分框架逻辑"，又容易悄悄偏离上游语义，导致和社区认知不一致。dsh 选的中间路径是把上游源码原样拷进仓库，既不重新实现，也不通过 npm 间接依赖，所有本地修改都在一份公开文档里逐条记录并附理由。这样审计变成读一份 markdown 加一份 diff，补丁走正常代码评审，升级成为主动的同步操作。

## vendor/README.md 与 manifest

`vendor/README.md` 开篇就是策略陈述：这些源码副本被拷进 monorepo，而不是通过 npm 依赖，这样 harness 完全拥有自己的框架层，可审计、可打补丁、被钉死。所有 vendored 包统一改名到 `@deepseek-ai` scope，`cordis` 变成 `@deepseek-ai/cordis`，`@cordisjs/plugin-<x>` 变成 `@deepseek-ai/cordis-plugin-<x>`。改名的原因和发布有关：harness 的叶子包都把 `@deepseek-ai/cordis` 声明成 peer dependency，值是 `workspace:^`，发布时这份框架层也会一起发布；如果不改名，直接用上游包名发布就等于在公共 registry 上抢注别人的包名，这是必须避免的供应链事故。

manifest 表格是治理的核心数据结构，九个 vendored 包每行记录六列：仓库目录、npm 包名、上游名、版本、上游仓库、commit。commit 精确到可以拿去上游仓库对出准确 diff 的程度，不是"大约 4.0"。表格记录的是上游版本与 commit，而每个 vendored 包自己的 `package.json` 携带的是 Harness 的发布版本，两个版本号含义不同。README 还列出了哪些依赖没有 vendor（`@standard-schema/spec`、`js-yaml`、`chokidar` 继续走 npm），以及哪些上游包经过验证确实没被使用因此故意不 vendor（`reggol`、`@cordisjs/utils`）。vendoring 的范围是盘点后的决定，不是把上游整个抄一遍。

## 本地修改日志

README 的 "Local modifications" 一节要求穷举每一条与上游的偏离。有两条最能说明这套做法的价值。

一条是对 `cordis/src/fiber.ts` 的生命周期加固：它本地补上了三处可重入销毁的漏洞。一个 effect 的 owner-list 包装在 setup 主体运行之前就已登记，所以在 setup 内部发起的卸载会等待 setup 和所有已收集的清理；同步 setup 失败会移除包装并回滚已收集的清理；当 owner 处于 `UNLOADING` 状态时拒绝创建新 effect（`PENDING` 与 `LOADING` 仍然合法），避免清理期间的注册逃出卸载快照。这类并发正确性问题只有深入理解插件生命周期语义才能发现，也只有拥有源码才能修，如果框架是黑盒依赖，只能排队等上游。

另一条是 `include/src/index.ts`：`applyEntryPatches` 在逐条 `insert` 时同时建立索引，使同一列表里靠后的 patch 能够配置或禁用靠前 patch 插入的行；上游是在 patch 循环之前一次性建 id 索引，导致被插入的行无法再被 patch。这条服务于 harness 自己的 `dsh --dump-config` 功能，并注明由 `packages/boot/app-boot/tests/config-reload.spec.ts` 覆盖。几乎每条修改后面都跟着 "Covered by ...spec.ts"，治理文档和测试证据是绑定的。

更新流程写在根 `AGENTS.md` 的 "Vendoring policy" 里：按 `vendor/README.md` 的同步流程更新，重新应用或废弃已记录的本地修改，再运行 `pnpm run test && pnpm run build`。同步流程要求记录上游 `git rev-parse HEAD`、拷贝 `src/`、逐条处理本地修改清单、更新 manifest 的版本和 commit。这个流程刻意繁琐，每次同步都强制回顾"我们改了上游什么、还需不需要"，而不是 `git pull` 覆盖。

## 在依赖解析层落地

声明本身不会自动生效，让 vendored 源码取代 npm 副本靠两层配合。第一层是仓库内所有 manifest 对 vendored 名字的引用统一使用 `workspace:^` 协议，包括 307 个叶子包对 `@deepseek-ai/cordis` 的 peer dependency。README 的说法是：本地构建解析到钉死的 workspace 包，发布时再把协议替换成发布的 semver 范围。第二层是根 `pnpm-workspace.yaml` 的 `overrides`：

```yaml
overrides:
  '@deepseek-ai/cosmokit': 'link:vendor/cosmokit'
  '@deepseek-ai/schemastery': 'link:vendor/schemastery'
```

它把这两个名字无条件重写成本地 `link:`，不论声明处写的是什么版本范围，兜住的主要是 vendor 包之间仍按上游 semver 写法互相引用的那些边。这样即使某处声明看上去指向 registry 的版本范围，pnpm 实际解析的也永远是 `vendor/` 下的源码，不存在上游发布者悄悄推新版本的风险。

`vendor/README.md` 还提到一个 link 带来的边界情况：Schemastery 的 `package.json` 额外声明了条件 `exports`（import 走 `.mjs`，require 走 `.cjs`）。原因是 pnpm 链接的是目录本身，没有 `exports` 时 Node 的 ESM 解析器会退回读 `main` 字段加载 CJS 入口，而 CJS 入口里对 `@deepseek-ai/cosmokit` 的惰性 `require`，在 vitest 这类做模块钩子的宿主里可能与 ESM 加载同一个被链接模块产生竞态。把 npm 依赖换成本地路径并非零成本。

## 已经找不到的那道校验

原课程写作时，`scripts/verify-vendored-links.ts` 做的是反向验证：遍历 `pnpm-lock.yaml` 的 `importers`，确认每个引用 vendored 包名的依赖都解析到 `link:` 而非 registry 版本，再检查 `packages` 和 `snapshots` 顶层键里 vendored 包名从未以 `<name>@<version>` 形式独立出现。它防的是"registry 副本与 vendored 版本同时存在，悄悄分叉出两份框架代码却不报任何错"。

材料的核对结论是：这个脚本在当前版本里已经找不到了。`package.json` 的 `hygiene` 现在是 `tsx scripts/run-gates.ts hygiene`，展开的检查项（`rescope-vendor:check`、`publint`、`constraints`、`verify-package-dependencies`、`verify-dsh-package-licenses`、`verify-package-invariants`、`verify-node-next-types`、`verify-cordis-config`、`verify-runtime-closure` 等）里没有它或明显的同名替代。最接近的是 `scripts/check-vendor-manifest.sh`（lefthook pre-commit 的 vendor manifest 守卫，规则是改了 `vendor/*/src` 却没同步更新 `vendor/README.md` 就拒绝提交）和 `rescope-vendor:check`（验证改名一致性），但它们检查的不是 lockfile 有没有偷偷解析出 registry 副本。这意味着这类问题目前依赖 `workspace:^` 加 `overrides` 本身的正确性，以及人工审查 `pnpm-lock.yaml` 的 diff。这是材料明确标注的核对结果，读者若在意，应在本地仓库里再搜索确认。

## 第三方依赖的另外两道手段

整份 vendor 只用于"完全拥有"的框架层。对继续走 npm 的第三方库，`pnpm-workspace.yaml` 有另外两道治理。

`patchedDependencies` 用于不打算整份 vendor、但需要改一处行为的库，用 pnpm 原生补丁机制，补丁文件进版本控制。当前有六条：`@earendil-works/pi-ai`、`@electron/osx-sign`、`@fortune-sheet/core`、`@fortune-sheet/react`、`@yao-pkg/pkg` 和 `node-pty`。后两类里，`osx-sign` 与 `pkg` 伴随 Electron 桌面应用和单文件可执行体分发出现；`pi-ai` 的补丁去掉了流式 tool-call 增量 JSON 的重复解析；`fortune-sheet` 是 Web 端 XLSX 预览用的电子表格组件，补丁修复 HTML 单元格转义。`node-pty` 的补丁内容是给 PTY 后端的 spawn-helper 路径解析加一个可覆盖的出口：优先读环境变量 `DSH_NODE_PTY_SPAWN_HELPER`，其次找 `process.execPath + '-spawn-helper'`，最后才退回原来的 `native.dir` 加 `app.asar` 替换逻辑。为什么不整份 vendor `node-pty`？它涉及原生二进制编译，整份 vendor 的收益抵不过维护成本，所以选补丁。补丁可 diff、可评审，和偷偷手改 `node_modules` 是两回事。

`allowBuilds` 是默认拒绝的白名单：pnpm 10 以上默认阻止依赖运行 install 或 build 脚本，除非显式列入。`esbuild`、`lefthook`、`node-pty`、`koffi`（JSONL 持久化在 Windows 上调用 `MoveFileExW`）被允许，因为确实需要自己的构建脚本；`@google/genai`、`protobufjs`、`node-addon-require-builtin`、`electron-winstaller`、`msgpackr-extract` 被显式拒绝，仓库判断它们的脚本对当前用法是无操作的空跑，拒绝不影响安装成功。其中还有一条精确到 `@deepseek-ai/dsh-subprocess-local@file:packages/subprocess/subprocess-local` 的允许项，对应 Python 运行时部署时恢复 node-pty macOS spawn helper 可执行位的 postinstall 脚本，经过评审。

治理结果还对外可见：`THIRD_PARTY_NOTICES.md` 由 `scripts/gen-third-party-notices.ts` 自动生成、禁止手改，lefthook pre-commit 在任何触及 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`vendor/README.md` 的提交上自动重新生成并 `git add`，同步不依赖人记得去跑。

## 我的看法

以下是基于材料的判断。vendoring 的成本在材料里有具体体现：本地修改日志要求穷举，每次同步要逐条重新应用，还带来了 `exports` 竞态这样只在 link 方案下才出现的新边界；而 lockfile 反向校验脚本的缺失，说明自动化的守门并不是一成不变，"版本钉死"这个承诺的一部分现在落在配置正确性和人工审查上。相比之下，manifest、修改日志与测试绑定、同步流程这几层是仍然在起作用的。若这道校验确实被移除，是一个值得主线确认的治理缺口。

## 小结

- vendoring 把框架层变成自己拥有的代码，用 manifest 表、本地修改日志和强制的同步流程，把审计、补丁和升级变成可评审的普通工程动作。
- `workspace:^` 加 `overrides` 保证依赖解析落到 `vendor/` 源码；曾经存在的 lockfile 反向校验脚本在当前版本中已找不到，需要人工复核。
- `patchedDependencies`、`allowBuilds` 和自动生成的 `THIRD_PARTY_NOTICES.md` 把同样的"默认不信任、例外留痕"用于第三方依赖。

对应原课程篇目：`02-仓库全景与工程实践/04-Vendoring策略与供应链治理`。
