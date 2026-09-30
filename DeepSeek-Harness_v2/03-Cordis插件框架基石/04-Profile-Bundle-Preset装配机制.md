# Profile、Bundle、Preset：dsh 的装配语言

这一篇要回答的问题是：一个真实的 `dsh` 进程启动时装配了哪些插件、按什么顺序、怎么区分"进程级的能力"和"某个会话里 Agent 的能力组合"，以及装出来的结果不符合预期时怎么查。

结论有三句。Bundle 是可安装的补丁层，Profile 是若干 Bundle 加用户覆盖叠出来的具名装配，二者解决进程级复用；Preset 用同一套补丁语言声明会话级的 Agent 组合，靠 `isolate` 域和作用域隔离会话。所有层都是"按 `id` 定位一行、整体替换 `config`"，不是深合并。`dsh --dump-config` 是这门装配语言的调试器。

## 两个层面的复用问题

`dsh` 要同时支持命令行一次性跑任务（headless）和起本地网页界面持续对话（web）。两种形态共享绝大多数插件（模型适配器、工具、会话持久化），只在少数几行上不同，比如要不要起 HTTP 服务器、要不要挂浏览器客户端。若每种形态维护一份完整的 `cordis.yml`，共享部分改一次就要在每份文件里同步一次。

同样的问题在会话粒度再出现一次：同一部署里，做代码评审的 Agent 和写代码的 Agent 共享"支持哪些模型、怎么持久化"，但各自有不同的工具集合和系统提示词，还不能踩到对方注册的同名服务。`dsh` 用两套呼应的机制回答：Bundle 加 Profile 管进程级装配，Preset 管会话级装配。

## Bundle：带一份补丁的 npm 包

Bundle 是普通 npm 包，特殊之处是 `package.json` 里有 `dsh.bundle.patch` 字段，指向一份 Cordis 补丁文件，或者一组按顺序应用的补丁（类型是 `patch: string | string[]`，路径相对声明它的包根，见 `packages/util/package-manifest/src/types.ts`）。核心 Bundle `@deepseek-ai/dsh-base` 的字段就是 `"patch": "./cordis.patch.yml"`。

补丁文件是 YAML，顶层是一个 `insert` 列表，每行是一条标准的 Cordis Loader 配置行：`id`、`name`，以及可选的 `config` 和 `disabled`。`packages/bundle/base/cordis.patch.yml` 开头的几行里有两处值得看。一是 `tool-plugin-manager` 在共享层被写死 `disabled: true`，因为插件管理工具不跑在宿主层，由每个 Preset 在自己的组合里挂载。二是 `plugin-manager` 和 `hmr` 的 `disabled` 是 `!!js` 表达式，比如 `!ctx.get('profileContext')`，求值推迟到运行时，由当前上下文决定这一行是否生效，于是同一份共享补丁能服务形态迥异的环境。`hmr` 一行现在指向 `@deepseek-ai/dsh-hmr`，它把模块热替换、Include 刷新和 profile 配置变更协调进同一个队列（`packages/boot/hmr/README.md`），vendor 包的配置与事件仍暴露在 `ctx.hmr` 下。

补丁文件本身只是数据，一份"我要插入哪些行"的清单。`packages/bundle/README.md` 列出了六个自带 Bundle：

| Bundle | 角色 |
|---|---|
| `base` | 以 base 为底的 Profile 共享的核心，只有补丁 |
| `acp-app` | 仅自动化的 ACP stdio 应用 |
| `web-app` | 浏览器应用层 |
| `headless` | 一次性命令行任务应用，提供 `headless-runner` |
| `sdk-app` | SDK JSON-RPC stdio 应用 |
| `sdk-minimal` | 不含 base 与 Web 的独立最小 SDK 应用，携带完整补丁树 |

一个 Bundle 只关心往树里插入哪些行，不关心自己会被装进哪个 Profile、与谁叠加，这是它能复用的原因。Bundle 也不限于这个目录：领域包可以在目录之外声明额外的层，第三方 Bundle 可用 `dsh plugin --profile <name> add <package>` 装进任意 Profile。所以它同时是仓库内部的分层手段和对外的扩展分发格式。

## Profile：叠层的结果

Profile 是"选哪些 Bundle、按什么顺序叠、再叠一份用户自己的补丁"这件事的具名结果。`packages/boot/app-boot/src/profile.ts` 里的 `PROFILE_TEMPLATES` 定义了五个自带模板，每个模板是一个 `ProfileTemplate`，目前只有 `bundles` 一个字段：

```ts
// packages/boot/app-boot/src/profile.ts
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] },
  web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
  headless: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] },
  sdk: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] },
  'sdk-minimal': { bundles: ['@deepseek-ai/dsh-sdk-minimal'] },
}
```

共享的核心只维护在 `dsh-base` 一份补丁里，除 `sdk-minimal` 之外的四种形态只在各自 Bundle 里追加自己特有的几行。模板值包成一个接口而不是裸数组，说明装配层把"Profile 模板是什么"当成一个可以继续长字段的结构，不预设它永远只是一份 Bundle 列表。

叠层顺序，`docs/architecture.md` 的表述是：对空的条目列表，先按 Profile 列出的顺序逐个应用 Bundle，再应用 Profile 自己的 `cordis.patch.yml`，再应用 home 级的补丁，最后是 `--patch` 覆盖层。补丁按 `id` 定位一行并替换它的整个 `config`，或者插入新行。真正执行叠加的是同文件里的 `composeEntries`，它对 `layers.flat()` 做一次 `applyEntryPatches`。它的注释强调，这与启动进程时使用的是同一个调用，所以离线算出的装配结果和真实启动的装配不会有偏差，这也是 `--dump-config` 可信的原因。

"整体替换而非深合并"是这一节最需要记住的规则。`base` 补丁开头的注释写得直白：补丁替换目标行的整个 `config`，所以值会因模式不同而不同的行不应放在这里，而应属于各个模式 Bundle，让任何一行都只落在一个 Bundle 层加用户层之内。反过来看，若把随形态变化的字段放进共享层，任何模式 Bundle 想覆盖它，都得把整行 `config` 重抄一遍，共享层一加字段，各模式层就得同步补齐，退化成手工维护的重复劳动。

## Preset：把 Agent 组合写成一行配置

Profile 决定进程装配了哪些服务，对所有会话共享。而"这次对话里 Agent 能用哪些工具、系统提示词写了什么"因会话而异，这是 Preset 的层级。

先交代一次架构演进，因为它决定了当前状态。早期的 Preset 是"一个目录加一份 `agent.cordis.yml`"的独立文件体系，配有自己的发现、元数据、复制与编辑 API。当前主线已经整体替换了它（PR #4569，`feat(preset): declare Agent compositions in profile YAML`）。设计备忘给出的理由是，目录式 Preset 复制了 Cordis 的配置所有权，那套独立 API 无法用一个普通的 profile 补丁表达同样的组合。现在，Preset 就是用普通 Cordis YAML 声明的一行插件配置，由 `@deepseek-ai/dsh-agent-preset` 承载，配套的 `@deepseek-ai/dsh-agent-preset-registry`（`ctx.agentPresets` 服务）负责选择、修订保留和 Profile 编辑。

最小声明是：一行注册表（`config.default: standard`），加一行 `@deepseek-ai/dsh-agent-preset`（`config.id: standard`，`config.plugins` 是子插件清单）。这里有两个 `id`，分工不同，README 的原话是"声明行的 `id` 用于 Loader 编辑；`config.id` 是会话保存的 Preset 身份"。行 `id`（例如 `preset-standard`）是补丁系统定位这一行用的，`config.id`（`standard`）才是会话记录里保存的身份。此外有可选的 `name`、`description` 作展示，`order` 决定选择器里的排序。

由此产生的关键变化是：Preset 不再是补丁体系之外的第二套文件格式，而是补丁体系的内容。新增一个 Preset、覆盖一个自带 Preset，都只是一次普通补丁操作，README 写明注册表自己不写声明，要么 `insert` 一行，要么按那行的 id 打补丁，再用 `plugin_manager` 装进 Profile。自带的 `standard` 就住在 `packages/bundle/web-app/presets/standard.patch.yml`，`config.plugins` 里有 persona、`tool-bash`、`tool-fs`、`tool-jobs` 等行，以及一个 `planning` 分组：

```yaml
# packages/bundle/web-app/presets/standard.patch.yml（节选）
- id: planning
  name: cordis:group
  group: true
  isolate:
    planMode: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
```

载体换了，`cordis:group` 加 `isolate` 的运行时机制原样保留：这个分组内部注册的 `planMode` 服务只在该分组的作用域内可见，每挂载一次得到一份互不干扰的实例。不需要写一行 TypeScript，靠 YAML 的 `isolate` 字段就能声明"这个服务不能是进程全局的，必须一会话一份"。清单里的 `persona` 来自 `@deepseek-ai/dsh-persona` 包，它给 Agent 注册专属的提示词前后缀并遮蔽部署级默认，说明 Preset 能改的不只是工具集合，也包括 Agent 的身份表述。

## 什么该 isolate，什么不该

判断标准来自 `packages/bundle/web-app/cordis.patch.yml` 里一段真实踩坑后写下的注释。Web 形态把 `tool-bash`、`tool-jobs` 这类宿主行整体 `disabled: true`，改由每个 Preset 自己挂载，补丁里那一节的标题就叫 "the agent plane moves behind agent presets"。但后台任务的注册表本体留在宿主层，只有面向模型的 `job_*` 控制工具移到 Preset 里。原因是注册表内部已经按所属 Agent 做了键控，一个宿主实例本来就能服务所有会话。此前有人给注册表套了 entry-local realm，结果分组外的兄弟行看不到它，`run_in_background` 回答"后台任务不可用"，而操作它的工具明明还列在目录里。

所以规则很清楚：服务若已按会话或 Agent 键控，就应当是进程级单例，Preset 只决定这个会话看不看得到操作它的工具，不需要再套 `isolate`。反过来，本该隔离却忘了加的服务，会被 `packages/preset/agent-preset-registry/src/mount.ts` 里的 `leakedServices()` 检测出来，导致挂载被拒绝。

## 急切激活与修订保留

新模型把泄漏检测升级成了更完整的激活审计。按注册表 README 的描述，每份声明会急切地创建一个由注册表拥有的作用域和内存中的 Loader 树。三个行为值得注意。其一，Preset 定义存在即被激活，不等第一个会话选中它，所以 import 失败、缺服务、服务泄漏在装配阶段就暴露。其二，编辑 Preset 不会抽掉运行中 Agent 脚下的地毯：更新或删除声明会让旧修订退役，只要还有 Agent、子级或临时的历史读取者持有引用，旧修订的树就继续存活，最后一个引用释放时才被 dispose。其三，失败的定义会留在名册里可见，现有 Agent 保留它们已经在用的组合，只是拒绝新会话绑定，整个应用不会因此无法启动。Agent 循环仍在宿主层共享，Preset 改的是挂在 Agent 作用域下的那部分。

注册表的配置也换了面貌（`packages/preset/agent-preset-registry/src/preset.ts`）：`default` 是部署方给的兜底，`selectedDefault` 是用户在设置里选的个人默认，`modeSelectionEnabled` 控制新会话界面是否暴露 Preset 选择。用户偏好通过补丁覆盖写进 Profile，不再有第二套"用户 Preset 目录"。

## 我的看法：Preset 的安全边界要看清

这一节是我的判断。README 的 Known Limitations 第一条写得很直接：Preset 不是安全沙箱，YAML 与插件可以执行宿主代码；用户的覆盖会整体替换子插件清单，不会自动合并自带清单未来的变更。据此我认为有两点值得使用者留意。一是 Preset 的隔离解决的是"会话之间互不干扰"，不是"防止配置作者执行代码"，能往声明里加一行插件配置的人，等同于能在宿主进程里执行任意代码，所以第三方 Bundle 与 Preset 的来源需要按可信代码对待。二是"整体替换"规则在这里有实际后果：用户一旦覆盖了 `plugins`，自带清单后续新增的插件行就不会自动出现，升级时可能悄悄缺能力。材料没有给出针对这一点的提示或迁移机制。

## 用 dump 命令验证装配结果

三层装配叠起来，"我以为装出来的"与"实际装出来的"很容易偏离。`apps/cli/reference/README.md` 的区分是：`--dump-default-config` 只打印 Bundle 层，`--dump-config` 再加上 Profile 的 `cordis.patch.yml`、home 级补丁和 `--patch` 覆盖层。

```sh
dsh --profile web --dump-default-config
dsh --profile web --patch ./extra.yml --dump-config
```

它们不启动进程，只打印 `composeEntries` 的结果，并在注释里标出每一行由哪个文件提供、被哪些覆盖层改过。`!!js` 表达式保持未求值，插入行里的相对插件名按补丁文件所在位置解析，没有匹配到目标行的补丁会报告到 stderr，也就是说 `id` 写错的补丁既不会被静默采纳，也不会中止装配，需要主动看 stderr 才能发现。dump 会初始化缺失的 profile 文件，不会运行应用的命令行 provider，因此带应用参数的调用会被拒绝。排查覆盖没生效时，第一步应当是跑一次 `--dump-config` 看那一行最终标注来自哪一层，而不是先去猜代码。

较新的 `--dump-config-schema`（PR #4705）走相同的多层装配，但不打印配置值，而是 import 组合树里每个插件声明的 Schemastery `Config`，投影成 JSON Schema 2020-12 文档输出到 stdout，用途是给配置编辑器和校验工具提供机器可读的"每一行能接受什么配置"。使用时有三点：三个 dump 标志互斥；它会 import 插件模块，可能触发 Config getter 和惰性构建器，但不会 apply 插件，也不求值配置表达式，所以对不可信插件组成的 Profile 要先读上游的安全说明，自动化调用方应加外部超时；schema 只是声明的投影，`complete: false` 不等于不能启动，`complete` 也不保证能启动，运行时生成的 Preset 与客户端子树不在它的视野内。

## 小结

- Bundle 是带 `dsh.bundle.patch` 的 npm 包，Profile 按 Bundle 顺序、Profile 补丁、home 补丁、`--patch` 的次序叠层，每层按 `id` 整体替换 `config`，不做深合并。
- Preset 现在是用同一套补丁语言声明的一行 `dsh-agent-preset` 配置，靠 `isolate` 分组和作用域隔离会话；已按 Agent 键控的服务保持进程单例，不该套 `isolate`；Preset 不是安全沙箱。
- `--dump-default-config`、`--dump-config`、`--dump-config-schema` 用与真实启动相同的装配路径暴露结果，是排查装配偏差的首选工具。

对应原课程：`03-Cordis插件框架基石/04-Profile-Bundle-Preset装配机制.md`
