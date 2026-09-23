# Subagent 委派与协作模型

> 一个 Agent 能不能把手头的活儿"分包"出去,交给另一个 Agent 去干,自己只等结果或者顺手继续别的事?dsh 的答案是:能,而且分包的方式不止一种——同进程内 fork 一个带记忆的孩子、同进程内 spawn 一个白板孩子、通过 ACP 协议驱动远程 Agent、直接拉起 `claude`/`codex` 这样的外部 CLI 当子代理,甚至递归地拉起另一整套 dsh 自己。本篇从 `SubagentProvider` 这个统一契约讲起,拆开六种委派后端各自的机制,再讲清楚父子会话之间"谁能看见谁""谁能管谁"的作用域与通信规则。

## 学习目标

- 理解 `SubagentProvider` 接口如何用一个 `start()` 方法统一六种截然不同的委派机制(同进程 fork/spawn、ACP 远程、外部 CLI、递归 dsh),并弄清 `inheritsParentContext`/`capabilities` 这些声明式字段解决了什么问题。
- 掌握 `SessionHeader` 里 `delegationDepth`/`parentSession`/`origin` 三个字段如何共同支撑"子代理是谁生的、生了几代、还能不能再生"这套会话血缘与深度预算机制。
- 弄清六种 Provider(`fork-in-process`/`spawn-in-process`/`acp`/`claude-code`/`codex`/`dsh-sdk`)分别适合什么场景,以及为什么 fork 和 spawn 的全部差异只是"要不要塞一份历史记录种子"。
- 读懂 `tool-subagent` 委派工具的三条执行路径(前台等待、一次性后台、可续接后台),理解"用哪个委派 Provider"为什么只能由部署方锁定,而子代理的 LLM 路由(provider/model/推理强度)在什么条件下允许模型自己选。
- 区分父子之间两类独立的消息:`send_message`/`interrupt_agent`(相邻 Agent 之间的模型自主消息与主动控制,来源标记 `agent-message`)、结算通知(运行时→父的强制通知,来源标记 `subagent-settled`),理解它们为什么故意做成不同的消息来源而不是合并成一种。

## 背景与设计动机

多智能体协作最容易踩的坑,是把"谁负责启动子任务""子任务能看到多少上下文""出了问题谁来兜底"这三件事混在一起变成一坨。dsh 的设计里,这三件事被拆成了三层正交的抽象:

1. **传输层**——`SubagentProvider`,只回答一个问题:"怎么把一个 prompt 变成一个正在跑的子代理"。同进程 fork、同进程 spawn、跨进程 ACP、外部 CLI 子进程,对上层来说都是同一张契约。
2. **血缘与预算层**——`SessionHeader` 里的 `parentSession`/`origin`/`delegationDepth`,负责回答"这个会话是不是子代理""它是谁的孩子""它已经递归了几层"。这一层完全独立于传输机制:无论子代理是 fork 出来的还是外部 CLI 拉起来的,只要走完 `SubagentRuntime` 的创建流程,都会留下同一套血缘记录。
3. **通信层**——`send_message`/`interrupt_agent`/结算通知,负责回答"父子之间谁能对谁说话,说的话算不算数"。

这种分层的好处是:给系统换一种委派后端(比如从"同进程 fork"换成"外部 Claude Code CLI"),血缘记录和通信规则完全不用变——因为它们根本不知道传输层长什么样。

## 核心机制详解

### `SubagentProvider`:委派后端的统一契约

所有委派后端要实现的核心接口定义在 `packages/subagent/subagent/src/types.ts`:

```typescript
// packages/subagent/subagent/src/types.ts:344-389（节选）
export interface SubagentProvider {
	/** Unique registry name (e.g. `spawn`, `fork`, `acp`). */
	readonly name: string
	/** The start-time features this provider supports (see {@link SubagentCapabilities}). */
	readonly capabilities: SubagentCapabilities
	/**
	 * Whether the child sees the parent's completed-turn prefix. This is descriptive, not a
	 * service-validated start capability: the model-facing tool derives truthful wording from it.
	 * It says nothing about tool registration, injected services, or authority inheritance.
	 */
	readonly inheritsParentContext: boolean
	/**
	 * Establish a ONE-SHOT child and return its handle after publication.
	 * ...
	 */
	start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
	prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
```

这个接口刻意做得很"瘦":**唯一必须实现的方法是 `start()`**——建立一个一次性(one-shot)子代理,返回一个句柄。`prepareContinuable()` 是可选的,它的"存在与否"本身就是能力声明——某个 Provider 是否支持"可续接"(continuable,能被后台挂起、之后再用 `send_message` 唤醒)的后台子代理,不是靠一个布尔字段标注,而是靠这个方法有没有被实现来判断。

`SubagentCapabilities` 则是一组**启动前**就能检查的静态能力标志(同样在 `types.ts` 里):

```typescript
// packages/subagent/subagent/src/types.ts:130-136(当前已新增 agentOptions 字段)
export interface SubagentCapabilities {
	readonly agentOptions: boolean
	readonly outputSchema: boolean
	readonly depthLimit: boolean
	readonly toolFilter: boolean
	readonly persona: boolean
}
```

这五个字段分别对应"能不能给这个子代理单独覆写 provider/model/推理强度/输出 token 上限这类 Agent 选项""能不能约束子代理必须以某个 JSON Schema 结束""能不能强制一个最大递归深度""能不能限制子代理可用的工具集""能不能覆写子代理的人设(persona)"。`agentOptions` 是相对课程写作时新增的一个能力位——同进程 Provider 会把这份覆写合并到父 Agent 的选项之上再创建子代理,`subagent-dsh-sdk` 则合并到它自己那套独立 harness 实例的默认路由上,而 ACP/Codex/Claude Code 这三个"驾驶别人的车"的 Provider 直接拒绝这个字段(它们没有能力把 provider/model 覆写透传给被驾驶的外部进程)。这组能力检查在真正调用 `provider.start()` 之前就会做——如果调用方要求某个能力而当前 Provider 不支持,请求会直接失败,而不是等子代理跑完了才发现结果格式不对。

`SubagentProvider` 接口本身也多了一个可选字段 `agentRouteDefaults?: Readonly<{ provider: string; model: string }>`——供 Provider 声明一个"静态的、与父代理无关"的默认路由(比如 `subagent-dsh-sdk` 拉起的独立 harness 实例有自己的默认模型),消费方在真正下发请求前,会把这份默认值和调用方传入的 `agentOptions` 覆写做合并。

子代理跑起来之后,拿到的句柄类型是 `SubagentRun`:

```typescript
// packages/subagent/subagent/src/types.ts:308-334(节选)
export interface SubagentRun {
	readonly id: SessionId
	readonly localAgent: Agent | undefined
	readonly result: Promise<SubagentResult>
	dispose(): Promise<void>
}
```

注意这里没有 `send()`/`interrupt()`/`list()` 这类方法——**一次性子代理的句柄只负责"等结果"和"清理"**。父代理想给已经在跑的后台子代理发消息、打断它、或者列出自己有哪些子代理,走的是另一套服务级 API(`SubagentRuntime` 上的 `sendMessage()`/`interrupt()`/`listChildren()`),这些方法在下文"父子双向通信"一节详细展开。这个设计选择本身就是一个提示:一次性委派(fire-and-wait)和可续接的后台委派(fire-and-control),在 dsh 里被认为是两种不同强度的关系,不该塞进同一个句柄接口里。

### 会话身处何方:`SessionHeader` 与 `delegationDepth`

子代理终究是一个普通会话(Session),只是它的 `SessionHeader` 多带了几个字段来记录血缘:

```typescript
// packages/core/session/src/types.ts:94-131(节选,字段随版本演进,以下为当前实际字段)
export interface SessionHeader {
	readonly version: typeof SESSION_FORMAT_VERSION
	readonly id: SessionId
	readonly createdAt: number
	readonly cwd?: string
	readonly parentSession?: SessionId
	readonly isSeeded: boolean
	readonly origin?: 'subagent'
	readonly delegationDepth?: number
	readonly agentPreset?: string
}
```

> **一个已验证的实现细节变化**:早期版本里这个字段叫 `seedLength?: number`,直接把"种子历史有多长"这个数字持久化进会话头;当前版本已经把它简化成一个布尔字段 `isSeeded`——头里只记录"这个会话是否带了 fork 继承来的历史前缀",具体前缀有多长被下放成了"Session 状态"而不是头部元数据的一部分。这是一处很典型的"头部只留粗粒度、可复用的判定字段,细节挪到别处"的收窄。

- `parentSession`——这个会话是从哪个会话派生出来的(种子血缘),顶层会话没有这个字段。
- `origin === 'subagent'`——一个粗粒度的产品分类标记,说明"这个会话是作为子代理创建的"。源码注释特别强调:*这只是展示层(navigation)的元数据,不是"这个子代理可续接"的证明*——模式与续接能力的权威依据是子会话日志里的 `subagent/descriptor` 描述符(见下文),运行时再往上追一层,就是看创建它的 Provider 有没有实现 `prepareContinuable()`。
- `delegationDepth`——顶层会话缺省为 0,子代理是父深度 + 1。之所以要把它**持久化**进会话头,而不是只在运行时内存里记一个计数器,是因为"递归预算必须扛得住重启和续接"——如果子代理被挂起后台、进程重启、之后再被唤醒,它得记得自己原来在第几层,不能因为重启就"洗白"成顶层会话。

深度的读取逻辑体现了这一点,在 `packages/subagent/subagent/src/depth.ts` 里:

```typescript
// packages/subagent/subagent/src/depth.ts:28-36
export function delegationDepthOf(agent: Agent): number {
	const runtime = agent.options.subagentDepth
	if (runtime !== undefined && (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))) {
		throw new TypeError('agent subagentDepth must be a non-negative safe integer')
	}
	// The header value was validated at the session boundary (creation and
	// persistence load both construct through the store).
	return Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0)
}
```

这里的 `Math.max(持久化的 header 值, 运行时选项)` 是一个很值得注意的小设计:深度只能被**运行时选项加深,不能被它调浅**。这防止了一种作弊路径——一个被冷启动恢复的子代理,如果单纯从运行时选项里读深度(而运行时选项在恢复时是全新构造的、默认可能是 0),就会被当成顶层会话,从而绕开递归预算重新无限委派下去。用持久化值做"下限",运行时值只能"追加深度",堵住了这条路。

真正的深度上限检查发生在创建子代理时,`packages/subagent/subagent/src/child-agent.ts`:

```typescript
// packages/subagent/subagent/src/child-agent.ts:50-59
export function resolveChildDepth(parent: Agent, maxDepth: number | undefined): number {
	const childDepth = delegationDepthOf(parent) + 1
	if (!Number.isSafeInteger(childDepth)) {
		throw new RangeError('subagent child depth exceeds the safe-integer range')
	}
	if (maxDepth !== undefined && childDepth > maxDepth) {
		throw new SubagentDepthError(childDepth, maxDepth)
	}
	return childDepth
}
```

值得强调的是:**全局代码里搜不到一个叫 `MAX_DELEGATION_DEPTH` 的常量**——深度上限完全是"每个工具实例自带配置、调用方自己传"的,不是全局硬编码。`tool-subagent` 的 `maxDepth` 配置项如果省略,会在**每次委派时**通过 `ctx.subagents.resolveMaxDepth()` 去读 Host 级 `SubagentRuntime` 的当前深度设置(`packages/subagent/subagent/src/index.ts` 的 `Config.maxDepth`,一个 volatile 配置,**默认 1**;同一处还有一个 `maxActiveSubagents` 容量上限,默认 8)——也就是说顶层会话默认只允许再往下派一代,想加深得由部署方或用户显式调大;而所有走外部进程的 Provider(ACP/Claude Code/Codex/dsh-sdk)都声明 `depthLimit: false`,这意味着如果用这些 Provider 配置 `subagent` 工具,部署方必须显式把 `maxDepth` 设成字符串常量 `'provider-managed'`——含义是"深度预算由子代理自己那套 harness/产品去管,父层不插手"。

子代理创建时,`origin`/`delegationDepth`/`parentSession` 会一起写进子会话头,`packages/subagent/subagent/src/child-agent.ts` 里的 `childSessionMeta()`:

```typescript
// packages/subagent/subagent/src/child-agent.ts:146-156（节选,当前实际实现,已同步 isSeeded 改动)
return {
	...(parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {}),
	...(agentPreset === undefined ? {} : { agentPreset }),
	parentSession: parentHeader.id,
	isSeeded,
	origin: 'subagent',
	delegationDepth: childDepth,
}
```

后续列举"某会话的直接子代理"用的已经不是全仓库扫描,而是**父会话自己日志里的一份目录**。每次子代理建立时,运行时会往父会话追加一条 `subagent/catalog` 事件(one-shot 路径在 `packages/subagent/subagent/src/index.ts:574`、continuable 路径在 `continuation.ts:184`,最终都落到 `catalog.ts` 的 `establishCatalogChild(parent.session, child.header, descriptor)`),这条事件再被折叠成父会话上的 `subagentCatalog` 投影。于是直接子代理解析变成一次纯父会话的 O(1) 观察,`packages/subagent/subagent/src/list-children.ts`:

```typescript
// packages/subagent/subagent/src/list-children.ts:67-90（节选）
export async function listChildren(
  ctx: Context,
  parentSessionId: SessionId,
  signal?: AbortSignal,
): Promise<SubagentCatalogEntry[]> {
  const query = ctx.get('sessionQuery')
  // ...
  using parent = await query.observeSession(parentSessionId, { ... })
  const entries = parent.projections?.values.subagentCatalog
  if (entries === undefined) {
    throw new SubagentError('listing subagents requires the registered subagentCatalog projection', ...)
  }
  return entries
}
```

目录条目就是 `catalog.ts` 里的事件载荷:`{ childId, childCreatedAt, mode, label? }`,其中 `mode` 取 `'one-shot' | 'continuable' | 'unknown'`(`unknown` 专留给 V3→V4 会话格式迁移——`packages/session/session-format-v3-to-v4/` 会为历史子代理从它们自己日志里的 `subagent/descriptor` 证据回填 catalog 事实);continuable 条目必带 `label`(即委派时的 `description`),one-shot 的 `label` 可选。这个"父方持有目录"的设计有两个好处:列举不打开任何子代理日志(冷会话不用被唤醒);fork 出来的子代理不会因为它自己也携带一份种子前缀而被父方的 fork 继承逻辑误判——投影折叠时直接用 `event.seq < inheritedEventCount` 丢掉 fork 种子里的继承事实。

而跨代的整树枚举 `listDescendants()` 仍然保留完整语料库遍历:先用 header 里的 `parentSession` 关系把整个会话树串起来,再对每个候选读子会话的身份投影——它由**子代理自己日志**里的 `subagent/descriptor` 事件折叠而成(`descriptor.ts`,`SUBAGENT_DESCRIPTOR_VERSION = 3`,可续接描述符还持久化了 provider/model/推理强度/persona/工具过滤这些恢复组合所需的字段)。读不动的子代理不会让整个列举失败,而是降级成一行 `{ kind: 'diagnostic', reason: 'corrupt' | 'unavailable' }`。

### 六种委派后端:从同进程 fork 到外部 CLI 子代理

`SubagentProvider` 这一层契约之下,dsh 目前提供六个具体实现,分布在 `packages/subagent/subagent-*` 六个独立包里。它们的差异全部体现在"用什么机制建立子代理进程/会话",而对上层(`tool-subagent`)完全透明。

| Provider 包 | 机制 | 子代理能看到父会话历史? | 典型场景 |
|---|---|---|---|
| `subagent-fork-in-process` | 同进程内创建新 Agent,种子(seed)填父会话已完成的对话轮次 | 是(`inheritsParentContext: true`) | 便宜的同进程委派,子代理需要知道"我们刚讨论到哪儿了" |
| `subagent-spawn-in-process` | 同进程内创建新 Agent,不填任何种子 | 否 | 最便宜的传输,独立子任务,不需要对话上下文 |
| `subagent-in-process-driver` | 不是 Provider,是前两者共享的底层驱动函数 | — | — |
| `subagent-acp` | 拉起任意外部可执行文件,用 Agent Client Protocol 在 stdio 上驱动 | 否 | 驱动任意"会说 ACP"的远程编码 Agent,不锁定具体产品 |
| `subagent-claude-code` | 通过官方 `@anthropic-ai/claude-agent-sdk` 拉起真实 `claude` CLI | 否 | 把任务委派给 Claude Code 本尊 |
| `subagent-codex` | 拉起 `codex app-server --stdio`,手写 JSON-RPC 协议驱动 | 否 | 把任务委派给 Codex 本尊 |
| `subagent-dsh-sdk` | 拉起另一整套完整的 dsh harness(自己的 `cordis.yml`/模型路由/工具集),用 dsh 自己的 SDK 协议驱动 | 否 | 递归跑一个完全独立配置的 dsh 对等实例(自测/dogfood SDK 本身) |

**fork 与 spawn 的全部差异只是"要不要塞种子"。** `subagent-fork-in-process` 的核心逻辑(`packages/subagent/subagent-fork-in-process/src/index.ts`):

```typescript
// packages/subagent/subagent-fork-in-process/src/index.ts:48-83（节选）
function completedTurnPrefix(parent: Agent): SessionEvent[] {
  const events = parent.session.snapshotEvents()
  const lastEnd = events.findLast(e => e.type === 'turn/end')
  if (lastEnd === undefined) return []
  // seq === array index (the append contract), so slice up to and including it.
  return events.slice(0, lastEnd.seq + 1)
}

class ForkInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  readonly inheritsParentContext = true

  start(request: ResolvedSubagentStartRequest) {
    const seed = completedTurnPrefix(request.parent)
    return startInProcessRun(request, {
      // 只有真的存在已完成轮次才传 seed;空 seed 等价于白板子代理
      ...seed.length > 0 ? { seed } : {},
    })
  }

  prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    // fork 前缀只在创建时截取一次:它会成为子代理自己日志的一部分,
    // 之后的冷恢复回放这份前缀,而不是重新去 fork 父代理更新的历史
    const seed = completedTurnPrefix(request.parent)
    return Promise.resolve(seed.length > 0 ? { seed } : {})
  }
}
```

`completedTurnPrefix` 只截取父会话**已经完成的对话轮次**(找到最后一个 `turn/end` 事件为止),而不是把当前这个还在进行、工具调用还没配对完的轮次也塞进去——一个未完成的轮次(比如模型刚发起了工具调用但结果还没回来)直接塞给子代理会导致上下文里出现"悬空"的工具调用,子代理看不懂。

`subagent-spawn-in-process` 几乎是同一份代码,唯一区别是不传种子:

```typescript
// packages/subagent/subagent-spawn-in-process/src/index.ts:41-65（节选）
class SpawnInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  readonly inheritsParentContext = false

  start(request: ResolvedSubagentStartRequest) {
    // 白板子代理:不传 seed。共享驱动负责铸 id、盖 cwd/血缘/深度章、驱动一次性运行并映射结果
    return startInProcessRun(request, {})
  }

  prepareContinuable(): Promise<ContinuableCreateSpec> {
    // spawn 的孩子天生白板,对 continuable 组合没有任何贡献
    return Promise.resolve({})
  }
}
```

而 `startInProcessRun` 这个共享函数本身,住在第三个包 `subagent-in-process-driver` 里——**这个包本身不注册任何 `SubagentProvider`**,它只导出一个函数。模块文档写得很直白:"深度解析、子代理创建、可选的子代理定制、结果读取、取消、清理——这些逻辑只在这里实现一次;fork 只是多传了父会话已完成的对话前缀。" 这是一个典型的"两个薄 Provider 共享一个厚驱动"的结构:避免 fork/spawn 在深度校验、结果读取、资源清理这些容易出错的细节上各写一份还可能出现行为漂移。

外部进程类的三个 Provider,机制各不相同但目标一致——把"外部产品的子进程"伪装成一个符合 `SubagentProvider` 契约的子代理:

`subagent-acp` 用官方 ACP SDK 在子进程的 stdio 上跑 ND-JSON:

```typescript
// packages/subagent/subagent-acp/src/index.ts(节选)
const conn = new ClientSideConnection(
	makeClient,
	ndJsonStream(
		NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
		NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
	),
)
await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
const session = await conn.newSession({ cwd: spec.cwd, mcpServers: [] })
const promptResult = await conn.prompt({ sessionId: remoteSessionId, prompt: toAcpPrompt(request.prompt) })
```

`subagent-claude-code` 没有自己拼协议,而是复用官方 SDK 的 `query()`,但把 SDK 内部"怎么拉起子进程"这一步接到了 dsh 自己统一的子进程管理服务上:

```typescript
// packages/subagent/subagent-claude-code/src/run.ts(节选)
query = officialQuery({
	prompt,
	options: claudeQueryOptions(spec, controller, (captured) => { child = captured }),
})
// claudeQueryOptions() 里:
spawnClaudeCodeProcess: (options: SpawnOptions) => {
	const child = spec.spawn(claudeSpawnSpec(options, spec.disposeGraceMs))
	capture(child)
	return new ManagedClaudeCodeProcess(child)
},
```

这样一来,真实的 `claude` 进程虽然是 SDK 帮忧拉起来的,但它的生命周期(环境变量清理、进程树级联清理)统一纳入了 dsh 自己的子进程管理体系,不会因为用了外部 SDK 就绕开 dsh 的资源治理。

`subagent-codex` 则完全没有现成 SDK 可用,是手写的一套 JSON-RPC 客户端,拉起 `codex app-server --stdio` 之后走 `initialize → initialized → thread/start → turn/start → 等待 turn/completed`:

```typescript
// packages/subagent/subagent-codex/src/wire.ts(节选,CodexAppServerWire.runTurn())
const response = object(await this.guarded(this.transport.request('turn/start', {
	threadId,
	input: texts.map(text => ({ type: 'text', text, text_elements: [] })),
}, signal), signal), 'turn/start response')
```

`subagent-dsh-sdk` 最特别——它拉起的不是别的产品,而是**另一整套完整的 dsh harness**(自己的 `cordis.yml`、自己的模型路由、自己的工具集、自己的会话持久化),通过 dsh 自己的 SDK 客户端驱动:

```typescript
// packages/subagent/subagent-dsh-sdk/src/run.ts(节选)
const harness = new DeepSeekHarness({
	launch: { command: spec.command, args: spec.args, cwd: spec.cwd, env: {...}, shutdownTimeoutMs, disposeEofGraceMs, disposeGraceMs },
	cwd: spec.cwd, provider: spec.provider, model: spec.model,
})
await harness.start()
const turn = await harness.session(childSessionId).run(request.prompt, { onNotification: observe })
```

这与包装外部 CLI 的三个 Provider 有本质区别:那三个是"驾驶一辆别人造的车",这个是"造一辆完全独立、可能配置迥异的新车,让它自己跑"——子 harness 有自己决定的组合、自己的会话持久化、自己的模型路由,完全是一个对等的独立个体,只是它的启停被父进程当作子代理来管理。这六个外部/递归 Provider 无一例外都声明 `depthLimit: false`——它们的深度预算(如果有)由自己那套系统内部管理,dsh 父进程管不到、也不假装能管到。

### `tool-subagent`:委派工具的完整执行流程

模型真正调用的委派工具是 `packages/subagent/tool-subagent/src/index.ts`。有一个反直觉但很关键的设计:**模型在调用这个工具时,既不能选 Provider,也不能选"要不要 fork 历史"**——这些都是部署方在工具配置(`Config`)里锁定好的:

```typescript
// packages/subagent/tool-subagent/src/index.ts:48-104(节选,当前实际字段)
interface Config {
	provider: string
	toolName?: string           // 默认 'subagent'
	modelSelectionSettings?: boolean  // 相对课程写作时新增:是否采样 Host 侧"子代理模型选择"设置
	enableRunInBackground?: boolean  // 默认 true
	backgroundMode?: 'one-shot' | 'continuable'  // 默认 'one-shot'
	agentOptions?: AgentOptions
	persona?: string
	toolFilter?: { allow?: string[]; deny?: string[] }
	maxDepth?: number | 'provider-managed'   // 省略时每次委派读取 Host 级子代理深度设置(默认 1)
}
```

`modelSelectionSettings` 是相对课程写作时新增的一个配置项:开启后,每个新建的**顶层**会话会读取一次 Host 侧的 `subagent-model-selection` 设置(用户在设置面板里选的"子代理该用哪个模型"这类偏好),并把这个决定原样传给它派生出来的所有子代理会话——也就是说这个设置只在顶层会话创建时采样一次,子代理不会各自重新读取、也不会因为用户中途改了设置而"变卦"。

模型侧看到的参数只有 `description`(3~5 词的一句话描述,用于展示)、`prompt`(完整、自包含的任务描述——因为子代理很可能什么上下文都没有,任务描述必须把话说全),以及在 `enableRunInBackground` 开启时的可选 `run_in_background` 布尔值。一个例外是 LLM 路由选择:当部署开启 `modelSelectionSettings`、且 Host 侧的子代理模型选择设置为当前会话解析出一份允许路由清单(`ModelSelectionPolicy.routes`)时,工具上还会额外出现三个**可选**参数——`provider`/`model`/`reasoning_effort`——同时挂载一个伴生工具 `list_subagent_models`,让模型在委派前先查清楚允许的路由和推理强度。不传这三个参数就走继承链:配置的 `agentOptions` → 父 Agent 最新一次请求的路由(其次创建选项)→ Provider 自己的 `agentRouteDefaults`;换了路由但没显式给推理强度时,继承来的强度会被清掉、改用新模型的默认。模型自填的路由还要过两道闸——允许清单校验(`assertAllowedModelSelection`)和真实的 LLM 路由预检(`preflightChildLlmRoute`,Provider 无静态路由默认时才对父路由做兼容合并)——确保路由在子代理真正创建之前就是可用的,而不是跑起来才发现模型名是瞎编的。

一个部署可以同时挂载这个工具的多个实例,分别绑定不同 Provider(比如 `subagent`/`subagent_codex`/`subagent_claude_code`),模型看到的是几个名字不同、职责各异的委派工具,而不是一个带"选择 Provider"参数的万能工具——这样可以避免模型因为参数组合过多而"选错搭配"。

`execute()` 的调度逻辑会依据"续接模式"和"要不要后台"走三条完全不同的路径:

- **可续接 + 后台**(`ctx.subagents.startContinuable(...)`)——立即返回 `{ kind: 'continuable', subagentId }`,**不等子代理跑完这一轮**,后续通过 `send_message`/`interrupt_agent`/`list_agents` 去操控它。
- **一次性 + 后台**——包成一个 `ctx.jobs` 任务,异步跑,父代理可以先干别的,之后再来查任务状态。
- **前台(one-shot 的默认行为)**——直接 `await ctx.subagents.start(...)`,父代理这一步工具调用就会一直挂起,直到子代理跑完。

前台路径的收尾逻辑值得单独看一下,因为它体现了"无论成功失败都要清理资源"的原则:

```typescript
// packages/subagent/tool-subagent/src/index.ts:208-238(节选,settleForegroundRun 的当前实现)
async function settleForegroundRun(run: SubagentRun): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) {
        // 登记处会把这个 throw 转成 isError;部分输出不算成功,但会随错误一起回到父代理
        throw new Error(withDiagnosticAndPartialText(error, result))
      }
      return { kind: 'foreground', runId: run.id, output: result.output as unknown as JsonValue[] }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError([execution.reason, disposal.reason], '...')
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}
```

这段代码已经从早先的 `try { await run.result ... } finally { run.dispose() }` 改成了 `Promise.allSettled` 双结算结构:执行(取结果 + 映射错误)和释放(`dispose`)被**独立**结算,任何一边的失败都不会盖掉另一边的失败——两边都失败时抛出一个 `AggregateError` 把两个原因都带上;执行失败始终优先原样抛出,与它并行的释放失败则单独抛出。这与第一篇讲工具调用机制时"任何异常都要转换成正常的工具结果反馈给模型"是同一条设计哲学的延伸:正常收尾的子代理产出 `output`,非正常收尾的子代理产出 `stopReasonError()` + 诊断文本 + 部分输出,释放阶段的清理失败则绝不能被静默吞掉。

### 父子双向通信:两类消息源,一条血缘授权

父子代理之间的通信被拆成了两类**故意分开**的持久化消息来源,而不是合并成一条"消息总线"。理解这个拆分,是理解整套委派模型的关键。

**信道一:模型自主消息与主动控制,`tool-subagent-control`。** 这个包里注册了三个独立的工具(而不是一个带 `action` 参数的调度工具):`send_message`、`interrupt_agent`、`list_agents`。

`send_message`(`packages/subagent/tool-subagent-control/src/index.ts:28-74`)现在是**相邻 Agent 之间的双向**消息:父代理用它投递给直接的可续接子代理;一个常驻的可续接子代理也可以用它回投给自己的直接父代理。工具实现只是 `ctx.subagents.sendMessage()` 的薄壳,血缘授权完全下沉在服务里——服务端会拿"精确的活体发送者 Agent"去比对目标会话记录的血缘,相邻关系不成立就直接拒收:

```typescript
// packages/subagent/tool-subagent-control/src/index.ts:60-73(节选)
async execute(args, exec) {
  const sender = exec.agent
  if (!sender) {
    throw new Error('send_message requires a calling agent (exec.agent was undefined)')
  }
  const message: ContentBlock[] = [{ type: 'text', text: args.message }]
  const messageId = await ctx.subagents.sendMessage(
    sender,
    brandString<SessionId>(args.agent_id),
    message,
    { signal: exec.signal },
  )
  return { messageId }
}
```

投递语义在 `SubagentRuntime.sendMessage()`(`packages/subagent/subagent/src/index.ts:279-286`)的文档注释里写得很清楚:目标正在跑,消息在它**最近的步边界**插入、起到引导(steer)作用;目标空闲,消息直接为它开启或续上一轮;目标是个已被卸载的直接子代理,则先**从持久化冷恢复**再投递。这个调用只返回消息被收件箱接受的 `messageId`,**不会等对方的回答**——"失败"意味着消息压根没送达,而不是"对方没回话"。消息落到接收方会话里时,来源被持久化为 `{ kind: 'agent-message', form: 'relay', senderSessionId }`(`continuation-messages.ts` 的 `createAgentMessage()`)——一句话,谁说的、什么语义,都钉在会话记录里。

`interrupt_agent`(同文件 76-116)则是真正的"打断"——目标不仅限于直接子代理,也可以是更深一层的子孙代理;它只打断目标**当前这一轮**:已经排队的消息会继续停着,目标自己启动的子代理继续跑,目标本身之后仍可被 `send_message` 唤醒:

```typescript
// packages/subagent/tool-subagent-control/src/index.ts:105-115(节选)
execute(args, exec) {
  const caller = exec.agent
  if (!caller) {
    // 祖先授权要求一个精确的活体调用方 Agent
    throw new Error('interrupt_agent requires a calling agent (exec.agent was undefined)')
  }
  // 服务端拿精确的活体调用方去比对目标记录的血缘;工具自身不加任何授权
  ctx.subagents.interrupt(brandString<SessionId>(args.agent_id), { kind: 'ancestor', agent: caller })
  return Promise.resolve({ accepted: true })
}
```

`list_agents`(独立文件 `packages/subagent/tool-subagent-control/src/list-agents.ts`)支持 `scope: 'children' | 'descendants'` 两档:`children` 直接读上文说的父方 catalog 投影,`descendants` 走完整语料库遍历并给每行标注直接父会话 id 和深度;两档都**只投影可续接的子代理**给模型——一次性子代理跑完就没了,模型压根不会去选它们。状态口径也值得注意,`statusOf` 现在只返回两态:

```typescript
// packages/subagent/tool-subagent-control/src/list-agents.ts:55-57
function statusOf(agents: { get(id: SessionId): Agent | undefined }, id: SessionId): 'running' | 'inactive' {
  return agents.get(id)?.status === 'running' ? 'running' : 'inactive'
}
```

`inactive` 故意**不区分**"加载着但没在跑"和"已被卸载、可被冷恢复"——工具描述里专门叮嘱模型:inactive 不代表任务完成、成功、失败或在等别的 Agent,那只是"此刻没有在执行的轮次"。

**信道二(已重构):子 → 父的汇报,复用同一条相邻消息。** 早期版本里有一个专门的 `report` 工具和独立的 `tool-subagent-report` 包,靠"只在可续接子代理的作用域里注册"来实现可见性隔离。**这套东西现在已经整个移除了**——包里搜不到 `tool-subagent-report`,`ctx.subagents` 上也没有 `reportFrom()`/`registerContinuableSetup()` 了。取而代之的是一个更简单的安排:可续接子代理的初始任务会被拼上一段固定的"回路指引"(`withContinuableReturnGuidance`,`continuation-messages.ts:81-97`),把父代理的会话 id 直接写进任务文本,告诉子代理"收工之前用 `send_message({ agent_id: <父id>, message: '<自包含的结果>' })` 把结果发回去;中途有能改变父方下一步决策的发现,也可以随时发——发消息不会结束你这一轮"。也就是说,子→父的汇报现在就是同一条 `agent-message` 的反方向使用,不再需要专属工具;当年"仅子级可见"的隔离诉求,则由 `sendMessage` 的血缘相邻校验接管——子代理能回话的对象天然只有它的直接父代理,越层的地址在服务侧就拒了。

**信道三:运行时 → 父的强制结算通知。** 这条信道不由子代理的意愿决定——当一个可续接子代理的 Activation(运行实例)结算(settle)时,运行时会**无条件**通知父代理它是怎么结束的。这条通知的来源被刻意标成另一种 kind——`{ kind: 'subagent-settled', form: 'notice', summary, senderSessionId }`(`continuation-messages.ts:30-38`),和 `agent-message` 泾渭分明:*绝不能让会话记录看起来像是子代理自己说了某句话,而那句话其实是运行时代它说的*。通知的正文由 `createSettlementMessage()`(同文件 135-160)组装:先按 `stopReason` 生成一行结案陈词("finished and will do no further work unless you send it more" / "was stopped before it finished" / "ran out of room" / "declined the task" / "failed"……),再附上子代理最后的助手收尾文本(没有就明说 "It left no closing message.")。委派工具的描述里还专门向模型承诺了这条通知的存在——"后台运行结算时,运行时会给你发一条包含结果和最终助手消息的通知"——所以模型知道自己**不需要轮询**子代理的状态。

把两条消息源放在一起看:`agent-message` 是模型自主、相邻双向、可 steer 可 queue 的消息;`subagent-settled` 是运行时强制、单向、绝不漏发的兜底通知。它们共用同一套底层的收件箱投递机制,却被明确赋予了不同的持久化来源,这样任何一方在回放会话历史时,永远能分清楚"这句话是哪个 Agent 自己说的""这句话是运行时替谁说的"。

### 权限作用域:委派不能被用来越权

子代理的权限不是"继承父代理当前的权限设置",而是在委派发起的那一刻被**永久固定**下来,之后无法从子代理内部再放宽。这一点通过在每个同进程子代理的系统提示里注入一段固定文案来强制模型知晓边界:

> "You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically..."

配合"每个子代理只会认识一个全新的、扁平的注册作用域"——子代理不会自动继承父代理注册过的服务或者放宽过的沙箱例外,只会继承(a)对话历史(仅 fork,且仅限已完成轮次)和(b)父代理所在的 Agent Preset 组合出来的工具集。上下文、工具、权限这三个维度各管各的、互不含混,是理解"子代理到底看得到什么、能做什么"时最容易被忽略、却最值得记住的一条设计线。

## 小结与思考题

委派链路可以归纳为:**模型调用 `tool-subagent` → 工具按部署配置选定 Provider → `SubagentProvider.start()` 用六种机制之一建立子代理,写入 `delegationDepth`/`parentSession`/`origin` 血缘记录、并在父会话日志里追加 `subagent/catalog` 目录事实 → 子代理在被永久固定的权限范围内运行 → 通过两类消息源(模型自主的 `agent-message` 与控制工具、运行时强制的 `subagent-settled` 结算通知)与父代理交互 → 结果或错误统一封装回父代理的工具结果**。深度预算靠"持久化下限 + 运行时只能追加"防止被重启/续接绕开;直接子代理的发现靠"写入时往父日志追加目录事件"替代"读取时全仓库扫描",`send_message` 的隔离靠服务端血缘相邻校验替代"工具可见性",这三处都是"用结构性约束替代运行时检查"的例子。

思考题:

1. 如果你要新增一个 `subagent-docker` Provider(在隔离容器里跑一个完全独立的编码环境),按照 `SubagentProvider` 契约,你至少要实现哪个方法?`inheritsParentContext` 应该填 `true` 还是 `false`?`capabilities.depthLimit` 呢——容器内部还能不能继续无限委派下去,这件事该由谁来保证?
2. 直接子代理的发现从"全仓库扫描 `parentSession`/`origin` 两个 header 字段"改成了"父会话日志里的 `subagent/catalog` 事件 + 投影"。这个新机制在冷会话很多时省掉了什么开销?它把哪些正确性负担从"读取方"转移到了"写入方"?V3→V4 迁移里 `mode: 'unknown'` 的回填为什么是必要的?
3. 子→父的汇报从一个"只在子代理作用域里注册"的专属 `report` 工具,改成了"回路指引 + 全局 `send_message` + 服务端血缘相邻校验"。这两种隔离手段各自的失效模式是什么?如果一个子代理的初始任务被人篡改、回路指引丢失,新模型下父代理还收得到汇报吗?老模型下呢?
