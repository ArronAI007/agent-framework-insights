# Workflow 引擎与 Ralph 循环

> 一次委派解决"分一个任务出去",但如果任务需要"先跑三个子代理探路,再挑一个结果继续深入,期间还要动态决定要不要多开几路"呢?靠模型在对话里手动一次次调用委派工具来编排,既费 token 又容易在多轮之间丢状态。dsh 的解法是让模型直接写一段 JavaScript 编排脚本,交给一个专门的 `ctx.workflowEngine` 去跑——脚本本身持有循环、分支、并发逻辑,只在需要真正干活时才调用 `agent()` 桥接回宿主进程里的真实子代理。**这一篇的执行层描述已根据最新源码更新**:课程写作时,唯一的引擎实现是自建的 worker_threads + `node:vm` 双层隔离;当前版本已经把执行层整体迁移到一个新的、被多个子系统共享的沙箱化子进程执行引擎 `ctx.ptcRuntime`(PTC Runtime)之上——这不再只是"遏制"(containment),而是真正接上了 `ctx.sandbox`/`ctx.subprocess` 这套 OS 级沙箱与进程治理体系。本篇按当前实现重新讲清楚这套隔离机制的分层,以及它与"每轮启动全新子代理"的 Ralph 循环之间的关系。

## 学习目标

- 理解 `ctx.workflowEngine` 作为一个 Cordis 服务抽象只暴露一个 `start()` 方法(这一点自课程写作以来没有变化),以及具体实现 `workflow-ptc` 如何通过声明式组合(`cordis.yml`)绑定到这个服务位。
- 掌握当前的执行隔离结构:脚本运行在一个全新的、由 `ctx.ptcRuntime` 启动的**独立 Node 进程**里,进程通过与 `bash` 工具共享的同一个 `ctx.sandbox` Provider 应用 OS 级沙箱策略,生命周期交给 `ctx.subprocess` 统一治理;进程内部仍然用 `node:vm` 做一层价值物化(materialize)上的保护,但真正的安全边界已经上移到"进程 + OS 沙箱"这一层,不再是"仅遏制、非安全边界"。
- 弄清脚本里的 `agent()` 调用如何跨越进程边界,真正触达宿主进程里的 `ctx.subagents`——这条通信走的是一条独立于程序 stdout/stderr 的专用二进制控制通道,协议角色和课程写作时的 worker `postMessage` 版本类似,但载体已经从"同进程 worker 的 MessagePort"变成了"跨进程的受管道"。
- 理解这套沙箱化 PTC 执行引擎为什么会被 workflow 和其他多个子系统(工具执行、fs、ssh 等)共享——这是一次明确的架构收敛:课程写作时"各自独立实现、不共享代码"的 Code Mode 沙箱(`code-runtime` 包)已经不存在了,它的职责被合并进了同一个 `ptc-runtime` seam。
- 理解 `tool-ralph`"每轮启动全新子代理"的设计动机——用共享工作区 + 一份小的结构化交接报告,在杜绝上下文污染的同时仍然让进度可以累积(这部分工具层逻辑基本没有变化)。

## 背景与设计动机

模型如果想要"编排"多个子代理协作,最朴素的做法是在对话里一步步来:调用委派工具、看结果、再调用下一个委派工具……这种做法有两个明显问题:每一步的中间状态(比如"已经启动了几个子代理""它们分别返回了什么")都要塞进对话上下文里反复重述,token 开销随委派次数线性增长;而且编排逻辑(循环、条件分支、并发调度)本质上是**程序逻辑**,用自然语言一步步驱动天然低效。

dsh 的解法是承认这一点,直接让模型把编排逻辑写成一段真正的 JavaScript——这段脚本不活在对话历史里,而是被交给一个独立的运行时去执行,脚本自己持有循环变量、累积结果,只有在真正需要"叫一个子代理做事"的地方,才通过几个受限的全局函数(`agent`/`parallel`/`pipeline`)桥接回宿主进程发起真实的委派。这个思路与 Claude Code 自己的 "dynamic workflows" 特性是同源的——dsh 的设计文档直接承认了这一点,`meta` 元数据块的词汇表也刻意保持了兼容。

## 核心机制详解

### `ctx.workflowEngine`:一个只有一个方法的服务抽象

整套 workflow 体系构建在 Cordis(dsh 的服务/依赖注入框架,详见第七篇下半部分)之上。`packages/workflow/workflow/src/index.ts` 声明了这个服务位并定义了抽象类:

```typescript
// packages/workflow/workflow/src/index.ts:31-34
declare module '@deepseek-ai/cordis' {
	interface Context {
		workflowEngine: WorkflowEngine
	}
}
```

```typescript
// packages/workflow/workflow/src/index.ts:157-168
export abstract class WorkflowEngine extends Service {
	constructor(ctx: Context) {
		super(ctx, 'workflowEngine')
	}

	/**
	 * Parse and execute a workflow script.
	 * @param request - the script, its `args`, the parent agent, and an
	 *   optional cancel signal.
	 * @returns the live run; its `result` resolves when the script settles.
	 */
	abstract start(request: WorkflowStartRequest): WorkflowRun
}
```

`ctx.workflowEngine` 故意做得极简——**只有一个方法** `start()`。没有"列出所有运行中的工作流""按 id 停止某个工作流"这类管理 API,因为控制权完全交给调用方拿到手的句柄 `WorkflowRun`(`packages/workflow/workflow/src/runtime-types.ts:40-49`):

```typescript
export interface WorkflowRun {
	readonly id: WorkflowRunId
	readonly meta: WorkflowMeta
	readonly result: Promise<WorkflowResult>
	cancel(reason?: string): void
	dispose(): Promise<void>
}
```

`result` 这个 Promise **永远不会 reject**——任何失败都会 resolve 成一个带 `stopReason: 'cancelled' | 'error'` 的 `WorkflowResult`,这与第一篇讲工具异常处理时"永远把异常转成正常结果反馈给模型"的原则一脉相承。运行时的生命周期通过六个 Cordis 事件(`workflow/start`/`/phase`/`/log`/`/agent-start`/`/agent-end`/`/end`)对外广播,这些事件只携带数据快照,从不把活的 `WorkflowRun` 对象泄露出去——观察者永远只能看,不能拿着事件里的对象反向操控运行。

`ctx.workflowEngine` 的绑定不是硬编码在某个中心化的注册表里,而是普通的 Cordis 插件声明式组合。**当前**实现包是 `workflow-ptc`(课程写作时的实现包叫 `workflow-worker-thread`,已被取代),通过继承来"认领"这个服务位,机制不变,只是底层执行方式换了:

```typescript
// packages/workflow/workflow-ptc/src/index.ts(节选,当前实现)
// class 通过 extends WorkflowEngine 认领 ctx.workflowEngine 服务位,
// 构造函数里调用 super(ctx, 'workflowEngine')
```

因为它 `extends WorkflowEngine`(其构造函数调用了 `super(ctx, 'workflowEngine')`),只要这个插件被加载进 Cordis 上下文,`ctx.workflowEngine` 就自动指向了它。真正的装配点是一份声明式的组合文件,例如:

```yaml
- id: workflow-ptc
  name: '@deepseek-ai/dsh-workflow-ptc'
  config:
    provider: spawn

- id: tool-workflow
  name: '@deepseek-ai/dsh-tool-workflow'

- id: tool-ralph
  name: '@deepseek-ai/dsh-tool-ralph'
```

`docs/subsystems/workflow.md` 把这个设计规则说得很直接:一个 Cordis 上下文里只允许**一个**引擎实现提供 `ctx.workflowEngine`,没有按名字区分的多引擎注册表——换一个引擎实现,是在组合配置里替换掉这一行,而不是让两个引擎并存。历史上这一行确实被替换过一次:`workflow-worker-thread` → `workflow-ptc`,正是下面要讲的那次架构收敛。

### `workflow-ptc`:从"worker+vm 遏制"升级为"沙箱化子进程执行"

这是当前唯一的引擎实现,机制相对课程写作时有实质性变化。仓库里一份 2026-09-11 的架构决策记录(`.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md`)把动机写得很直接——原先的 worker 方案有一个结构性缺陷:

> "Node worker 隔离 JavaScript 状态,但不应用调用 Session 的 OS 沙箱策略。模型代码可以直接导入文件系统与子进程 API,绕过工具策略路径,即使嵌套 `tools.*` 调用受到正确检查。终止 worker 也不能证明其子进程已停止。"

也就是说,课程写作时那套"worker_threads 隔离主线程 + vm 隔离全局对象,但明确声明'这不是安全边界'"的设计,恰恰卡在了这个问题上:vm 能挡住模型代码直接碰到 host 进程里的敏感对象引用,但挡不住脚本里一句 `require('fs')` 或 `require('child_process')` 直接绕过所有工具层的策略检查。当前的解法是把整套执行下沉到一个共享的服务位 `ctx.ptcRuntime`(PTC Runtime,详见 `docs/subsystems/ptc-runtime.md`),它的隔离结构变成了两层,分工也变了:

1. **一个全新的 Node 子进程**(不是 worker 线程)——每次运行由 `dsh-ptc-runtime-node` 在一个全新进程里跑脚本,进程通过与 `bash` 工具**同一个** `ctx.sandbox` Provider 解析并应用调用会话的 OS 沙箱策略(文件系统读写限制等),进程本身的生命周期(启动、超时终止、清理)交给 dsh 统一的 `ctx.subprocess` 服务治理,而不是引擎自己管。这一层才是真正的安全边界来源。
2. **进程内部仍然用 `node:vm`**——但用途变了,不再是"隔离全局对象防止脚本碰到 host 引用",而是用于安全地"物化"(materialize)脚本抛出的值/getter 返回值,防止读取一个恶意构造的 `.stack`/`.message` 属性时触发意外的副作用代码。源码注释写得很明确:"Getters and proxy traps may execute inside the confined Node process; process isolation and cancellation belong to PTC, not the VM"(getter 和 proxy 陷阱可能在受限的 Node 进程内部执行;进程隔离和取消属于 PTC,不属于 vm)。

也就是说,"这不是安全边界"这句话不再适用于当前的执行层——当前架构里,进程边界 + `ctx.sandbox` 强制策略才是安全边界的来源,vm 只是进程内部的一个价值安全网。不过设计记录也留了一句谨慎的免责声明,值得记住:"程序成功不证明完整强制能力"(`process` 描述符与额外控制通道也不声明多租户隔离)——沙箱策略是否被完整强制执行,和程序本身有没有报错是两件独立的事,不能因为脚本正常跑完就假设沙箱一定生效了。

脚本里能调用的全局函数在当前实现里还是那五个(`agent`/`parallel`/`pipeline`/`phase`/`log`),这一点没有变化,只是它们现在是通过 PTC 的绑定(binding)机制注入,而不是直接挂在 `vm.createContext()` 的全局对象上。

### 进程与 Host 之间怎么"越境":`agent()` 如何桥接回真正的子代理

这是整套机制里最值得细看的一环——脚本运行在一个独立的沙箱化子进程里,但它调用 `agent()` 想要启动的是**宿主进程里真实的子代理**(`ctx.subagents`)。这中间必须跨越一次进程边界。课程写作时这条边界是 worker 的 `MessagePort`,当前实现换成了 PTC 运行时提供的"专用二进制控制通道"——`.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md` 里的描述是:"子进程所有者提供专用的继承式二进制控制通道,与程序 stdout/stderr 及 launcher 生命周期 IPC 分开。Host 限制帧、排队写入、待处理调用和未完成参数字节,然后在分派前验证调用身份与绑定允许列表。" 通道的角色分工和课程写作时的协议(区分"guest → host 的请求"与"host → guest 的回复/结算通知")在思路上是一致的,只是载体从"同进程 worker 的 MessagePort"变成了"跨进程的受管道",且明确写着"模型代码可以写入该通道,因此其中字节仍不可信"——host 侧不能假设从这条通道读到的字节是安全的,必须像对待任何外部输入一样校验。

`agent()` 桥接到子代理运行时的最终落点没有变——还是调用 `ctx.subagents.start(provider, { prompt, parent, signal, ... })`。**关键点也没有变**:`ctx.subagents` 只在 host 侧被触及,子进程本身没有、也永远不会拿到对它的直接引用,它手里只有一个通过受管道往返的 RPC 桩。跨这条边界传递的值仍然必须是纯 JSON——函数、Symbol、循环引用、非有限数字等都会被拒绝,这一校验现在发生在 `realm.ts` 的 `materializeFromRealm` 里(和课程写作时的文件名一致,逻辑角色也一致)。

并发和取消也是这套机制要管的事,配置项基本延续了下来:`maxConcurrentAgents`(默认按 CPU 核数自动推算,当前代码里是 `min(16, max(1, cores - 2))`)、`maxTotalAgents`(默认 1000,作为"失控循环"的兜底)、`maxItemsPerCall`(`parallel`/`pipeline` 单次调用的元素上限,默认 4096)、`syncTimeoutMs`(脚本"起始同步切片"的 vm 超时,默认 5000ms)。取消时,host 通过受管子进程发出取消信号,进程侧脚本会在下一次 `await` 处停下;如果不配合,PTC 运行时会强制结束这个受管子进程。

### 与"Code Mode"的关系:从"各自实现"到"共享同一个执行引擎"

课程写作时,dsh 里还有另一套基于 worker 线程的沙箱——`packages/code-runtime`,用于"Code Mode"(模型编写 JS 代码去程序化调用工具,而不是一次一个工具调用),和 workflow 引擎"共用同一个 Node 原语,但彼此独立实现,没有共享的沙箱/vm 工具库"。

**这个结论在当前版本已经不成立了。** `packages/code-runtime` 这个包在当前仓库里已经不存在——同样是为了解决"worker 隔离挡不住模型代码直接绕过工具策略"这个结构性问题,Code Mode 的执行也被合并进了同一个 `ctx.ptcRuntime` seam(仓库里能看到一份专门的后续设计记录 `2026-09-13-workflow-ptc-sandbox-reuse`,明确讨论了 workflow 复用这套沙箱执行能力的决策)。现在 `packages/ptc-runtime/` 是一个被相当多子系统共享的通用执行原语——不只是 workflow 和"运行代码"这类模型可见的能力,`packages/core/tools`、`packages/fs/tool-fs`、`packages/ssh/ssh`、`packages/mcp/mcp-resources` 等好几个子系统的 package.json 里都能看到对 `@deepseek-ai/dsh-ptc-runtime` 的依赖。

也就是说,dsh 在这段时间里做了一次很典型的"发现两个子系统在解决同一类问题、于是把执行层收敛成一个共享 seam"的重构:workflow 编排脚本和"模型编程式调用工具"曾经是两套独立的 worker+vm 沙箱,现在统一构建在同一个"沙箱化子进程执行引擎"之上,新增能力(比如更完整的 OS 沙箱策略强制、进程级资源限制)只需要在 `ptc-runtime` 这一层做一次,所有消费方都能受益,而不用像以前那样在每个独立实现里各自补一遍。

结论从"同一个 Node 原语,因为同一个理由被选中,但两套隔离层各自独立工程化,互不复用代码"更新为:**同一个安全缺陷(worker 挡不住绕过工具策略的直接系统调用)被发现后,两套原本独立的执行层被合并成了一个共享的、真正接入 OS 沙箱的执行引擎**。

### `tool-workflow`:模型编写 JS 编排脚本的入口

`packages/workflow/tool-workflow/src/index.ts` 是模型真正调用的工具。它要求的参数很直接:`script`(纯 JS 正文字符串,不需要写 `export const meta` 这种头部)、`meta`(单独的对象参数:`name`/`description` 必填,`whenToUse`/`phases` 可选)、`args`(可选的 JSON 对象,会作为 `args` 全局量注入脚本)。

值得一提的是 `meta` 被设计成**单独的数据参数,而不是脚本里的一段代码**——这是刻意偏离 Claude Code 那种 `export const meta = {...}` 写法的地方,原因是如果 `meta` 也是脚本的一部分,宿主就得在 worker 隔离生效之前对它求值(比如脚本里塞一个带副作用的 getter),这恰好绕开了本该保护的边界。源码里甚至专门写了一段正则检查,一旦发现脚本尝试用 CC 风格的头部,会给出明确报错而不是默默兼容。

`execute()` 的核心流程:检查调用方必须是一个真实的 Agent → 调用 `ctx.workflowEngine.start({ script, meta, args, parent, signal })` → 把工具调用自身的 `AbortSignal` 桥接到 `run.cancel()` → `await run.result` → 把非 `completed` 的 `stopReason` 统一转成一个会被上抛的 `Error` → 成功时返回 `{ runId, agentsStarted, result }` → `finally` 里永远调用 `run.dispose()`。这条收尾逻辑和上一篇 `tool-subagent` 的 `settleForegroundRun` 几乎是同一个模式的重复出现——`await` 主结果、映射失败原因、`finally` 里无条件释放资源。

### `tool-ralph`:每轮全新子代理的固定前台循环

如果说 `tool-workflow` 是"给模型一把编排的刀",`tool-ralph` 就是"用这把刀固定打磨出的一件成品工具"——模型侧只能配置两个参数:

```typescript
// packages/workflow/tool-ralph/src/index.ts(节选,参数)
// objective: string  — 必填,不可变的目标
// maxRounds: number  — 可选,受部署方 Config.maxRounds 上限约束,默认 256
```

没有 prompt 模板参数,没有停止条件参数——Provider、结构化输出 schema、循环脚本本身,统统是部署方在配置里锁死的,模型完全无法定制。核心循环是一段固定的 JS 字符串 `RALPH_SCRIPT`,走的是和 `tool-workflow` 完全同一套 `ctx.workflowEngine`/`agent()` 机制:

```javascript
// packages/workflow/tool-ralph/src/index.ts:152-176(RALPH_SCRIPT 节选)
phase('Fresh-agent rounds')
for (let round = 1; round <= args.maxRounds; round += 1) {
	const prior = previous === undefined ? '(none — this is the first round)' : JSON.stringify(previous)
	const prompt = [
		'You are one fresh worker in a foreground Ralph loop. You receive no parent conversation and no prior child session. Do not call the ralph tool: this round already is its worker.',
		'Immutable objective:\n' + args.objective,
		'Ralph round: ' + round + ' of ' + args.maxRounds + '.',
		'The shared workspace and its current working tree are the long-term memory and source of truth. Inspect them before acting, preserve existing work, perform concrete in-scope work, and verify what you change. Treat the previous report only as a bounded handoff; confirm it against the workspace.',
		'Previous structured handoff:\n' + prior,
		'Return one report with exact normalized strings. ...',
	].join('\n\n')
	const rawReport = await agent(prompt, { label: 'Ralph round ' + round, phase: 'Fresh-agent rounds', schema: reportSchema })
	if (rawReport === null) {
		return { status: 'round-failed', roundsStarted: round, lastReport: previous ?? null }
	}
	const report = validateReport(rawReport)
	if (report.status === 'complete') return { status: 'complete', roundsStarted: round, report }
	if (report.status === 'blocked') return { status: 'blocked', roundsStarted: round, report }
	previous = report
}
return { status: 'budget-limited', roundsStarted: args.maxRounds, report: previous }
```

**每一轮 `agent(...)` 调用都是一次全新的委派**——新的 `run.id`,没有任何预先灌入的对话历史。这正是"每轮全新子级"字面意义上的实现:第 N 轮的子代理完全不知道第 N-1 轮的子代理说过什么,它拿到的只是 prompt 里显式拼进去的"上一轮结构化交接报告"(`previous`,被 `JSON.stringify` 之后原样嵌进文本)。

为了保证"全新"这件事不被悄悄破坏,工具还专门加了一层守卫,在启动循环前校验绑定的 Provider 必须是真正无状态的:

```typescript
// packages/workflow/tool-ralph/src/index.ts:220-231
function requireFreshProvider(ctx: Context, name: string): SubagentProvider {
	const provider = ctx.subagents.getProvider(name)
	if (provider === undefined) {
		throw new Error(`Ralph subagent provider "${name}" is not registered`)
	}
	if (!provider.capabilities.outputSchema) {
		throw new Error(`Ralph subagent provider "${name}" does not support structured output`)
	}
	if (provider.inheritsParentContext) {
		throw new Error(`Ralph subagent provider "${name}" inherits parent context; Ralph requires a fresh provider`)
	}
	return provider
}
```

这里直接检查上一篇讲过的 `SubagentProvider.inheritsParentContext` 字段——如果部署方手滑把 Ralph 绑定到了 `fork-in-process`(会继承父对话历史的那个 Provider),工具会直接拒绝启动,而不是悄悄跑出一个"看起来是全新、实际上带了历史"的 Ralph 循环。这是"每轮从干净状态开始"这条设计承诺,从提示词层面的口头约定,进一步落到了代码层面的硬校验。

**每轮之间到底传递了什么、解决了什么问题?** 恰好只有两样东西跨轮传递:(1)共享的文件系统工作区及其当前工作树——这被明确定位为"长期记忆和事实来源",提示词里反复强调"检查工作区、保留已有工作、核实你做的改动";(2)一份体量很小的结构化 JSON 报告(`status`/`summary`/`evidence`/`nextSteps`/`blocker`,受 `maxHandoffChars` 上限约束,默认 16384 字符)。没有对话历史,没有 git commit 协议,没有除了"工作区"之外的暂存文件约定。

这恰恰就是设计意图所在——完全对话式的连续委派(比如反复对同一个子代理 `send_message`),会让子代理的上下文随轮次线性增长,越往后越容易被早期的错误判断或过时信息"带偏";而 `tool-ralph` 用"每轮开全新脑子 + 工作区当共享记事本 + 一份小报告当交接"的组合,既避免了上下文污染和跨轮的隐性状态积累,又不至于让每轮都从零开始摸索——工作区里已经完成的改动是看得见的事实,不需要被重新描述一遍。

完成、受阻、预算耗尽这几种终态,都是**工作节点自己声明的,没有独立的验证者去复核**——这一点在工具自己的文档里被列成已知局限,值得在使用时留意:Ralph 循环判断"任务完成了",完全基于最后一轮子代理自己填的 `status: 'complete'`,而不是某个外部裁判去检查工作区里的改动是否真的达成了目标。

**关于"Ralph"这个名字的来源**:在 dsh 仓库内部,无论是源码注释、README,还是设计文档,都没有对这个名字的出处做任何解释——文档只是把"Ralph 模式/Ralph 循环"当作一个已知的外部术语直接使用,没有给出词源或引用。这个名字实际上来自 AI 编程 Agent 社区里流传的一种自动化技巧的俗称(常与工程师 Geoffrey Huntley 分享的"每轮用全新上下文重跑同一个目标"的实践联系在一起,"Ralph"这个称呼据说取自动画角色 Ralph Wiggum 那种"没有记忆、每次都从头开始却又意外把事情做成"的形象)——但这属于社区外部知识,不是本仓库文档或源码里能验证到的内容,读者可以把它当作背景趣闻,不必当作 dsh 官方定义。

## 常见问题/易踩坑

- **不要用课程写作时"这是遏制,不是安全边界"的旧结论套用到当前版本。** 当前 `workflow-ptc` 已经把执行下沉到一个真正应用 `ctx.sandbox` OS 沙箱策略的独立子进程,安全模型比早期的 worker+vm 方案强得多——但设计记录仍然明确提醒"程序成功不证明完整强制能力",沙箱是否被完整强制执行和脚本有没有报错是两件独立的事。判断一段编排脚本的信任边界,应该去看 `docs/subsystems/ptc-runtime.md` 和当时具体部署的 `ctx.sandbox` 策略,而不是凭历史印象。
- **`agent()` 调用失败会静默降级成 `null`,而不是抛异常。** 脚本作者(也就是模型)需要用 `.filter(Boolean)` 之类的写法去处理这种"某个子任务失败了但整个脚本还想继续"的情况;而像"启动参数不合法""触发了并发/总数上限"这类致命错误,则会以 `WorkflowError` 的形式直接杀死整个运行——这是刻意的两级错误处理策略,写编排脚本时要分清"哪些失败该忽略、哪些失败该让整个工作流跟着挂掉"。
- **Ralph 的完成判定没有第三方裁判。** 如果你的场景需要"客观验证任务确实完成了"而不是"子代理自己说完成了",需要在 `objective` 的表述里显式要求子代理提供可核查的证据(`evidence` 字段),或者在工作区外再加一层独立的验收检查,不能假设 Ralph 循环自带质检环节。

## 小结

`ctx.workflowEngine` 是一个只有 `start()` 一个方法的 Cordis 服务位,这一层抽象自课程写作以来没有变化。变化最大的是具体实现:早期的 `workflow-worker-thread`(worker 线程隔离主线程 + vm 上下文隔离全局对象,明确"非安全边界")已经被 `workflow-ptc` 取代——脚本现在运行在一个由共享的 `ctx.ptcRuntime` 服务启动的独立沙箱化子进程里,真正接入了 `ctx.sandbox`/`ctx.subprocess` 这套 OS 级沙箱与进程治理,vm 退居为进程内部的一层价值物化保护。这次迁移同时也让 workflow 引擎和曾经独立实现的 Code Mode 沙箱(`code-runtime`,现已不存在)收敛成了同一个共享执行引擎——根源都是同一个安全缺陷:纯 worker 隔离挡不住脚本直接绕过工具策略去调用系统 API。脚本对外暴露的五个受限全局函数(核心是 `agent()`)和跨进程边界"只传纯 JSON"的约束都延续了下来。`tool-ralph` 是这套引擎上长出来的一个高度约束的固定循环:模型只能填目标和轮数,每一轮都是一次全新的、不继承任何对话历史的委派,靠共享工作区和一份小的结构化交接报告让进度在"干净上下文"和"累积进展"之间找到平衡——这部分工具层逻辑基本没有变化。

思考题:

1. `tool-workflow` 允许模型自由编排,`tool-ralph` 把编排逻辑完全锁死只让模型填目标——如果要新增一个"介于两者之间"的工具(比如允许模型指定轮数上限和一个简单的停止条件表达式,但不允许自定义循环体),你会把这个"停止条件"设计成脚本里的一段代码,还是像 `tool-ralph` 一样做成一个受限的结构化参数?为什么?
2. `requireFreshProvider` 检查的是 `provider.inheritsParentContext`,而不是检查 Provider 的具体类型名字。这种基于能力声明而非具体实现类型做校验的方式,比硬编码"禁止使用 fork-in-process"多了什么灵活性?
