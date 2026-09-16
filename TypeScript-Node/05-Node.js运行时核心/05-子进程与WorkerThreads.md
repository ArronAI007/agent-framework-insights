# 子进程与 Worker Threads

> 上一篇讲完了网络编程，这一篇讲 Node 里两种"让工作不只挤在一条主线程上"的方式：开子进程（`child_process`）和开 Worker 线程（`worker_threads`）。这两者经常被笼统地归到"并行处理"这个大类下，但它们的隔离级别、通信方式、适用场景完全不同——搞混这两者，要么是该用进程隔离的场景用了共享内存的线程（引入不必要的数据竞争风险），要么是该用轻量线程的场景开了一堆重量级进程（浪费内存和启动开销）。

## 学习目标

- 分清 `child_process.spawn`/`exec`/`execFile`/`fork` 各自的定位和适用场景
- 理解 `worker_threads` 和子进程的本质区别：共享内存 vs 完全隔离
- 掌握 `parentPort`/`workerData` 这套 Worker 通信模型
- 理解为什么本篇的 worker 脚本要用 `.cjs` 而不是让 `tsx` 处理 TS

## `child_process` 的四个 API：怎么选

`child_process` 模块提供了四种启动子进程的方式，核心差异在"怎么拿到输出"和"要不要经过 shell"：

- **`spawn(command, args)`**：最底层、最灵活的方式，返回的子进程对象把 `stdout`/`stderr` 暴露成 `Readable` 流，适合输出量可能很大、或者需要边产出边处理的场景（比如长时间运行、持续打印日志的命令行工具）。默认**不**经过 shell 解析，`args` 以数组形式传递，避免了 shell 注入的风险。
- **`exec(command)`**：把命令交给 shell 解析（支持管道 `|`、通配符等 shell 语法），全部输出会被一次性攒进内存，通过回调一次性拿到——适合"输出量小、只关心最终结果"的一次性命令，但因为经过 shell，如果命令字符串里拼接了不可信的用户输入，存在命令注入风险，应该避免直接拼接外部输入。
- **`execFile(file, args)`**：和 `exec` 类似（一次性拿到全部输出），但不经过 shell，直接执行指定的可执行文件，`args` 以数组形式传递——兼具 `exec` 的"简单拿结果"和 `spawn` 的"不走 shell、更安全"。
- **`fork(modulePath)`**：`spawn` 的一个特化版本，专门用来启动另一个 **Node.js** 脚本作为子进程，并自动建立一条基于 IPC 的消息通道（子进程里能直接用 `process.send()`/`process.on("message")` 和父进程通信），常用于"把一部分 CPU 密集型或需要隔离的 Node 逻辑放到独立进程里"的场景。

## `spawn`：启动子进程，收集 stdout，等待退出码

```ts
import { spawn } from "node:child_process";

const child = spawn("node", ["-e", "console.log('hi from child')"]);

let stdoutData = "";
child.stdout.on("data", (chunk: Buffer) => {
	stdoutData += chunk.toString("utf8");
});

child.on("close", (code) => {
	console.log(`[spawn] 子进程 stdout -> ${JSON.stringify(stdoutData.trim())}`);
	console.log(`[spawn] 子进程退出码  -> ${code}`);
});
```

真实输出：

```text
[spawn] 子进程 stdout -> "hi from child"
[spawn] 子进程 stderr -> ""
[spawn] 子进程退出码  -> 0
```

这里用 `node -e "..."` 当作子进程命令，而不是依赖某个系统自带的 shell 命令（比如 `echo`），是为了保证这个例子在任何装了 Node 的机器上都能跑，不受操作系统差异影响。`"close"` 事件（而不是 `"exit"` 事件）在子进程的 `stdio` 流被**完全消费完**之后才触发，用它来确认"输出真的都收全了"比 `"exit"` 更可靠——`"exit"` 触发时，`stdout`/`stderr` 流里可能还有数据没被读完。

## `worker_threads` 与子进程的本质区别

`child_process` 启动的是一个完全独立的**操作系统进程**：独立的内存地址空间、独立的 V8 实例。父子进程之间**没有任何内存是共享的**，唯一的通信方式是 IPC（进程间通信，比如管道、Unix domain socket），任何要传递的数据都必须先序列化（通常是 JSON）再通过 IPC 通道发送、在对方进程反序列化。这种完全隔离带来的好处是**容错性最强**——子进程崩溃（比如未捕获异常导致进程退出）不会直接影响父进程，代价是进程创建本身有明显的启动开销（fork 一个新进程、初始化一个新的 V8 实例都不是免费的），且每次通信都有序列化/反序列化成本。

`worker_threads` 启动的是**同一个进程内的独立线程**：每个 worker 线程仍然有自己独立的 V8 堆（JS 对象本身不能被两个线程直接共享访问，避免了传统多线程语言里"两个线程同时读写同一个对象"的数据竞争问题），但 JS 标准提供的 `SharedArrayBuffer` 可以被多个 worker 线程共享同一块**原始二进制内存**——线程间基于 `SharedArrayBuffer` 的通信开销比跨进程的序列化通信小得多。这种"线程内隔离但可选共享原始内存"的模型，适合"CPU 密集型计算需要并行、又不想付出完整进程隔离代价"的场景，比如图片/视频处理、大规模数值计算、压缩解压这类不涉及太多 I/O、纯粹需要多核并行跑计算的任务。

## `parentPort`/`workerData`：Worker 的通信模型

```ts
// worker-main.ts —— 主线程
import { Worker } from "node:worker_threads";

const worker = new Worker(new URL("./worker-script.cjs", import.meta.url), {
	workerData: { a: 2, b: 3 },
});

worker.on("message", (result: { sum: number }) => {
	console.log(`[worker_threads] worker 传回的结果 -> 2 + 3 = ${result.sum}`);
	void worker.terminate();
});
```

```js
// worker-script.cjs —— worker 线程
const { parentPort, workerData } = require("node:worker_threads");

const { a, b } = workerData;
const sum = a + b;
parentPort.postMessage({ sum });
```

真实输出：

```text
[worker_threads] worker 传回的结果 -> 2 + 3 = 5
```

`workerData` 是创建 `Worker` 实例时传入的初始数据，worker 线程内部通过 `worker_threads` 模块的 `workerData` 导出拿到；`parentPort` 是 worker 线程和主线程之间的双向消息端口，worker 用 `parentPort.postMessage()` 把结果发回主线程，主线程通过监听 `worker` 实例的 `"message"` 事件接收。这套通信本质上是一种"结构化克隆"（structured clone）——能传递大部分 JS 内置类型（对象、数组、`Map`/`Set`、`ArrayBuffer` 等），但不能直接传递函数或某些带有运行时状态的对象（比如打开的文件句柄），和跨进程 IPC 的"必须能被序列化"这个限制类似，只是不需要真正转成 JSON 文本。

另外注意：`worker.terminate()` 是必须显式调用的一步——worker 线程默认会一直存活、持有事件循环，即使主线程的逻辑已经跑完，如果不主动终止 worker，进程也不会自然退出。

## 为什么 worker 脚本用 `.cjs` 而不是 `.ts`

这是本篇一个容易被忽视、但对"代码到底能不能跑起来"很关键的细节：`npx tsx worker-main.ts` 启动主线程时，tsx 做的事情是给**当前进程**注册一个 TS 转译的模块加载钩子——这个钩子只在启动它的那一个线程/进程上下文里生效。`new Worker(...)` 创建的是一个全新的、独立的线程（背后对应一个新的 V8 隔离环境），Node 加载这个新线程的入口脚本时，走的是全新的、干净的模块加载流程，**并不会自动继承主线程注册过的 tsx 加载器**——如果 worker 脚本本身是一个 `.ts` 文件，Node 会尝试用默认的方式加载它，由于不认识 TS 语法而失败。

针对这个问题有几种可能的解法：给 worker 也单独配置一次加载器注入（增加复杂度和一处容易被遗漏的配置）、或者更省心的做法——**直接让 worker 脚本是一个纯 JS 的 `.cjs` 文件**，完全不涉及 TS 转译这一步。这门课选择了后者：worker 逻辑通常比较独立、职责单一（这里就是"把两个数字相加"），用纯 JS 写没有额外成本，还避免了"worker 内部代码到底有没有正确经过转译"这类不必要的排错。

## 小结

`spawn` 适合输出量大或需要流式处理的场景，`exec`/`execFile` 适合一次性拿到全部输出的简单命令（注意 `exec` 经过 shell、存在命令注入风险，不可信输入应优先用 `execFile`），`fork` 专门用于启动带 IPC 通道的 Node 子脚本。`child_process` 提供的是完全隔离的独立操作系统进程（容错性最强、开销最大），`worker_threads` 提供的是同进程内的独立线程（各自 V8 堆隔离、可选通过 `SharedArrayBuffer` 共享原始内存，适合 CPU 密集型并行计算）。`parentPort`/`workerData` 是 worker 线程的标准通信模型，本质是结构化克隆式的消息传递。由于 `new Worker()` 创建的新线程不会继承主线程注册的 tsx 加载器，本篇的 worker 脚本选择直接用不需要转译的纯 JS `.cjs` 文件，这是实践中最省心的规避方式。下一篇是这一章的最后一篇，讲进程生命周期和优雅关闭——把这一篇学到的"进程"概念延伸到"一个 Node 进程从启动到退出，应该如何正确响应终止信号"这个生产环境绕不开的问题。
