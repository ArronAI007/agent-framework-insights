# Stream 流式处理

> 上一篇的 `readFile`/`writeFile` 有一个隐含的前提：把整个文件内容一次性读进内存。处理几 KB 的配置文件没问题，但如果是几 GB 的日志文件、或者一个持续产生数据的网络连接，"一次性读全部到内存"要么不现实，要么完全没必要——数据应该"边到达边处理"，而不是等全部到齐。这正是 Stream 要解决的问题。这一篇讲 Stream 的四种类型、背压这个核心概念，以及为什么应该用 `pipeline()` 而不是手写 `.pipe()` 链。

## 学习目标

- 认识 `Readable`/`Writable`/`Duplex`/`Transform` 四种流的角色分工
- 理解背压（backpressure）：当下游处理跟不上上游产出速度时会发生什么
- 掌握 `node:stream/promises` 的 `pipeline()`，理解它相比手写 `.pipe()` 链的可靠性优势

## 四种流：`Readable`/`Writable`/`Duplex`/`Transform`

Stream 抽象的核心是"数据分块（chunk）流动"，四种流按"数据能往哪个方向流动"划分角色：

- **`Readable`**（可读流）：数据源，只能被"读出"——比如从文件读取内容、从网络连接接收数据。
- **`Writable`**（可写流）：数据的终点，只能被"写入"——比如写入文件、发送到网络连接。
- **`Duplex`**（双工流）：同时具备可读和可写两端，但两端是**独立**的数据流——典型例子是 TCP socket，"往里写"和"从里读"是两条互不相关的数据流。
- **`Transform`**（转换流）：`Duplex` 的一种特殊形式，写进去的每个 chunk 会经过一次自定义处理逻辑，再从可读端流出去——是"数据流经的过程中被加工一次"的标准实现方式，比如压缩、加密、文本大小写转换。

## 自定义 `Transform` 流：把流过的文本转成大写

```ts
class UppercaseTransform extends Transform {
	override _transform(
		chunk: Buffer | string,
		_encoding: BufferEncoding,
		callback: (error?: Error | null, data?: unknown) => void,
	): void {
		const text = chunk.toString("utf8").toUpperCase();
		this.push(text);
		callback();
	}
}
```

`_transform` 是 Stream 机制里的核心钩子：每当上游写入一个 chunk，Node 就会调用一次这个方法。方法里 `this.push(text)` 把处理完的数据推给下游（可读端），最后**必须**调用 `callback()` 告诉流"这个 chunk 处理完了，可以继续处理下一个"——这是新手容易踩的坑：如果 `_transform` 里某个分支忘了调用 `callback`，整条流会永久卡在那一步，既不报错也不继续，调试起来相当隐蔽。

## 用 `pipeline()` 把流连接起来

```ts
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const source = Readable.from(["a", "b", "c"]);
const collected: string[] = [];
const sink = new Writable({
	write(chunk, _encoding, callback) {
		collected.push(chunk.toString("utf8"));
		callback();
	},
});

await pipeline(source, new UppercaseTransform(), sink);
```

真实输出：

```text
[pipeline] 收集到的结果 -> ["A","B","C"]
[pipeline] 拼接后的完整字符串 -> ABC
```

`Readable.from(["a", "b", "c"])` 把一个普通数组包装成一个 `Readable` 流（每个数组元素作为一个 chunk 依次产出），经过自定义的 `UppercaseTransform` 转成大写，最后被自定义的 `Writable` 收集进数组——完整验证了数据确实按 `a -> A`、`b -> B`、`c -> C` 的方式流经了整条管道。

## 为什么用 `pipeline()` 而不是手写 `.pipe()` 链

`.pipe()` 链（`a.pipe(b).pipe(c)`）是 Stream API 里更早出现的写法，语法上确实更短，但有一个在生产代码里很致命的缺陷：**`.pipe()` 不会自动把错误从下游传播、或者从上游传播——任何一环出错，都需要给链上的每一个流单独手动挂 `error` 事件监听器**，稍不注意漏掉一个，这一环的错误就会变成一个未被处理的事件，甚至直接让进程崩溃（如果是 `EventEmitter` 上抛出但没人监听的 `error` 事件，Node 会把它当作未捕获异常处理）。更麻烦的是，出错时链上其他流不一定会被正确关闭——比如上游是一个打开的文件句柄，中游转换出错之后，如果没有额外代码去关闭上游，文件句柄可能一直不释放，长期运行的服务里这类问题会逐渐累积成资源泄漏。

`node:stream/promises` 提供的 `pipeline()` 函数统一处理了这些问题：它会监听链上所有流的错误和关闭事件，任意一环出错时自动销毁（destroy）整条链上的其他流，并把错误通过一个 `Promise` reject 出来，调用方只需要一个 `await`/`try...catch` 就能可靠地捕获"链上任意位置出的任何错误"，不需要给每个中间环节单独挂监听器。这也是为什么 Node 官方文档现在明确建议：处理流的组合，优先用 `pipeline()`，只有在非常简单、不关心错误处理健壮性的临时脚本里才考虑直接用 `.pipe()`。

## 背压（backpressure）：写入速度快于消费速度时会发生什么

背压是 Stream 体系里最容易被忽视、但对内存使用影响很大的一个机制。每个可写流内部有一个缓冲区，大小上限由 `highWaterMark` 选项决定；当调用 `writable.write(chunk)` 时，如果写入之后内部缓冲区的数据量超过了 `highWaterMark`，`write()` 会返回 `false`，这就是**背压信号**——它在告诉调用方"我这边已经积压了，建议先暂停写入，等我消化完触发 `drain` 事件再继续"。如果调用方完全无视这个返回值、拼命调用 `write()`，缓冲区会无限增长，最终把内存写爆——这正是"自己纯手写循环调用 `write()` 而不理会返回值"在处理大文件/大流量场景下最容易踩的坑；`.pipe()` 和 `pipeline()` 都在内部自动处理了背压（收到 `false` 就暂停上游的 `Readable`，等 `drain` 事件再恢复），手写循环则需要自己实现这套暂停/恢复逻辑。

```ts
const smallBufferSink = new Writable({
	highWaterMark: 1, // 故意设得很小，便于观察背压信号
	write(chunk, _encoding, callback) {
		collected.push(chunk.toString("utf8"));
		setImmediate(callback); // 模拟异步处理，不立刻消化掉缓冲区
	},
});
const writeOk = smallBufferSink.write("x".repeat(1024));
```

真实输出：

```text
[背压] write() 返回值（false 表示建议暂停写入）-> false
```

这里 `highWaterMark` 故意设成 1 字节，单次写入的 chunk（1024 字节）本身就已经远超这个上限，`write()` 立刻返回 `false`，如实反映了"缓冲区已经超出建议上限"这个状态。值得注意的是：如果 `write` 回调里同步调用 `callback()`（而不是像这里用 `setImmediate` 延后），缓冲区可能在同一时刻就被清空，观察不到背压——这也是本例特意用 `setImmediate` 模拟"下游处理不是瞬间完成的"这个更贴近真实场景的假设。

## 小结

`Readable`/`Writable`/`Duplex`/`Transform` 四种流按数据流动方向分工：可读流只出、可写流只入、双工流两端独立、转换流在流动过程中加工数据。自定义 `Transform` 流的核心是实现 `_transform` 钩子，处理完调用 `push()` 推给下游、并且必须调用 `callback()` 才能让流继续处理下一个 chunk。`pipeline()`（`node:stream/promises`）相比手写 `.pipe()` 链，最大的优势是自动处理错误传播和资源清理——任意一环出错会自动销毁整条链，错误通过一个 Promise 统一捕获，这是 Node 官方现在推荐的组合流的标准方式。背压是可写流内部缓冲区超过 `highWaterMark` 时通过 `write()` 返回 `false` 发出的信号，`.pipe()`/`pipeline()` 会自动响应这个信号暂停上游，手写循环处理大数据量时如果忽视这个信号会有内存被写爆的风险。下一篇进入网络编程，会讲 `node:http` 创建服务器、内置的全局 `fetch`，以及 WebSocket 握手在 HTTP 层面到底做了什么。
