# Workflow 引擎与 Ralph 循环：让编排逻辑活在脚本里，而不是对话里

这一篇要回答的问题是：当任务需要"先跑几个子代理探路，再挑一个继续深入，中途还要动态决定多开几路"时，编排逻辑应该放在哪里，放进去之后又怎么保证脚本不越权。

三句话概括。`dsh` 让模型直接写一段 JavaScript 编排脚本，交给只有一个 `start()` 方法的 `ctx.workflowEngine` 去跑，循环、分支、并发由脚本自己持有，只在真要干活时通过 `agent()` 回到宿主进程里的真实子代理。执行层现在建立在共享的沙箱化子进程引擎 `ctx.ptcRuntime` 之上，安全边界来自"独立进程加 OS 沙箱"，`node:vm` 只是进程内的一层保护。`tool-ralph` 是这套引擎上锁死的成品循环：每轮开一个全新子代理，靠共享工作区和一份小的结构化交接报告累积进度。

## 为什么不让模型在对话里手动编排

最朴素的做法是模型在对话里一步步调用委派工具：启动、看结果、再启动。这有两个问题。中间状态，比如启动了几个子代理、各自返回了什么，都要反复塞进上下文，token 随委派次数线性增长。而且循环、条件、并发调度本质上是程序逻辑，用自然语言逐步驱动效率很低。

所以 `dsh` 让模型把编排写成脚本。脚本不活在对话历史里，它自己持有循环变量和累积结果，通过受限的全局函数 `agent`、`parallel`、`pipeline`、`phase`、`log` 桥接回宿主。课程材料说明这个思路与 Claude Code 的 dynamic workflows 同源，`meta` 元数据的词汇表也刻意保持兼容。

## ctx.workflowEngine：只有一个方法的服务位

`packages/workflow/workflow/src/index.ts` 声明了抽象类 `WorkflowEngine`，只有一个抽象方法 `start(request)`，返回句柄 `WorkflowRun`。没有"列出所有工作流""按 id 停止"这类管理 API，控制权全在句柄里：`result`、`cancel(reason?)`、`dispose()`。`result` 这个 Promise 永远不会 reject，任何失败都 resolve 成带 `stopReason: 'cancelled' | 'error'` 的 `WorkflowResult`，与"异常转成正常结果反馈给模型"的原则一致。运行状态通过 `workflow/start`、`/phase`、`/log`、`/agent-start`、`/agent-end`、`/end` 六个事件广播，事件只带数据快照，不泄露活的 `WorkflowRun`，观察者只能看，不能反向操控。

请求 `WorkflowStartRequest` 里有两个每次运行可选的覆写：`subagentProvider`（本次所有 `agent()` 统一走这个 Provider）和 `maxTotalAgents`（本次子代理总数上限）。

一个 Cordis 上下文里只允许一个引擎实现占用 `ctx.workflowEngine`，没有按名字区分的多引擎注册表。换引擎就是在组合文件里替换一行，历史上确实替换过一次：`workflow-worker-thread` 换成了 `workflow-ptc`。

## 执行层：为什么从 worker 换成了子进程

早期实现用 worker_threads 隔离主线程、`node:vm` 隔离全局对象，同时明确声明这不是安全边界。2026-09-11 的一份架构决策记录指出了它的结构性缺陷：worker 只隔离 JavaScript 状态，不应用调用会话的 OS 沙箱策略；模型代码可以直接导入文件系统和子进程 API，绕过工具策略路径，即使嵌套的 `tools.*` 调用被正确检查；终止 worker 也不能证明它的子进程已经停止。换句话说，脚本里一句 `require('fs')` 就能绕过所有工具层策略。

当前的解法是把执行下沉到共享服务 `ctx.ptcRuntime`，分两层。第一层是一个全新的 Node 子进程（由 `dsh-ptc-runtime-node` 启动，不是 worker 线程），它通过与 `bash` 工具同一个 `ctx.sandbox` Provider 解析并应用调用会话的 OS 沙箱策略，进程的启动、超时终止、清理交给 `ctx.subprocess` 统一治理。这一层才是安全边界。第二层是进程内的 `node:vm`，用途变了：不再隔离全局对象，而是用来安全地物化脚本抛出的值和 getter 返回值，避免读取恶意构造的 `.stack` 或 `.message` 时触发副作用。源码注释写得直白：getter 和 proxy 陷阱可能在受限进程内执行，进程隔离和取消属于 PTC，不属于 vm。

设计记录同时留了一句谨慎的话：程序成功不证明完整强制能力。沙箱策略是否被完整强制，和脚本有没有报错是两件独立的事，不能因为脚本正常跑完就假设沙箱一定生效。

这次迁移还带来一次收敛。原来另有一套基于 worker 的 Code Mode 沙箱（`packages/code-runtime`，让模型写 JS 程序化调用工具），与 workflow 各自独立实现。发现是同一个缺陷之后，两者被合并进同一个 `ctx.ptcRuntime`，这个包已不存在。现在 `core/tools`、`fs/tool-fs`、`ssh/ssh`、`mcp/mcp-resources` 等多个子系统都依赖 `@deepseek-ai/dsh-ptc-runtime`。好处是新增的沙箱强制或资源限制只需在这一层做一次。

## agent() 怎么跨过进程边界

脚本在沙箱子进程里，但 `agent()` 要启动的是宿主进程里真实的子代理。这条边界靠 PTC 运行时提供的专用二进制控制通道：子进程所有者提供继承式通道，与程序的 stdout、stderr 以及 launcher 生命周期 IPC 分开。Host 一侧限制帧大小，排队写入、待处理调用和未完成参数字节，并在分派前验证调用身份与绑定允许列表。设计记录明说，模型代码可以写这条通道，所以其中的字节仍不可信，host 必须像对待外部输入一样校验。

落点没变：`agent()` 最终调用 `ctx.subagents.start(provider, { prompt, parent, signal, ... })`。`ctx.subagents` 只在 host 侧被触及，子进程手里只有一个往返的 RPC 桩，永远拿不到直接引用。跨边界的值必须是纯 JSON，函数、Symbol、循环引用、非有限数字都会被 `realm.ts` 的 `materializeFromRealm` 拒绝。

并发与预算由几个配置项管：`maxConcurrentAgents`（默认按核数推算为 `min(16, max(1, cores - 2))`）、`maxTotalAgents`（默认 1000，兜底失控循环）、`maxItemsPerCall`（`parallel` 与 `pipeline` 单次元素上限，默认 4096）、`syncTimeoutMs`（脚本起始同步切片的 vm 超时，默认 5000ms）。取消时 host 通过受管子进程发出信号，脚本在下一次 `await` 处停下，不配合就由 PTC 强制结束子进程。

## tool-workflow：模型的入口

`tool-workflow` 要求四个参数：`script`（纯 JS 正文）、`meta`（`name` 与 `description` 必填，`whenToUse`、`phases` 可选）、`args`（可选 JSON，注入为脚本的 `args` 全局量）、`run_in_background`（默认 true）。`meta` 被刻意做成单独的数据参数，而不是脚本里的 `export const meta = {...}`：如果它是脚本的一部分，宿主就得在隔离生效之前对它求值，一个带副作用的 getter 就绕过了本该保护的边界。源码里甚至有一段正则检查，发现 Claude Code 风格的头部会直接报错而不是默默兼容。`agent()` 的选项除 `label`、`phase`、`schema` 外还接受 `provider` 与 `model` 覆写，陌生选项一律 fail loud。

前台路径要求调用方是真实 Agent，把工具的 `AbortSignal` 桥到 `run.cancel()`，`await run.result`，非 `completed` 的 `stopReason` 转成抛出的 `Error`，成功返回 `{ runId, agentsStarted, result }`，最后无论如何 `run.dispose()`。后台路径把整个运行注册成 `kind: 'workflow'` 的 `ctx.jobs` 任务，立即返回 `{ kind: 'background', jobId, runId }`，引擎的同步拒绝（meta 非法、脚本解析失败）会直接抛回成普通工具错误，脚本返回值随任务完成通知回来，之后用 `job_output` 查、`job_kill` 停。此外工具内置的 recorder 会把 `tool-workflow/run-start`、`agent-start`、`agent-end`、`run-end` 四类 log-only 事件追加进父会话日志，让编排轨迹能脱离对话被回放；追加失败只记 warning，不影响执行。

## Ralph 循环：每轮换一个新脑子

`tool-ralph` 是用这套引擎固定打磨出的一件工具。模型只能填两个参数：必填的 `objective` 和可选的 `maxRounds`（受部署方上限约束，默认 256）。没有 prompt 模板参数，没有停止条件参数，Provider、输出 schema、循环脚本 `RALPH_SCRIPT` 全由部署方锁死。部署侧配置四项：`subagentProvider`（默认 `spawn`）、`maxRounds`、`maxHandoffChars`（单轮交接报告的字符上限，默认 16384）、`maxResultChars`（面向父代理的终态渲染文本上限，默认 16384，超出截断）。

循环体的核心是这样：

```javascript
for (let round = 1; round <= args.maxRounds; round += 1) {
  const prompt = [/* 不可变目标、轮次、"工作区是长期记忆"、上一轮结构化交接 */].join('\n\n')
  const rawReport = await agent(prompt, { label: 'Ralph round ' + round, schema: reportSchema })
  if (rawReport === null) return { status: 'round-failed', roundsStarted: round, lastReport: previous ?? null }
  const report = validateReport(rawReport)
  if (report.status === 'complete' || report.status === 'blocked') return { status: report.status, roundsStarted: round, report }
  previous = report
}
return { status: 'budget-limited', roundsStarted: args.maxRounds, report: previous }
```

每一轮 `agent()` 都是一次全新委派，新的 run id，没有灌入任何对话历史。第 N 轮完全不知道第 N-1 轮说过什么，只拿到 prompt 里显式拼进去的上一轮报告。恰好只有两样东西跨轮：共享的文件系统工作区（提示词反复强调它是长期记忆和事实来源，要先检查、保留已有工作、核实改动），以及一份小的 JSON 报告（`status`、`summary`、`evidence`、`nextSteps`、`blocker`）。设计意图很清楚：反复对同一个子代理 `send_message` 会让它的上下文线性增长，越往后越容易被早期错误判断带偏；每轮全新加工作区当记事本，既避免污染，又不用每轮从零摸索。

"全新"这个承诺被落到了代码里。`requireFreshProvider` 在启动前检查绑定的 Provider 必须已注册、支持 `outputSchema`，并且 `inheritsParentContext` 为 false；部署方如果误把 Ralph 绑到会继承历史的 `fork-in-process`，工具直接拒绝启动。这里检查的是能力声明，而不是 Provider 的类型名，所以任何满足"无继承、支持结构化输出"的新 Provider 都能直接用。启动引擎时，`maxTotalAgents` 被设为等于 `maxRounds`，Provider 选择也是通过引擎通用的请求形状带进去，而不是 Ralph 私有通道。

另一处跨边界不信任：脚本内 `validateReport()` 的结论宿主并不直接采信，终态回来后 `readRunResult`/`readReport` 会再严格校验一遍整体形状、字符串归一化、各状态的字段约束（`complete` 必须有 evidence 且无 nextSteps，`blocked` 必须有具体 blocker）和交接长度，不满足直接抛错。但要分清，这校验的是报告形状，不是内容真伪。

## 代价与边界

`agent()` 失败会静默降级成 `null` 而不是抛异常，脚本作者（即模型）要用 `.filter(Boolean)` 之类的写法处理；而启动参数不合法、触发并发或总数上限这类致命错误，则以 `WorkflowError` 杀死整个运行。这是刻意的两级错误处理，写编排脚本时要分清哪些失败该忽略。

Ralph 的三种终态，完成、受阻、预算耗尽，都是工作节点自己声明的，没有独立验证者复核，工具自己的文档把这列为已知局限。需要客观验收的场景，得在 `objective` 里显式要求可核查的 `evidence`，或在工作区外另加验收检查。

## 我的看法

Ralph 把"完成"的裁判权交给最后一轮的子代理，而报告校验只管形状，这意味着一个乐观的子代理可以让循环提前以 `complete` 收场。材料给出的缓解是要求 `evidence` 字段，但证据是否真实仍无人核对。如果要把 Ralph 用在有明确验收标准的任务上，我倾向于把验收做成循环之外的独立步骤。这是基于上面已知局限做的判断。

关于名字：`dsh` 仓库里没有对"Ralph"的出处做任何解释，课程材料说明它是社区里流传的俗称，属外部知识，无法在本仓库验证。

## 小结

- 编排逻辑写成脚本交给 `ctx.workflowEngine`，脚本持有循环和累积状态，`agent()` 是唯一回到宿主子代理的桥，跨边界只传纯 JSON。
- 执行层从 worker 加 vm 迁到 `ctx.ptcRuntime`，因为 worker 挡不住脚本绕过工具策略；现在的边界是独立进程加 `ctx.sandbox` 策略，且 Code Mode 沙箱也并入了同一个引擎。
- Ralph 用固定脚本、全新子代理、共享工作区和小报告实现进度累积，`requireFreshProvider` 硬校验"全新"，但完成判定没有第三方裁判。

对应原课程篇目：`07-多智能体与工作流/02-Workflow引擎与Ralph循环.md`
