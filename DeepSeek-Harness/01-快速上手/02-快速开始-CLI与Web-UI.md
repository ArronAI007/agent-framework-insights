# 快速开始：CLI 与 Web UI

> `dsh web` 这一句命令背后不是"启动一个 Web 服务器"这么简单——它是一次完整的 Profile 装配：一个空的插件树被逐层打上补丁（`dsh-base` 补丁层、`dsh-web-app` 补丁层、用户自己的 `cordis.patch.yml`），装配出的树里既有跑在 Node 里的 HTTP/WebSocket 服务，也有要发到浏览器执行的插件包。理解这一层装配关系，才能真正理解"`dsh` 启动"这件事在做什么。

## 学习目标

- 分清 `npx @deepseek-ai/dsh web`（发布态，从 npm 拉取）与 `pnpm dsh web`（源码态，跑仓库里的 TypeScript 源码）两种运行方式的本质区别。
- 理解 `apps/cli` 这个包如何通过 `bin` 字段把 `dsh` 命令暴露出去，以及它依赖了哪些运行时 bundle。
- 读懂 `dsh` 命令行解析的分发逻辑（`bin.ts`），知道 `dsh web` 只是 `--profile web` 的一个硬编码别名。
- 知道 Web UI 默认绑定在哪个地址、哪个端口，以及为什么 `--host 0.0.0.0` 被故意禁止。
- 建立"用户输入任务 → 会话创建 → Agent 开始工作"的第一个心智模型，并能指出这个模型在源码里对应哪些文件。

## 背景与设计动机

一个编码 Agent 产品通常需要同时服务两类使用场景：交互式的图形界面（给人用）和无人值守的一次性任务（给自动化流水线用）。如果这两种场景各写一套启动逻辑，很容易出现"Web 版本能用的 flag，CLI 版本却解析不了"之类的漂移。`dsh` 的做法是把"启动方式"抽象成统一的 **Profile**（一组按顺序叠加的插件补丁层），`web`、`headless` 只是两个内置的 Profile 名字，CLI 层只负责"选中哪个 Profile、传哪些参数"，剩下的装配逻辑完全共享。这也是为什么 `dsh web` 在源码里根本不是一个独立的实现，而是 `dsh --profile web` 的语法糖。

## 核心机制详解

### 两种运行方式：发布态与源码态

对于已经发布到 npm 的 `dsh`，最简单的用法是直接用 `npx` 拉取运行：

```sh
npx @deepseek-ai/dsh web
```

如果你是在克隆下来的仓库里做开发，则用 `pnpm dsh`——这条命令实际跑的是仓库源码，而不是打包产物。根 `package.json` 里定义了这条脚本：

```json
// package.json（节选）
"scripts": {
  "dsh": "node --import tsx/esm apps/cli/src/bin.ts",
  ...
}
```

`node --import tsx/esm` 是关键：`dsh` 的源码是纯 ESM TypeScript，`tsx/esm` 作为一个 Node loader hook，让 Node 直接运行 `apps/cli/src/bin.ts` 而不需要提前编译成 JS。`AGENTS.md` 里专门有一条约定强调了这一点的边界：

```markdown
The `dsh` CLI source launch runs through tsx's ESM-only hook (`node --import tsx/esm`);
modules it reaches must stay ESM (no CJS-only exports) — Node's native TypeScript modes
are unavailable across the engines range.
```

也就是说，源码态运行是有代价的约束：整条被 `dsh` 源码启动路径触达的模块链，都不能引入 CJS-only 的导出方式,因为 tsx 的 ESM hook 不兼容那种写法。而发布态（`npx @deepseek-ai/dsh`）跑的是构建产物，这条限制则不适用。

所以：`pnpm dsh web` 等价于 `npx @deepseek-ai/dsh web`，只是前者跑源码、后者跑构建产物——两者最终装配出的插件树、暴露的命令行参数都是一致的。

### `apps/cli`：`dsh` 命令的真正落地

`dsh` 这个命令名从哪里来？答案在 `apps/cli/package.json`：

```json
// apps/cli/package.json（节选）
{
  "name": "@deepseek-ai/dsh",
  "description": "dsh CLI: profile launch, plugin management, and configuration inspection",
  "type": "module",
  "bin": {
    "dsh": "lib/bin.js"
  },
  "files": [
    "lib/*.js",
    "lib/types/*.d.ts"
  ],
  ...
}
```

npm 包名是 `@deepseek-ai/dsh`,但它声明的 `bin.dsh` 指向构建产物 `lib/bin.js`——这正是 `apps/cli/src/bin.ts` 编译后的产物。`apps/cli` 这个包本身依赖了一长串 workspace 内部包（`dsh-base`、`dsh-web-app`、`dsh-headless`、各种 `dsh-tool-*`），这些依赖并不是运行时才动态拉取的插件，而是 CLI 包自己在 `package.json` 里显式声明的依赖——`dsh` 命令能装配出哪些 Profile,取决于这个包依赖了哪些 bundle。

### 命令分发：`bin.ts` 里的四种模式

`apps/cli/src/bin.ts` 是整个 CLI 的入口，逻辑很短：先解析参数,再按模式分发到不同的实现文件（下面这段是当前仓库的真实实现，比早期版本多了一层错误兜底和一个显式的执行入口守卫，以及 0.1.7 新增的第四种模式 `dump-config-schema`）：

```typescript
// apps/cli/src/bin.ts
import { loadLayeredEnv, StartupError } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parseDshArgs } from './args.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'

export async function runCli(): Promise<void> {
  const version = readVersion()
  const invocation = parseDshArgs(process.argv.slice(2), version)

  switch (invocation.mode) {
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      try {
        await runProfile({
          environment: loadLayeredEnv('dsh'),
          profile: invocation.profile,
          fromDefaultProfile: invocation.fromDefaultProfile,
          patchFiles: invocation.patches,
          args: invocation.args,
        })
      } catch (error) {
        if (!(error instanceof StartupError)) throw error
        await reportStartupFailure(error, { home: resolveDshHome(), version, profile: invocation.profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

if (import.meta.main) {
  await runCli()
}
```

三个值得留意的变化：

1. **每个分支依旧用动态 `import()`**而不是顶层静态导入——这一点没变。如果你只是运行 `dsh plugin --profile tui add some-package`，进程根本不需要加载 `profile-boot.ts` 里那一整套"装配插件树、启动 HTTP 服务"的代码——四种模式互不污染彼此的加载路径，启动速度和内存占用都更可控。`invocation satisfies never` 这一行是 TypeScript 的"穷尽性检查"写法：如果未来 `DshInvocation` 联合类型新增了一个模式而这里忘了处理，编译期就会报错，而不是留到运行时才发现分发逻辑漏了一支。
2. **分发逻辑被包进了一个导出的 `runCli()` 函数，配合 `if (import.meta.main)` 守卫**——这不只是代码风格调整：把整个 CLI 主流程做成一个可以被 `import` 的函数，意味着测试代码或者未来别的入口（比如桌面壳，见下文）可以直接调用 `runCli()`，而不必真的 fork 一个子进程去跑 `bin.ts`；`import.meta.main` 是 Node 用来判断"当前模块是不是被直接执行的入口文件"的标准写法，只有满足这个条件才会自动跑一次 `runCli()`，被别处 `import` 时则不会有副作用。
3. **`profile` 分支新增了 `try/catch`，专门捕获 `StartupError` 并交给 `reportStartupFailure` 统一渲染**——之前的版本里，装配阶段的任何失败都会是一段裸的 Node 异常堆栈；现在 `profile-boot.ts` 会把"可预期的启动失败"（比如补丁文件语法错误、缺少必需的凭证引用）包装成 `StartupError`，`bin.ts` 捕获后调用 `reportStartupFailure` 生成一份带 `$DSH_HOME`、版本号、Profile 名字上下文的诊断信息，再用 `process.exit(1)` 退出——这是"给用户看得懂的错误提示"和"给开发者看的完整堆栈"之间的一个折中：只有 `StartupError` 会被这样格式化，其他意料之外的异常仍然会原样抛出，不会被这层 catch 悄悄吞掉。

另外注意分发表里多出来的第四个分支 **`dump-config-schema`**（`--dump-config-schema`，0.1.7 新增）：它和 `--dump-config` 一样不启动进程，但打印的不是补丁层列表，而是组合树里各插件声明的 JSON Schema。它和 `profile`/`dump-config` 的具体边界下一篇会展开。

### `web` 是 `--profile web` 的别名

`apps/cli/src/args.ts` 用 `commander` 解析参数。**这里有一处需要更正的地方**：这一篇早先的版本里，`web` 曾经是 `apps/cli` 里唯一一个硬编码的 commander 子命令，模块顶部注释当时写的是"`web` is a hardcoded alias for `--profile web`"。当前仓库已经把这条能力**通用化**了，模块顶部注释也相应改成了：

```typescript
// apps/cli/src/args.ts
/**
 * `dsh <name>` abbreviates `dsh --profile <name>`; `plugin` manages a
 * profile's plugin dependencies by forwarding to pnpm.
 */
```

也就是说现在不只是 `web`，任何 Profile 名字都可以直接跟在 `dsh` 后面——`dsh web`、`dsh headless "task"`、`dsh tui`，乃至你自己起的 Profile 名字，都是 `dsh --profile <name>` 的等价简写，不再是"`web` 特别硬编码，其他名字都得写全 `--profile`"这套规则。这条改写发生在真正交给 commander 解析**之前**：只要第一个参数不是以 `-` 开头的 flag、也不是字面量 `plugin`，就会在参数最前面插进一个 `--profile`。

所以 `dsh web --port 8080` 和 `dsh --profile web --port 8080` 依然是完全等价的两种写法，区别只是前者更好记；只是这个"更好记的简写"现在对所有 Profile 名字都成立，而不只是 `web` 一个特例。`args.ts` 顶部的帮助文本也直接给出了几个等价关系的例子：

```typescript
// apps/cli/src/args.ts
const HELP_EXAMPLES = `
Examples:
  dsh web                                   boot the web profile (same as: dsh --profile web)
  dsh rescue --from-default-profile web
                                            create rescue from the shipped web template, then boot it
  dsh headless "run the tests"              answer one task, print the result, and exit
  dsh tui --patch ./extra.yml               boot a custom profile with one extra overlay
  ...
`
```

关于参数解析还有一个设计细节：`--profile` 之后的参数解析在**第一个不认识的 token** 处停下，剩下的全部原样转交给被启动的 app 自己解析（这就是为什么 `dsh --profile tui -h` 打印的是 `tui` 应用自己的帮助，而不是 launcher 的帮助）。这个改写规则、`plugin` 为什么被排除在外、以及新出现的 `--from-default-profile`（从官方模板创建一个新 Profile）具体怎么用，第 03 篇会展开讲。

### Web UI 默认绑定地址：`127.0.0.1:3080`

Web UI 实际监听的 host/port 是在 `dsh-web-app` 这个 bundle 的补丁层里配置的：

```yaml
# packages/bundle/web-app/cordis.patch.yml（节选）
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

`!!js` 是 Cordis Loader（`cordis-plugin-include`）识别的一种表达式语法：`ctx.webStartup.host ?? '127.0.0.1'` 在装配阶段会被求值成"如果命令行传了 `--host`，用命令行的值；否则用字面量默认值 `'127.0.0.1'`"。端口同理，默认 `3080`。`--host`/`--port` 这两个 flag 本身在 `dsh-web-app` 自己的启动插件里解析：

```typescript
// packages/bundle/web-app/src/startup.ts（节选）
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    ...
}

export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    if (options.host === '0.0.0.0') {
      program.error('error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead')
    }
    ...
  })
}
```

这里能看到一条明确写在代码里的安全策略：**`--host 0.0.0.0` 被显式拒绝**。理由很直白——Web UI 背后是一个可以执行任意 shell 命令的编码 Agent，一旦绑定到 `0.0.0.0`，局域网内任何设备都能访问到这个"远程代码执行入口"。默认只绑定 `127.0.0.1`（仅本机可访问），这不是一个可以随手改掉的配置项，而是代码里的一条硬性校验。

另一个值得知道的变化是：**当前版本 `dsh web` 启动完成后会默认打开系统浏览器**（`web-runtime` 行读取 `webStartup.openBrowser`），新出现的 `--no-open` 就是用来关掉这个行为的开关——在远程终端或 CI 环境里跑 `dsh web` 时记得加上它。

### 第一次会话的心智模型

不管是终端还是浏览器打开 `dsh web` 之后的地址，"用户输入一个任务"到"Agent 开始工作"这条路径的抽象是一致的：

1. **传输层接住请求**：网关在装配树里的行叫 `typert-gateway`（`@deepseek-ai/dsh-api-gateway`，0.1.7 起由 `dsh-base` 层提供，早期版本里它叫 `api-gateway`、挂在 `dsh-web-app` 层），是"Host 侧 Typert RPC 分发端点"（`packages/api/gateway`，Host 服务 `ctx.typertGateway`）；浏览器发来的 HTTP/WebSocket 请求经由 `webserver` 绑定的端口，落到这个网关上——web-app 层里的 `connection` 行（`@deepseek-ai/dsh-client-connection`）负责把网关绑定到 webserver 的 `/api` 下；
2. **会话被创建或恢复**：网关背后的会话相关能力（`dsh-session`、`dsh-storage`）负责把这次交互对应到一个具体的 `Session`——新会话意味着一条全新的事件日志开始被追加；
3. **Agent 循环开始驱动**：`dsh-agent`/`dsh-agent-loop` 拿到会话后，进入"读取用户消息 → 组装请求 → 调用模型 → 执行工具调用 → 写回会话日志"的循环，这正是后续章节（第 04 章"Agent 核心循环"）要深入拆解的部分；
4. **浏览器端渲染**：`web-app` 补丁层里的一长串 `ui-*` 插件（`ui-conversation`、`ui-tool`、`ui-workflow-run` 等）通过 WebSocket 订阅会话事件，把日志实时渲染成对话界面。

CLI（`apps/cli`）在这条链路里的角色，仅仅是**装配出承载这条链路的插件树，并把命令行参数原样转交给树里的具体插件**——它自己不实现任何"理解任务""调用模型"的逻辑。这也是为什么理解 `dsh` 的运行形态，最终会引向理解 Cordis 这套插件框架本身（第 03 章的主题），而不是停留在 CLI flag 层面。

### `apps/web`：真正跑 Vite 构建的前端工程

值得一提的是，"Web UI"这几个字对应的静态资源并不是 `apps/cli` 自己构建的,而是一个独立的前端工程 `apps/web`：

```json
// apps/web/package.json（节选）
{
  "name": "@deepseek-ai/dsh-web-frontend",
  "description": "Web application entry: vite build over the @deepseek-ai/dsh-client-web shell library; dist/ served by apps/cli's dsh web",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "watch": "vite build --watch --no-emptyOutDir"
  },
  "dependencies": {
    "@deepseek-ai/dsh-client-web": "workspace:^",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  ...
}
```

它的 `description` 已经写明了关系：这个包用 Vite 把 `@deepseek-ai/dsh-client-web` 这个"浏览器端插件外壳库"打包成 `dist/`，而这个 `dist/` 最终是被 `apps/cli` 的 `dsh web`（也就是 `web-app` 补丁层里的 `web-runtime` 行）解析并托管出来的静态资源。这印证了课程导读里提到的"Host 与 Client 物理分离"——`apps/web` 是纯浏览器端工程，和跑在 Node 里的 `apps/cli` 是两个独立的构建产物，只通过约定好的 `dist/` 路径和运行时 WebSocket 协议衔接。

0.1.7 之后 Web 前端值得一提的新功能有两类（都是纯浏览器侧的用户体验变化，不改变装配模型）：一类是**实验性语音输入**（`apps/web` 依赖的 `@deepseek-ai/dsh-experimental-voice-input-bundle`，本地 SenseVoice 语音识别，首次使用时下载运行时）；另一类是设置体验完善——General Settings 底部新增 **Current version 行**（展示构建时的 `DSH_CLIENT_VERSION`）、模型厂商选择入口的 UX 重写。另外有一个与浏览器直接相关的平台差异：DeepSeek 账号登录入口现在只在桌面壳（Electron）里可见，Web 端被有意隐藏（上游 #4897）。

### 补充：`apps/desktop`，一个新出现的第三种运行形态

课程写到这里时（2026 年 8 月中），`dsh` 只有"CLI 跑源码/发布包"和"浏览器打开 `dsh web`"这两种形态。仓库从 2026-08-28 起新增了 `apps/desktop`：

```json
// apps/desktop/package.json（节选）
{
  "name": "@deepseek-ai/dsh-desktop",
  "description": "Electron desktop shell for a bundled dsh runtime and external plugins",
  ...
}
```

配合一个私有的 `apps/desktop-host`（`description` 是 "Private Node-mode host process for the Electron desktop application"），这是一个用 Electron 打包的原生桌面壳：把 `dsh` 运行时和一份自带的 Node 环境一起打包分发，用户不需要自己装 Node/pnpm 就能跑起完整的 Agent。这条路径本质上仍然是"装配出前面讲的同一棵插件树"，只是把"谁来托管 Web UI 的浏览器窗口"从系统浏览器换成了 Electron 自带的 Chromium——对理解"CLI 装配 Profile"这条主线没有影响，值得知道的是它的存在，具体的打包与更新机制不在本课程的讨论范围内（这是一个 2026-08-28 之后才出现的能力，本课程后续章节的源码解读仍以 `apps/cli`/`apps/web` 这条 Node/浏览器路径为主）。0.1.7 前后的桌面壳还补上了完整的引导体验：启动后先出现一个独立的 Welcome 窗口（原生窗口控制、品牌化设计），在进入工作区之前完成凭证检查——没有配置任何模型 API Key 时，Welcome 窗口会直接给出 API Key 填写页；同时 DeepSeek 账号登录也只在桌面壳内提供，Web 端不再显示这个入口。

## 常见问题/易踩坑

- **以为 `dsh web` 和 `dsh --profile web` 是两套实现**：不是，前者是硬编码别名，命令行 flag 解析和装配逻辑完全共享，行为不一致大概率是理解错了参数转发边界。
- **想把 Web UI 暴露到局域网**：目前 `--host 0.0.0.0` 被显式拒绝，这不是 bug，是刻意的安全限制；如果确实需要远程访问，应该走反向代理或 SSH 隧道之类的方案，而不是绕过这条校验。
- **修改了 `apps/web` 的前端代码但页面没更新**：需要确认是走 `pnpm dev:web`（带热更新的开发模式）还是需要先 `pnpm run build:web` 生成新的 `dist/`——生产态的 `dsh web` 托管的是构建产物,不会自动感知源码变化。

## 小结

`dsh web` 和 `dsh --profile web` 是同一件事的两种写法：CLI 层只负责解析参数并选中一个 Profile，真正的"服务器绑定地址""浏览器插件树装配""任务如何变成会话"全部由被选中的 Profile（这里是 `dsh-base` + `dsh-web-app` 两层补丁叠加的结果）决定。下一篇会把 CLI 的四种模式（`profile`/`plugin`/`dump-config`/`dump-config-schema`）和 Profile 装配机制本身讲透，包括 `dsh --profile headless "task"` 这种一次性无人值守任务怎么跑起来。
