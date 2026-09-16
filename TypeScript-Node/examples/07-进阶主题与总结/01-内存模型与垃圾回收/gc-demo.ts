// ===== 运行方式 =====
// 需要 --expose-gc 这个 Node flag 才能拿到 global.gc()，
// 实测在 Node v26.5.0 + tsx v4.23.13 下可用的命令：
//
//   node --expose-gc --import tsx "gc-demo.ts"
//
// --expose-gc 是给 node 可执行文件本身的 flag，必须写在 --import tsx 前面；
// tsx 只负责把 .ts 转译成可执行的 JS，不会影响 V8 层面暴露的全局对象。

const BYTES_PER_MB = 1024 * 1024;

function formatMb(bytes: number): string {
	return `${(bytes / BYTES_PER_MB).toFixed(2)}MB`;
}

// ===== 1. 故意制造一个"内存泄漏"：全局数组只增不减 =====
// 真实项目里最常见的泄漏形态就是这样——一个本该是局部缓存的数组/Map
// 被挂在模块作用域甚至全局对象上，代码里只有 push，没有对应的清理逻辑。

interface LeakedRecord {
	id: number;
	payload: string;
}

const leakedRecords: LeakedRecord[] = [];

function leakSomeMemory(recordCount: number, payloadLength: number): void {
	for (let i = 0; i < recordCount; i++) {
		// 注意：这里故意用普通 JS 对象/字符串而不是 Buffer.alloc——
		// Node 对较大的 Buffer 会走 V8 堆外的分配路径（体现在
		// process.memoryUsage().external，而不是 heapUsed），用 Buffer
		// 演示反而看不到 heapUsed 增长。普通对象/字符串完全分配在
		// V8 管理的堆上，heapUsed 的变化才能直接反映"泄漏"的效果。
		leakedRecords.push({ id: i, payload: "x".repeat(payloadLength) });
	}
}

function printHeapUsed(label: string): void {
	const { heapUsed } = process.memoryUsage();
	console.log(`[gc-demo] ${label} -> heapUsed = ${formatMb(heapUsed)}`);
}

// ===== 2. 用 WeakRef 包裹一个对象，观察它在失去强引用后被回收 =====
// WeakRef 不会阻止 GC 回收它指向的对象；FinalizationRegistry 可以在对象
// 被回收后收到一次通知（时机不确定，不能用来做业务逻辑，只适合调试/缓存清理场景）。

interface CacheEntry {
	id: number;
	payload: string;
}

function describeEntry(entry: CacheEntry | undefined): string {
	if (entry === undefined) {
		return "undefined（已被回收）";
	}
	return `{ id: ${entry.id}, payload 长度: ${entry.payload.length} }`;
}

function createWeaklyHeldObject(): WeakRef<CacheEntry> {
	// 这个对象只在函数作用域内被强引用；函数返回后，
	// 唯一还"看得到"它的只剩 WeakRef 本身，不会阻止 GC 回收它。
	let entry: CacheEntry | undefined = { id: 1, payload: "x".repeat(1000) };
	const ref = new WeakRef(entry);
	entry = undefined; // 显式断开这个作用域内的强引用
	return ref;
}

async function main(): Promise<void> {
	console.log("===== 内存泄漏模拟：全局数组不断 push =====");
	printHeapUsed("泄漏前");

	const RECORD_COUNT = 200_000;
	const PAYLOAD_LENGTH = 50;
	leakSomeMemory(RECORD_COUNT, PAYLOAD_LENGTH);

	printHeapUsed(`泄漏后（已 push ${RECORD_COUNT} 条记录，每条 payload 长度 ${PAYLOAD_LENGTH}）`);
	console.log(
		`[gc-demo] leakedRecords.length = ${leakedRecords.length} —— 这些对象只要还挂在这个数组上，` +
			"就永远不会被 GC 回收，这正是内存泄漏的本质：不是「GC 不工作」，而是「代码里还有一根引用没断」。",
	);

	console.log("\n===== WeakRef 演示：失去强引用后 deref() 变成 undefined =====");
	const weakRef = createWeaklyHeldObject();
	console.log(`[gc-demo] 创建后立刻 deref() -> ${describeEntry(weakRef.deref())}`);

	if (typeof global.gc !== "function") {
		console.log(
			"[gc-demo] global.gc 不可用——请加上 --expose-gc 参数运行：" +
				"node --expose-gc --import tsx gc-demo.ts",
		);
		return;
	}

	// 手动触发一次全量 GC。生产代码里绝不应该调用 global.gc()——
	// 这里纯粹是为了让"对象被回收"这件事在演示中变成确定性的、可观察的。
	global.gc();
	// 实测发现：仅调用一次 global.gc() 往往还不够——WeakRef 的清理
	// 是在 GC 的收尾阶段异步排入的，需要让出一次宏任务（这里用
	// setImmediate）,再触发第二次 GC，才能稳定观察到 deref() 变成
	// undefined。只用微任务（比如 Promise.resolve()）让出控制权是不够的，
	// 必须是宏任务。这也是"不要依赖 GC 时机做业务逻辑"这条告诫的
	// 具体体现：GC 什么时候真正跑完、什么时候清理弱引用，是引擎实现细节，
	// 不同 Node/V8 版本之间可能有差异。
	await new Promise((resolve) => setImmediate(resolve));
	global.gc();

	console.log(`[gc-demo] 手动 global.gc() 之后 deref() -> ${describeEntry(weakRef.deref())}`);
	console.log(
		"[gc-demo] deref() 变成 undefined，说明那个对象已经被回收——" +
			"它的唯一强引用（函数内的局部变量 entry）在 createWeaklyHeldObject 返回前就已经被置空。",
	);

	// 清理泄漏的数组，避免这个演示脚本本身退出时留下不必要的常驻内存占用，
	// 也顺便展示"修复内存泄漏"最直接的方式就是让引用可达性变成 false。
	leakedRecords.length = 0;
	console.log("\n[gc-demo] 演示结束，已清空 leakedRecords，脚本正常退出。");
}

await main();
