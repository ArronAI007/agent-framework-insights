# Subagent 委派与协作模型：把任务分包出去，父子之间怎么隔离、怎么说话

这一篇要回答的问题是：一个 Agent 想把手头的活儿分包给另一个 Agent，`dsh` 怎么让"怎么启动子代理""子代理带多少上下文""父子之间怎么通信"这三件事互不纠缠。

结论可以先说三句。委派被拆成三层正交的抽象：传输层的 `SubagentProvider` 只管把 prompt 变成一个在跑的子代理，血缘层的 `SessionHeader` 字段管"谁生的、第几代"，通信层管"谁能对谁说话"。六种委派后端（同进程 fork 与 spawn、ACP、Claude Code、Codex、递归 dsh）共用同一张契约，所以换后端不影响血缘和通信规则。子代理的权限在启动那一刻固定，不能从内部放宽；父子消息故意分成"模型自主的消息"和"运行时强制的结算通知"两种来源，回放时永远分得清是谁说的。

## 为什么要拆成三层

多智能体最容易出问题的地方，是把"谁负责启动子任务""子任务能看到多少上下文""出了问题谁兜底"混成一团。混在一起的后果很具体：想从同进程委派换成外部 CLI 委派，就得同时改深度限制、会话记录和消息路由。`dsh` 的做法是让传输机制对上层不可见。无论子代理是 fork 出来的，还是拉起的 `claude` 进程，只要经过 `SubagentRuntime` 的创建流程，都会留下同一套血缘记录，也走同一套消息规则。

## SubagentProvider：一个 start() 统一六种后端

契约定义在 `packages/subagent/subagent/src/types.ts`，刻意做得很瘦。唯一必须实现的是 `start()`，它建立一个一次性子代理并返回句柄 `SubagentRun`。`prepareContinuable()` 是可选的，它有没有被实现，本身就是能力声明：一个 Provider 支不支持"可续接"的后台子代理（能被挂起，之后用 `send_message` 唤醒），看的是这个方法在不在，而不是某个布尔字段。

除此之外还有两类声明式字段。`inheritsParentContext` 说明子代理能不能看到父会话已完成的对话前缀，模型侧的工具描述据此生成准确的措辞。`capabilities` 是启动前就能检查的五个静态能力位：`agentOptions`（能否覆写 provider、model、推理强度等选项）、`outputSchema`（能否要求子代理按 JSON Schema 收尾）、`depthLimit`、`toolFilter`、`persona`。调用方要求的能力当前 Provider 不支持时，请求在 `start()` 之前就失败，而不是等子代理跑完才发现格式不对。

一次性子代理的句柄 `SubagentRun` 只有 `id`、`localAgent`、`result` 和 `dispose()`，没有 `send()` 或 `interrupt()`。想给后台子代理发消息、打断它、列出子代理，走的是 `SubagentRuntime` 上的 `sendMessage()`、`interrupt()`、`listChildren()`。这个划分本身表达了一个判断：一次性委派（发出去等结果）和可续接的后台委派（发出去还要继续控制）是两种强度不同的关系，不该塞进同一个句柄。

## 六种后端各自适合什么

六个实现分布在 `packages/subagent/subagent-*` 下。它们的差异只在"用什么机制建立子代理"。

`subagent-fork-in-process` 在同进程创建新 Agent，并把父会话已完成的对话轮次作为种子塞进去，`inheritsParentContext` 为 `true`，适合子代理需要知道"我们刚讨论到哪"的便宜委派。`subagent-spawn-in-process` 同样在同进程，但不塞种子，是白板子代理，适合独立的子任务。这两个 Provider 的全部差异就是"要不要传 seed"，深度校验、结果读取、取消和清理都在共享的驱动函数 `startInProcessRun` 里实现一次，那个包（`subagent-in-process-driver`）本身不注册任何 Provider。两个薄 Provider 共享一个厚驱动，避免了两份实现在容易出错的收尾细节上出现行为漂移。

fork 取种子时有一个细节：`completedTurnPrefix` 只截到父会话最后一个 `turn/end` 事件为止。一个还在进行的轮次，比如模型刚发起工具调用而结果还没回来，如果塞给子代理，上下文里会出现没有配对的悬空工具调用。对可续接子代理，这个前缀只在创建时截取一次，之后成为子代理自己日志的一部分，冷恢复时回放的是这份前缀，而不是重新去读父代理更新后的历史。

另外四个是驱动外部进程的 Provider。`subagent-acp` 拉起任意可执行文件，用 Agent Client Protocol 在 stdio 上驱动，不锁定具体产品。`subagent-claude-code` 复用官方 `@anthropic-ai/claude-agent-sdk` 的 `query()`，但通过 `spawnClaudeCodeProcess` 把"怎么拉起进程"接到 `dsh` 自己的子进程管理上，所以真实的 `claude` 进程仍然受 `dsh` 的环境清理和进程树级联清理约束。`subagent-codex` 没有现成 SDK，手写了 JSON-RPC 客户端，拉起 `codex app-server --stdio`，走 `initialize`、`thread/start`、`turn/start` 直到 `turn/completed`。`subagent-dsh-sdk` 最特殊：它拉起的是另一整套完整的 `dsh` harness，有自己的 `cordis.yml`、模型路由和会话持久化，用 `dsh` 自己的 SDK 客户端驱动。前三个是驾驶别人造的车，最后一个是造一辆配置独立的新车让它自己跑。

这四个外部或递归 Provider 都声明 `depthLimit: false`，它们内部如果有深度预算，由各自的系统管理，父进程不假装管得到。`agentOptions` 上则要分开看：ACP、Codex、Claude Code 三个驾驶外部进程的 Provider 直接拒绝这个能力，因为 `dsh` 没有办法把 provider、model 覆写透传给被驾驶的进程；`subagent-dsh-sdk` 不拒绝，它把覆写合并到自己那套独立 harness 的默认路由上。

## 血缘与深度预算

子代理终究是个普通会话，只是 `SessionHeader` 多了几个字段。`parentSession` 记录从哪个会话派生；`origin === 'subagent'` 是展示层的分类标记，源码注释特别强调它不是"可续接"的证明，权威依据是子会话日志里的 `subagent/descriptor` 描述符；`isSeeded` 说明是否带了 fork 继承来的历史前缀（早期版本持久化种子长度的 `seedLength`，现在收窄成了布尔值）；`delegationDepth` 顶层为 0，子代理是父深度加一。

深度之所以要写进会话头，而不是只在内存里记计数器，是因为递归预算必须扛得住重启。读取深度的 `delegationDepthOf` 取的是 `Math.max(会话头里的持久值, 运行时选项)`，运行时选项只能加深，不能调浅。这堵住了一条绕过路径：冷启动恢复的子代理，运行时选项是新构造的、默认可能是 0，如果只读它，就会被当成顶层会话重新无限委派。真正的上限检查在创建子代理时由 `resolveChildDepth` 做，超限抛 `SubagentDepthError`。

全局代码里没有 `MAX_DELEGATION_DEPTH` 这样的常量。`tool-subagent` 的 `maxDepth` 省略时，每次委派都会通过 `ctx.subagents.resolveMaxDepth()` 读取 Host 级设置，默认是 1，也就是顶层默认只能再派一代；同一处的 `maxActiveSubagents` 容量上限默认 8。由于外部进程类 Provider 声明了 `depthLimit: false`，用它们配置 `subagent` 工具时，部署方必须把 `maxDepth` 显式设成 `'provider-managed'`。

列举直接子代理的方式也从读取时扫描改成了写入时记账。每次子代理建立，运行时往父会话日志追加一条 `subagent/catalog` 事件，折叠成父会话上的 `subagentCatalog` 投影，条目是 `{ childId, childCreatedAt, mode, label? }`。于是 `listChildren` 只需观察父会话，不用打开任何子代理日志，冷会话不会被唤醒。`mode` 取 `one-shot`、`continuable` 或 `unknown`，`unknown` 专留给 V3 到 V4 会话格式迁移时回填历史子代理。跨代的 `listDescendants` 仍然遍历整个语料库，靠 `parentSession` 串起会话树，再读各子会话自己日志里折叠出的身份；读不动的子代理降级成一行诊断，不会让整个列举失败。

## tool-subagent：模型看到的委派入口

模型调用的工具是 `packages/subagent/tool-subagent`。一个反直觉的设计是：模型既不能选 Provider，也不能选要不要 fork 历史，这些都由部署方在 `Config` 里锁定。部署可以同时挂载多个实例，分别绑定不同 Provider，模型看到的是 `subagent`、`subagent_codex` 这样名字和职责各异的几个工具，而不是一个带"选择 Provider"参数的万能工具，避免它在参数组合上选错。

模型能填的参数只有 `description`（三到五个词，用于展示）、`prompt`，以及开启后台时可选的 `run_in_background`。`prompt` 必须自包含，因为子代理很可能没有任何上下文。唯一的例外是 LLM 路由：部署开启 `modelSelectionSettings`，且 Host 侧设置为当前会话解析出允许的路由清单时，工具上才会多出可选的 `provider`、`model`、`reasoning_effort`，并配一个 `list_subagent_models` 工具让模型先查。不传就沿继承链走：配置的 `agentOptions`，然后父 Agent 最新一次请求的路由，最后是 Provider 自己的 `agentRouteDefaults`。模型自填的路由要过允许清单校验和真实的路由预检，保证在子代理创建之前就可用。这个设置只在顶层会话创建时采样一次，并原样传给所有子代理，用户中途改设置不会让子代理"变卦"。

`execute()` 按"是否可续接、是否后台"走三条路径。可续接加后台，调用 `ctx.subagents.startContinuable` 后立即返回 `{ kind: 'continuable', subagentId }`，之后靠 `send_message` 等工具操控。一次性加后台，包成一个 `ctx.jobs` 任务异步跑。前台则直接 `await ctx.subagents.start(...)`，父代理这一步工具调用挂起到子代理结束。

前台收尾的 `settleForegroundRun` 值得一看：取结果和 `dispose` 用 `Promise.allSettled` 各自独立结算，任何一边失败都不会盖掉另一边；两边都失败时抛 `AggregateError` 带上两个原因。异常终止的子代理会带着 `stopReasonError()`、诊断文本和部分输出回到父代理，部分输出不算成功，但不丢。

## 父子之间怎么说话

通信被拆成两类故意分开的持久化来源。

第一类是模型自主的消息与主动控制，由 `tool-subagent-control` 提供三个独立工具：`send_message`、`interrupt_agent`、`list_agents`。`send_message` 是相邻 Agent 之间的双向消息：父代理投给直接的可续接子代理，常驻子代理也能回投给直接父代理。工具本身只是 `ctx.subagents.sendMessage()` 的薄壳，授权下沉在服务里：服务端拿活体发送者 Agent 去比对目标会话的血缘，不相邻就拒收。投递语义是：目标在跑，消息在最近的步边界插入起引导作用；目标空闲，消息为它开启或续上一轮；目标是已卸载的直接子代理，先从持久化冷恢复再投递。调用只返回收件箱接受的 `messageId`，不等回答，"失败"意味着没送达而不是对方没回话。落到接收方会话里的来源是 `{ kind: 'agent-message', form: 'relay', senderSessionId }`。

`interrupt_agent` 的目标可以是更深的子孙，但只打断目标当前这一轮：排队的消息继续停着，目标自己启动的子代理继续跑，目标之后仍可被 `send_message` 唤醒。`list_agents` 只向模型投影可续接子代理，并且状态只有 `running` 与 `inactive` 两态，工具描述专门提醒 `inactive` 不代表完成或失败，只是此刻没有在执行的轮次。

子代理向父代理汇报，现在复用同一条 `send_message`。早期版本有专门的 `report` 工具和独立的 `tool-subagent-report` 包，靠只在子代理作用域里注册来做可见性隔离，这套已经整个移除。取而代之的是给可续接子代理的初始任务拼上一段固定的回路指引（`withContinuableReturnGuidance`），把父会话 id 写进任务文本，告诉它收工前用 `send_message` 把自包含的结果发回去。隔离改由服务端的血缘相邻校验承担，子代理能回话的对象天然只有直接父代理。

第二类是运行时强制的结算通知。可续接子代理的一次运行结算时，运行时无条件通知父代理，来源标成 `{ kind: 'subagent-settled', form: 'notice', ... }`，与 `agent-message` 泾渭分明，正文由 `createSettlementMessage` 组装：先按 `stopReason` 写一行结案陈词，再附子代理最后的收尾文本，没有就明说它没留收尾消息。工具描述向模型承诺了这条通知的存在，所以模型不需要轮询。两类消息共用同一套收件箱投递，但持久化来源不同，目的是让回放时永远分得清"这句话是哪个 Agent 自己说的"和"这句话是运行时替谁说的"。

## 权限：启动时固定，不能放宽

子代理的权限不是继承父代理的当前设置，而是委派发起那一刻被固定，之后无法从内部放宽。每个同进程子代理的系统提示里会注入一段固定文案，告诉它权限范围在启动时已定、需要审批的操作会被自动拒绝。同时子代理只拿到一个全新的扁平注册作用域，不会继承父代理注册过的服务或放宽过的沙箱例外，只继承两样东西：对话历史（仅 fork，且仅限已完成轮次），以及所在 Agent Preset 组合出的工具集。上下文、工具、权限三个维度各管各的，这是判断"子代理到底看得到什么、能做什么"时最值得记住的一条线。

## 代价与边界

几点成本从材料里能直接读出来。外部进程类 Provider 的深度预算父层管不到，驾驶外部进程的三个 Provider 还不支持 `agentOptions` 覆写，部署方要显式承认 `provider-managed`，等于把递归风险交给了外部系统。前台委派会让父代理的这一步工具调用一直挂起，父代理要并行做别的事就得走后台路径。fork 只继承已完成轮次，意味着父代理正在进行的那一轮里的信息，子代理拿不到，`prompt` 必须自己写全。

## 我的看法

这一套里我认为最有价值的是"用结构性约束替代运行时检查"的取向：深度靠持久下限加只增不减，子代理发现靠写入时记 catalog，`send_message` 隔离靠血缘相邻校验。这些约束不依赖模型自觉。相应的风险是，回路指引依然是文本约定：如果子代理的初始任务被改动、指引丢失，子代理就不知道该往哪汇报，但结算通知作为兜底仍会送达父代理，这也是两类消息要分开的实际理由。这是我基于上述机制的推断，课程材料没有专门讨论这个失效场景。

## 小结

- `SubagentProvider.start()` 统一了六种委派后端，`inheritsParentContext` 与 `capabilities` 让上层在启动前就能判断能做什么；fork 与 spawn 的差别仅在是否传种子。
- 血缘与深度写进 `SessionHeader`，深度取持久值与运行时值的较大者，直接子代理靠父日志里的 `subagent/catalog` 发现，权限在启动时固定。
- 父子通信分成模型自主的 `agent-message` 与运行时强制的 `subagent-settled`，授权由服务端血缘校验完成。

对应原课程篇目：`07-多智能体与工作流/01-Subagent委派与协作模型.md`
