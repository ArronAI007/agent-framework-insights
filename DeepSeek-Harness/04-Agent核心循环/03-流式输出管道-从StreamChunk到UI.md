# 流式输出管道：从 StreamChunk 到 UI

> 一个模型输出的字符，从 DeepSeek 服务端的 SSE 报文，到浏览器里打字机式跳出来的文字，中间要经过好几层完全独立的"重组"：Provider 把裸字节解析成协议无关的 `StreamChunk`，`LlmRuntime` 用一个 waterfall 中间件链包一层，`ReactLoopAgent.step()` 通过 `AssistantStreamAttempt` 边组装边压缩，Host/Client 之间的传输层把这份数据推给浏览器，Client 再用一个独立的累加器把它重新拼回可渲染的块。本篇按数据实际流动的顺序，逐层拆开这条管道，并回答一个核心设计取舍问题：**逐 token 的回放保真度和日志体量这两个互相冲突的目标，是怎么被同时满足的**。
>
> **2026-09 更新**：这一篇讲的核心机制——尤其是"落盘"这一层——相比早期版本有实质性演进，请重点关注"第三层"和"为什么"这两节；Host/Client 之间具体的传输协议（原来的 `FrameQueue`/WebSocket 帧）也发生了包名和实现方式的变化，完整的 Host-Client RPC 架构以第 06 章为准，这里只更新到"数据传到 Client 之后要怎么再折叠"这个层面。

## 学习目标

- 理解 `StreamChunk` 这个协议无关的中间表示长什么样，以及 Provider 的 adapter 实现如何把 SSE 字节流转换成它。
- 理解 `LlmRuntime` 的 `'llm/stream'` waterfall 中间件链的作用——它是插件（比如下一篇的 checkpoint 策略）介入"模型请求即将发出"这一时刻的唯一入口。
- 通读 `BlockAssembler` 的真实实现，理解它如何把碎片化的 `block-start`/`text-delta`/`tool-call-delta`/`block-end` 等七种 chunk 类型，增量组装成完整的 `ContentBlock[]`。
- 理解 `AssistantStreamAttempt` + `AssistantStreamAccumulator` 这套新机制：为什么现在不再是"每个原始 chunk 都落一条日志"，而是把连续的同类 delta 压缩成"紧凑记录"、只落一条 `assistant/message`/`assistant/attempt` 事件，同时依然保证可以**无损**还原出原始的逐 chunk 时间序列。
- 理解实时 UI 更新（`AssistantStreamFrame` 的 `start`/`chunk`/`end`）和"落盘供回放"这两件事现在是彻底分离的两条路径，不再像早期版本那样共用同一条日志。

## 背景与设计动机

流式输出（streaming）本身不难——大多数 LLM SDK 都提供"边生成边吐"的能力。真正难的是把这件事嵌进一个需要"完整历史可回放、可持久化、可在多个消费者之间转发"的系统里，会同时冒出几个互相牵制的需求：

- **协议要统一**：DeepSeek、`pi-ai` 等不同 provider 的原始流格式各不相同（SSE 字段名、分块粒度都不一样），Agent 循环不该关心这些差异。
- **既要流式展示、又要有一个"最终定型"的消息**：UI 需要边到边渲染的原始 delta，但会话历史（第二篇讲的 Surface）只应该记一条组装完整的 `assistant/message`，不能把中间态污染进正式历史。
- **可靠重放优先于存储效率**：调试一次异常输出（比如模型在某个 token 处莫名其妙换了语言，或者一次奇怪的工具调用参数是怎么被拼出来的），最有效的手段是能看到逐 token 的原始流，而不是只有组装完的最终结果。
- **多端消费**：同一份流式输出，既要喂给持久化的会话日志，又要喂给可能同时打开的多个浏览器标签/多个客户端。

`dsh` 的解法是让每一层都做且只做自己该做的事：Provider 只管协议转换，`LlmRuntime` 只管中间件编排，`ReactLoopAgent` 通过 `AssistantStreamAttempt` 同时负责"实时转发给 UI"和"落盘一份可无损重放的紧凑记录"这两件事（但两条路径彼此独立，见下），Host/Client 之间的传输层负责把数据搬到浏览器，Client 只管"把收到的数据再折叠成可渲染的 UI 状态"。下面按这个顺序展开。

## 核心机制详解

### 第一层 Provider → Adapter：把 SSE 字节流转换成 StreamChunk

> **2026-09 更新**：`packages/llm/llm-deepseek` 的目录形态又变了一次——之前按协议形态拆出来的 `src/protocols/chat-completions/`、`src/protocols/messages/` 两层目录已经不存在，包重新回到了扁平结构，而且 DeepSeek 侧现在只保留一套 **Messages 协议**实现（Anthropic 风格的 `message_start`/`content_block_delta`/`message_stop` 事件流，请求发往 `${baseURL}/messages`）。`DeepSeekAdapter.stream()` 依然只是一层转发：`stream(options) { return this.generate(options, this.dependencies.options()) }`，真正的流式逻辑在私有的 `generate()` 里。

`packages/llm/llm-deepseek/src/sse.ts` 里的 `parseSse()` 负责把裸的 SSE 字节流解析成 DeepSeek Messages 协议的事件对象：

```typescript
// packages/llm/llm-deepseek/src/sse.ts
export async function* parseSse(body: ReadableStream<BufferSource>, activity: () => void): AsyncGenerator<Record<string, unknown>> {
  const events = body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment: activity }))
  for await (const frame of events) {
    activity()
    let raw: unknown
    try { raw = JSON.parse(frame.data) } catch (_invalidSseJson) {
      throw new LlmError('DeepSeek Messages SSE contains invalid JSON', 'MALFORMED_RESPONSE')
    }
    const event = object(raw)
    if (typeof event.type !== 'string' || (frame.event !== undefined && frame.event !== event.type)) {
      throw new LlmError('DeepSeek Messages SSE event type mismatch', 'MALFORMED_RESPONSE')
    }
    if (event.type === 'error') throw providerError(event, undefined)
    yield event
  }
}
```

它仍然把"帧重组"（分块可能在任意字节边界断开，甚至断在一个 UTF-8 多字节字符中间）完全委托给 `eventsource-parser` 这个第三方库，但职责比早期版本多了一层协议级校验：每一帧解析成 JSON 之后，必须携带字符串类型的 `type` 字段、且与 SSE 的 `event:` 行一致，否则抛 `MALFORMED_RESPONSE`；`type === 'error'` 的帧直接转成结构化 provider 错误抛出。第二个参数 `activity` 是一个心跳回调（每收到一帧就调一次），专门用来喂下面要讲的空闲看门狗。早期版本那条"必须显式收到 `[DONE]` 才算流正常结束"的规则没有消失，而是随协议迁移换了形态：现在它体现在 `translate()`（`packages/llm/llm-deepseek/src/translate.ts`）的出口处——`for await` 正常跑完都没见到 `message_stop` 事件，就 `throw new LlmError('DeepSeek Messages stream ended before message_stop', 'STREAM_CLOSED')`。"流看起来正常结束、但其实是网络层面被截断"这类隐蔽故障的第一道防线还在，只是判据从 `[DONE]` 哨兵文本换成了 Messages 协议的终止事件。

再往上一层，`DeepSeekAdapter` 的 `generate()`（`packages/llm/llm-deepseek/src/adapter.ts`）把 `parseSse()` 产出的事件流喂给 `translate()` 转换成协议无关的 `StreamChunk`（`yield* translate(parseSse(response.body, activity), options.model)`），并且套了一层空闲超时看门狗：

```typescript
// packages/llm/llm-deepseek/src/adapter.ts（节选）
private async * generate(options: GenerateOptions, connection: Connection): AsyncGenerator<StreamChunk> {
  const consumer = new AbortController()
  const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
  using watchdog = idleWatchdog(signal, connection.streamIdleTimeoutMs, 'MESSAGES_IDLE')
  const iterator = this.request(options, connection, watchdog.signal, () => { watchdog.pulse() })
  try {
    while (true) {
      const next = await watchdog.next(iterator)
      if (next.done) return
      yield next.value
    }
  } catch (error) {
    if (timeoutOf(watchdog.signal, 'MESSAGES_IDLE') !== undefined) throw new LlmError('DeepSeek Messages stream idle timeout', 'TIMEOUT', { cause: error })
    if (options.signal?.aborted) throw new LlmError('DeepSeek Messages request aborted', 'ABORTED', { cause: error })
    if (error instanceof LlmError) throw error
    throw new LlmError('DeepSeek Messages transport failed', 'TRANSPORT', { cause: error })
  } finally {
    consumer.abort()
    try { await iterator.return(undefined) } catch { /* 请求已结束，清理失败不改变结果 */ }
  }
}
```

一个信号同时服务两件事：调用方主动取消（`options.signal`）和空闲看门狗超时（`idleWatchdog` 内部的 `watchdog.signal`），两者用 `AbortSignal.any` 融合成一个。`catch` 块里的判断顺序也是精心设计的——先判断是不是看门狗超时（映射成 `TIMEOUT`），再判断是不是调用方主动取消（映射成 `ABORTED`），最后才是兜底的 `TRANSPORT`——这保证了同一次失败，无论真实原因是什么，最终抛出的 `LlmError` 都带着一个稳定、可被后续重试逻辑（第五篇）用来做路由判断的 `code`，而不是一段自然语言消息。

### 第二层 Adapter → LlmRuntime：一个可被中间件插入的 waterfall

`LlmRuntime`（`packages/llm/llm/src/index.ts`）并不直接把 adapter 的流原样吐出去,而是包了一层 Cordis 的 `waterfall` 中间件链：

```typescript
// packages/llm/llm/src/index.ts
private streamWithRegistration(
  options: GenerateOptions,
  prepared?: { registration: AdapterRegistration; config: LlmCallConfig },
): AsyncIterable<StreamChunk> {
  return this.ctx.waterfall(
    this,
    'llm/stream',
    options,
    () => this.adapterStream(options, prepared),
  )
}
```

`'llm/stream'` 这个事件名的类型签名是：

```typescript
// packages/llm/llm/src/index.ts
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

任何插件都可以监听这个事件,拿到 `next()`（代表"更内层中间件或者最终 adapter 会返回的流"）,决定原样转发、包一层新的 `AsyncIterable` 再返回，甚至完全替换掉。下一篇要讲的 `session-checkpoint-policy` 正是挂在这里——它在真正调用 `next()`（也就是真正向 provider 发起请求）之前，先做一次会话落盘 `flush`，实现"发模型请求前必须先把请求本身持久化"的 fail-closed 语义：

```typescript
// packages/session/session-checkpoint-policy/src/index.ts
function afterCheckpoint(ctx: Context, session: Session, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    await ctx.sessions.flush(session)
    yield* next()
  })()
}
ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
  if (options.sessionId === undefined) return next()
  const session = ctx.sessions.get(options.sessionId)
  return session === undefined ? next() : afterCheckpoint(ctx, session, next)
})
```

`adapterStream()`（waterfall 链条最内层的默认实现）本身还负责把"adapter 选择失败""迭代器构造失败""迭代过程中途抛异常"这三类完全不同来源的失败，统一收敛成一种协议——一个 `{ type: 'finish', reason: { kind: 'error' | 'aborted', failure } }` 的终止 chunk，而不是让异常直接从 `AsyncGenerator` 里抛出来打断消费者的 `for await`：

```typescript
// packages/llm/llm/src/index.ts（节选）
function adapterFailureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  const failure = normalizeLlmFailure(error)
  return {
    type: 'finish',
    reason: signal?.aborted || failure.code === 'ABORTED' ? { kind: 'aborted', failure } : { kind: 'error', failure },
  }
}
```

这意味着 `ReactLoopAgent.step()` 消费流的时候永远只需要处理"正常的 chunk"和"一条携带失败信息的 `finish` chunk"两种情况,不需要额外套 `try/catch` 来兜底 adapter 层面的各种抛异常方式——这也是为下一篇的重试机制铺路：重试判断的输入永远是一条结构化的 `finish` chunk，不是裸的 JS 异常。

### 第三层 LlmRuntime → Agent Loop：AssistantStreamAttempt——实时转发与落盘分离

> **这一节是本篇变化最大的地方**。早期版本里 `step()` 自己持有一个 `BlockAssembler`，每个 chunk 到达时"先原样落一条 `assistant/chunk` 日志、再喂给组装器"——落盘和实时转发是同一件事、同一条数据路径。当前版本把这两件事拆成了两条独立路径，都封装进了 `AssistantStreamAttempt`（`packages/core/agent-loop/src/assistant-stream.ts`）。

```typescript
// packages/core/agent-loop/src/assistant-stream.ts（节选）
push(chunk: StreamChunk): void {
  const timed = this.accumulator.push({ time: Date.now(), chunk })
  this.assembler.push(timed.chunk)
  this.emit({
    type: 'chunk',
    attemptId: this.attemptId,
    revision: this.nextRevision(),
    index: this.index++,
    time: timed.time,
    chunk: timed.chunk,
  })
}
```

一个 chunk 到达时，`AssistantStreamAttempt.push()` 同时做三件事，但它们服务三个完全不同的目的：

1. **`this.accumulator.push(...)`**——喂给 `AssistantStreamAccumulator`（`packages/llm/llm/src/assistant-stream.ts`），这是**唯一**会被落盘的路径，但它不是"每个 chunk 一条日志"，而是把连续的同类 delta 就地压缩（细节见下一节）。
2. **`this.assembler.push(...)`**——喂给 `BlockAssembler`（内部持有，逻辑和早期版本完全一致，见下方节选），负责把碎片拼成完整的 `ContentBlock[]`，供这一次请求成功后组装出最终 `AssistantMessage`。
3. **`this.emit(...)`**——发出一个 `AssistantStreamFrame`（`type: 'chunk'`），通过 `dispatch.emit('agent/assistant-stream', { frame })` 广播出去。**这一步完全不落盘**，是纯粹的进程内实时通知，专门服务于"UI 需要立刻看到这个 token"这一个需求。

一次请求结束时，`step()` 调用 `live.settle('assistant/message', () => this.session.append(...))`——只有这一刻，才会真正往会话日志写一条事件，而且这条事件携带的是 `live.stream`（`AssistantStreamAccumulator.snapshot()` 的结果，一份紧凑记录），不再是一长串独立的 `assistant/chunk` 事件：

```typescript
// packages/core/agent-loop/src/assistant-stream.ts（节选）
settle(eventType: 'assistant/message' | 'assistant/attempt', append: () => SessionSeq): void {
  let seq: SessionSeq
  try { seq = append() } catch (error: unknown) { this.abandon(); throw error }
  this.terminal = true
  this.emit({ type: 'end', attemptId: this.attemptId, revision: this.nextRevision(), index: this.index,
    outcome: { kind: 'committed', eventType, seq } })
}
```

这就是为什么本篇开头说"实时转发"和"落盘"是两条彻底独立的路径：即使 UI 一次帧都没收到（比如没有任何浏览器连着），落盘这条路径完全不受影响；反过来，即使日志写入失败（`abandon()` 分支），之前已经发给 UI 的帧也不会被撤回——UI 展示的是"这一刻模型说了什么"的事实，会话日志记的是"这次请求最终、经得起回放验证的结果"，两者故意不耦合。

`BlockAssembler` 本身（`packages/llm/llm/src/assembler.ts`）依然是这条管道里真正的"折叠算法"核心，实现和早期版本一致:

```typescript
// packages/llm/llm/src/assembler.ts
push(chunk: StreamChunk): void {
  switch (chunk.type) {
    case 'block-start': {
      if (!this.partials.has(chunk.index)) {
        this.order.push(chunk.index)
        this.partials.set(chunk.index, { blockType: chunk.blockType, text: '', toolCallArguments: '' })
      }
      return
    }
    case 'text-delta':
    case 'reasoning-delta': {
      const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
      if (partial.block) return // closed by block-end; ignore stragglers
      partial.text += chunk.text
      return
    }
    case 'tool-call-delta': {
      const partial = this.ensure(chunk.index, 'tool-call')
      if (partial.block) return
      partial.toolCallId = chunk.id
      if (chunk.name) partial.toolCallName = chunk.name
      partial.toolCallArguments += chunk.argumentsDelta
      return
    }
    case 'block-end': {
      const partial = this.ensure(chunk.index, chunk.block.type)
      if (partial.block) return
      partial.block = chunk.block
      return
    }
    case 'usage': { this._usage = chunk.usage; return }
    case 'finish': { this._finish = chunk.reason; this._replayState = chunk.replayState; return }
    default: return assertNever(chunk, 'BlockAssembler.push')
  }
}
```

`StreamChunk` 是一个按 `index`（内容块在这条消息里的位置）分片的增量协议,`BlockAssembler` 用一个 `Map<number, PartialBlock>` 按 `index` 维护每个内容块自己的组装状态——文本类块（`text`/`reasoning`）是简单的字符串累加,工具调用块是"调用 id + 名字 + 参数 JSON 片段"三个字段各自累加,直到一条 `block-end` 到达把这个 `index` "钉死"成最终的 `ContentBlock`。**"第一次关闭生效,之后的迟到 delta 被忽略"**（`if (partial.block) return`）是一条专门针对畸形流的防御:如果某个 provider 的实现有 bug,在 `block-end` 之后又发来同一个 `index` 的 delta,这条防线保证最终组装结果和当时流式展示给用户看到的内容完全一致,不会因为迟到数据而产生"UI 上看到的和存进历史的不一样"的诡异错位。

`blocks()` 还处理了一个边界情况:

```typescript
// packages/llm/llm/src/assembler.ts
blocks(): ContentBlock[] {
  const blocks = this.order.map(index => this.assemble(this.mustGet(index), index))
  return this.finish.kind === 'max-tokens'
    ? blocks.filter(block => block.type !== 'tool-call')
    : blocks
}
```

如果这一步是被输出 token 上限截断的（`max-tokens`),组装结果里的工具调用块会被整体过滤掉——一个被截断的工具调用参数（比如一个被截成一半的文件路径字符串)如果被当真执行,后果可能是危险的,所以宁可让模型"这一步什么工具都没调用",也不要执行一个残缺的调用。

### AssistantStreamAccumulator：紧凑记录如何做到"无损"

上一节说落盘路径不再是"每个 chunk 一条日志"，但依然要保证**无损**——这是 `AssistantStreamAccumulator`（`packages/llm/llm/src/assistant-stream.ts`）真正解决的问题。它的核心思路是"打包连续同类 delta"：

```typescript
// packages/llm/llm/src/assistant-stream.ts（节选，text-delta 分支）
case 'text-delta':
case 'reasoning-delta': {
  const type = chunk.type === 'text-delta' ? 'text-chunks' : 'reasoning-chunks'
  const gap = previous !== undefined && previous.type === type ? safeGap(previous.lastTime, time) : undefined
  if (previous !== undefined && previous.type === type && previous.index === chunk.index && gap !== undefined) {
    previous.dt.push(gap)      // 和上一条记录同类型、同 index，追加时间差和文本，不新开一条记录
    previous.texts.push(chunk.text)
    previous.lastTime = time
  } else {
    this.records.push({ type, time0: time, index: chunk.index, dt: [], texts: [chunk.text], lastTime: time })
  }
  return timed
}
```

如果连续几十个 `text-delta` 都属于同一个内容块（`index` 相同），它们不会变成几十条独立记录，而是被压进**一条** `text-chunks` 记录里：`time0`（第一条的时间戳）+ `dt`（后续每条相对上一条的时间差数组）+ `texts`（每条的文本片段数组）。这份紧凑记录不是有损摘要——`expandAssistantStream()` 能把它精确地展开回原始的、带时间戳的逐 chunk 序列（`time0` 累加每个 `dt` 就是每条原始 chunk 的真实到达时间）,`assembleAssistantStream()` 也能把它重新喂回一个 `BlockAssembler` 得到和当初完全一样的组装结果。只有 `block-start`/`block-end`/`usage`/`finish` 这类"每种最多出现一次或语义上不该合并"的 chunk 才会被原样存成一条 `{ type: 'chunk' }` 记录。

这是比早期版本更好的答案：早期版本用"存储换保真度"（每个 chunk 一条日志，体量大但简单）；现在用一个不复杂的打包算法同时拿到了两者——日志体量大幅下降（连续的同类 delta 从 N 条压成 1 条），但 `expandAssistantStream()` 保证这依然是一份可以逐 token 精确重放的记录,不是有损压缩。

### 第四层与第五层：Host/Client 传输与再折叠（架构已重组，细节见第 06 章）

> 早期版本里，Host 端用 `packages/host/apiproxy/src/api-proxy.ts` 里手写的 `FrameQueue`/`events.mux` 把 `session/event` 重新打包成 WebSocket 帧、`packages/client/connection` 负责在 Node 侧转发、`packages/client/runtime` 里的 `PartialAccumulator` 在浏览器侧再折叠一次。当前版本里，`packages/host/` 下已经不存在 `apiproxy` 这个包，取而代之的是 `packages/api/session-controller` 这个新包（下辖 `remote-events.ts`/`commands.ts`/`control.ts` 等，是命令下发、远程事件订阅、断线重连快照的统一入口），客户端侧的折叠器也从 `packages/client/runtime/src/client/sessions/partial.ts` 挪到了 `packages/client/ui-chat/src/client/conversation-nodes/partial.ts`。
>
> 这是一次真正的包重组，不是简单改名——完整、准确的 Host-Client 传输架构（RPC 契约怎么生成、连接怎么建立、重连快照怎么工作）已经超出本篇"流式管道"的范围，留给第 06 章《Host-Client 分离与 Typert RPC 生成》专门讲解。这里只需要记住一个不变的架构原则：**折叠这件事在 Client 侧依然是独立于服务端重新做一遍的**，浏览器不会盲目信任服务端"已经算好的中间结果"，而是拿到原始的流式数据/事件后自己重新组装出可渲染的状态——这个"每一层只信任自己收到的原始输入"的设计原则本身没有变，变的只是搬运这些数据的具体传输层代码。

### 为什么现在只落盘紧凑记录，而不是每个原始 chunk

把整条链路串起来看,这个问题的答案是:

- **回放保真度没有被牺牲**:紧凑记录（`AssistantStreamRecord[]`）依然完整保留了"模型输出到底是怎么一小块一小块吐出来的"这一事实——`expandAssistantStream()` 可以精确重建出原始的逐 chunk 序列，包括每条的到达时间。这不是"取舍"，而是同一份保真度用更省空间的编码方式存下来。
- **崩溃恢复的精确性不受影响**:即使进程在流式响应过程中崩溃，`AssistantStreamAccumulator` 内部维护的记录列表本身就是增量构建的，只是最终 `settle()` 那一刻才整体落盘——如果崩溃发生在 `settle()` 之前，这一次 attempt 本来就不会被认为已经完成,和早期版本"部分 chunk 已落盘、但没有 assistant/message"的中间状态相比，语义更干净（要么完整落盘，要么这次 attempt 视为没发生）。
- **实时性和持久化解耦**:UI 需要的"立刻看到这个 token"通过完全独立的 `AssistantStreamFrame` 广播满足，不再依赖"chunk 必须先落盘才能被转发"这个顺序——这也是为什么 Host/Client 重连后想要恢复"刚才漏掉的片段"，现在要靠专门的重连快照机制（第 06 章），而不是简单地重放一段 `assistant/chunk` 日志。

早期版本的代价是显而易见的:一次几百 token 的回复可能对应几十上百条 `assistant/chunk` 事件,日志体量会明显膨胀。当前版本用一个不复杂的"打包连续同类 delta"算法解决了这个代价，同时没有放弃"逐 token 级别可精确重放"这个目标——这是一个值得在自己的系统设计中借鉴的思路:**当"简单但浪费"的方案跑了一段时间之后，往往能找到一个不牺牲原有保证、但明显更省资源的编码方式**。

## 小结

- 流式管道核心分三层：Provider 协议转换（`parseSse` + `translate`，当前 DeepSeek 侧只保留一套 Messages 协议实现，包回到扁平目录）→ `LlmRuntime` 的 `'llm/stream'` waterfall（中间件可介入,如 checkpoint）→ Agent Loop 的 `AssistantStreamAttempt`，把"实时转发给 UI"（`AssistantStreamFrame`，不落盘）和"落盘一份可无损重放的紧凑记录"（`AssistantStreamAccumulator` 打包连续同类 delta）彻底拆成两条独立路径。Host/Client 之间具体怎么传输、怎么重连恢复，架构已经重组，详见第 06 章。
- `BlockAssembler` 按内容块 `index` 维护增量组装状态,`block-end` 到达即钉死,之后的迟到 delta 被忽略;`max-tokens` 截断时会把不完整的工具调用块整体过滤掉。
- 落盘的紧凑记录（`AssistantStreamRecord[]`）通过打包连续同类 delta 大幅降低日志体量，同时用 `expandAssistantStream()`/`assembleAssistantStream()` 保证依然可以无损还原出原始的逐 chunk 时间序列——不是"用存储换保真度"的取舍，而是同一份保真度换了一种更省空间的编码方式。
