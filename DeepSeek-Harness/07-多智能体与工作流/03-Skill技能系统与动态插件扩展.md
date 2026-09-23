# Skill 技能系统与动态插件扩展

> 一套技能库越丰富,越容易在不知不觉间把每个 skill 的完整说明全塞进 system prompt,喂给模型的 token 越滚越大。dsh 的 Skill 系统把这个问题拆成两层:一份轻量的"名字 + 一句话描述"目录随会话常驻,完整的操作说明只在模型明确点名要用某个 skill 时才被加载进来。本篇前半讲这套"按需展开上下文"的技能系统,后半讲一个走得更远的能力——`packages/extensions` 里的 Cordis 插件机制:模型在工作区里写一个插件包,再用 `plugin_manager` 把它持久安装进当前 Profile,从而给宿主进程加上一件新能力,也就是所谓"自我扩展"。这个能力默认不随标准配置启用,本篇会把源码里能找到的风险边界原样摆出来。

## 学习目标

- 理解 `SkillProvider` 注册表如何把"列出候选(元数据)"和"加载正文(完整指令)"拆成两个方法,以及这个拆分如何天然支撑"目录常驻、正文按需加载"的设计。
- 读懂内置的 `skill-badge`(最小示例)和 `skill-filesystem`(真实的磁盘发现 + 文件监听引擎)两个 Provider 的实现差异。
- 弄清 `tool-skill` 工具如何把"模型可调用的加载动作"和"随会话注入的技能目录消息"分成两条独立路径,以及目录消息为什么要做摘要长度截断和内容摘要去重。
- 把 Skill 系统的"按需加载正文"与第四篇讲过的上下文压缩做类比,理解两者都是"控制喂给模型的上下文体量"的手段,只是压缩针对的是历史,按需加载针对的是待选知识。
- 理解 Cordis 动态插件扩展在当前版本的能力边界与形态变化:模型侧的"生成代码"工具(`cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine`)已经被整体撤掉,`tool-cordis` 缩编为两个**只读自省**工具,自我扩展改走"工作区里写插件包 + `plugin_manager install_bundle` 持久安装到 Profile"这条路;在此基础上弄清 `vm`/`guard` 挡住了什么、又刻意没有挡住什么,以及这套能力为什么仍然被隔离在一个非默认的 Agent Preset 里。

## 背景与设计动机

Skill 系统和 Cordis 动态插件系统表面上离得很远,但放在一起讲是因为它们回答的是同一个更大问题的两端:**一个 Agent 的能力边界,应该在启动时就固定死,还是可以在运行过程中动态调整?**

Skill 系统给出的答案是"温和版"的动态——技能的**内容**在运行时按需加载,但技能能做的事(读文件、生成徽章之类)早就被写成了静态的 Markdown 说明,模型只是"学会怎么用现有工具去完成一件事",并没有获得任何新的执行能力。Cordis 插件给出的是"彻底版"的动态——模型写出一段全新的、真正会被求值执行的 JavaScript,装成宿主进程里能访问真实服务的插件,相当于给自己造了一件新工具(当前版本的具体路径是"工作区写包 + `plugin_manager` 持久安装",见下文)。前者几乎没有额外的信任风险,后者的信任模型等价于给了 shell 访问权限——这也是为什么它被单独隔离在一个不常驻的预设里,而不是随手可用的默认能力。

## Skill 技能系统

### `SkillProvider`:元数据与正文分离的注册表

核心接口定义在 `packages/skill/skill/src/index.ts`:

```typescript
// packages/skill/skill/src/index.ts:247-268(节选,当前实际字段)
/** Provider interface for one source of skills, such as local directories or a remote registry. */
export interface SkillProvider {
	/** Unique provider name in the `ctx.skills` registry. */
	readonly name: string
	list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[] | SkillProviderObservation>
	get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}
```

`list()` 返回的是轻量候选——`SkillCandidate`/`SkillSummary` 只带 `name`/`description`/`whenToUse?`/`invocation`/`source`/`provider` 这些**元数据**字段,不含正文。`get()` 才会真正加载出带 `content: string`(完整 Markdown 正文)的 `SkillDefinition`。这个"先列候选、再按需取正文"的两段式设计,是整套按需加载机制成立的地基。`list()` 的返回类型是一个联合类型:大多数 Provider(比如下面的 `skill-badge`/`skill-filesystem`)一次性给出完整数组;需要"发现可能没做完、但已经有一批可用候选"这种场景(比如需要探测远程注册表的 Provider)则返回 `SkillProviderObservation`(`{ candidates, complete: boolean }`)——`complete: false` 时,调用方知道这批结果还不能被长期缓存。配合这一点,注册表还提供了 `SkillProviderControl.invalidate()` 给 Provider 自己主动"戳一下"、让已完成的目录缓存失效,不用干等下一次自然过期。

`SkillRegistry` 服务(`packages/skill/skill/src/index.ts`)在这之上再叠一层——它是一个"分层注册表",host 级的 Provider 加上每个 Agent Preset 自己的层,同名冲突时按固定优先级(`RUNTIME_RANK=250`、`BUNDLED_SKILL_RANK=600` 等,数值越小越优先)由最近的层胜出。`get()` 方法的实现特别值得注意——它**不缓存正文**,只缓存轻量候选映射:

```typescript
// packages/skill/skill/README.md 的设计原则(转述自源码行为)
// registry.get(name, options) 每次都会重新走 provider.get() 加载正文,
// 只有 list() 产出的候选集合会被缓存(默认上限 128 条)。
```

这个"正文永不缓存"的选择,直接服务于下一节要讲的 `skill-filesystem`——正文文件被人改了之后,下一次加载立刻拿到最新内容,不需要设计任何缓存失效/版本号机制。

### 内置 skill:`skill-badge` 与 `skill-filesystem`

`packages/skill/skill-badge/src/index.ts` 是一个极简示例,把"元数据/正文分离"体现得最清楚:

```typescript
// packages/skill/skill-badge/src/index.ts(节选)
const CANDIDATE: SkillCandidate = { name: 'dsh-badge', description: DESCRIPTION, /* ... */ }
const provider: SkillProvider = {
	name: PROVIDER_NAME,
	list: () => Promise.resolve([CANDIDATE]),   // 零 I/O,同步就能给
	async get(_candidate): Promise<SkillDefinition> {
		return { ...CANDIDATE, content: await readFile(SKILL_BODY_URL, 'utf8') }  // 正文这才去读
	},
}
```

`list()` 完全不碰磁盘,`get()` 才真正去读一次文件。这个 skill 的作用是教模型生成一个 "Built with DeepSeek Harness" 的项目徽章,**默认在标准 CLI 组合里是禁用的**——即便这么轻量的一个内置 skill,dsh 也不假设它应该默认出现在每个会话的目录里,而是要求部署方显式打开。

`packages/skill/skill-filesystem/src/index.ts` 则是真正干活的发现引擎——扫描 `<name>/SKILL.md` 这种技能包目录或者扁平的 `<name>.md` 文件,跨若干个按优先级排序的根目录查找,并且带一套基于 Chokidar(加上对不存在路径的轮询兜底)的文件监听器,能在技能文件被增删改时刷新目录。它的失效判定很有分寸——只有顶层技能包的增删,或者 `SKILL.md`/扁平 `.md` 文件本身的变化才会触发目录刷新,技能包内部 `references/`、`scripts/`、`assets/` 目录下的资源文件变化不会触发失效。这与"正文不缓存,每次现读"配合起来,形成了一条从磁盘到模型的短闭环:**目录变了才刷新目录,内容变了不用管缓存,因为压根没缓存内容**。

`skill-filesystem` 同时按优先级扫描五种根目录,数值越小优先级越高、同名冲突时更靠前的层胜出:

| 根目录种类 | 优先级(rank) |
|---|---|
| 项目级 `.dsh/skills` | 100 |
| 项目级 `.agents/skills`(与 `AGENTS.md` 生态兼容) | 200 |
| 自定义配置根 | 300 |
| 用户级 `~/.dsh/skills` | 400 |
| 用户级 `~/.agents/skills` | 500 |

除了 `skill-badge` 这个极简示例,当前仓库里还有一个分量重得多的内置 Provider——`packages/skill/skill-office`(`@deepseek-ai/dsh-skill-office`),打包了 `office-docx`/`office-pptx`/`office-xlsx` 三个技能,分别覆盖 Word/PowerPoint/Excel 的文档写作工作流和结构校验,技能正文和资源(带 YAML frontmatter 的 Markdown + 脚本)随包一起分发,同样注册在 `BUNDLED_SKILL_RANK` 这一档优先级上。这算是课程写作时还没有的一个新板块,方向上属于"给内置技能库补充更贴近真实办公场景的技能包",机制上完全复用了本节前面讲的 Provider 接口,不需要新的加载逻辑。

对照前面提到的 `RUNTIME_RANK=250`(运行时动态注册的技能)和 `BUNDLED_SKILL_RANK=600`(随包自带的内置技能,如 `skill-badge`/`skill-office`),可以看出整条优先级链条的设计意图:**项目级配置 > 运行时注册 > 用户级配置 > 内置默认**——一个项目自己放在 `.dsh/skills` 目录下的同名技能,永远能覆盖用户全局配置甚至内置技能,方便团队用项目内配置统一约束技能行为,而不用担心被某个用户的本地全局配置覆盖。

顺带一提两个容易被忽略的边界:技能可以在其元数据里标注 `disable-model-invocation: true`,这样它会从模型可见的目录里消失,但仍然可以被用户用 `/名字` 手势直接触发——也就是"人可以用,模型看不到、也调不了"这档中间状态;另外,整个 Skill 系统里**没有任何"版本号"字段**,同名冲突完全靠层级优先级和注册顺序决定谁生效,不存在语义化版本比对的机制。

### `tool-skill`:按需加载,而不是全部塞进 system prompt

模型真正用来加载技能正文的工具是 `packages/skill/tool-skill/src/index.ts`,它的参数极其简单——只要一个 `name`:

```typescript
// packages/skill/tool-skill/src/index.ts:82-92(节选)
{
	name: 'skill',
	description: 'Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill.',
	parameters: {
		name: { type: 'string', required: true, description: 'The exact skill name from the available skills list.' },
	},
}
```

`execute()` 内部会同时查 `ctx.skills.list()` 和 `ctx.skills.get()`,这一步会透明地合并所有已注册 Provider、所有层级的结果,最终把完整正文作为工具结果的一部分返回给模型。

真正体现"按需加载"这个设计的,不是这个工具的 `description` 字段(那只是一句静态说明),而是一条**独立注入的目录消息**——它不是工具描述的一部分,是一条会话历史里的普通 `UserMessage`,由 `renderCatalogMessage()` 渲染:

```typescript
// packages/skill/tool-skill/src/index.ts:254-277
function renderCatalogMessage(entries: SkillCatalogSource['entries']): UserMessage {
	return createUserMessage({
		content: [{
			type: 'text',
			text: [
				'<system-reminder>',
				'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
				'',
				'<available_skills>',
				...renderCatalogEntries(entries),
				'</available_skills>',
				'',
				"If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
				'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
				'</system-reminder>',
			].join('\n'),
		}],
		source: { kind: 'skill-catalog', form: 'catalog', entries },
	})
}
```

每一条目录项只有"名字 + 一句话描述",而且这句描述本身还要过一次长度截断(默认上限 500 字符,可通过 `Config.catalogDescriptionMaxLength` 配置)——这是刻意压低"常驻"部分的 token 体量:目录本身要足够便宜,才值得让它一直待在上下文里;昂贵的完整正文只有真正要用到的那一个 skill 才会被加载进来,而且往往只加载一次。

这条目录消息也不是每一轮都重新发一遍——有一个 `agent/pre-step` 钩子会对当前候选集合算一次 SHA-256 摘要,只有摘要变化(比如新增/删除了一个 skill 文件)时才会重新发一条"替换版"目录消息,这个开销通常只在会话开始时付一次,不是逐轮重复的常态成本。

除了工具调用这条路径,还有一条更直接的旁路——用户在对话里直接打出 `/skill 名字` 这种手势,会被另一个 `agent/pre-step` 钩子的正则匹配捕获,直接把技能正文注入对话,完全不经过 `skill` 工具本身。

**与第四篇上下文压缩的类比**:上下文压缩解决的是"历史已经发生的对话太长,要不要把老的部分折叠成摘要";Skill 目录/正文的分离解决的是另一个方向的同一类问题——"待选的知识太多,要不要把还没用到的部分折叠成一句话描述"。两者的手法都是"先给一个廉价的摘要,真正需要细节时再展开完整内容",只是压缩作用于过去已发生的内容,按需加载作用于尚未被选中使用的内容。放在一起看,会发现 dsh 在"控制喂给模型的 token 预算"这件事上是有一套一致方法论的,而不是每个子系统各自发明一套。

一个值得记住的边界:**目录本身的 token 预算被压得很紧,但加载进来的 skill 正文长度目前没有任何上限**——这是工具自己文档里明确写出的已知局限,如果某个技能包的 `SKILL.md` 写得非常长,加载它带来的 token 成本目前完全由技能作者的自觉去控制,系统不会替你截断。

## 动态插件自举:Cordis 自我扩展能力

这一半相对课程写作时发生了实质性变化,先把结论放在最前面:**模型侧那套"生成代码"型工具已经整体撤掉,自我扩展改走了另一条路**——Agent 把插件包写成普通的工作区文件,再调用 `plugin_manager` 工具把它持久安装到当前 Profile;而"动态定义请求"(`code: { host?, client? }`)这套底层机制并没有拆,只是它的消费方从模型工具换成了面板类 / 程序化调用方。下面按"现在模型手里有什么 → 还在的底层机制 → 风险边界 → 预设打包方式"的顺序,讲当前版本的全貌。

### `tool-cordis`:从"七件套"缩编为两个只读自省工具

课程写作时,`packages/extensions/tool-cordis/src/index.ts` 里注册了七个 `cordis_` 前缀的工具——既有自省工具,也有 `cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine` 四个直接改写运行时的"生成代码"工具。**当前版本里,留给模型的只剩两个只读工具**,模块头注释写得很直接("Read-only Host and Client runtime API discovery for plugin development"),注入的服务也只剩 `['tools', 'cordisInspect']`:

```typescript
// packages/extensions/tool-cordis/src/index.ts(当前全部工具)
// cordis_inspect_list   — 列出 Host 当前已知的全部 Cordis Inspect Provider
//                         (含浏览器页面上同步过来的 Client manifest),带各 Provider 的
//                         平台、用途、只读方法清单和输入/输出 Schema
// cordis_inspect_query  — 按"平台(host/client)+ Provider + 方法"精确读取 Service 方法签名、
//                         Event 模式、插件 Config 的 JSON Schema、Tool 参数模式、
//                         主题 token、实时 Slot 树和 props
```

`cordis_inspect_list` 的 description 里有一句警告值得原样转述:"Do not guess names or treat an Inspect method as a business Service that Plugin code can call."——这些 Provider 只负责"让你看清楚宿主有哪些 API 可用";`cordis_inspect_query` 自己的 description 也把边界钉死了:"This Tool cannot invoke business Service methods or modify the runtime." 换句话说,模型现在能做"写插件前的侦察",不能通过工具会话发起任何运行时的定义、挂载、停止或删除。仓库里两份状态为 implemented 的设计笔记把这次撤编写得很直白——`.agents/notes/implemented/architecture/2026-09-16-creator-persistent-plugin-management.md`:"The model sees two read-only Cordis inspection tools. Generated-code define/run/stop/undefine and dynamic self-inspection tool APIs are absent."(课程写作时还有的第三个自省工具 `cordis_inspect_self`,也随着"看自己的行为"这一元能力被要求消失而撤掉了);更早一份 `.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md`:"Shipped model tools do not create or mutate runner definitions."

### 没拆的底层:`DynamicCordisDefineRequest` 与 `guard.ts`

模型会话发起 define 这条路没了,但底层那套"动态定义"机制还在原地——`DynamicCordisRunnerService`(`packages/extensions/cordis-host-runner/src/index.ts:129`)依旧暴露 `define()` 等四个操作,它的输入契约也还没变(`packages/extensions/cordis-host-runner/src/registry.ts:85-98`):

```typescript
// packages/extensions/cordis-host-runner/src/registry.ts:85-98
export interface DynamicCordisDefineRequest {
  /** Session that owns the plugin. */
  sessionId: SessionId
  /** Create a plugin or append to an existing one. */
  plugin:
    | { kind: 'new'; idPrefix: string }
    | { kind: 'existing'; pluginId: CordisDynamicPluginId }
  /** Package label. */
  name: string
  /** User-facing purpose. */
  purpose: string
  /** At least one source half. */
  code: { host?: string; client?: string }
}
```

`code` 字段仍然是一段**纯 JavaScript 源码字符串**(一个隐式的 async 函数体),求值后必须返回一个满足 Cordis "插件"形态的值,判定逻辑一字未动:

```typescript
// packages/extensions/cordis-host-runner/src/guard.ts:790-794
export function isPlugin(value: unknown): value is Plugin {
	if (typeof value === 'function') return true
	return typeof value === 'object' && value !== null
		&& typeof (value as { apply?: unknown }).apply === 'function'
}
```

也就是说,动态代码可以返回一个函数,或者一个带 `apply(ctx)` 方法的对象——这正是 Cordis 框架里普通静态插件的形态(`docs/cordis-primer.md` 里解释 Cordis 是"插件 = Service、Context = 服务仓库、`inject` 声明依赖"的元框架)。一条典型的动态插件正文,和静态插件长得一模一样:

```javascript
// 摘自内置技能 cordis-plugin-development 的模板 templates/decoration/client.js(节选)
// ——该技能当前教模型用"工作区写插件包 + plugin_manager install_bundle"的方式产出这类文件
return {
	inject: ['slots'],
	apply(ctx) {
		ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ /* ... */ }, Decoration))
	},
}
```

换句话说,`DynamicCordisRunnerService.define()` 仍能让一段临时代码自己声明要依赖哪些服务、自己挂到活的运行时上——"动态插件自举"的机制层面没有变,变的是**谁能发起一次 define**:课程写作时是模型的一次工具调用,当前是面板操作(`ui-cordis` 的控制面板)或程序化调用方的 API 调用——`ui-cordis` 的 README 现在写得很明确:用户侧新创建的插件走 Plugin Manager,这个包只负责渲染历史上那些"生成插件"的卡片、并对进程内定义提供控制面板,"this package exposes no model mutation tools"。模型真正要走的扩展新路,是后面"预设"一节要讲的 Plugin Manager。

### 沙箱与守卫:`guard.ts`/`sandbox.ts` 到底挡住了什么

`cordis-host-runner/src/sandbox.ts` 用 `node:vm` 给动态定义的代码建了一个执行环境,但源码从一开始就明确否认了这是安全边界。真正挡住的是一组会诱导误用的 Node 全局量——不是删除,而是替换成"抛出教学性错误"的陷阱:

```typescript
// packages/extensions/cordis-host-runner/src/sandbox.ts:56-59,68-79(节选与注释)
const TIMER_REDIRECT = 'Node timers are unavailable. Use the cordis timer service instead...'
// 只有函数型全局量会被陷阱替换;
// 像 `process` 这样的数据型全局量干脆留空,因为抛错的访问器会引爆常见的 `typeof process` 特性探测。
const NODE_API_REDIRECTS: Record<string, string> = {
	require: 'Node modules are unavailable. Use the cordis services on ctx instead...',
	setTimeout: TIMER_REDIRECT, setInterval: TIMER_REDIRECT, setImmediate: TIMER_REDIRECT,
	clearTimeout: TIMER_REDIRECT, clearInterval: TIMER_REDIRECT,
	fetch: 'Network access goes through the cordis web service...',
}
```

`process`/`Buffer` 这类更底层的对象则干脆留空(`undefined`),不做任何拦截包装。vm 的超时(`Config.vmTimeoutMs`,默认 5000ms)用的是 `node:vm` 自带的 `timeout` 选项——但文档特别提醒:一个异步函数体可以轻易绕开这个超时,这在这套机制的信任前提下是"可接受的",而不是被当作漏洞。

`guard.ts` 是另一层——一个白名单式的 `ctx` 访问代理,同样明确写着"不是安全边界"。它允许的 `ctx` 方法被限制在一个固定集合(`effect`/`on`/`once`/`provide`/`timeout`/`interval`/`setTimeout`/`setInterval`/`throttle`/`debounce`),未声明的服务读取会抛出带教学意味的错误,任何写操作一律被拒绝("sandbox ctx 是只读的")。其中一条反逃逸规则值得单独一提:**任何服务方法如果返回值本身是一个活的 Cordis `Context` 对象,会被直接拒绝**——这是专门防止"模型写的代码通过某个服务方法拿到一个未经代理的、完整权限的 Context 引用,从而绕开整套 guard"的路径。跨越这条边界传递的数据必须是无损的纯 JSON,类实例、函数、`Map`/`Set`、`Date`、嵌套 `undefined` 都会被明确拒绝并给出具体错误信息。

把这些机制放在一起看,"这不是安全边界"这个声明在当前版本里仍然原样立在两处源码里——`packages/extensions/cordis-host-runner/README.md`:"The sandbox isolates globals but is not a security boundary ... Treat a dynamic package like bash access";以及 `packages/extensions/cordis-client-runner/src/client/guard.ts` 头注释:"This is API discipline, not a security boundary: a dynamic package's code is as trusted as the host process that accepted its definition." 课程写作时引用的另外两处证据已经随版本变动:工具自身注入给模型的那段提示词(当时的 `cordis_define` 提示词,原文 "The restricted execution environment prevents accidental misuse; it is not a security boundary for malicious code.")随模型工具的撤编一起没了;而那份当时还处于 proposed 状态的架构设计笔记,已经转正到 `.agents/notes/implemented/` 目录下,它和宿主侧的 README 现在交叉引用——`2026-07-08-self-referential-cordis-toolset.md` 确认的口径依然是"防误用的门槛,不是能挡住恶意代码的安全边界",并且明确说 vm"is not a security boundary"。

真正能拿到的能力边界,由插件自己声明的 `inject` 列表决定,而不是由沙箱去裁剪——一个插件完全可以声明依赖 `fs`/`bash`/`subprocess`/`pty`/`web` 这类具备真实主机权限的服务,一旦声明了依赖,拿到的就是真实的服务对象,不是阉割版。另一个课程写作时的结论也到期了:当时动态定义的插件只活在一个进程内的内存 `Map` 里,进程重启全部消失——**现在由面板/程序化消费者发起的动态定义依旧进程内易失,但模型改走 Plugin Manager 安装出来的插件,是持久写进 Profile 的**(细节见下文"预设"一节),读者不应再把"重启即消失"当成可依赖的安全假设。

### `cordis-client-runner` 与 `ui-cordis`:浏览器侧的另一半,更弱的隔离

动态定义请求的 `code` 参数其实分 `host`/`client` 两份源码——`host` 那份跑在 Node 侧的 `cordis-host-runner` 里(上一节讲的 `vm` + `guard` 组合),`client` 那份则跑在浏览器页面里,由 `cordis-client-runner` 负责。`packages/extensions/cordis-client-runner/src/index.ts` 本身只是一个 9 行的空壳,真正的执行逻辑在浏览器端的 `client/*.ts` 文件里——因为浏览器环境里根本没有 `node:vm` 可用,它退而用 `new Function(...)` 构造函数来跑动态代码(`packages/extensions/cordis-client-runner/src/client/evaluator.ts:180`)。这是一种**明显更弱**的隔离:`new Function` 构造出的代码仍然运行在同一个 JS 现实(realm)里,只是形参列表可以拿掉一部分自由变量的直接可见性,并不像 `vm.createContext` 那样有一个真正独立的全局对象。浏览器端的 `client/guard.ts` 对此毫不讳言:"This is API discipline, not a security boundary: a dynamic package's code is as trusted as the host process that accepted its definition."

`packages/extensions/ui-cordis` 提供的是配套的人机交互外壳,当前 README 的定位是:"renders historical generated-plugin cards and a control panel for process-local definitions"——它仍会渲染历史会话里留下的 `cordis_define`/`cordis_run` 工具卡片(纯记录性质:名字、purpose、源码、结局,不可再操作),并为**进程内仍存活的定义**提供一个控制面板:列出当前 Host 侧的全部定义(不分会话,自己会话的排前面),提供批准 / 停止 / 移除等操作按钮,行内同时显示"host 是否还在跑"和"本页是否已加载"两件事。课程写作时文档提到的 `@插件id` 提及(mention)输入源,在当前源码里已经找不到;新的一套用户创作路径(Agent 自己写插件的"Creator"自我扩展)改由 Plugin Manager 承担,README 原话:"New Creator plugins use Plugin Manager ... this package exposes no model mutation tools." 需要强调的是:这层 UI 只是"审批和观察动态插件"的外壳,并不是给动态插件本身提供渲染能力的框架——插件内部要不要有界面、界面长什么样,是插件自己 `client` 代码的事,`ui-cordis` 管的是"人怎么看见、怎么批准这件事在发生"。

浏览器端仍然保留着一层 Host 侧没有的强制人工关卡:**Client 代码的挂载需要经过人工点击审批,纯 Host 定义则不需要**——`ui-cordis` README 里对纯 Host 定义的读数是"plainly running",可供操作的只有停止按钮;而一次带 Client 代码的请求会让 approvals 行停在 warning 状态,等页面用户在控制面板里点下决定。审批粒度是"插件身份"而非"这一次具体改了什么代码":审批按钮旁有一个显式勾选项("Allow future versions of this plugin"),勾选后同一插件的后续版本更新不再逐次询问——这是为了不让每次小改动都要求用户重新点一次确认,但它终究是由人勾选的选择,不是默认行为。另外,审批现在被明确设计为**页面全局(frame-wide)**:一个标签页里模型发起的请求,可以在另一个标签页的控制面板里被批准,"最先回答的那个决定生效,其余随之收敛"(README 原话 "the first answer wins and the rest converge")——这也意味着审批的责任主体是整个浏览器页面,不是某个具体会话视图。

### 默认不启用:`cordis` 预设与持久化的 Plugin Manager

这套自我扩展能力不是随手可用的默认工具集,仍然被隔离在一个专门的、非默认的 Agent Preset 里。**打包方式相对课程写作时已经变样**:当时预设是 `apps/cli/config/agent-presets/cordis/agent.cordis.yml` 里的一份完整 YAML,当前已改成 `packages/bundle/web-app/presets/*.patch.yml` 里的一组"补丁文件"(patch 方言,与第三篇讲的 Profile/Bundle/Preset 装配机制一致;当前这份目录下有 `minimal`/`standard`/`ptc`/`cordis` 四份)。`packages/bundle/web-app/presets/cordis.patch.yml` 的内容很说明问题——它不再是课程写作时那样的"自包含全量配置",而是只向 web 组合之上**追加一行** `@deepseek-ai/dsh-agent-preset` 声明:

```yaml
# packages/bundle/web-app/presets/cordis.patch.yml(头部注释与主体摘录)
# Agent preset cordis: one `@deepseek-ai/dsh-agent-preset` declaration inserted
# after the web patch. Edits saved from the Web editor override this row's
# `config.plugins` by id from the profile patch.
- insert:
    - id: preset-cordis
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: cordis
        order: 4
        plugins:
          # Same persona as `standard`: tool descriptions and the skill catalog carry
          # the operating detail, and the skills own the preset-authoring rules.
          - id: persona            # 与 standard 相同的 persona,没有"Creator 人格"
          # ... (沿用 standard 的全部工具与命令)
          - id: tool-cordis        # 只剩两个只读自省工具(见上文)
          - id: skill-filesystem
            config:
              customSkillDirs:
                - !!js <解析到 @deepseek-ai/dsh-agent-preset 包内的 skills/ 目录>
                # ——即 cordis-plugin-development / editing-cordis-compositions
                #   / cordis-composition-reference 这套"组合写作"技能
          - id: tool-plugin-manager
            name: '@deepseek-ai/dsh-plugin-manager/tools'
            disabled: !!js "!ctx.get('profileContext')"   # 未跑在 Profile 里则禁用
```

也就是说,当前版本的 `cordis` 预设 = `standard` 的全部内容 + 三个组合写作技能 + 只读的 `tool-cordis` + `tool-plugin-manager`,连"独立的 Creator persona"都被刻意去掉了(文件头注释原话:"Same persona as `standard`: tool descriptions and the skill catalog carry the operating detail, and the skills own the preset-authoring rules.")。课程写作时文件头部那段 `# TRUST:` 风险声明也随打包方式迁移消失了——风险声明的职责被挪到了**工具自己的 description** 上:`packages/boot/plugin-manager/src/tools.ts` 注册的 `plugin_manager` 工具的动作面是 `list_plugins`/`list_bundles`/`set_plugin`/`set_bundle`/`install_bundle`/`remove_bundle`,工具的 description 里直接写着:"Changes affect every session in this profile ... installed Host code runs outside the workspace sandbox." 而且每次调用都要过一次以 `'danger-full-access'` 为请求的逐次审批(`approveEscalation({ requestedMode: 'danger-full-access', ... })`)。

课程核对时留下的那个"未完全展开的信号",现在可以确认落地了(`.agents/notes/implemented/architecture/2026-09-16-creator-persistent-plugin-management.md`,状态 implemented):**"Creator mode enables the existing `plugin_manager` tool. Agents author packages and Loader YAML patches as workspace files, then install them through `install_bundle`."** 对照前面"动态定义依旧进程内易失"的事实,整个故事的两头就都能说清:**由面板类 / 程序化消费者发起的动态定义,仍然是进程内内存态、重启即消失**(`2026-07-08` 笔记原话:"Definitions remain process-local. Restart and session resume do not recreate them from historical calls.");**而 Agent 自己写的、经由 `plugin_manager` `install_bundle` 装上来的宿主代码,是持久写进 Profile、对该 Profile 下每个会话都生效的**。

而系统级的默认预设 id 仍然被硬编码为 `standard`(`packages/bundle/web-app/cordis.patch.yml:544` 的 `default: standard`,这一引用的位置没有变),`standard` 预设本身根本不引用 `tool-cordis`/`tool-plugin-manager` 这些包——也就是说,一个普通会话从"标准编码 Agent"切换到"能把插件持久安装进自己所在 Profile 的 Agent",必须由部署方或使用者显式切换到 `cordis` 这个预设,不存在任何默认路径会不知不觉打开这扇门。这与 Skill 系统里 `skill-badge` 默认关闭是同一种谨慎——但风险等级完全不是一个量级:`skill-badge` 关闭只是少一个生成徽章的技能,而 `cordis` 预设关闭意味着"默认情况下没有任何会话具备重写自己所在运行时的能力"。

文档层面(`docs/subsystems/extensions.md`/`.zh.md`)仍然只是自动生成的 API 参考,没有展开讨论风险考量;`docs/cookbook/extension-cookbook.md` 覆盖的是普通的静态插件编写,同样没有涉及动态自举这个特性。课程写作时那份"proposed 状态的架构设计笔记",如今已经转正落地为两份 implemented 笔记——`2026-07-08-self-referential-cordis-toolset.md`(原文:"The vm prevents accidental global pollution; injected filesystem, shell, and network services still have real authority, so it is not a security boundary.")和 `2026-09-16-creator-persistent-plugin-management.md`(明确模型工具面只剩两个只读自省工具、写操作工具不存在、"The model sees two read-only Cordis inspection tools")。这一点值得如实告诉读者:**dsh 的正式文档目录(`docs/`)至今没有单独展开讨论这个特性的安全考量**,风险边界需要读者自己去源码注释、README 和 `.agents/notes/implemented/` 里的设计笔记拼出全貌。

## 小结

Skill 系统和 Cordis 动态插件机制是同一条设计主线的两种强度:前者让模型"按需知道有哪些现成本领可用",本领本身是静态、无害的操作说明;后者让模型"按需给自己造一件新本领",新本领是真正会被执行的代码,拿到的是宿主服务的真实访问权限。`SkillProvider` 的 `list`/`get` 分离,以及 `tool-skill` 的目录消息与加载工具分离,构成了一套"廉价目录常驻、昂贵正文按需"的上下文预算控制手法,与上下文压缩是同一方法论在不同方向上的应用。Cordis 动态插件机制在这一轮里完成了一次"收窄模型面、纯化机制层"的调整:模型侧的工具表面缩编为两个只读自省工具(`cordis_inspect_list`/`cordis_inspect_query`),自我扩展改走"工作区写插件包 + `plugin_manager install_bundle` 持久安装到 Profile"的路(带 profile 级持久化和逐次满权限审批);而底层那套"`vm` 重定向 + `guard` 白名单 + `inject` 决定能力边界"的机制原样留给面板类和程序化定义,两处源码注释依然老实写明"这不是安全边界",并且用一个非默认的 Agent Preset 把这扇门锁在默认路径之外——文档本身没有展开的风险讨论,读者在真正启用这类自举能力之前,需要自己把源码注释、README 和设计笔记里的这几处声明当作唯一可信的风险说明。

思考题:

1. `tool-skill` 的目录消息用摘要(SHA-256 digest)去重来避免逐轮重发,而 skill 正文选择"完全不缓存、每次现读"。如果要新增一个允许远程 HTTP 拉取的 `SkillProvider`,你会给它的 `get()` 加缓存吗?加的话,怎么在"正文可能被远程更新"和"不希望每次加载都发一次网络请求"之间取舍?
2. `guard.ts` 里"任何返回值是活的 Context 对象就拒绝"这条反逃逸规则,和上一篇讲的 workflow 引擎里"跨进程边界的值必须是纯 JSON"的约束,本质上是同一类防御——不让"活的、有权限的对象"跨越一条本该受限的边界。如果你要给 Cordis 动态插件系统也加一层"遏制而非安全边界"的进程外隔离(类似第二篇提到的 `isolated-vm` 被放弃的方案),你觉得最难处理的是插件对宿主服务的"能力"访问,还是它返回值里可能夹带的"活对象引用"?
