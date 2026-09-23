# Profile、Bundle、Preset：dsh 的装配语言

> 前三篇讲的是"一个插件怎么写、插件之间怎么通信、卸载怎么保证干净"——都是单个插件视角的机制。这一篇换到系统视角：一个真实的 `dsh` 进程启动时，到底装配了多少插件、以什么顺序、又是怎么被拆成"可安装的层"的？答案是三个逐层收窄的概念——Bundle 是可安装的补丁层，Profile 是具名的装配结果，Preset 是会话级别的 Agent 组合——它们共同构成了 dsh 的"装配语言"，而 `dsh --dump-config` 就是这门语言的调试器。

## 学习目标

- 理解 Bundle 的本质：一个声明了 `dsh.bundle.patch` 字段的 npm 包，携带一份（或按序多份）Cordis 补丁文件，可以被安装进任意 Profile。
- 理解 Profile 的装配顺序——Bundle 层 → Profile 自己的补丁 → Home 级补丁 → `--patch` 覆盖——以及"后写的层覆盖先写的层"这条统一规则。
- 理解 Preset 是另一个粒度的装配：不是"进程启动装配什么服务"，而是"这一次会话的 Agent 拥有哪些工具和提示词"；它同样以补丁行的形式声明，运行时隔离开的是注册表私有作用域与 `isolate` 域，而不是进程。
- 读一份真实的生产 Preset 声明（`packages/bundle/web-app/presets/standard.patch.yml`），理解为什么某些子插件行要放进 `isolate` 分组、某些行不需要。
- 学会用 `dsh --dump-config`（以及导出 JSON Schema 的 `--dump-config-schema`）验证"我以为装配出来的树"和"实际装配出来的树"是否一致——这是调试装配问题的第一步，而不是最后一步。

## 背景与设计动机

前三篇建立的机制回答了"一个插件怎么工作"，但没有回答一个更实际的问题：dsh 要同时支持"命令行一次性跑一个任务"（headless）和"起一个本地网页界面持续对话"（web）两种截然不同的部署形态，这两种形态共享绝大多数插件（模型适配器、工具、会话持久化），只在少数几行上不同（要不要起 HTTP 服务器、要不要挂浏览器客户端）。如果每种部署形态都维护一份完整的 `cordis.yml`，维护成本会随着共享插件数量线性增长——共享部分改一次，就要在每份配置文件里同步改一次。

同样的问题在会话粒度上又出现了一次：同一个部署里，不同的对话可能想要不同的 Agent 能力组合——一个专门做代码评审的 Agent、一个专门写代码的 Agent，它们共享"这个部署支持哪些模型、怎么持久化会话"这类进程级配置，但各自拥有不同的工具集合和系统提示词，而且不能互相踩到对方注册的同名服务。

dsh 用两套独立但呼应的机制分别解决这两个层面的问题：**Bundle + Profile** 解决"进程级装配"的复用，**Preset** 解决"会话级装配"的复用与隔离。`docs/architecture.md` 用一句话概括了这套体系存在的理由：

> There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads.

## 核心机制详解

### Bundle：可安装的补丁层

一个 Bundle 就是一个普通的 npm 包，唯一的特殊之处是它的 `package.json` 里带一个 `dsh.bundle.patch` 字段，指向一份 Cordis 补丁文件——或者**一组按顺序应用的补丁文件**（`packages/util/package-manifest/src/types.ts` 里该字段的类型是 `patch: string | string[]`，注释写明 "One patch file path, or an ordered list applied in sequence, each relative to the declaring package root"）。`packages/bundle/base/package.json` 是 dsh 自带的最核心的 Bundle：

```json
// packages/bundle/base/package.json（节选）
{
  "name": "@deepseek-ai/dsh-base",
  "description": "The shared dsh core as a profile bundle: the first patch layer of base-backed profiles, inserting core rows over the empty profile root",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

注意 description 的措辞是 "base-backed profiles"（以 base 为底的那些 Profile）而不是 "every profile"——因为 `sdk-minimal` 是唯一不叠在 `dsh-base` 之上的例外，这一点后面还会看到。

`dsh.bundle.patch` 指向的文件是一份 YAML，顶层是一个 `insert` 列表，列表里每一行都是一条标准的 Cordis Loader 配置行（`id` + `name` + 可选的 `config` / `disabled`）。`packages/bundle/base/cordis.patch.yml` 的开头几行：

```yaml
# packages/bundle/base/cordis.patch.yml（节选）
- insert:
    - id: tool-plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager/tools'
      disabled: true

    - id: plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager'
      disabled: !!js "!ctx.get('profileContext')"

    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'

    # Profile configuration reloads by default; module roots are opt-in.
    - id: hmr
      name: '@deepseek-ai/dsh-hmr'
      disabled: !!js "!ctx.get('profileContext')"

    - id: llm
      name: '@deepseek-ai/dsh-llm'

    # ...session、agent 等核心行从略...

    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: deepseek-official
        model: deepseek-flash
```

这个开头相比早期版本有两个值得注意的变化。一是出现了 `disabled` 字段：`tool-plugin-manager` 在共享层被写死禁用（插件管理工具不跑在宿主层，后面会看到它由每个 Preset 在自己的组合里挂载），而 `plugin-manager` 和 `hmr` 的 `disabled` 是 `!!js` 表达式——它的求值被推迟到运行时，按当前上下文决定这一行是否激活（例如 `!ctx.get('profileContext')` 的意思是"没有 profile 上下文的环境里才禁用"，这让同一份共享补丁可以安全地服务于形态迥异的环境）。二是 `hmr` 一行的名字从 vendor 的 `@deepseek-ai/cordis-plugin-hmr` 换成了 dsh 自己的封装 `@deepseek-ai/dsh-hmr`——后者把"模块热替换、Include 刷新、profile 配置变更"协调进同一个队列（`packages/boot/hmr/README.md`），vendor 包的配置和事件仍然暴露在 `ctx.hmr` 下。

这份文件本身不做任何事情——它只是数据，一份"我要插入哪些行"的清单。dsh 目前自带六个 Bundle（相比早期版本新增了 `acp-app`、`sdk-app`、`sdk-minimal` 三个，对应 ACP 自动化协议和 SDK JSON-RPC 这两类新的部署形态），`packages/bundle/README.md` 用一张表说明了它们的分工：

| Package | Role | ctx key |
|---|---|---|
| `base/` | Shared core for base-backed profiles | — (patch only) |
| `acp-app/` | Automation-only ACP stdio application over base | mounts the ACP bridge |
| `web-app/` | Browser application layer over base | mounts Web rows |
| `headless/` | One-shot command-line task application over base | `headless-runner` |
| `sdk-app/` | SDK JSON-RPC stdio application over base | mounts the SDK server |
| `sdk-minimal/` | Standalone minimal SDK application without base or Web | — (complete patch tree) |

一个 Bundle 只关心"我要往树里插入哪些行"，完全不关心自己会被安装进哪个 Profile、和哪些其他 Bundle 叠在一起——这正是它能被复用的原因：`dsh-base` 这份补丁是 `web`、`headless`、`acp`、`sdk` 四个 Profile 共同的第一层，只有 `sdk-minimal` 是例外——它是唯一一个不叠在 `dsh-base` 之上、自己携带完整补丁树的 Bundle。

`packages/bundle/README.md` 还补充了两条使用层面的事实：Bundle 并不限于这个目录（"Domain packages can declare additional layers outside this directory"），且第三方 Bundle 可以通过 `dsh plugin --profile <name> add <package>` 安装进任意 Profile（"In-box bundles resolve from the dsh installation; out-of-tree bundles install into a profile through `dsh plugin --profile <name> add <package>`"）——也就是说 Bundle 是 dsh 对外的扩展分发格式，不只是仓库内部的分层手段。

### Profile：一个具名的插件树装配

Profile 是"选中哪些 Bundle、以什么顺序叠加、再叠加一份用户自己的补丁"这件事的具名结果。`packages/boot/app-boot/src/profile.ts` 定义了 dsh 自带的五个 Profile 模板（早期版本只有 `web`/`headless` 两个，后续跟着 Bundle 一起扩展到了五个）：

```ts
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
  sdk: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  },
  'sdk-minimal': {
    bundles: ['@deepseek-ai/dsh-sdk-minimal'],
  },
}
```

（相比早期版本，模板的值从一个裸的字符串数组包了一层 `ProfileTemplate` 接口——目前这个接口只有 `bundles` 一个字段，但这个改动本身就说明了装配层的一个设计倾向：把"一个 Profile 模板是什么"定义成一个可以继续长字段的结构体，而不是直接假设它永远只是一份 Bundle 列表。）`web` Profile 是"`dsh-base` 加 `dsh-web-app`"，`headless` 是"`dsh-base` 加 `dsh-headless`"，`acp` 是"`dsh-base` 加 `dsh-acp-app`"（面向自动化场景的 stdio ACP 协议应用），`sdk` 是"`dsh-base` 加 `dsh-sdk-app`"（面向 JSON-RPC SDK 调用的应用），`sdk-minimal` 比较特殊——它不叠在 `dsh-base` 之上，`bundles` 里只有它自己这一个完整补丁树。共享的核心能力只维护在 `dsh-base` 一份补丁里，除 `sdk-minimal` 外的四种部署形态都只在各自的 Bundle 里追加自己特有的几行。

真正把多层补丁叠成一棵最终插件树的函数是 `composeEntries`，源码就在同一个文件里：

```ts
// packages/boot/app-boot/src/profile.ts
/**
 * Compose patch layers into the effective entry list over an empty root —
 * the same single `applyEntryPatches` call the boot include makes, so flag
 * derivation and config dumps see exactly what mounts.
 * @param layers - patch lists in application order.
 * @param warn - sink for skipped-patch diagnostics; defaults to silent (boot repeats them).
 * @returns the composed entry list.
 */
export function composeEntries(
  layers: readonly PatchOptions[][], warn: (message: string) => void = () => {},
): EntryOptions[] {
  return applyEntryPatches([], structuredClone(layers.flat()), (message: string, ...args: unknown[]) => {
    let index = 0
    warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  })
}
```

注释里特意强调了一点值得记住的工程细节：**这个函数和真正启动进程时用的是同一个 `applyEntryPatches` 调用**——也就是说"离线算出装配结果给你看"（比如 `--dump-config`）和"真正启动进程时的装配"走的是完全相同的代码路径，不存在"文档说的和实际跑的不一样"这种偏差。

装配的分层顺序，`docs/architecture.md` 用一句话讲清楚了：

> Layers apply to an empty entry list in this order: each bundle in the profile's listed order, then the profile's `cordis.patch.yml`, then the home-level one, then any `--patch` overlay. A patch targets a row by id and replaces its whole config, or inserts new rows.

翻译成具体规则：Bundle 层最先叠加，Profile 自己的 `cordis.patch.yml`（用户为这一个 Profile 写的覆盖）叠在 Bundle 之上，`$DSH_HOME/cordis.patch.yml`（跨所有 Profile 共享的机器级偏好）再叠一层，命令行传入的 `--patch <file>` 覆盖层最后叠加、优先级最高。**每一层的补丁都是按 `id` 定位一整行、整体替换 `config`，不是逐字段深合并**——`packages/bundle/base/cordis.patch.yml` 开头的注释对这一点讲得很直白：

> A patch replaces the targeted row's whole `config` rather than merging into it, so a row whose value differs by mode does NOT live here: it belongs to each mode bundle, keeping any single row down to one bundle layer plus the user's.

这也是为什么"哪个模式该有的字段"的判断标准是"这个字段的取值会不会因部署形态而不同"——会不同的字段就不该放在 `dsh-base` 这一层，否则任何一个更上层的覆盖都要把整行重新抄一遍。

### Preset：会话级别的 Agent 组合

Profile 解决的是"这个进程装配了哪些服务"，是进程启动时一次性决定、跨所有会话共享的。而"这一次对话里 Agent 能用哪些工具、系统提示词写了什么"是每个会话可能各不相同的——这正是 Preset 存在的层级。

需要先说明一次架构演进：早期版本的 Preset 是"一个目录 + 目录里一份 `agent.cordis.yml`"的独立文件体系，配有一套独立的目录发现、元数据、复制与编辑 API。当前 master 上这套目录机制已被整体替换（PR #4569，`feat(preset): declare Agent compositions in profile YAML`；上游设计备忘 `.agents/notes/implemented/architecture/2026-09-18-declarative-agent-presets.md` 记录了决策始末——替换的理由正是"目录 preset 复制了 Cordis 的配置所有权，独立的那套 API 无法用一个普通的 profile 补丁表达同样的组合"）——**Preset 现在就是用普通 Cordis YAML 声明的一行插件配置**，由 `@deepseek-ai/dsh-agent-preset` 这个插件承载。`packages/preset/agent-preset/README.md` 的定义：

> Define an Agent's child plugins in ordinary Cordis YAML. Declare several presets and let sessions select one. Definitions load eagerly, and edits affect subsequently created Agents.

配套的 `@deepseek-ai/dsh-agent-preset-registry`（`ctx.agentPresets` 服务）负责选择、修订保留和 Profile 编辑。`packages/preset/agent-preset-registry/README.md` 给出的最小声明长这样：

```yaml
# packages/preset/agent-preset-registry/README.md
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins: []
```

注意两个 `id` 的分工（README 原文："The declaration row's `id` addresses Loader edits; `config.id` is the preset identity saved by sessions"）：**行的 `id`（`preset-standard`）是补丁系统定位这一行用的**，之后任何一层补丁想改这个 Preset，都按这个 id 寻址；**`config.id`（`standard`）才是会话记录里保存的 Preset 身份**。`config` 里还有三个可选字段：`name`/`description` 是展示元数据，`order` 决定在选择器里的排列顺序。

这个变化的深远之处在于：**Preset 不再是补丁体系之外的第二套文件格式，而是补丁体系的内容本身**——新增一个 Preset、覆盖一个自带 Preset，都只是一次普通的补丁操作。上游 README 把这一点写得很直白：

> The registry writes no declarations. A new preset or an override of a shipped one is a bundle patch: an `insert` of a `@deepseek-ai/dsh-agent-preset` row, or a patch keyed by that row's id, installed into the profile with `plugin_manager`; Creator mode authors such bundles in conversation.

dsh 自带的 `standard` Preset 现在住在 `packages/bundle/web-app/presets/standard.patch.yml`——一个 Bundle 内的补丁文件，往树里插入一条 `preset-standard` 声明行，其 `config.plugins` 就是这个 Agent 组合的子插件清单。摘录其中"计划模式"这一段最能说明变与不变：

```yaml
# packages/bundle/web-app/presets/standard.patch.yml（节选）
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          # ...persona、tool-bash、tool-fs、tool-jobs 等行从略...
          - id: planning
            name: cordis:group
            group: true
            isolate:
              planMode: true
            config:
              - id: plan-mode
                name: '@deepseek-ai/dsh-plan-mode'
                config:
                  section: |
                        You are in plan mode. Stay in plan mode until exit_plan_mode succeeds...
```

可以看到：**文件载体换了，`cordis:group` + `isolate` 的运行时机制原样保留**。"这个分组内部注册的 `planMode` 服务，只在这个分组自己的作用域里可见，且这个分组每被挂载一次就获得一份专属的、互不干扰的实例"这条语义没有任何变化——变化的只是这份清单从独立目录里的 `agent.cordis.yml` 搬进了 Bundle 补丁的 `config.plugins` 字段。这正是第一篇提到的 `ctx.isolate(name, label?)` 在生产配置里的用法——不需要写一行 TypeScript，靠 YAML 里的 `isolate` 字段就能声明"这个服务不能是进程全局的，必须一会话一份"。顺带一提，清单里那行 `persona` 来自新拆出的 `@deepseek-ai/dsh-persona` 包：它给一个 Agent 注册专属的提示词 persona 前后缀、遮蔽部署级默认——Preset 能改的不只是工具集合，还包括 Agent 的"身份"表述。

`standard` Preset 里 `tool-jobs` 是普通的一行（不在任何 `isolate` 分组里）；关于"哪些行不该进 `isolate`"的反面教材注释则搬到了 `packages/bundle/web-app/cordis.patch.yml` 的宿主层禁用区——Web 形态会把 `tool-bash`、`tool-jobs` 这类宿主行整体 `disabled: true`，改由每个 Preset 自己挂载（补丁注释里那节标题就叫 "the agent plane moves behind agent presets"），而注册表本体留在宿主层：

> The background-job REGISTRY stays on the host plane; only the model-facing `job_*` controls move. Its producers ... are preset rows that resolve it with `ctx.get`, and an entry-local realm around the registry is invisible to every sibling row outside that realm ... The registry is keyed by owning agent, so one host instance serves every session exactly as before presets.

判断标准和以前一样清楚：如果一个服务本身已经按会话/Agent 做了内部键控（比如任务注册表内部用 `owning agent` 做 key），那么它天然就该是进程级单例，Preset 只需要决定"这个会话能不能看到操作它的工具"，不需要再套一层 `isolate`。这段注释还记录了真实踩过的坑：曾有人给注册表套了 entry-local realm，结果分组外的兄弟行看不见它，`run_in_background` 回答 "background jobs unavailable"，而操作它的工具明明还列在目录里。

服务泄漏检测也还活着，只是搬了家：`leakedServices()` 现在在 `packages/preset/agent-preset-registry/src/mount.ts`，一个本该 `isolate` 却忘了加的服务依然会被检测出来并导致挂载被拒绝。而且新模型把它升级成了一整套**激活审计**——上游 README 的实现注释：

> Each declaration eagerly creates a registry-owned scope and an in-memory Loader tree. Updating or removing a declaration retires its previous revision. Agents, children and temporary historical reads retain references; releasing the final reference disposes the retired tree. Plugin registrations inherit the preset scope, and the Agent scope's parent link controls visibility. The Host continues to share the Agent loop.

这段里有三个要点。其一，声明是**急切激活**的——一个 Preset 定义存在即被挂载成一棵注册表私有的作用域加内存 Loader 树，不等第一个会话选中它，激活失败（import 失败、缺服务、服务泄漏）在装配阶段就暴露。其二，**编辑 Preset 不会抽掉正在运行的 Agent 脚下的地毯**——更新声明会让旧修订退役，但只要还有 Agent 或临时读者持有引用，旧修订的树就继续存活，最后一个引用释放时才真正 dispose；这也是为什么 Agent 循环在宿主层共享、Preset 改的是挂在 Agent 作用域下的那部分。其三，失败的定义**会留在名册里可见**（"Failed definitions remain visible, while existing Agents retain the composition they already use"），只是拒绝新会话绑定，不会阻止整个应用启动——一个有毛病的可选能力集应当是可修复的，而不是把宿主拖下水。

Preset 注册表自己的可配置项也换了面貌，`packages/preset/agent-preset-registry/src/preset.ts`：

```ts
// packages/preset/agent-preset-registry/src/preset.ts
export interface Config {
  /** Deployment default when the caller omits a preset. */
  default: string
  /** User-selected default while the chooser is shown; edited through Settings. */
  selectedDefault: Volatile<string | undefined>
  /** Whether new-session surfaces expose preset selection and the saved default applies. */
  modeSelectionEnabled: Volatile<boolean>
}
```

`default` 是部署方给的兜底，`selectedDefault` 是用户在设置里选的个人默认——注意它们是同一个声明行上的字段，用户偏好通过补丁覆盖写进 Profile，不再有第二套"用户 Preset 目录"存储。

最后，旧版 `trust: 'system' | 'user'` 的目录信任分级随着目录模型一起消失了，但它背后的安全提醒换了一种更直白的说法保留下来，`agent-preset-registry` README 的 Known Limitations 第一条：

> Presets are not security sandboxes: YAML and plugins can execute Host code. A user override replaces the complete child list and does not automatically merge future changes to the builtin list.

**Preset 的隔离机制解决的是"会话之间互不干扰"，而不是"防止配置作者执行代码"**——能往 Preset 声明里加一行插件配置的人，等同于能在宿主进程里执行任意代码。这句话还附带一个工程后果值得记住：用户对 `plugins` 清单的覆盖是**整体替换**，不会自动合并自带清单未来的更新——这正是"补丁按行整体替换 config"规则在 Preset 场景的直接推论。

### 用 `dsh --dump-config` 验证装配结果

Bundle、Profile、Preset 叠了三层装配逻辑之后，"这次到底装出了什么"很容易和直觉产生偏差——这正是本课程第一章介绍过的 `dsh --dump-config` 存在的意义：它不启动进程，只把 `composeEntries` 算出来的最终树按 YAML 打印出来。`apps/cli/reference/README.md` 描述了它和 `--dump-default-config` 的区别：

> `--dump-default-config` prints only the bundle layers; `--dump-config` adds the profile's `cordis.patch.yml`, the home-level `$DSH_HOME/cordis.patch.yml`, and `--patch` overlays. Both print comments naming the file that supplied each row and every overlay that changed it; `!!js` expressions remain unevaluated, relative plugin names in inserted rows resolve beside their patch file, and unmatched patch targets are reported on stderr. A dump initializes missing profile files. It never runs app command-line providers, so it shows the composed tree before any app argument is resolved and rejects an invocation that carries app arguments.

两个命令分别对应"只看共享的核心装配"和"看叠加了我自己所有覆盖之后的最终结果"：

```sh
# apps/cli/reference/README.md
dsh --profile web --dump-default-config
dsh --profile web --patch ./extra.yml --dump-config
```

值得记住的两个细节：**每一行输出都带着"这一行是从哪个文件来的"的注释**——这意味着排查"为什么我期望被覆盖的一行没有生效"时，第一步永远应该是跑一次 `--dump-config`，看那一行最终被标注为来自哪一层，而不是直接去改代码猜测；**没有匹配到任何目标行的补丁会被报告到 stderr**——一个 `id` 写错了的补丁不会被静默忽略，但也不会中止装配，需要主动检查 stderr 才能发现。把这条命令当成本章装配机制的调试器：任何"我以为装出来的树"和"实际跑起来的行为"不一致的时候，先用它把两棵树的差异摊开来看，再回头去查是哪一层补丁、哪一个 Bundle 版本、或者哪一个 Preset 的 `isolate` 分组导致的。

第三个 dump 标志是较新的 **`--dump-config-schema`**（PR #4705，`apps/cli/reference/README.md` 的 "Config schema dump" 一节）：它与 `--dump-config` 走完全相同的多层装配（bundle → profile → home → `--patch`），但不打印配置值，而是 import 组合树里每个插件声明的 Schemastery `Config`，投影成一份 JSON Schema 2020-12 文档打到 stdout——根 schema 描述 `--dump-config` 打出的条目列表，`$defs.patchList` 单独描述补丁覆盖层。两个使用要点：三个 dump 标志互斥；且该命令**会 import 插件模块**（可能触发 Config getter 和惰性构建器，但绝不 apply 插件、不求值配置表达式），所以面对不可信插件组成的 Profile 要先读上游的安全说明（import 可能阻塞或滞留进程句柄，自动化调用方应加外部超时）。另外 schema 只是声明的投影（`secret`、`volatile` 等角色元数据保留在 `x-cordis` 注解里），`complete: false` 不等于不能启动，反过来 `complete` 也不保证能启动——运行时生成的 Preset/客户端子树本就不在它的视野内。它的用途很明确：给配置编辑器和校验工具一个机器可读的"这个 Profile 里每一行能接受什么配置"的目录，而不需要真的把进程跑起来。

## 常见问题/易踩坑

- **在共享 Bundle 里写了随部署形态变化的字段**：`dsh-base` 的补丁注释已经把这条规则写死——凡是"值会因模式不同"的字段，都不该出现在共享层，否则任何模式专属 Bundle 想要覆盖它，都得把整行 `config` 重新抄一遍，一旦共享层加了新字段，各个模式层就要同步补齐，退化成手工维护的重复劳动。
- **给本该进程唯一的服务套了不必要的 `isolate`**：`tool-jobs` 那段宿主层注释（现在住在 `packages/bundle/web-app/cordis.patch.yml` 的 "the agent plane moves behind agent presets" 一节）是一个很好的反例参照——如果一个服务的注册表本身已经按 Agent/Session 做了内部键控，给它加 `isolate` 只会让分组外的兄弟行（和它背后的跨会话读取方）看不到它，而不会带来任何额外的隔离收益，实测结果就是 `run_in_background` 报"后台任务不可用"。
- **把补丁覆盖当成深合并**：任何一层补丁替换的是目标行的**整个 `config`**，不是逐字段合并。覆盖一行里的一个字段时，务必先用 `--dump-config` 看清楚这一行当前完整的 `config` 是什么，再把需要保留的字段一起抄进覆盖补丁里，否则会在不知不觉中把没打算动的字段重置成了缺省值。

## 小结

Bundle、Profile、Preset 是同一套"分层装配、按层覆盖"思想在两个不同粒度上的应用：Bundle 是可安装、可复用的补丁层（一个包可以携带一份或按序携带多份补丁文件），Profile 把若干 Bundle 按固定顺序叠加成一个具名的进程级装配（再叠上用户自己的覆盖），这一切都建立在第三篇讲过的"注册即副作用"之上——每一层补丁增删的插件行，卸载时都会干净地撤销。Preset 在架构演进之后不再是补丁体系之外的第二套文件格式，而是**用同样的补丁机制声明的** Agent 组合（一行 `@deepseek-ai/dsh-agent-preset` 配置），由注册表急切激活成私有的作用域与 Loader 树，多个会话绑定到同一修订上共享、编辑时旧修订为运行中的 Agent 保留——会话之间的互不串扰依然靠 `isolate` 域和作用域父子链接保证。`dsh --dump-config` / `--dump-default-config` 把这套多层装配逻辑的最终结果暴露成一份可读的 YAML，`--dump-config-schema` 进一步把每行声明的配置契约投影成机器可读的 JSON Schema——它们是排查"装配结果和预期不一致"这类问题时最先应该想到的工具，而不是最后的手段。

至此，本章从"一个插件长什么样"（第一篇），到"插件之间怎么通信"（第二篇），到"卸载怎么保证干净"（第三篇），再到"这些插件在系统和会话两个粒度上怎么被组装起来"（本篇），构成了理解 dsh 运行时架构所需要的完整 Cordis 基础——后续章节里出现的任何一个具体子系统，都是在这套基础之上长出来的一棵插件树。
