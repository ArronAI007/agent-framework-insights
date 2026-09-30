# 快速开始：CLI 与 Web UI

这一篇回答的问题是：敲下 `dsh web` 之后，到底启动了什么。答案不是"一个 Web 服务器"，而是一次 Profile 装配：一棵空的插件树被逐层打上补丁，最终既包含跑在 Node 里的 HTTP 与 WebSocket 服务，也包含要发到浏览器执行的插件。CLI 只负责选 Profile、传参数，`web` 不是独立实现，而是 `--profile web` 的简写。Web UI 默认只绑定 `127.0.0.1:3080`，并且代码里硬性拒绝 `--host 0.0.0.0`。

## 两种运行方式

已发布到 npm 的版本，直接用 `npx` 运行；在克隆下来的仓库里开发，则用 `pnpm dsh`：

```sh
npx @deepseek-ai/dsh web     # 发布态：跑构建产物
pnpm dsh web                 # 源码态：跑仓库里的 TypeScript
pnpm dsh web --no-open       # 不自动打开浏览器
```

根 `package.json` 里 `dsh` 脚本的内容是 `node --import tsx/esm apps/cli/src/bin.ts`。`tsx/esm` 是 Node 的 loader hook，让 Node 直接运行 ESM TypeScript，不用先编译。这带来一条约束，`AGENTS.md` 里写得明白：源码启动路径触达的所有模块必须保持 ESM，不能出现只有 CJS 导出的写法，因为 Node 自带的 TypeScript 模式在支持的版本区间内并不都可用。发布态跑的是构建产物，没有这条限制。两种方式装配出的插件树和命令行参数是一致的。

## apps/cli：dsh 命令从哪来

`apps/cli/package.json` 里 npm 包名是 `@deepseek-ai/dsh`，`bin.dsh` 指向 `lib/bin.js`，即 `apps/cli/src/bin.ts` 的构建产物。这个包在 `package.json` 里显式依赖了一长串 workspace 包（`dsh-base`、`dsh-web-app`、`dsh-headless` 以及各种工具包）。这些是 CLI 自己声明的依赖，不是运行时动态拉取的插件：`dsh` 能装配出哪些 Profile，取决于这个包依赖了哪些 bundle。

`bin.ts` 的入口是导出的 `runCli()`，末尾用 `if (import.meta.main)` 守卫，只有被直接执行时才自动运行。这样测试代码或桌面壳可以直接调用 `runCli()`，不必 fork 子进程。它先用 `parseDshArgs` 解析出一个 invocation，再按 `mode` 分发：`profile`、`plugin`、`dump-config`、`dump-config-schema` 四种，每个分支都用动态 `import()` 加载对应实现。所以 `dsh plugin ...` 不会加载装配插件树与启动 HTTP 服务的那一大套代码。分发表末尾的 `invocation satisfies never` 是穷尽性检查，未来新增模式而忘记处理，编译期就会报错。

`profile` 分支还包了一层 `try/catch`：只捕获 `StartupError`（补丁文件语法错误、缺少必需凭证引用这类可预期的启动失败），交给 `reportStartupFailure` 输出带 `$DSH_HOME`、版本号、Profile 名的诊断，然后 `process.exit(1)`。其他意外异常原样抛出，不会被吞掉。用户看到的是可读的提示，开发者仍能拿到完整堆栈。

## web 只是 --profile web 的简写

`apps/cli/src/args.ts` 的模块注释是这样写的：`dsh <name>` 是 `dsh --profile <name>` 的缩写，`plugin` 则是把参数转发给 pnpm 的插件管理。也就是说，这个简写对所有 Profile 名字通用，不只是 `web`：`dsh web`、`dsh headless "task"`、`dsh tui`，以及你自己起的名字，都是同一条规则。实现方式是在交给 commander 之前先改写参数：第一个参数存在、不以 `-` 开头、也不是字面量 `plugin`，就在最前面插入 `--profile`。

`--profile` 之后的解析在第一个 launcher 不认识的 token 处停下，剩下的原样交给被启动的应用。因此 `dsh --profile web -h` 打印的是 web 应用自己的帮助，而不是 launcher 的。改写规则的其他细节、`plugin` 为什么被排除在外、`--from-default-profile` 怎么用，都留给第 03 篇。

## 默认地址与 --host 0.0.0.0

Web UI 监听哪里，在 `dsh-web-app` 的补丁层里配置：

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

`!!js` 是 Cordis Loader 识别的表达式语法，在这一行对应的插件被激活时求值：命令行传了 `--host` 就用命令行的，否则用默认的 `127.0.0.1` 与 `3080`。`--host`、`--port` 由 `dsh-web-app` 自己的启动插件用 commander 解析，同时还有 `--no-open`（不自动打开浏览器）、`--trusted-host <authority...>`（`/api` 的浏览器信任围栏额外接受的主机，可重复）。`--port 0` 表示让操作系统挑一个空闲端口。

`startup.ts` 里有一条明确的安全策略：`--host 0.0.0.0` 会被直接拒绝，报错信息说的是它会把远程代码执行暴露给网络。理由很直接，Web UI 背后是一个能执行任意 shell 命令的 Agent。这是一条写在代码里的硬校验，不是可以随手改掉的配置项。要远程访问，材料里的建议是走反向代理或 SSH 隧道之类的方案。

另外，当前版本 `dsh web` 启动完成后默认会打开系统浏览器，由 `webStartup.openBrowser` 控制；在远程终端或 CI 里跑，记得加 `--no-open`。

## 一个任务怎样变成会话

不论从终端还是浏览器进入，"用户输入一个任务"到"Agent 开始工作"的路径是一致的：

1. 浏览器请求经 `webserver` 绑定的端口，落到 Host 侧的 Typert RPC 网关（`typert-gateway`，即 `@deepseek-ai/dsh-api-gateway`，0.1.7 起由 `dsh-base` 层提供）。`web-app` 层里的 `connection` 行负责把网关挂到 webserver 的 `/api` 下。
2. 会话相关能力（`dsh-session`、`dsh-storage`）把这次交互对应到一个具体的 `Session`。新会话意味着一条新的事件日志开始追加。
3. `dsh-agent` 与 `dsh-agent-loop` 拿到会话后进入循环：读用户消息、组装请求、调用模型、执行工具、写回日志。这是第 04 章的内容。
4. `web-app` 补丁层里的 `ui-conversation`、`ui-tool`、`ui-workflow-run` 等浏览器插件，通过 WebSocket 订阅会话事件，把日志实时渲染成对话界面。

CLI 在这条链路里只做一件事：装配出承载它的插件树，并把参数原样转交给树里的插件。它自己不理解任务，也不调用模型。这也是为什么读懂运行形态，最终要读懂 Cordis，而不是停留在 flag 层面。

## apps/web 与 apps/desktop

"Web UI"的静态资源不是 `apps/cli` 构建的，而是独立的前端工程 `apps/web`（包名 `@deepseek-ai/dsh-web-frontend`）。它用 Vite 把浏览器端插件外壳库 `@deepseek-ai/dsh-client-web` 打包成 `dist/`，再由 `dsh web` 托管。所以修改前端后，开发模式用 `pnpm dev:web`（带热更新），要让 `dsh web` 看到变化则需要先 `pnpm run build:web` 生成新的 `dist/`。这也是"Host 与 Client 物理分离"的一个具体体现：两个独立构建产物，只靠 `dist/` 路径和运行时 WebSocket 协议衔接。

0.1.7 之后的 Web 前端新增了实验性的语音输入（本地 SenseVoice 识别，首次使用时下载运行时）、General Settings 底部的 Current version 行，以及模型厂商选择入口的重写。DeepSeek 账号登录目前只在桌面壳里可见，Web 端有意隐藏。

仓库从 2026-08-28 起新增了第三种运行形态：`apps/desktop`，一个 Electron 桌面壳，配合私有的 `apps/desktop-host`（Node 模式的宿主进程），随包带一份 Node 环境，用户不需要自己装 Node 或 pnpm。它装配的仍是同一棵插件树，只是浏览器窗口由 Electron 自带的 Chromium 承载。启动时先出现独立的 Welcome 窗口，在进入工作区前检查凭证；没有配置任何模型 API Key 时，直接给出填写页。打包与更新机制不在课程范围内。

## 我的看法

`--host 0.0.0.0` 的硬拒绝值得肯定，但它把"想在容器里跑 `dsh web` 再从宿主机访问"这类常见需求推给了用户自己想办法，而材料里只提到反向代理或 SSH 隧道，没有给出官方推荐的做法。同时，`--trusted-host` 存在本身说明"从别的主机名访问"这个场景是被预期的，只是被一道围栏管着。两者如何配合，课程材料中未展开，使用前建议看 `dsh web -h` 和 `startup.ts`。

## 小结

1. `dsh web` 等价于 `dsh --profile web`，CLI 只做参数解析和分发（四种模式），装配逻辑完全共享；简写规则对所有 Profile 名通用。
2. Web UI 默认 `127.0.0.1:3080`，地址由补丁层里的 `!!js` 表达式决定，`--host 0.0.0.0` 被代码硬性拒绝，启动后默认打开浏览器，可用 `--no-open` 关闭。
3. 请求经 Typert 网关进入 Session，由 Agent 循环驱动，浏览器插件通过 WebSocket 订阅事件渲染；前端由独立的 `apps/web` 构建，另有 Electron 桌面壳作为第三种形态。

更详细的源码走读见 `DeepSeek-Harness/01-快速上手/02-快速开始-CLI与Web-UI.md`。
