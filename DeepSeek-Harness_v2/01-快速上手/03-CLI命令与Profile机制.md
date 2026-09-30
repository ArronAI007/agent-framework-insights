# CLI 命令与 Profile 机制

这一篇回答的问题是：`dsh` 的命令行到底决定了什么，以及一个 Profile 是怎么变成一棵可运行的插件树的。三句话概括：CLI 只做元层面的事，即选装配哪棵树、叠加哪些补丁、要不要真的启动，对应 `profile`、`plugin`、`dump-config`、`dump-config-schema` 四种模式；Profile 是"若干 Bundle 补丁层，加上用户层和命令行覆盖层"按固定顺序叠出来的结果，官方模板没有任何特权；启动行为因此是可预测、可审查的，`--dump-config` 就是审查它的工具。

## 四种模式与参数边界

`apps/cli/src/args.ts` 用 `commander` 解析出一个判别联合类型 `DshInvocation`，四个成员各自带着自己需要的字段：

- `profile`：真正启动一个 Profile，字段有 `profile`、`fromDefaultProfile`、`patches`（额外覆盖层，按命令行顺序）、`args`（launcher 自己的 flag 之后的全部内容，原样转交）。
- `dump-config`：不启动，按层打印装配出的插件树。
- `dump-config-schema`：不启动、也不挂载插件，导出各插件声明的配置 JSON Schema（0.1.7 新增）。
- `plugin`：把参数原样转发给 pnpm，在 Profile 目录里执行 `add`、`remove`、`why` 等。

这里有一条边界规则写在模块注释里：launcher 只解析它自己拥有的东西（启动哪个 Profile、哪些 `--patch`、配置导出），launcher 的 flag 必须写在前面，遇到的第一个不认识的 token 就是内层参数的起点。所以 `dsh --profile tui --resume abc` 是用 `--resume abc` 启动 tui Profile，`dsh --profile web -h` 打印的是 web 应用自己的帮助。实现上靠 `allowUnknownOption`、`passThroughOptions`、`enablePositionalOptions` 与 `helpOption(false)` 的组合；只有裸 `dsh -h`（没带 `--profile`）才打印 launcher 的帮助。

`dsh <name>` 的简写在上一篇提过：在交给 commander 之前，若第一个参数不以 `-` 开头且不是 `plugin`，就在最前面插入 `--profile`。`plugin` 被排除，是因为它是另一套语义（管理依赖而不是启动 Profile），并且只有第一个参数恰为 `plugin` 时才注册这个子命令。还有一个保留名：`rejectElectronProfile` 直接拒绝名为 `desktop` 的 Profile，因为桌面应用自己在内部管理这个名字，CLI 也去写同一个目录会互相冲突。

## 只打印不启动的三个开关

三个 dump 开关（`--dump-config`、`--dump-default-config`、`--dump-config-schema`）两两互斥，并且都不接受应用参数。`resolveBoot` 里的注释解释了原因：dump 从不运行应用的命令行 provider，如果允许传参却不生效，打印出的树就会和同样参数下真实启动的结果不一致，误导排查的人。

`--dump-config` 打印一次真实启动会装配出的完整补丁栈，`--dump-default-config` 只打印 Bundle 自带的默认层，不含用户层，也不能同时带 `--patch`。执行逻辑在 `dump-config.ts` 的 `collectConfigDumpLayers`：先收集各 Bundle 层，非 `defaultOnly` 时再依次追加 Profile 自己的 `cordis.patch.yml`、Home 级补丁文件、每个 `--patch` 文件。它是纯静态的补丁列表展开，既不 import 插件，也不求值 `!!js` 表达式，所以你看到的是表达式本身而不是它的结果。行为不符合预期时，第一步应该是跑 `dsh --profile <name> --dump-config` 看每一行来自哪一层，而不是猜装配顺序。

```sh
pnpm dsh --profile web --dump-config
pnpm dsh --profile web --dump-default-config
pnpm dsh --profile web --dump-config-schema > schema.json
```

`--dump-config-schema` 输出的是 JSON Schema 2020-12：根节点描述 `--dump-config` 打印的那份条目列表，`$defs.patchList` 描述 Profile、Home 与命令行覆盖层。它和 `--dump-config` 有一个关键区别，`dump-config-schema.ts` 的模块注释直说了："Imports and lazy schema builders execute trusted module code"。要拿到每个插件的 `Config` schema，就必须 import 这些插件模块，会执行模块顶层代码和惰性的 schema 构造器，只是不 apply、不求值 `!!js`。因此对不可信的第三方插件运行它之前要有这个意识；schema 收集或投影不完整时进程以 exit code 1 退出并把诊断写到 stderr。典型用途是给编辑器或校验工具提供 `cordis.patch.yml` 的字段形状，默认值、描述以及 `secret`、`credential-ref`、`volatile` 等角色元数据以 `x-cordis` 注解出现。

## Profile 的物理结构

`packages/boot/app-boot/src/profile.ts` 的注释定义了 Profile：`$DSH_HOME/profiles/<name>` 目录，里面有一个 `package.json` 和一个 `cordis.patch.yml`。`package.json` 中的 `dsh.profile.bundles` 是一份有序的包名列表，也可以带 Profile 自己的仓库外插件依赖；`cordis.patch.yml` 是用户自己的补丁层，排在所有 Bundle 层之后。所谓 Bundle，就是在自己的 `package.json` 里声明了 `dsh.bundle.patch` 的 npm 包，值可以是单个文件，也可以是有序的文件列表。

`dsh-web-app` 是第一个用列表形态的官方 Bundle：主补丁层之外，还有 `presets/standard.patch.yml`、`ptc.patch.yml`、`minimal.patch.yml`、`cordis.patch.yml` 四个预设文件。这对应 0.1.7 的另一条能力：Agent 组合（preset）现在可以直接用普通 Cordis YAML 声明。以 `standard` 为例，它插入一条 `@deepseek-ai/dsh-agent-preset` 行，`config.plugins` 就是这个组合挂载的子插件清单（persona、tool-bash、tool-fs、plan-mode 等）；`web-app` 主层里的 `agent-preset-registry`（`config.default: standard`）声明默认启用哪个组合。用户在 Web UI 的 General 设置页可以切换，编辑器里的修改以补丁形式写回 Profile 的 `cordis.patch.yml`。"一个 Agent 挂哪些工具、什么人格"因此从硬编码变成了 YAML 数据，完整机制留给第 03 章。

官方模板放在同一个文件里的 `PROFILE_TEMPLATES`，现在有五个：

| 模板 | Bundle 列表 |
| --- | --- |
| `web` | `dsh-base` + `dsh-web-app` |
| `headless` | `dsh-base` + `dsh-headless` |
| `acp` | `dsh-base` + `dsh-acp-app` |
| `sdk` | `dsh-base` + `dsh-sdk-app` |
| `sdk-minimal` | `dsh-sdk-minimal` |

`acp` 对应对外协议接入（第 06 章），`sdk` 与 `sdk-minimal` 对应 Python SDK 这类把 `dsh` 当子进程驱动的场景。模板的值是一个 `ProfileTemplate` 接口，目前只有 `bundles` 字段。`dsh-headless` 的包描述把它的角色说得很清楚：在 `dsh-base` 之上直接运行核心 Agent 与 Session，没有 Host、HTTP 或浏览器层。

## 补丁的叠加顺序

`apps/cli/src/profile-boot.ts` 里 `composeProfile` 的注释给出了完整顺序，后面的层覆盖前面的层：

1. Bundle 层，按 `dsh.profile.bundles` 的顺序（先 `dsh-base`，再 `dsh-web-app`）；
2. Profile 自己的 `cordis.patch.yml`；
3. Home 级用户层，即 `$DSH_HOME/cordis.patch.yml`；
4. `--patch` 命令行覆盖层，按 argv 顺序；
5. 遥测开关：如果设置了 `DSH_TELEMETRY_DISABLED`，追加一条禁用遥测的补丁。

Home 层排在 Profile 层之后，是因为它是"机器级偏好"，对所有 Profile 生效，理应比某一个 Profile 的设置更优先。补丁里可以带 `!!js` 表达式，这就是 `host: !!js ctx.webStartup.host ?? '127.0.0.1'` 这种"命令行优先、否则默认"写法的来源。`composeProfile` 现在是异步的，并多了 `resolvedProfile` 和 `installAnchor` 参数，供桌面壳这类自带运行时的应用用；这属于插件解析细节，不影响叠加顺序。

## 从模板建一个 Profile

自定义 Profile 第一次使用前必须先存在。`dsh plugin --profile myprofile add <package>` 会隐式初始化一个只挂 `dsh-base` 的 Profile（`DEFAULT_PROFILE_BUNDLES`）。更直接的路径是 `--from-default-profile`，由 `initializeProfileFromDefault` 实现：

```sh
dsh rescue --from-default-profile web   # 新建 rescue，照抄 web 模板的 bundle 列表并启动
dsh rescue                              # 之后就是普通启动
```

它只复制模板的 bundle 列表，不读取同名官方 Profile 的本地状态，也不保存继承关系；模板名只在目标目录还不存在的那一次调用里生效。模板名不认识时，报错会列出全部合法值（目前是 `acp`、`headless`、`sdk`、`sdk-minimal`、`web`）。五个官方名字是保留字，不能作为自定义 Profile 的目标名。这解决了以前想要"基本等同 web，再加几个插件"的配置时，得手抄 bundle 列表去写 `package.json` 的痛点。

## 无人值守：headless

`dsh-headless` 的补丁层展示了一次性任务驱动器最少需要什么：一行 `system-prompt` 配置（人格拆成 `personaPrefix` 和 `personaSuffix`）、`tools`、一个 `headless-startup` 启动插件，和一个 `headless-runner`。模式与上一篇的 `web-startup` 相同：`headless-startup` 解析任务字符串、`--session-id`（精确接续已有会话）、`--json`（结构化输出），发布为 `headlessStartup` 服务；`headless-runner` 用 `inject: [headlessStartup]` 等它就绪，再通过 `!!js ctx.headlessStartup.task` 等表达式把参数注入自己的 config。

```sh
pnpm dsh --profile headless "summarize this workspace"
```

需要环境或仓库根 `.env` 里有 `DEEPSEEK_API_KEY`。这条路径完全跳过 HTTP、WebSocket 与浏览器插件：直接在 `dsh-base` 之上创建 Agent，跑完任务打印结果就退出，适合 CI 与脚本。如果卡住不退出，先确认凭证可用，没有可用凭证时模型调用会失败而不是立即报错退出。

## plugin：装依赖不等于接入

`plugin.ts` 现在委托给共享包 `@deepseek-ai/dsh-plugin-manager`，函数是异步的（所以 `bin.ts` 里是 `process.exit(await runPlugin(...))`）。`lockWaitMs`（120 秒）解决多个 `dsh plugin add` 并发操作同一个 Profile 目录时的锁竞争；git 来源的插件（`git+`、`github:`、`.git` 结尾）安装失败时，会额外提示去 Profile 目录的 `pnpm-workspace.yaml` 里给它补 `allowBuilds`，呼应上一篇。

```sh
dsh plugin --profile tui add some-third-party-plugin
```

这条命令只是让 pnpm 在 `$DSH_HOME/profiles/tui` 下安装依赖。要让新插件真正进入装配树，还需要在该 Profile 的 `cordis.patch.yml` 里用 `insert` 补丁接入。安装依赖和接入装配树是两个独立步骤，漏掉第二步是最常见的"装了没生效"。

## 我的看法

`--dump-config` 不求值 `!!js`，这是它安全、快速的原因，也是它的局限：排查"最终值是多少"的问题时，它只能告诉你表达式在哪一层，没法告诉你结果。材料里没有看到一个能"求值但不启动"的官方开关；`--dump-config-schema` 虽然会 import 插件，也只是导出 schema，不求值。所以涉及 `process.env` 或命令行参数的配置，仍然需要实际启动才能确认。这是基于材料的判断，并非说明该能力不存在，只是课程材料中未展开。

## 小结

1. CLI 是一层薄分发器：`profile` 启动、`dump-config` 与 `dump-config-schema` 只打印、`plugin` 转发 pnpm；launcher 的 flag 在前，第一个不认识的 token 起是应用参数，dump 模式拒绝应用参数以保证与真实启动一致。
2. Profile 是有序的 Bundle 层加 Profile 层、Home 层、`--patch` 层与遥测开关；`web`、`headless`、`acp`、`sdk`、`sdk-minimal` 五个官方模板没有特权，`--from-default-profile` 让任何人从模板起步。
3. 装依赖与接入装配树是两步；调试装配问题先看 `--dump-config`，需要机器可读的配置形状则用 `--dump-config-schema`，但要注意它会执行插件模块代码。

更详细的源码走读见 `DeepSeek-Harness/01-快速上手/03-CLI命令与Profile机制.md`。
