# 会话事件溯源：Session Event Log 与 Surface

这一篇回答的问题是：`dsh` 里为什么没有一个"当前消息列表"的可变数组，模型看到的历史到底是怎么从日志里算出来的，压缩又怎么做到不删原文。

结论有三句。`Session` 只有一个写入口 `append()`，日志只追加、写入即深度冻结；Surface 是日志之上的一层可重写索引，`append` 往尾部加节点，`replace` 用一个新节点遮蔽一段旧范围，原始事件从不被改动；`deriveMessages()`、`requestHeader()`、`requestContext()` 都只是对日志的缓存投影，缓存丢了随时能重算。样稿已经讲过三层结构的概念，本篇往下看事件词表、折叠算法和写入校验的具体落点。

## 日志里记什么

事件词表定义在 `packages/core/session/src/types.ts` 的 `SessionEventMap`，它是可合并扩展的类型，插件用 `declare module` 加入自己的事件。例如 `agent/inbox/spliced` 是 `packages/core/agent` 合并进来的；早期内置的 `todo/write` 现在也不在核心词表里，而是由 `packages/todo/tool-todo` 合并进来。

按语义分，事件有四类。第一类是边界标记：`turn/start`、`turn/end`（带 `reason`）、`step/start`、`step/end`，不产生任何消息，只是回放和定位用的书签。第二类是五种产生模型消息的事件：`user/message`、`system/message`、`developer/message`、`assistant/message`（可带 `usage`）、`tool/result`（可带 `error` 和 `meta`）。第三类是过程记录：`assistant/attempt` 携带一次请求尝试的紧凑流 `stream: AssistantStreamRecord[]`，`tool/call` 记录模型发出的原始调用，其中 `arguments` 是模型输出的未解析 JSON 字符串。第四类是请求状态：`request/header`、`request/context`、`session/end-seed`。

早期版本里的 `assistant/chunk`（每个原始 chunk 一条事件）在当前格式中已不存在，只在旧格式迁移代码里能看到。会话格式当前已演进到 V4，`packages/session/` 下保留着从 `session-format-v0-to-v1` 到 `session-format-v3-to-v4` 的完整迁移链。这条链本身说明了一件事：日志格式是会演进的，读旧日志靠迁移，而不是靠读取者兼容一切。

`request/header` 值得单独看。它记录"下一次请求会用的配置"，并带一个 `RequestHeaderReason`：`initial` 是日志里的第一条；`resume` 是同一份日志上、这个进程实例第一次发请求（重启或 fork 种子恢复之后）；`change` 是配置变了；`series` 是配置没变，但显式开启了新的消息系列，或紧跟在一次 Surface 替换之后。有了这四个原因，事后可以分清配置是何时真的变化的，而不是每次请求都重复一份。

另一条保守规则挂在 `SessionEvent` 的 `ignorable` 标记上：读取者遇到不认识的事件类型时，默认必须拒绝重建整个会话，因为这条事件可能改变后续内容的解读方式；只有显式标了 `ignorable: true` 的纯信息记录才允许跳过。

## Surface 的折叠

五类产生消息的事件构成 `SurfaceEventType`，其中 `system/message` 和 `developer/message` 是后来才加入的（最初只有后三种）。写入时要用 `SurfaceOp` 声明意图：

```typescript
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
```

折叠逻辑在 `packages/core/session/src/surface.ts`。`foldSurface()` 一次性折叠整份日志，`SurfaceManager` 是 `Session` 内部持有的增量版本，二者共用 `applySurfacePlan`，它只有三个分支。`append` 把事件 seq 推入 `state.nodes`；`replace` 用 `nodes.splice(startIdx, endIdx - startIdx + 1, seq)` 把一段连续的旧 seq 换成一个新 seq，同时让 `replaceGeneration` 与 `contentGeneration` 各加一；`project` 服务于 `SessionMessageProjection` 机制，把某个事件在投影层对应的消息登记进 `projectedMessages`，并让 `contentGeneration` 加一。

要点在于 `replace` 改的只是 `nodes` 这个"当前可见"的索引，被换掉的旧事件仍然原样留在 `log` 里。所谓"日志不可变、视图可重写"，在代码上就是这一行 `splice` 作用于索引而非日志。

替换的正确性靠写入时的校验保证。新事件的 `sourceEventSeqs` 必须完整覆盖被遮蔽的每一个 surface 节点，缺一个就抛出 `surface replace: sourceEventSeqs must include every shadowed surface node`。`startSeq` 和 `endSeq` 两端也必须是当前 surface 上真实存在的节点。这样"这条摘要替换了哪些原始事件"的血缘不是约定，而是 `Session.append()` 会真的拒绝违规写入的约束。

## 节点怎么变成消息

Surface 节点到 `Message` 的投影集中在纯函数 `deriveEventMessage()`。先查 `projectedMessages`，命中就直接用（登记过的投影优先于内置规则）；否则按类型：`user/message` 返回数据本身，`tool/result` 返回其 `message`，`system/message`、`developer/message`、`assistant/message` 在 `content` 为空数组时返回 `null`，其余类型一律返回 `null`。

空内容返回 `null` 这条规则对应一个具体场景：一个 step 因 `max-tokens` 被截断，模型什么都没产出，只留下一份 usage 统计。这个事件要保留，好让用量账目完整，但它不能在派生历史里变成一条空的 assistant 发言，否则下一次请求里会出现语义上没有意义的空轮次。节点还在 surface 上占着位置，只是不进请求。

## deriveMessages：靠代次做增量

`Session.deriveMessages()` 是外部拿到完整历史的唯一入口，`buildRequest()` 每次组装请求前都会调它。它内部保留了 `derived` 数组、已处理的节点数 `derivedNodes` 和上次见到的 `derivedGeneration`：

```typescript
if (generation !== this.derivedGeneration) {
  this.derived = []; this.derivedNodes = 0; this.derivedGeneration = generation
}
for (const seq of nodes.slice(this.derivedNodes)) {
  const msg = this.deriveEventMessage(this.log[seq]!)
  if (msg) this.derived.push(msg)
}
this.derivedNodes = nodes.length
return [...this.derived]
```

`contentGeneration` 不变，说明这段时间只发生过 `append`，只需投影新增节点；一变，说明发生过替换或投影更新，缓存整体重建。没有压缩发生的正常对话，每次调用的开销是新增节点数，而不是整份历史。返回的是数组的拷贝，外部拿到后无法污染缓存。`requestHeader()` 和 `requestContext()` 用的是同一个模式：缓存最近一次折叠结果，日志是唯一权威，缓存只是性能优化。

## append：写入路径上的三道闸

所有投影之所以可信，是因为 `append()` 把校验焊死在了写入口。第一，类型层面：签名里用条件类型 `T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []`，让"Surface 事件必须带 `surfaceOp`、其余事件禁止带"在编译期就被检查。第二，运行时用 `snapshotJsonValue` 做 JSON 无损校验，`BigInt`、函数、`Symbol`、循环引用一律拒绝，因为日志必须能逐字节持久化并重放；不可序列化时抛出 `session event "..." carries non-JSON-serializable data`。第三，事件构造出来后立刻 `deepFreeze`，`seq` 取当前日志长度，`time` 取 `Date.now()`，随后 `surfaceManager.validateNext(event)` 校验 surface 语义，通过才 `push` 进日志。事件一旦入日志就连自己都不可变，后续代码没有"悄悄改一下历史"的机会。

## 一个完整案例：RuntimeContextProjection

样稿讲过它做去重，这里看它如何在不持有独立持久状态的前提下做到重启后仍然正确。它只有一个内存字段 `retained`，取值有三种：`undefined` 表示从没写过，`null` 表示写过但已不可见，对象表示当前可见的最近快照（含 `seq` 与 `text`）。

构造时先做一次性回溯：把当前 surface 的节点放进 Set，从日志尾部往前找自己写过的 `user/message`（由 `isOwned` 判定），第一个出现在 surface 上的就是 `retained`，途中见过但不在 surface 上的，把 `retained` 置为 `null`。此后订阅 `session/event`，只处理本会话的事件：看到自己新写的快照就更新，看到替换事件的 `sourceEventSeqs` 里包含 `retained.seq` 就置 `null`。`project()` 里，`retained` 为 `undefined` 且当前文本为空时什么都不做；当前文本为空但之前写过，会写入一个 `CLEARED` 标记；文本与 `retained.text` 相同则返回 `undefined`。

这个模式可以概括成：状态是日志的函数，构造时从日志重算，运行时靠事件订阅维持一致。任何需要跨进程记住点什么的插件都应该照这个写法，而不是另开一份独立于日志的持久状态。

## 我的看法

这一节是判断。这套设计的代价主要在两处，且材料里都有迹可循。一是 `deriveMessages()` 每次返回 `[...this.derived]` 的拷贝，缓存命中时仍是 O(已有消息数) 的复制，而不是它文中强调的 O(新增节点数)。严格地说，"增量"只体现在投影环节，复制成本没有省掉；对几千条事件的会话大概不是瓶颈，但这是文中"数量级差别"说法需要限定的地方。二是 `contentGeneration` 是全局计数：任何一次 `replace` 或 `project` 都会让整份缓存重建，材料中没有看到按范围局部失效的机制。压缩发生频率低，这个取舍目前合理，但如果 `project` 的使用变得频繁，重建会变得常见。

## 小结

- 日志是唯一事实来源：只追加、深度冻结、强 JSON 校验，事件词表可被插件合并扩展，读取者遇到未知类型默认拒绝重建。
- Surface 是日志上的可重写索引：`append` 加节点，`replace` 遮蔽旧范围并要求 `sourceEventSeqs` 完整覆盖，`project` 登记投影消息；`contentGeneration` 决定 `deriveMessages()` 是增量追加还是整体重建。
- 派生状态一律可重算：`RuntimeContextProjection` 是范本，构造时回溯、运行时订阅，重启和压缩之后都不需要额外快照。

对应原课程篇目：`04-Agent核心循环/02-会话事件溯源-SessionEventLog与Surface.md`。
