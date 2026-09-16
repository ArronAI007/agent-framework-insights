import { Worker } from "node:worker_threads";

// ===== worker_threads vs child_process：本质区别 =====
// child_process.spawn 启动的是一个完全独立的操作系统进程：独立的内存空间、
// 独立的 V8 实例，进程间通信只能靠 IPC（管道/socket），开销相对大，
// 但隔离性最强——一个子进程崩溃不会直接波及父进程。
// worker_threads 启动的是同一个进程内的独立线程：仍然有各自独立的 V8 堆
// （不能直接共享 JS 对象），但可以通过 SharedArrayBuffer 共享同一块原始内存，
// 线程间通信开销比跨进程小得多，适合"CPU 密集型计算需要并行、又不想付出
// 完整进程隔离代价"的场景（比如图片处理、大规模数据转换）。

// ===== 用 new URL(..., import.meta.url) 定位同目录下的 worker 脚本 =====
// 这是 ESM 下引用"非 import 语句、需要运行时动态解析路径"的资源的标准写法——
// import.meta.url 给出当前模块自己的 URL，new URL(relativePath, base) 在此基础上
// 解析出目标文件的绝对 URL，Worker 构造函数接受这个 URL 作为 worker 脚本的入口。
const worker = new Worker(new URL("./worker-script.cjs", import.meta.url), {
	workerData: { a: 2, b: 3 },
});

worker.on("message", (result: { sum: number }) => {
	console.log(`[worker_threads] worker 传回的结果 -> 2 + 3 = ${result.sum}`);
	// 显式终止 worker 线程，让进程能自然退出——worker 线程默认会一直存活、
	// 持有事件循环，不主动 terminate 的话主线程即使逻辑跑完也不会退出。
	void worker.terminate();
});

worker.on("error", (error) => {
	console.error(`[worker_threads] worker 出错 -> ${error.message}`);
	process.exit(1);
});
