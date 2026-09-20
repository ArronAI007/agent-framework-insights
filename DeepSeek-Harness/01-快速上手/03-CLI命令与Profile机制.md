# CLI 命令与 Profile 机制

> `dsh` 的命令行只做一件"元"层面的事：决定装配哪一棵插件树、往树上叠加哪些补丁、以及要不要真的启动它。`profile`、`plugin`、`dump-config` 三种模式分别对应"启动"、"给某个 Profile 装插件依赖"、"只打印装配结果不启动"——搞懂这三者的边界，再配合 `--dump-config` 这个调试利器，你会发现 `dsh` 的启动行为完全是可预测、可审查的，没有任何"黑魔法"。

## 学习目标

- 读懂 `apps/cli/src/args.ts` 里三种命令行模式（`profile`/`plugin`/`dump-config`）的解析逻辑与边界规则。
- 理解 Profile 的物理结构：`$DSH_HOME/profiles/<name>` 目录下有什么，`dsh.profile.bundles` 字段如何决定叠加哪些 Bundle。
- 理解 `profile-boot.ts` 里补丁层的叠加顺序：Bundle 层 → Profile 自己的 `cordis.patch.yml` → Home 级用户层 → `--patch` 覆盖层。
- 会用 `dsh --profile headless "task"` 跑一次无人值守的一次性任务。
- 会用 `dsh --profile <name> --dump-config` 在不启动任何进程的情况下，审查一个 Profile 最终装配出的插件树。
- 理解 `dsh <name>` 是怎么在参数解析层面变成 `dsh --profile <name>` 的通用简写（不再只是 `web` 一个硬编码特例），以及 `--from-default-profile` 如何从官方模板新建一个自定义 Profile。

## 背景与设计动机

如果一个 Agent 产品只支持"一种启动方式"，添加一种新的运行形态（比如"给 CI 用的无人值守模式"）往往意味着要复制一份启动逻辑、再手动同步两边的插件配置，久而久之两份逻辑就会跑偏。`dsh` 的解法是把"启动方式"整体抽象成 **Profile**：一个 Profile 不是写死的代码路径，而是"若干 Bundle 补丁层 + 用户自己的覆盖层"叠加出的一棵插件树。`web`、`headless` 只是官方内置的两个 Profile 名字，理论上任何人都可以基于同一套装配机制拼出自己的 Profile。这也解释了为什么 CLI 层的代码量很小——绝大多数"能力"都不在 CLI 包里，而在被组合进来的各个 Bundle 里。

## 核心机制详解

### 命令行的三种模式

`apps/cli/src/args.ts` 用 `commander` 解析出一个判别联合类型 `DshInvocation`：

```typescript
// apps/cli/src/args.ts
/** Boot a named profile and hand it the invocation's inner arguments. */
interface ProfileInvocation {
  mode: 'profile'
  profile: string
  /** Shipped template used once to initialize a missing profile. */
  fromDefaultProfile?: string | undefined
  patches: string[]
  args: string[]
}

/** Print a composed profile tree and exit without booting. */
interface DumpConfigInvocation {
  mode: 'dump-config'
  profile: string
  /** Shipped template used once to initialize a missing profile. */
  fromDefaultProfile?: string | undefined
  defaultOnly: boolean
  patches: string[]
}

/** Manage a profile's plugins: forward `args` to pnpm inside the profile directory. */
interface PluginInvocation {
  mode: 'plugin'
  profile: string
  args: string[]
}

export type DshInvocation = ProfileInvocation | DumpConfigInvocation | PluginInvocation
```

（`fromDefaultProfile` 是仓库在课程写作之后新加的字段，配合下面会讲到的 `--from-default-profile` 选项——先记住它的存在，具体作用见"创建一个新 Profile"一节。）

三种模式分别是：

- **`profile`**：真正启动一个 Profile（`dsh --profile web`、`dsh --profile headless "task"`）；
- **`dump-config`**：不启动任何进程，只把 Profile 装配出的插件树按补丁层打印出来；
- **`plugin`**：管理某个 Profile 目录下的插件依赖（本质是把参数转发给 pnpm，在 Profile 目录里执行 `pnpm add`/`remove`/`why`）。

命令行解析上有一条很重要的边界规则，写在模块顶部的注释里：

```typescript
// apps/cli/src/args.ts
/**
 * The launcher parses only what it owns — which profile to boot, which extra
 * patch overlays to apply, and the config dumps — and hands **everything after
 * its own flags** to the booted tree verbatim, where injected app plugins parse
 * their own flag families and print their own `--help` ...
 * Launcher flags therefore come first: the first token this parser does not
 * recognize starts the inner arguments, so `dsh --profile tui --resume abc`
 * boots the tui profile with `--resume abc`, and `dsh --profile web -h` prints
 * the web app's help, not this one's.
 *
 * `dsh <name>` abbreviates `dsh --profile <name>`; `plugin` manages a profile's
 * plugin dependencies by forwarding to pnpm.
 */
```

也就是说 `dsh --profile <name>` 之后遇到的第一个"launcher 不认识"的 token，就是被启动应用自己的参数起点。这条规则由 commander 的几个配置项共同实现（这段是当前仓库的真实实现，比早期版本多了 `--from-default-profile` 选项和 `selectProfile` 校验器）：

```typescript
// apps/cli/src/args.ts（节选）
program
  .name('dsh')
  .version(version, '-V, --version', 'output the version number')
  .usage('[--profile] <name> [options] [app-args...]\n       dsh plugin --profile <name> <pnpm-args...>')
  .description('dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch layers under your own overrides.')
  .addHelpText('after', HELP_EXAMPLES)
  .exitOverride()
  .helpOption(false)
  .helpCommand(false)
  .allowUnknownOption()
  .passThroughOptions()
  .enablePositionalOptions()
  .argument('[args...]', 'arguments for the booted profile\'s app (see: dsh --profile <name> --help)')
  .option('--profile <name>', 'the profile under $DSH_HOME/profiles to boot', selectProfile)
  .option('--from-default-profile <name>', 'initialize a new custom profile from a shipped profile template')
  .option('--patch <path>', 'extra patch-list overlay applied after the profile layer (repeatable)', collect)
  .option('--dump-config', 'print the composed profile tree and exit')
  .option('--dump-default-config', 'print the profile tree without its user layer or --patch overlays and exit')
  .action((args: string[], options: BootOptions & { profile?: string }) => {
    if (options.profile === undefined) {
      if (args.some(argument => argument === '-h' || argument === '--help')) program.help()
      program.error('error: --profile <name> is required')
    }
    const profile = options.profile
    if (profile === '') program.error('error: --profile needs a name')
    rejectElectronProfile(program, profile)
    resolved = resolveBoot(program, profile, options, args)
  })
```

`helpOption(false)` 意味着 launcher 自己不接管 `-h`——这就是为什么 `dsh --profile web -h` 打印的是 web 应用自己的帮助文本；只有裸 `dsh -h`（没有 `--profile`）才会打印 launcher 自己的帮助，这一分支就在上面 `action` 回调的开头单独处理。

`rejectElectronProfile` 是一条新加的校验，专门保留了 `desktop` 这个 Profile 名字：

```typescript
// apps/cli/src/args.ts（节选）
function rejectElectronProfile(program: Command, profile: string): void {
  if (profile.toLowerCase() === 'desktop') {
    program.error('error: profile "desktop" is managed exclusively by the Electron application')
  }
}
```

这条规则和上一篇提到的新增 Electron 桌面壳（`apps/desktop`）是同一件事的两面：桌面应用自己内部管理一个名为 `desktop` 的 Profile，如果允许 CLI 也去操作这同一个名字，两边对 Profile 目录的写入就可能互相打架，所以干脆在命令行层面直接拒绝。

### `dsh <name>`：从"`web` 专属别名"到"任意 Profile 名的通用简写"

课程写到这里时，`web` 是 `apps/cli` 里唯一一个硬编码的 commander 子命令（下一篇会讲这段历史）。当前仓库已经把这条能力**通用化**了：任何 Profile 名字都可以直接跟在 `dsh` 后面，不再需要显式的 `--profile`。这不是靠给每个 Profile 名字注册一个子命令实现的，而是在真正交给 commander 解析之前，先做一次参数改写：

```typescript
// apps/cli/src/args.ts（节选）
try {
  const expanded = first !== undefined && !first.startsWith('-') && first !== 'plugin'
    ? ['--profile', ...argv]
    : argv
  program.parse(expanded, { from: 'user' })
} catch (error) {
  return process.exit(error instanceof CommanderError ? error.exitCode : 1)
}
```

规则很直接：如果第一个参数存在、不是以 `-` 开头的 flag、也不是字面量 `plugin`，就在参数数组最前面插入一个 `--profile`，再交给 commander 走正常的解析路径。也就是说 `dsh tui --resume abc` 在真正解析之前，会被静默改写成等价的 `dsh --profile tui --resume abc`——`web`、`headless`、`tui`，乃至你自己起的任何 Profile 名字，都走的是同一条改写规则，不再是"`web` 特别硬编码，其他名字都得写全 `--profile`"。`plugin` 被排除在这条改写规则之外，是因为它是另一套独立语义（管理插件依赖，而不是启动一个 Profile），需要精确匹配字面量 `plugin` 才注册成子命令：

```typescript
// apps/cli/src/args.ts（节选）
if (first === 'plugin') {
  const plugin = program.command('plugin').description('manage a profile\'s plugins by forwarding the remaining arguments to pnpm in the profile directory')
  plugin
    .requiredOption('--profile <name>', 'the profile whose plugins to manage (initialized on first use)', selectProfile)
    .allowUnknownOption()
    .argument('[args...]', 'pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)')
    .action((args: string[], options: { profile: string }) => {
      if (options.profile === '') program.error('error: --profile needs a name')
      rejectElectronProfile(plugin, options.profile)
      if (args.length === 0) program.error('error: plugin needs pnpm arguments to forward (e.g. add <package>)')
      resolved = { mode: 'plugin', profile: options.profile, args }
    })
}
```

`plugin` 子命令现在也只在需要时（`first === 'plugin'`）才注册，而不是无条件挂在 `program` 上——这是一个很小但值得注意的细节：不相关的调用路径不会承担注册一个从不会用到的子命令的开销。

### `--dump-config` 与 `--dump-default-config`：两种"打印而不启动"

`dump-config` 模式在同一个 `resolveBoot` 函数里判定：

```typescript
// apps/cli/src/args.ts（节选，当前版本比早期多了 --from-default-profile 的两处校验/透传）
function resolveBoot(program: Command, profile: string, options: BootOptions, args: string[]): DshInvocation {
  const patches = options.patch ?? []
  if (patches.includes('')) program.error('error: --patch needs a path')
  if (options.fromDefaultProfile === '') program.error('error: --from-default-profile needs a name')
  if (options.dumpConfig !== true && options.dumpDefaultConfig !== true) {
    return { mode: 'profile', profile, fromDefaultProfile: options.fromDefaultProfile, patches, args }
  }
  if (options.dumpConfig === true && options.dumpDefaultConfig === true) {
    program.error('error: --dump-config and --dump-default-config are mutually exclusive')
  }
  // The dump is boot-free: it never runs app command-line providers, so it
  // cannot show what those flags would decide, and printing a tree that differs
  // from the same invocation's boot would mislead.
  if (args.length > 0) {
    program.error(`error: config dumps take no app arguments, got ${args.map(argument => JSON.stringify(argument)).join(' ')}`)
  }
  const defaultOnly = options.dumpDefaultConfig === true
  if (defaultOnly && patches.length > 0) {
    program.error('error: --dump-default-config prints the bundle layers and takes no --patch')
  }
  return { mode: 'dump-config', profile, fromDefaultProfile: options.fromDefaultProfile, defaultOnly, patches }
}
```

两者的区别在于是否包含用户自己的覆盖层：`--dump-config` 打印"这次真实启动会装配出的完整树"（Bundle 层 + Profile 的 `cordis.patch.yml` + Home 级用户层 + `--patch` 覆盖），`--dump-default-config` 只打印"Bundle 自带的默认层"，跳过用户的任何自定义。代码里那句注释解释了为什么 dump 模式干脆拒绝任何 app 参数：因为 dump 从不真正启动被装配的应用，如果允许传参却不生效，打印出的树就会和真实启动的结果不一致，反而误导排查问题的人。

真正执行打印的是 `dump-config.ts`：

```typescript
// apps/cli/src/dump-config.ts
export function runDumpConfig(
  profile: string,
  defaultOnly: boolean,
  patches: readonly string[],
  fromDefaultProfile?: string,
): void {
  const loaded = prepareProfile(profile, !defaultOnly, fromDefaultProfile)
  const layers: ConfigDumpLayer[] = loaded.layers.map(layer => ({
    label: layer.packageName,
    patches: layer.patches,
  }))
  if (!defaultOnly) {
    if (existsSync(loaded.patchPath)) {
      layers.push({ label: loaded.patchPath, patches: loaded.patches })
    }
    const homePatchFile = homePatchPath()
    const homePatches = loadOptionalPatches(NAME, homePatchFile)
    if (homePatches !== undefined) {
      layers.push({ label: homePatchFile, patches: homePatches })
    }
    for (const file of patches) {
      const absolute = resolve(file)
      layers.push({ label: absolute, patches: loadOverlayPatches(NAME, absolute) })
    }
  }
  process.stdout.write(renderConfigDump(NAME, join(loaded.dir, PROFILE_ROOT_FILENAME), layers))
}
```

这个命令的价值在于：当一个插件行为不符合预期时（比如某个工具没被启用、某个配置项的值不是你以为的那样），第一反应不该是去猜测装配顺序,而是先跑一遍 `dsh --profile <name> --dump-config`，把每一层补丁（哪个 Bundle 贡献了哪一行、Profile 自己覆盖了什么、`--patch` 又覆盖了什么）按顺序打印出来直接看——这条命令完全不启动进程,也不会评估任何 `!!js` 表达式，是纯静态的补丁列表展开。

### Profile 的物理结构

一个 Profile 的定义写在 `packages/boot/app-boot/src/profile.ts` 的模块注释里：

```typescript
// packages/boot/app-boot/src/profile.ts
/**
 * A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
 * `package.json` (out-of-tree plugin dependencies plus the profile manifest
 * `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
 * (the user's own patch layer, applied after every bundle layer). Bundles are
 * npm packages whose manifest declares
 * `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; the tree is
 * composed by applying each bundle's patch list in `dsh.profile.bundles`
 * order over an empty entry list, then the profile's own patches, then any
 * launcher layers (`--patch` files and flag-derived patches).
 */
```

拆开来看，一个 Profile 目录里有两个关键文件：

- `package.json`：里面的 `dsh.profile.bundles` 是一份**有序的包名列表**，决定按什么顺序叠加哪些 Bundle；
- `cordis.patch.yml`：用户自己在这个 Profile 上追加的覆盖层，会在所有 Bundle 层之后应用。

反过来，"Bundle"指的是任何在自己 `package.json` 里声明了 `dsh.bundle.patch` 字段的 npm 包，比如：

```json
// packages/bundle/headless/package.json（节选）
{
  "name": "@deepseek-ai/dsh-headless",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  ...
}
```

`dsh` 内置了官方模板，写在同一个文件里（当前已经是三个，课程写作时只有 `web`/`headless` 两个,`acp` 是后来加的,对应第 06 章"对外协议 SDK、ACP 与生态兼容 Hooks"要讲的 ACP 协议接入,这里先不展开）：

```typescript
// packages/boot/app-boot/src/profile.ts
/** Installation-owned defaults used when a shipped profile is first opened. */
export interface ProfileTemplate {
  /** Ordered bundle layer list. */
  bundles: readonly string[]
}

export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
  },
  web: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  },
  headless: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  },
}
```

结构上有一处变化：早期版本里 `PROFILE_TEMPLATES` 的值直接是一个 bundle 名字数组（`Record<string, readonly string[]>`），现在包了一层 `ProfileTemplate` 接口，`bundles` 字段本身没变，只是留出了给"模板"未来附加其他元数据（而不只是 bundle 列表）的空间——这个接口的注释"Installation-owned defaults used when a shipped profile is first opened"也透露了新的用途：模板不仅用于装配补丁栈，还被用来判断"一个已存在的 Profile 是不是恰好等于某个官方模板"（下一节会看到这一点如何支撑 `--from-default-profile`）。

也就是说 `web` Profile 是 `dsh-base`（基础能力：模型、工具、沙箱、会话……）叠加 `dsh-web-app`（HTTP 服务、WebSocket、浏览器插件roster）；`headless` Profile 则是 `dsh-base` 叠加 `dsh-headless`——一个"直接跑核心 Agent/Session，不挂任何 Host、HTTP 或浏览器层"的一次性任务驱动器,`dsh-headless` 自己的包描述写得很直接：

```json
// packages/bundle/headless/package.json（节选）
{
  "name": "@deepseek-ai/dsh-headless",
  "description": "The dsh one-shot bundle: a direct core Agent/Session runner over dsh-base with no Host, HTTP, or browser layer",
  ...
}
```

### 补丁层的叠加顺序

`apps/cli/src/profile-boot.ts` 是真正把这些补丁层拼起来的地方。`composeProfile` 函数把叠加顺序落成了代码：

```typescript
// apps/cli/src/profile-boot.ts（节选，签名比早期版本多了几个和"插件依赖解析模式""从模板新建 Profile"相关的参数）
async function composeProfile(
  name: string,
  patchFiles: readonly string[],
  resolutionMode: ProfileResolutionMode,
  fromDefaultProfile?: string,
  resolvedProfile?: ResolvedProfileRuntime,
): Promise<ComposedProfile> {
  const profile = resolvedProfile?.profile ?? prepareProfile(name, true, fromDefaultProfile)
  ...
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  return { profile, resolution, overlays }
}
```

新增的 `resolutionMode`/`resolvedProfile` 两个参数处理的是"这个 Profile 目录下的第三方插件依赖该用什么方式解析"（运行时查找、磁盘链接、还是两者都验证一遍），这属于插件安装与解析机制的细节，不是本篇"补丁怎么叠加"要讲的内容，这里跳过，只需要知道函数变成异步、多了这两个参数即可。真正和本篇相关的是 `fromDefaultProfile` 这个参数——它被原样转发给 `prepareProfile`，这正是"用一个新名字 + 一个官方模板，创建并启动一个全新 Profile"这条路径的入口，下一节展开讲。

配合模块顶部注释里的完整叠加顺序说明（这段措辞比早期版本略有调整，但描述的仍然是同一套顺序）：

```typescript
// apps/cli/src/profile-boot.ts
/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (a base-backed profile gets the base bundle's
 * platform-gated shell rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 */
```

完整顺序是：

1. **Bundle 层**（按 `dsh.profile.bundles` 声明的顺序，比如先 `dsh-base` 再 `dsh-web-app`）；
2. **Profile 自己的 `cordis.patch.yml`**（这个 Profile 独有的覆盖）；
3. **Home 级用户层**（`$DSH_HOME/cordis.patch.yml`——对**所有** Profile 都生效的机器级偏好覆盖）；
4. **`--patch` 命令行覆盖层**（单次调用临时追加的覆盖，比如调试时用 `--patch ./extra.yml` 关掉某个工具）；
5. **遥测开关**（`DSH_TELEMETRY_DISABLED` 环境变量，如果设置了，追加一条禁用遥测行的补丁）。

后面的层永远能覆盖前面的层——这也是为什么 Home 级用户层"排名高于"单个 Profile 自己的层：它是"机器级偏好"，理应比某一个具体 Profile 的默认设置优先级更高。补丁层本身在装配时可以携带 `!!js` 表达式（详见 `docs/cordis-primer.md` 的 Loader Configuration 一节），这也是为什么 `web-app` 补丁层里能写出 `host: !!js ctx.webStartup.host ?? '127.0.0.1'` 这种"命令行参数优先，否则用默认值"的写法（上一篇已经展开过）。

### 新增能力：`--from-default-profile`，从模板创建一个新 Profile

早期版本里，一个自定义 Profile（比如 `tui`）第一次被用到时，只能靠 `dsh plugin --profile tui add <package>` 隐式初始化一个空目录（前面"`plugin` 模式"一节的注释里也写着"initialized on first use"）。当前仓库新增了一条更直接的路径：`--from-default-profile <name>`，可以显式指定"照抄哪个官方模板的 Bundle 列表来新建"。落地实现在 `initializeProfileFromDefault`：

```typescript
// apps/cli/src/profile-boot.ts
/**
 * Initialize a missing profile from one shipped template. This copies only
 * the template's bundle list; local state from the same-named shipped
 * profile is not read, and no inheritance metadata is persisted. Shipped
 * profile names are reserved, and the target directory is claimed
 * exclusively so existing or concurrent state is never reused.
 */
export function initializeProfileFromDefault(
  name: string,
  fromDefaultProfile: string,
  home: string = resolveDshHome(),
): void {
  const dir = resolveProfileDir(name, home)
  const template = Object.hasOwn(PROFILE_TEMPLATES, fromDefaultProfile)
    ? PROFILE_TEMPLATES[fromDefaultProfile]
    : undefined
  if (template === undefined) {
    const expected = Object.keys(PROFILE_TEMPLATES).sort().map(value => JSON.stringify(value)).join(', ')
    throw new Error(
      `${NAME}: unknown default profile ${JSON.stringify(fromDefaultProfile)}; expected one of ${expected}`,
    )
  }
  if (Object.hasOwn(PROFILE_TEMPLATES, name)) {
    throw new Error(
      `${NAME}: profile ${JSON.stringify(name)} is shipped and cannot be a custom profile target; ...`,
    )
  }
  ...
}
```

用法上，`args.ts` 的帮助文本给出了一个标准例子：

```text
dsh rescue --from-default-profile web
                                          create rescue from the shipped web template, then boot it
```

也就是说 `dsh rescue --from-default-profile web` 会新建一个叫 `rescue` 的 Profile，Bundle 列表直接照抄 `web` 模板（`dsh-base` + `dsh-web-app`），然后立刻启动它——新 Profile 一旦建好，后续再运行 `dsh rescue`（不带 `--from-default-profile`）就是普通的启动，模板名字只在"这个 Profile 目录还不存在"的那一次调用里生效。函数注释里"local state from the same-named shipped profile is not read"这句话值得注意：如果你恰好把新 Profile 取名叫 `web` 本身，这条路径也会拒绝——`web`/`headless`/`acp` 这几个官方模板名字本身是保留字，不能被当成自定义 Profile 的目标名字（对应上面代码里的第二个 `throw`）。这条新命令解决的是一个具体的实际痛点：以前想要"一个基本等同于官方 web Profile，但自己加了几个额外插件"的自定义配置，得手动照抄 `PROFILE_TEMPLATES` 里的 Bundle 列表去写 `package.json`；现在一条命令就能从模板起步，再叠加自己的 `cordis.patch.yml`。

### 跑一次无人值守任务：`dsh --profile headless`

`dsh-headless` 这个 Bundle 的补丁层展示了一个"一次性任务驱动器"最小需要挂载哪些插件：

```yaml
# packages/bundle/headless/cordis.patch.yml
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: hmr
  disabled: true

- insert:
    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'

    - id: headless-startup
      name: '@deepseek-ai/dsh-headless/startup'

    # Reads its task from the ordinary headlessStartup provider.
    - id: headless-runner
      name: '@deepseek-ai/dsh-headless'
      inject: [headlessStartup]
      config:
        task: !!js ctx.headlessStartup.task
```

这里的模式和上一篇讲的 `web-startup` 一模一样：`headless-startup` 是一个普通插件,负责解析命令行里的任务字符串（`dsh --profile headless "summarize this workspace"` 里引号内的那段文本）并把它作为 `headlessStartup` 服务发布出去；`headless-runner` 声明 `inject: [headlessStartup]`，等这个服务可用之后再用 `!!js ctx.headlessStartup.task` 把任务文本注入自己的 `config.task`。跑起来的命令形如：

```sh
pnpm dsh --profile headless "summarize this workspace"
```

`docs/development.md` 给出的说明印证了这一点：

```markdown
The one-shot Headless coding agent needs `DEEPSEEK_API_KEY` in the environment or repo-root `.env`:

pnpm dsh --profile headless "summarize this workspace"
```

这条路径完全跳过了 `dsh-web-app` 里的 HTTP 服务、WebSocket、浏览器插件 roster——`dsh-headless` 直接在 `dsh-base` 之上创建一个 Agent，把任务丢进去，等它跑完打印结果就退出，非常适合 CI 流水线或脚本化调用。

### `plugin` 模式：管理 Profile 的插件依赖

第三种模式转发到 `plugin.ts`。它在 `args.ts` 里的 commander 定义前面已经贴过（见"从 `web` 专属别名到通用简写"一节），这里补充 `plugin.ts` 自己的实现：它不再是一句简单的 `spawn pnpm`，而是委托给一个共享包 `@deepseek-ai/dsh-plugin-manager`（同一套包管理逻辑也被别处复用），并且整个函数是异步的：

```typescript
// apps/cli/src/plugin.ts
export async function runPlugin(profile: string, args: readonly string[]): Promise<number> {
  const result = await runPluginCommand({ profile, installAnchor: INSTALL_ANCHOR, cwd: process.cwd() }, args, {
    execution: 'cli',
    outputBytes: 16384,
    lockWaitMs: 120000,
    onOutput: (text, stream) => { process[stream].write(text) },
  })
  if (result.exitCode === 127) process.stderr.write('dsh: pnpm was not found; install pnpm and make it available on PATH.\n')
  if (result.exitCode !== 0) process.stderr.write(`dsh: pnpm failed; diagnostics: ${result.logPath}\n`)
  if (result.exitCode !== 0 && args.some(argument => /^git\+|^github:|\.git(?:#|$)/.test(argument))) {
    process.stderr.write(`dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in ${join(resolveProfileDir(profile), 'pnpm-workspace.yaml')}, then re-run\n`)
  }
  return result.exitCode
}
```

这也是为什么第 01 篇里 `bin.ts` 现在对 `plugin` 分支写的是 `process.exit(await runPlugin(...))`，而不是早期版本的同步 `process.exit(runPlugin(...))`——`runPlugin` 本身变成了异步函数。新增的 `onOutput`/`outputBytes`/`lockWaitMs` 这些参数解决的是一个具体问题：多个 `dsh plugin add` 调用如果并发对同一个 Profile 目录跑 `pnpm`，会互相踩锁，`lockWaitMs` 就是等待另一个安装完成的超时时间；`git+`/`github:`/`.git` 结尾的插件来源如果安装失败，还会额外提示"这是一个需要 `allowBuilds` 放行的 git 插件"，这正好呼应第 01 篇讲过的 `allowBuilds` 白名单机制。

典型用法是给某个 Profile 安装一个仓库外的第三方插件：

```sh
dsh plugin --profile tui add some-third-party-plugin
```

这条命令不会启动任何 Agent 进程,只是把 `add some-third-party-plugin` 转发给 pnpm，在对应 Profile 目录（`$DSH_HOME/profiles/tui`）下执行安装——安装完之后，还需要在这个 Profile 的 `cordis.patch.yml` 里用 `insert` 补丁把新插件真正接入装配树，安装依赖和接入装配树是两个独立的步骤。

## 常见问题/易踩坑

- **改了 `cordis.patch.yml` 却不知道生效了没有**：先跑 `--dump-config` 确认补丁层顺序和内容,而不要直接启动进程再靠日志猜测。
- **以为 `--dump-config` 会执行 `!!js` 表达式**：不会，`dump-config` 是纯静态的补丁列表展开，从不装配、也不启动树，所以看不到 `!!js` 表达式求值后的最终值，只能看到表达式本身和它所在的补丁层。
- **`dsh --profile headless` 卡住不退出**：确认 `DEEPSEEK_API_KEY` 是否可用——没有可用的凭证时模型调用会失败，而不是直接报错退出；参见第 01 篇的凭证优先级说明。
- **给 Profile 装完插件依赖后没生效**：`dsh plugin add` 只负责 pnpm 依赖安装，真正把新插件接入装配树需要手动编辑该 Profile 的 `cordis.patch.yml`。
- **想创建一个自定义 Profile，但 `dsh myprofile` 直接报"Profile 不存在"**：自定义 Profile 第一次启动前必须先有内容——要么用 `dsh plugin --profile myprofile add <package>` 装至少一个插件，要么用 `dsh myprofile --from-default-profile web`（或 `headless`/`acp`）从官方模板起步；裸启动一个从未初始化过的自定义名字不会自动生成任何内容。
- **`--from-default-profile` 传了一个不认识的名字**：会直接抛错并在错误信息里列出当前所有合法模板名（目前是 `acp`/`headless`/`web`，按字母序），照着这份列表选一个即可，不需要去翻源码确认。

## 小结

`dsh` 的命令行本质上是一层很薄的分发器：`profile` 模式启动装配好的插件树，`dump-config` 模式只打印装配结果不启动，`plugin` 模式管理某个 Profile 的第三方依赖。Profile 本身是"若干 Bundle 补丁层 + Home 级用户层 + 命令行覆盖层"按固定顺序叠加的结果；`web`/`headless`/`acp` 是三个内置模板，本质上没有任何特权，`--from-default-profile` 让任何人都能从这几个模板起步拼出自己的 Profile。命令行解析本身也从"只有 `web` 硬编码成子命令"演化成了"任意 Profile 名字都能作为 `dsh <name>` 的通用简写"这套更一致的规则。下一篇会深入其中一层最关键的补丁——Provider 与模型配置，看 `dsh` 如何用同一套 Seam 机制同时支持 DeepSeek 官方 API 和其他厂商的模型。
