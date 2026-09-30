# 上下文压缩 Compaction 与 Checkpoint 持久化

这一篇回答两个相互咬合的问题：长会话撑爆上下文窗口时，`dsh` 怎样把旧历史折叠掉而不丢账；以及在发模型请求、执行工具这类不可撤回的动作之前，怎样保证会话日志已经真正落盘。

先给结论。压缩分两个触发点：`agent/pre-step` 上的主动压力检测，和 `agent/request-error` 上的被动溢出恢复，两者共用"剪枝、选区、摘要、替换"四步，但被动路径更激进。整个压缩被 `compaction/start` 与 `compaction/end` 一对标记包成事务，崩溃后能从日志里判断它有没有做完。而压缩所依赖的可靠性底座是 `session-checkpoint-policy`：它在三个副作用边界上强制 `flush`，flush 失败就不让副作用发生，即 fail-closed。

## 为什么不能只靠一个阈值

朴素做法是"token 数到了阈值就自动摘要"。这个做法至少有三处漏洞。

第一，阈值可能算错。本地的 token 估算口径和 provider 的真实限制不一定一致，可能出现本地觉得还有余量、provider 却已经拒绝请求的情况。只靠事前预测无法兜底，必须有一条在 provider 明确报错之后再补救的路径。

第二，压缩本身是一次异步、可能失败的操作。摘要请求要发给模型，可能超时、被取消，也可能在等待期间这段历史又被别的操作动过。如果中途崩溃，日志必须能说清这次压缩到底成没成，不能留下模糊状态。

第三，副作用不可逆。如果请求已经发给模型而会话记录还没落盘，这时进程崩溃，重启后的历史就和"模型实际看过什么"产生分歧，这种分歧事后无法修复。

`dsh` 对三个漏洞分别用不同的机制应对：两个触发点、标记对事务、三处强制 flush。它们的共同底线是：宁可拒绝一次副作用，也不让日志和真实发生的事脱节。

## 主动触发：每个 step 之前量一次

`BasicCompactionEngine` 在 `config.auto` 为真时挂两个监听器，第一个在 `agent/pre-step`，也就是 `preStep()` 里那个决定这一步能否进入模型调用的 waterfall 钩子。它调用 `compactIfNeeded(agent, 'pressure', signal)`，然后无论成功、失败还是配置缺失，最后一律 `return next()`。压缩失败不应该阻塞对话，这是刻意的容错。唯一的特殊照顾是 `TargetPressureConfigError`：当某个 provider/model 组合没有配置 `contextWindow`，压力根本算不出来时，同一个目标只告警一次，避免每步刷屏。

压力判断的流程是分层的。先用 `resolveModelInfo` 拿到当前路由模型的 `contextWindow`，再由 `resolveCompactSpec` 算出阈值，算的时候会用 `reservedCompletionTokens` 给模型输出预留空间。当前估算低于阈值就直接返回 `null`。到了阈值，第一件事不是摘要，而是调用可选的 `toolResultPruner` 服务做一次剪枝，然后重新测量；如果剪完已经低于阈值，压缩到此为止，连摘要请求都不用发。只有剪枝不够，才进入"选区、摘要、替换"的循环，循环最多重试 `compactionRetries` 次，每一轮都重新选区，因为一次摘要可能不够小。次数耗尽仍高于阈值就抛错，这个错误由上面的监听器降级成一条警告日志。

这个顺序体现的是成本递增：能不调模型就解决的问题，不调模型。

## 被动触发：provider 已经拒绝之后

第二个监听器挂在 `agent/request-error`，也就是 `step()` 里决定失败请求要不要重试的那个钩子。它只处理错误码为 `CONTEXT_WINDOW_EXCEEDED_CODE` 的失败，其余直接 `next()` 交给别的监听器，比如下一篇要讲的重试插件。它还受 `maxOverflowRetries` 限制，按 agent 记录已经恢复过几次，用完就放手。

这条路径和主动路径有两处关键差异。第一，跳过阈值判断，因为 provider 已经用行动表明"太大了"。它先做一次剪枝，再以 `retainTokens = 0` 调用 `selectCompactableRange`，即不为最近的对话尾部留后手，能压多少压多少。目标从"细水长流地保持余量"变成"尽快让这次请求被接受"。第二，判断恢复算不算成功的依据不是压缩函数有没有抛异常，而是 `surface.replaceGeneration` 有没有增长。这个计数器只在真的发生过 `replace` 写入时递增。于是出现了一个有意为之的分支：压缩抛了异常，但代次已经比开始前大，说明无模型的剪枝已经落地，这份持久的缩减足以支撑一次重试，就返回 `{ kind: 'retry' }`，不因为后续摘要失败而白白浪费。返回 retry 后，`step()` 的循环重新走 `buildRequest()`，用更短的历史再发一次。

反过来，如果代次没有变化，说明没有任何进展，监听器会 `return next()`，把原始的"上下文超限"错误原样交给外层，而不是无休止地重试一个注定失败的恢复。这也造成一个不对称：主动压缩失败只打警告、对话继续；被动恢复没有进展则错误照常上抛。前者是"还没出事，尽力而为"，后者是"已经出事，没有补救就得如实报告"。

## 四个阶段里各自的取舍

**剪枝**由独立的 `compaction-tool-result-pruner` 包提供，通过 `ctx.get('toolResultPruner')` 可选接入，职责严格限定为清理旧的工具结果，不动对话本体。理由是一次 `bash` 的完整输出往往是历史里最占 token、又最不需要被反复阅读的部分。因为是可选服务，没装它引擎照样工作，只是少了这一步便宜的缩减。

**选区**是纯函数 `selectCompactableRange(session, measurement, retainTokens)`。它从尾部往前累计 token，凑够 `retainTokens` 就停，得到初步切分点，再往前微调到最近一个"不会切断工具调用与结果配对"的边界（`toolPairingBalancedBefore`）。切开一对 `tool/call` 和 `tool/result` 会让派生出的历史出现没有结果的裸调用，模型会困惑，还可能违反 provider 对消息格式的约束。入口处有两道硬约束：一是 token 测量结果必须和当前 Surface 的节点逐个对得上，对不上直接抛错，不在错误前提上选区；二是如果节点 0 是 `system/message` 系统头部，选区下界从 1 开始，系统提示词永远不被卷进压缩范围。材料里给出的原因是系统提示词通常要作为 provider 侧 KV 缓存的锚点留在头部。

**摘要**是唯一调用模型的一步。`buildSummarizationInput()` 复用会话自己的工具 schema，系统提示词则直接从 Surface 头部那条 `system/message` 投影出来，不再从请求头里取，因为 `EpochHeader` 已经不携带 `system` 字段。复用同一份系统提示词和工具前缀，让摘要请求在 provider 侧看起来是同一个对话的延续，可以命中 prompt cache。摘要生成后还有一道检查：用 `meter.estimateMessage` 估算包装后的摘要 token，如果不小于被遮蔽内容的 token，整个事务判为失败。压缩的意义就是变小，不变小的压缩不该被接受。

**替换**用的是 Surface 的 `replace` 原语。先追加一条 `compaction/summary` 事件，再追加一条携带摘要内容的 `user/message`，带上 `surfaceOp: { op: 'replace', startSeq, endSeq }`，`sourceEventSeqs` 里列出起始事件、摘要事件和全部被遮蔽的旧事件。原始事件仍在日志里，只是不再出现在模型视图中，而且每条摘要替换了什么是可以核对的。

## 用标记对把压缩做成事务

四个阶段被 `compactSurfaceRegion()` 整体包在 `compaction/start` 与 `compaction/end` 之间。核心结构是一个 try/catch：进入时先写 start；成功路径依次是准备、摘要、稳定性断言、提交、写 end；失败路径在 catch 里尝试补写一条带 `error` 字段的 `compaction/end`。这意味着无论成败，日志上 start 之后几乎总会跟着一个 end。

这带来一个可用的判据：如果扫描日志发现某个 start 没有匹配的 end，就可以断定这是一次被进程崩溃真正打断的压缩，而不是逻辑失败后优雅收尾的压缩。两种情况在恢复时需要不同对待，标记对让它们能被区分开。

事务里另一个重要环节是 `assertStable()`。摘要请求要花时间，这期间日志还可能在增长。摘要回来之后，引擎会重新核对被替换区域有没有变化：自动压缩用整个 Surface 不变的校验（`assertWholeSurfaceUnchanged`），手动 `compactNow()` 用选中区间不变的校验（`assertSelectedSpanStable`）。发现变了就拒绝替换，而不是把摘要盲目塞进一个可能已经不对应的位置。

## Checkpoint：三个副作用边界上的 flush

压缩谈的是"模型看到什么"，checkpoint 谈的是"日志有没有真的存下来"。`session-checkpoint-policy` 只有一个 `apply` 函数，注册三个监听器。

```typescript
ctx.on('llm/stream', (options, next) => { /* ... afterCheckpoint(ctx, session, next) */ })
ctx.on('tools/execute', async (exec, next) => {
  if (exec.agent === undefined || exec.parent !== undefined) return next()
  await ctx.sessions.flush(exec.agent.session)
  if (exec.signal.aborted) return abortedBeforeDispatchResult()
  return next()
})
ctx.on('agent/pre-step', async ({ agent }, next) => {
  await ctx.sessions.flush(agent.session); return next()
})
```

三处分别是发起模型请求之前、顶层工具真正执行之前、组装下一步请求之前。工具那一处对 `exec.parent !== undefined` 的嵌套调用直接放行，因为嵌套调用复用外层已经落盘的调用记录，不必重复 flush。flush 之后还会检查一次 `signal`，如果这期间已经被取消，就返回"派发前已中止"的结果，不去执行工具。

关键在于结构：都是先 `await flush`，flush 抛异常就直接向上传播，`next()` 根本不会被调用。这就是 fail-closed 的具体含义：checkpoint 失败，模型请求和工具执行就不会发生。反过来的顺序，即先执行再补记，在副作用不可逆的前提下没有意义，补记的日志改变不了已经发生的事实。同样的理由，材料里指出这三处都没有 `catch` flush 的失败，这是有意的。

## 批量写入：语义上必须落盘，实现上可以攒一攒

如果每追加一个事件都同步写盘，热路径会很慢；如果全部攒着，checkpoint 又不可靠。`dsh` 把这两件事放在不同层次。

日常追加走 `JsonlSessionHandle.enqueueLive()`：事件先被 `structuredClone` 进内存缓冲，若当前没有定时器且没有被暂停（`drainPaused`），就启动一个 `LIVE_WRITE_BATCH_MAX_DELAY_MS`（200 毫秒）的定时器，到点后调用 `drainLive()` 批量写出。`drainLive()` 用 `this.draining ??= ...` 的写法，保证并发调用只触发一次排空，其余调用者共享同一个 promise。

需要 durability 的时刻则调用 `ctx.sessions.flush(session)`。这个方法定义在 `SessionStore` 上：向所有注册了 `session/flush` 的监听器并行派发，用 `Promise.allSettled` 等全部结束，只要有一个失败就抛出第一个失败原因。JSONL 后端通过 `ctx.on('session/flush', ...)` 注册自己的监听器，内部再去排空缓冲。这个 fan-out 设计的好处是：将来有多个持久化后端时，每个都可以挂一个 durability 监听器，flush resolve 就意味着所有参与的后端都已落盘。

分层的收益很明确：绝大多数事件追加走便宜的、被批量摊销的路径，只有三个关键时刻付出立即写入的代价。可靠性语义不打折，性能代价被限制在必须付出的地方。

这一层的包结构相比早期有过重构：`session-persistence` 现在只保留存储契约（`SessionHandle` 接口、错误类型、版本校验），具体的批量写入落在实现包 `session-persistence-jsonl` 里，为接入非 JSONL 后端留出了空间。当前状态下应以 `JsonlSessionHandle` 和 `SessionStore.flush` 为准。

## 我的看法

以下是判断，不是材料的结论。

其一，主动路径和被动路径的失败语义不同，这个不对称是合理的，但使用者容易踩坑：主动压缩失败只有一条警告日志，如果 `compactionRetries` 耗尽而始终没压下来，会话会带着高压力继续走，直到 provider 报错才触发被动恢复。监控上需要留意这条警告，材料中没有看到把它升级为可观测指标的说明。

其二，`agent/pre-step` 上同时挂着压缩监听器和 checkpoint 的 flush 监听器，材料只说明了 request-error 钩子上"谁先注册谁先跑"，没有说明 pre-step 上二者的相对顺序及其影响。压缩会写入 `replace`，如果 flush 发生在压缩之前，这次替换要等下一个边界才会被 flush。材料没有展开，我不做推断，但值得在源码里确认。

其三，摘要的信息损失无法被这套事务解决。标记对与 `sourceEventSeqs` 保证了可审计，模型自己却读不回被遮蔽的原文，课程材料中没有展开任何召回机制。

## 小结

- 压缩有主动（`agent/pre-step`，按阈值、先剪枝再摘要）和被动（`agent/request-error`，按 `CONTEXT_WINDOW_EXCEEDED_CODE`，`retainTokens` 为 0，以 `replaceGeneration` 判断进展）两个触发点，共用四步流程；主动失败放行，被动无进展则原错误上抛。
- 摘要必须比原文小、不能切断工具调用配对、不能吞掉系统头部；整个过程由 `compaction/start`/`compaction/end` 标记，并在提交前用稳定性断言防止替换到过期区域。
- `session-checkpoint-policy` 在模型请求、顶层工具执行、pre-step 三处先 flush 再放行，失败即中止；写入层用 200 毫秒批量窗口加显式 `flush` 把性能与可靠性分开处理。

对应原课程篇目：`04-Agent核心循环/04-上下文压缩Compaction与Checkpoint持久化.md`。
