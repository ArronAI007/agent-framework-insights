# ReactLoopAgent 总览：kick、turn、step 各管什么

这一篇回答一个问题：`dsh` 的整个 Agent 引擎收敛在 `packages/core/agent-loop/src/agent.ts` 的 `ReactLoopAgent` 一个类里，它凭什么把"驱动一次对话"拆成 `kick → turn → step` 三层嵌套，而不是一个 `while`？

结论先说三句。`kick()` 只管"还有没有排队的输入"，`turn()` 只管"一次用户可见的交互何时算结束"，`step()` 只管"一次模型请求加它触发的工具执行"，三层各自持有不同范围的状态。工具调用发生在 step 层，所以多步 ReAct 不会制造新的 turn。用户插话、取消、维护任务这些并发场景，靠一个三态的 `Phase` 和几条队列去规约，而不是靠锁。

## 朴素循环处理不了的事

最朴素的 Agent 循环是：读用户消息，发给模型，模型要工具就执行并把结果拼回去再发，直到不再要工具，然后等下一条消息。它在四件事上会出问题。模型正在跑工具时用户又发来一句话，是立刻处理还是等整轮结束；一次工具调用之后模型通常还要再说一次话，这算同一次交互的延续还是新交互；崩溃后从哪里续；用户点停止时，只应该打断当前这一件事，不能误伤后面的操作。

`ReactLoopAgent` 的回答是把边界画在两个地方。turn 是用户能感知到的一次完整交互，日志里从 `turn/start` 到 `turn/end`；step 是 ReAct 的最小单元，日志里从 `step/start` 到 `step/end`。这四类事件在会话日志里天然构成一棵"turn 下挂多个 step"的树，崩溃后能精确说出中断在哪个 turn 的哪个 step。

## 谁在触发 kick

引擎是纯事件驱动的，没有轮询。入口是 `Agent` 上四个写方法，它们都是 `send(message, target, wakeup)` 的不同参数组合：

| 方法 | 队列 | 是否唤醒 driver |
|---|---|---|
| `followup` | `next-turn` | 是 |
| `steer` | `next-step` | 是 |
| `inject` | `next-step` | 否 |

`followup` 是普通的"用户发了新消息"，作为独立的新 turn 处理。`steer` 是用户在模型思考或执行工具期间补充指令，不开新 turn，塞进当前 turn 的下一个 step。`inject` 是系统自己往上下文里放东西，例如文件变更通知，同样进 `next-step`，但不叫醒循环。所以 `steer` 与 `inject` 的差别不在"是否影响下一步"，而在 agent 空闲时会不会被叫醒：只调用 `inject` 而 agent 一直 idle，这条消息可能永远没人消费。

`send()` 里还有一处细节：如果调用时循环刚被取消、正在收尾（`wakeup` 为真且当前 phase 的 abort signal 已经触发），无论调用者指定了什么队列，消息都会被改投到 `next-turn`。原因不难推断：旧 turn 已经被取消，把消息塞进它的"下一个 step"没有意义。

真正决定要不要启动 `kick()` 的是 `wakeDriver()`，它只在 `phase.kind === 'idle'` 时才会创建一个 `Promise.withResolvers`、把 phase 切到 `running`、并通过 `loopCtx.agents.withInitiator(this, () => this.kick())` 启动 driver。如果当前是 `maintenance`（例如正在做会话压缩），或者刚被取消还没收尾，唤醒请求不会被丢掉，而是记在 `phase.wakeRequested` 上，等那次活动结束后补发。如果已经在正常运行，就什么也不做，因为循环自己会在下一个 step 边界去认领 inbox。取消原因是 `disposed`（agent 被销毁）时，连这条记账也不做。

`Phase` 是一个判别联合，三种形态：

```typescript
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
```

三种形态都带着 turn 编号（`lastTurn` 或 `turn`），所以"下一个 turn 该编几号"永远查得到。`running` 和 `maintenance` 各持有独立的 `AbortController`，`cancel()` 只会打断当前这一次活动，不会波及下一次唤醒。

## kick：只反复调用 turn

`kick()` 本身几乎没有逻辑：`while (await this.turn()) {}`，`turn()` 返回 `true` 表示 inbox 里还有排队消息，值得再开一个 turn。它真正认真的部分在 `finally`：不管 `turn()` 是正常结束还是抛出了取消或致命错误，都要把 phase 收回 `idle`，并且如果这期间 `wakeRequested` 被置位、inbox 也确实还有东西，就再调一次 `wakeDriver()`。这是为了对付"driver 收尾的同时外部又发来一条消息"的竞态：消息在 driver 判定"没事可做"之后、phase 变回 idle 之前到达，如果没有这一段补发，它会一直躺在队列里。

被取消或出错时，异常在 driver 边界就被吞掉了（catch 里没有任何处理），失败和取消已经作为事件记进了日志，不需要再向上抛给调用者。

## turn：一次交互的边界

`turn()` 进入时先写 `turn/start`，然后进入内部循环，每圈对应一个 step。每圈依次做的事是：调用 `preStep()` 认领消息并装配上下文，`step()` 执行，写 `step/end`，再判断要不要收尾。有几个边界条件值得逐个看。

`preStep()` 返回 `reject`（某个 `agent/pre-step` 监听器拒绝了这一步，例如审批没通过）时，turn 以 `blocked` 收尾。如果这是 turn 的第一步而认领到的消息为空（比如一条 steering 消息在被认领前就被取消了），turn 以 `completed` 收尾，并且不消耗任何模型调用；代码注释的说法是，一个被改写成空的 `enter` 决定仍然占有 turn 的起始边界，但不花一次模型请求。

max-tokens 是粘滞的：`if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd`。一旦某个 step 因输出被截断而结束，后面 step 即便正常完成，turn 的最终结论也不会被降级覆盖。"这次交互曾被截断"这个事实因此不会在日志里丢失。

收尾之前的判断最讲究。当 `turnEnds` 已有结论且 `inbox.nextStep` 为空时，`turn()` 不是直接结束，而是先触发一个串行钩子 `agent/turn-stopping`，然后再检查一次 `nextStep`，还是空才 break。这个钩子不能投票否决。想让 turn 继续的插件要调用 `agent.steer(...)` 往队列里放一条消息，`turn()` 看到队列非空就继续走下一个 step。是否继续只取决于队列里有没有数据，与监听器的先后顺序无关，这正是想要的性质：两个插件谁先谁后，结果一样。

turn 的 `finally` 无条件写 `turn/end`，携带 `TurnEndReason`。它是一个可被插件合并扩展的判别联合，涵盖 `completed`、`aborted`、`blocked`、`error`、`max-tokens`、`interrupted`、`forked` 七种。`forked` 不会由运行中的循环产生，而是 fork 出子会话时，给源会话在 fork 边界处尚未收尾的 turn 事后补记的；`aborted` 携带的 `reason` 类型还额外容纳一个 `{ kind: 'legacy' }`，专门给历史导入的、当年没记录取消原因的旧日志。

异常路径里有一个不起眼的点：读取取消原因用的是 `abortedCancelCause(signal)`，而不是直接取 `signal.reason`。它只拷贝 `turn/end` 真正会记录的字段。原因是 Node 的 `fetch` 会往 abort 原因对象上挂一个 `stack` 属性，原样交给 `Session.append()`，要么被日志拒收，要么把不可序列化的内容写进持久化数据。

最后，如果 inbox 里还有排队消息（用户在这个 turn 进行期间又发了 `followup`），`turn()` 换一个新的 `AbortController`、清掉 `wakeRequested`、把 step 计数归零，返回 `true`，`kick()` 的外层循环随即开始下一个 turn。

## preStep：认领消息与装配

每个 step 开始前，`preStep()` 先从 `Inbox.claim(target, turn)` 取出这一步要处理的消息（target 为 `next-turn` 时会顺带取一条排队的独立输入），再调用 `systemPrompt.assemble()` 收集系统提示词、动态上下文和工具定义，交给 `RuntimeContextProjection` 判断是否要写入一条新快照，最后把这一切送进 `agent/pre-step` waterfall 钩子，由插件决定放行还是拒绝。权限审批和上下文压缩都挂在这个钩子上。装配的细节见样稿讲上下文管理的那一篇，这里只需记住一点：动态上下文最终也是一条普通的 `user/message`，与认领来的消息一起进入本步。

## step：一次模型调用与它触发的工具

`step()` 现在接收的是 `preStep()` 返回的完整 decision（含 `messages`、`assembly`、`startsRequestSeries`），而不是单独一份 prompt 装配结果。这一步要处理的用户消息在 `step()` 内部落盘，并且只在 `firstAttempt` 时写一次，这样请求失败重试时，日志里不会重复出现同一条用户消息。

step 内部还有一层 `while (true)`，只服务于请求重试。骨架是：`prepareRequest()` 得到配置，`buildRequest()` 组装不可变的 `GenerateOptions`，创建一个 `AssistantStreamAttempt` 消费流，流的终止如果是 `error` 或 `aborted`，就走 `agent/request-error` waterfall，监听器返回 `retry` 才 `continue`，否则抛出 `LlmError`。重试策略的细节属于本章后面的错误处理篇，这里不展开。请求成功后，用 `live.blocks()` 组装出 `AssistantMessage`，通过 `live.settle('assistant/message', ...)` 写入日志。流式消费与落盘的细节留给下一篇。

到这里就是"为什么工具调用不产生新 turn"的答案。`step()` 只有三种返回：`{ kind: 'completed' }`、`{ kind: 'max-tokens' }` 和 `null`。消息里没有 `tool-call` 块，step 直接 `completed`；有的话调用 `executeToolCalls()` 执行，并把执行过程中产生的上下文通过 `inbox.splice('next-step', ...)` 放回队列。若工具结果里有任何一个显式带 `concludesTurn: true`，`concluded` 为真，step 以 `completed` 收尾；否则返回 `null`，含义是"工具执行完了，模型大概率还要针对结果再说点什么"。`turn()` 拿到 `null` 时不会开新 turn，而是把 `target` 切成 `next-step`，回到内部循环的下一圈。

`max-tokens` 分支有一个安全细节：被截断的响应里，工具调用块会在组装阶段被整体过滤掉（下一篇会看到），所以截断不会导致执行一个只有一半参数的调用。

## 为什么分两层

turn 层的状态跨越多次模型调用：inbox 里是否还有 steering、要不要问 `agent/turn-stopping`、max-tokens 是否曾发生。step 层的状态局限在单次调用：怎么消费这次的流、怎么执行工具、失败后是否原地重试。把它们揉进一个大循环，`max-tokens` 的粘滞判断、`turn-stopping` 的调用时机、"续当前 turn 还是开新 turn"会互相牵连，改一处容易波及另一处。分开之后，每一层各自的失败与取消语义也更清晰：step 层的重试不会污染 turn 边界事件，turn 层的取消收尾不需要知道请求做过几次尝试。

## 我的看法

这一节是判断，不是材料的结论。`kick()` 在 driver 边界把异常整体吞掉，靠的是"失败已经在 `turn/end` 里留痕"这个前提。从材料看这个前提是成立的，`turn()` 的 `catch` 会先把 `aborted` 或 `error` 写进 `turnEnds`，再交给 `finally` 落盘。但这意味着，调用方如果想知道一次触发最终成败，只能读日志，不能等 Promise。这与"日志是唯一事实来源"的整体取向一致，代价是对不读日志的调用者不友好。材料中没有展开这一点在外部 API 层是如何处理的，所以我只把它当作一个值得留意的边界。

## 小结

- 三层各有所守：`kick()` 守"还有无排队输入"，`turn()` 守"交互何时结束"，`step()` 守"单次模型调用与工具执行"；工具调用停留在 step 层，靠 `concludesTurn` 与 `null` 返回值续接，不开新 turn。
- 并发靠数据而不是锁：`followup`、`steer`、`inject` 用两条队列与是否唤醒区分语义，`Phase` 三态加独立的 `AbortController` 让取消、维护与重入唤醒互不踩踏，`wakeRequested` 把竞态里的唤醒推迟到活动结束再补。
- 结论都留在日志里：`agent/turn-stopping` 只看队列，max-tokens 粘滞，`turn/end` 无条件落盘并携带七种原因之一。

对应原课程篇目：`04-Agent核心循环/01-ReactLoopAgent总览-kick-turn-step.md`。
