# 流式输出管道：从 StreamChunk 到 UI

这一篇回答的问题是：模型吐出的每个字，怎么既能实时出现在界面上，又能在事后逐 token 回放，而会话日志不至于被几百条碎片撑爆。

结论三句话。协议差异被压在 Provider 的 adapter 里，向上只暴露协议无关的 `StreamChunk`；`ReactLoopAgent` 通过 `AssistantStreamAttempt` 把每个 chunk 同时送去三个地方，其中"实时转发给 UI"不落盘，"落盘"只写一条携带紧凑记录的事件；紧凑记录靠打包连续同类 delta 省空间，却能被 `expandAssistantStream()` 无损展开回逐 chunk 的时间序列。下面按数据流动的顺序走一遍。

## 第一层：把 SSE 变成 StreamChunk

DeepSeek 侧现在只保留一套 Messages 协议实现（Anthropic 风格的 `message_start`、`content_block_delta`、`message_stop` 事件流，请求发往 `${baseURL}/messages`），`packages/llm/llm-deepseek` 是扁平目录。`DeepSeekAdapter.stream()` 只是转发给私有的 `generate()`。

`parseSse()` 负责把字节流解析成事件对象：`TextDecoderStream` 加 `EventSourceParserStream` 处理帧重组，分块可能断在任意字节边界，甚至断在 UTF-8 多字节字符中间，这件事完全交给 `eventsource-parser`。在此之上它加了协议级校验：每帧必须能 `JSON.parse`，必须有字符串类型的 `type`，且与 SSE 的 `event:` 行一致，否则抛 `MALFORMED_RESPONSE`；`type === 'error'` 的帧转成结构化 provider 错误。它的第二个参数 `activity` 是心跳回调，每收到一帧或注释就调用一次，用来喂空闲看门狗。

"流看起来正常结束，其实被网络截断"是一类隐蔽故障，这里的防线在 `translate()` 的出口：`for await` 跑完仍没见到 `message_stop`，就抛 `STREAM_CLOSED`。判据从早期的 `[DONE]` 哨兵文本换成了协议自己的终止事件，但防线还在。

`generate()` 给整个流套上空闲看门狗。调用方的 `options.signal` 与看门狗的 signal 用 `AbortSignal.any` 合并成一个。`catch` 里的判断顺序是设计过的：先看是不是看门狗超时（映射为 `TIMEOUT`），再看是不是调用方取消（`ABORTED`），最后才是兜底的 `TRANSPORT`。同一次失败无论真实原因怎样，抛出的 `LlmError` 都带一个稳定的 `code`，后面的重试逻辑靠 `code` 路由，而不是解析自然语言消息。`finally` 里无条件 `consumer.abort()` 并尝试 `iterator.return()`，清理失败被有意忽略，因为请求已经结束，清理失败不应该改变结果。

## 第二层：LlmRuntime 的 llm/stream 中间件

`LlmRuntime` 不把 adapter 的流原样返回，而是包了一层 Cordis waterfall：`this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(...))`。事件签名是 `(options, next) => AsyncIterable<StreamChunk>`，监听者拿到代表内层的 `next()`，可以原样转发、包一层再返回，也可以完全替换。这是插件介入"模型请求即将发出"这一刻的唯一入口。

第一个使用者是 `session-checkpoint-policy`：如果 `options.sessionId` 对应的会话存在，就返回一个异步生成器，先 `await ctx.sessions.flush(session)`，再 `yield* next()`。也就是说，请求真正发向 provider 之前，会话必须先落盘，这是 fail-closed 语义。持久化的细节属于后面一篇。

链条最内层的 `adapterStream()` 做了一件让上游省心的事：把"adapter 选择失败""迭代器构造失败""迭代中途抛异常"三种来源不同的失败，统一转成一条终止 chunk `{ type: 'finish', reason: { kind: 'error' | 'aborted', failure } }`，而不是让异常从 `AsyncGenerator` 里冒出来。`adapterFailureChunk()` 里，signal 已 aborted 或 `failure.code === 'ABORTED'` 就归为 `aborted`，否则是 `error`。于是 `step()` 消费流时永远只面对两种输入：正常 chunk，或一条携带失败信息的 `finish`，重试判断的输入也因此永远是结构化数据。

## 第三层：AssistantStreamAttempt 把一个 chunk 送去三处

早期版本里 `step()` 自己持有 `BlockAssembler`，每个 chunk 到达就先原样落一条 `assistant/chunk`，再喂给组装器，落盘和转发是同一条路径。当前版本把它们拆开，封装进 `packages/core/agent-loop/src/assistant-stream.ts` 的 `AssistantStreamAttempt`。`push(chunk)` 依次做三件事：

- 喂给 `AssistantStreamAccumulator`，这是唯一会落盘的路径，但它把连续同类 delta 压进一条记录，而不是逐条保存。
- 喂给内部的 `BlockAssembler`，拼出完整的 `ContentBlock[]`，请求成功后用来构造 `AssistantMessage`。
- `emit` 一个 `AssistantStreamFrame`（`start`、`chunk`、`end` 三种，`chunk` 帧带 `attemptId`、单调递增的 `revision`、`index` 与时间），经 `dispatch.emit('agent/assistant-stream', { frame })` 广播。这一步不落盘，只是进程内实时通知。

请求结束时才真正写日志。`live.settle('assistant/message', () => this.session.append(...))` 先执行写入，成功才把 `terminal` 置位，并发出一个 `outcome: { kind: 'committed', eventType, seq }` 的 `end` 帧；`append` 抛异常则走 `abandon()`，不发 committed。`settle` 的第一个参数还允许 `'assistant/attempt'`，即没有产出完整消息的尝试也可以记一条只带紧凑流的事件。取消场景下，`step()` 的 `catch` 里会用 `live.interruptedBlocks()` 截取用户已经看到的可见前缀，具体细节课程材料中未展开。

两条路径故意不耦合。没有任何浏览器连着，落盘照常进行；日志写入失败，已经发给 UI 的帧也不会被撤回。UI 展示的是"此刻模型说了什么"，日志记录的是"这次请求最终经得起回放的结果"。这也带来一个副作用：Host 与 Client 重连后想补回漏掉的片段，不能再指望重放一串 `assistant/chunk`，要靠专门的重连快照机制，课程把它留给第 06 章。

## BlockAssembler 的折叠

`packages/llm/llm/src/assembler.ts` 里的 `BlockAssembler` 用 `Map<number, PartialBlock>` 按内容块的 `index` 各自组装。`push()` 处理七种 chunk：`block-start` 登记顺序和初始状态；`text-delta` 与 `reasoning-delta` 累加文本；`tool-call-delta` 分别累加调用 id、名字（有则覆盖）和参数 JSON 片段；`block-end` 把该 `index` 钉成最终的 `ContentBlock`；`usage` 与 `finish` 记录用量和终止原因，`finish` 还带回 `replayState`。最后一个 `default` 分支调用 `assertNever`，新增 chunk 类型忘了处理会在编译期暴露。

有一条防线值得记住：每个分支在处理 delta 或 `block-end` 前都有 `if (partial.block) return`，即块一旦被 `block-end` 关闭，同一 `index` 上迟到的 delta 与重复的 `block-end` 都被忽略。某个 provider 有 bug 在关闭后又发 delta，最终组装出来的内容也仍然与流式展示给用户的一致，不会出现"界面看到的与历史里存的不同"。

`blocks()` 里还有一条更硬的规则：`finish.kind === 'max-tokens'` 时，所有 `tool-call` 块被整体过滤。一个被截成一半的参数，比如残缺的文件路径，一旦被当真执行可能出事，所以宁可这一步不调用任何工具。这与上一篇里 `step()` 对 `max-tokens` 直接返回的处理是配套的。

## 紧凑记录为什么无损

`AssistantStreamAccumulator`（`packages/llm/llm/src/assistant-stream.ts`）的思路是"打包连续同类 delta"。以文本为例：新到的 `text-delta` 如果与上一条记录类型相同、`index` 相同，且时间差 `safeGap(previous.lastTime, time)` 有效，就往上一条记录里追加 `dt`（相对上一个 chunk 的时间差）和 `texts`（文本片段），不新开记录；否则新开一条 `{ type: 'text-chunks', time0, index, dt: [], texts: [...] }`。`reasoning-delta` 同理，记录类型是 `reasoning-chunks`。`block-start`、`block-end`、`usage`、`finish` 这类每种最多出现一次或语义上不该合并的，原样存成 `{ type: 'chunk' }` 记录。

无损体现在可逆：`time0` 依次累加各个 `dt` 就是每个原始 chunk 的真实到达时间，`expandAssistantStream()` 据此展开出带时间戳的逐 chunk 序列，`assembleAssistantStream()` 可以把它重新喂回 `BlockAssembler`，得到与当初一致的组装结果。几十个连续的 `text-delta` 从几十条日志变成一条，回放保真度没有下降，只是换了更省空间的编码。

另有一个副产物：崩溃语义更干净。累加器的记录是在内存里增量构建、`settle()` 时才整体落盘的，所以流式过程中崩溃，这次尝试要么完整落盘，要么等于没有发生；早期"部分 chunk 已落盘、却没有 `assistant/message`"的中间状态不再出现。

## Client 端的再折叠

Host 到 Client 的传输层已经重组：原来的 `packages/host/apiproxy`（`FrameQueue`、`events.mux`）不复存在，改由 `packages/api/session-controller` 承担命令下发、远程事件订阅和断线重连快照，客户端的折叠器也从 `packages/client/runtime/src/client/sessions/partial.ts` 挪到了 `packages/client/ui-chat/src/client/conversation-nodes/partial.ts`。传输协议与重连细节课程放在第 06 章，这里只有一条原则保持不变：浏览器拿到原始流式数据后自己再折叠一遍，不盲信服务端算好的中间结果。

## 我的看法

这一节是判断，依据都来自材料。第一，实时帧与日志故意解耦，好处明确，但也意味着"UI 上看到过、日志里没有"是被允许的：日志写入失败时，界面已经展示过的内容不会撤回。这与全局那条"模型可见必须留痕"的纪律讲的是模型输入，不是用户界面输出，两者不矛盾，但读者容易混淆，值得留意区分。第二，紧凑流只在 `settle()` 时整体落盘，意味着一次很长的输出如果在中途进程崩溃，已经吐出的内容在日志里查不到，只能靠 UI 帧的实时消费方保留。对以"可回放调试"为卖点的设计，这是取舍的另一面，材料中未看到对这类中途崩溃内容的额外保存。

## 小结

- 管道分层清楚：adapter 只做协议转换并把所有失败归一为带稳定 `code` 的 `LlmError`，`llm/stream` waterfall 是插件介入请求发出前一刻的入口，`adapterStream()` 把异常统一转成 `finish` chunk。
- `AssistantStreamAttempt` 把每个 chunk 同时送给累加器（落盘）、`BlockAssembler`（组装）和实时帧（转发），`settle()` 才写一条日志事件；`BlockAssembler` 有迟到 delta 忽略与 `max-tokens` 过滤工具调用两条防线。
- 紧凑记录用打包连续同类 delta 降低日志体量，`expandAssistantStream()` 与 `assembleAssistantStream()` 保证可无损还原，回放保真度与存储效率不再对立。

对应原课程篇目：`04-Agent核心循环/03-流式输出管道-从StreamChunk到UI.md`。
