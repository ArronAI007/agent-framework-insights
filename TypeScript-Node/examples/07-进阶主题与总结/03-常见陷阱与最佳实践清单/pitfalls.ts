// ===== 常见陷阱：错误写法 vs 正确写法，成对可运行验证 =====
// 每一组都会实际执行两种写法并打印结果，用打印出来的差异证明
// "这两种写法的行为确实不一样"，而不是只在注释里空谈。

import { setTimeout as delay } from "node:timers/promises";

// ===== 1. == 隐式转换陷阱 =====
// 用 unknown 来存这些待比较的值，而不是直接写字面量——这不是为了绕开
// 示例的重点，而是更接近真实场景：== 的陷阱几乎总是发生在"值从外部
// 输入进来、编译期类型已经收窄成 unknown/any"的地方（查询参数、
// JSON.parse 的结果……）。事实上，如果两个操作数是编译期就能确定的
// 具体类型（比如直接写 "0" == 0），tsc 在 strict 模式下会直接报
// "This comparison appears to be unintentional" 拒绝编译——这本身也说明
// 了一个道理：TypeScript 的类型系统已经在替你挡掉了很大一部分 == 的
// 陷阱，真正危险的永远是类型信息已经丢失（unknown/any）之后的比较。
interface LooseEqualityCase {
	left: unknown;
	right: unknown;
	expr: string;
}

function demoLooseEquality(): void {
	console.log("\n===== 1. == 隐式类型转换陷阱 =====");

	const cases: LooseEqualityCase[] = [
		{ left: "0", right: 0, expr: '"0" == 0' },
		{ left: "", right: 0, expr: '"" == 0' },
		{ left: false, right: "0", expr: 'false == "0"' },
		{ left: null, right: undefined, expr: "null == undefined" },
	];

	// ❌ 错误写法：用 == 比较，触发隐式类型转换，结果经常违反直觉
	for (const { left, right, expr } of cases) {
		console.log(`[❌ ==] ${expr} -> ${left == right}`);
	}

	// ✅ 正确写法：用 === 严格比较，不做隐式类型转换——类型不同就直接
	// 判定为不相等（除了 null === undefined 这一条，两者本来就不相等，
	// 用 === 才能把它们和"值恰好相等"的情况区分开）
	for (const { left, right, expr } of cases) {
		const strictExpr = expr.replace("==", "===");
		console.log(`[✅ ===] ${strictExpr} -> ${left === right}`);
	}
}

// ===== 2. 忘记 await 导致悬空 Promise =====
async function riskyWrite(id: number): Promise<void> {
	await delay(5);
	if (id === 2) {
		throw new Error(`写入 id=${id} 失败（模拟）`);
	}
}

async function demoDanglingPromise(): Promise<void> {
	console.log("\n===== 2. 忘记 await 导致悬空 Promise =====");

	// ❌ 错误写法：调用了返回 Promise 的函数但不 await，也不 catch。
	// riskyWrite(2) 内部会 reject，但这个 rejection 没有被任何地方处理，
	// 只能被 process.on("unhandledRejection") 兜底观察到——业务代码里
	// 完全看不出这里发生过错误，调用方以为"调用完就万事大吉"。
	let unhandledCaught: string | undefined;
	const unhandledListener = (reason: unknown): void => {
		unhandledCaught = reason instanceof Error ? reason.message : String(reason);
	};
	process.on("unhandledRejection", unhandledListener);

	console.log("[❌ 悬空 Promise] 调用 riskyWrite(2) 但不 await...");
	void riskyWrite(2); // 故意不 await，模拟"忘记写 await"（用 void 只是让 tsc 知道这是有意为之，不是漏写）
	await delay(20); // 等一小段时间让 unhandledRejection 事件有机会触发
	console.log(
		`[❌ 悬空 Promise] 函数调用后的代码已经继续往下跑了，错误只能靠 unhandledRejection 事件兜底捕获到 -> ${
			unhandledCaught ?? "（未捕获到，说明这次没触发，风险依然存在）"
		}`,
	);
	process.off("unhandledRejection", unhandledListener);

	// ✅ 正确写法：await + try/catch，错误在调用处就被显式处理
	try {
		console.log("[✅ 正确 await] 调用 riskyWrite(2) 并 await + try/catch...");
		await riskyWrite(2);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.log(`[✅ 正确 await] 错误在调用处被直接捕获 -> ${message}`);
	}
}

// ===== 3. for...in 遍历数组的隐患 =====
function demoForInOnArray(): void {
	console.log("\n===== 3. for...in 遍历数组的隐患 =====");

	const numbers = [10, 20, 30];
	// 给数组对象挂一个自定义属性——真实项目里，第三方库或框架给数组
	// 附加元数据（比如 Vue 2 的响应式实现）并不罕见。
	(numbers as unknown as Record<string, unknown>).source = "sensor-A";

	// ❌ 错误写法：for...in 遍历的是"可枚举属性名"，不是"数组索引"，
	// 会把 source 这个非索引属性也遍历进来，而且顺序不保证是索引顺序。
	const forInVisited: string[] = [];
	for (const key in numbers) {
		forInVisited.push(key);
	}
	console.log(`[❌ for...in] 遍历到的 key -> ${JSON.stringify(forInVisited)}（混入了非索引属性 "source"）`);

	// ✅ 正确写法：for...of 或 .forEach 只关心元素值，不会被额外的可枚举
	// 属性干扰
	const forOfVisited: number[] = [];
	for (const value of numbers) {
		forOfVisited.push(value);
	}
	console.log(`[✅ for...of] 遍历到的元素 -> ${JSON.stringify(forOfVisited)}`);
}

// ===== 4. 闭包共享可变状态 =====
function demoSharedMutableClosure(): void {
	console.log("\n===== 4. 闭包共享可变状态 =====");

	// ❌ 错误写法：三个函数共享同一个可变的 counters 对象，
	// 任何一个函数内部的修改都会"泄漏"给其他持有同一个闭包变量的调用方。
	function makeWrongCounters(): { increment: () => number; reset: () => void } {
		const state = { count: 0 };
		return {
			increment: () => ++state.count,
			reset: () => {
				state.count = 0;
			},
		};
	}
	const wrongA = makeWrongCounters();
	const wrongShared = wrongA; // 常见 bug 来源：以为是"拿到一个新实例"，其实是同一个引用
	wrongA.increment();
	wrongA.increment();
	wrongShared.reset(); // 这一行会意外清空 wrongA 的计数，因为两者是同一个闭包
	console.log(`[❌ 共享闭包] wrongA.increment() 两次后又被 wrongShared.reset() -> ${wrongA.increment()}`);

	// ✅ 正确写法：每次调用工厂函数都创建全新的、互不共享的状态
	function makeCounter(): { increment: () => number; reset: () => void; value: () => number } {
		let count = 0;
		return {
			increment: () => ++count,
			reset: () => {
				count = 0;
			},
			value: () => count,
		};
	}
	const counterA = makeCounter();
	const counterB = makeCounter();
	counterA.increment();
	counterA.increment();
	counterB.increment();
	console.log(
		`[✅ 独立闭包] counterA.value() -> ${counterA.value()}，counterB.value() -> ${counterB.value()}（互不影响）`,
	);
}

// ===== 5. any 类型逃逸导致类型系统形同虚设 =====
function demoAnyEscape(): void {
	console.log("\n===== 5. any 类型逃逸导致类型系统形同虚设 =====");

	interface Order {
		id: number;
		totalCents: number;
	}

	// ❌ 错误写法：用 any 接收外部数据，类型检查器对后续所有操作失去约束力，
	// 一个拼写错误的字段名在编译期完全不会被发现，只有运行时才炸。
	function wrongTotal(order: any): number {
		return order.totlaCents ?? 0; // 故意拼错 totalCents -> totlaCents
	}
	const parsedOrder: Order = { id: 1, totalCents: 5000 };
	console.log(`[❌ any 逃逸] wrongTotal(order) -> ${wrongTotal(parsedOrder)}（拼写错误被 any 悄悄放过了）`);

	// ✅ 正确写法：用具体类型（或至少 unknown + 类型收窄），
	// 拼写错误在编译期就会被 tsc 直接拒绝
	function correctTotal(order: Order): number {
		return order.totalCents;
	}
	console.log(`[✅ 具体类型] correctTotal(order) -> ${correctTotal(parsedOrder)}（字段名错误会在 typecheck 阶段报错）`);
}

// ===== 6. 浮点数精度问题 =====
function demoFloatingPointPrecision(): void {
	console.log("\n===== 6. 浮点数精度问题 =====");

	// ❌ 错误写法：直接用 === 比较两个浮点数运算结果
	const sum = 0.1 + 0.2;
	console.log(`[❌ 浮点比较] 0.1 + 0.2 === 0.3 -> ${sum === 0.3}（实际值是 ${sum}）`);

	// ✅ 正确写法：用一个足够小的误差范围（epsilon）判断"足够接近"，
	// 或者在涉及金额等场景直接用整数（分）而不是浮点小数（元）计算
	const EPSILON = 1e-10;
	const isCloseEnough = Math.abs(sum - 0.3) < EPSILON;
	console.log(`[✅ 误差范围比较] Math.abs(0.1 + 0.2 - 0.3) < 1e-10 -> ${isCloseEnough}`);
}

// ===== 7. 同步阻塞操作出现在请求处理路径里 =====
function demoSyncBlockingInHandler(): void {
	console.log("\n===== 7. 同步阻塞操作拖垮吞吐 =====");

	// ❌ 错误写法：用一个耗时的同步计算模拟 fs.readFileSync 这类阻塞调用——
	// 它会独占事件循环所在的这一条 JS 主线程，期间无法处理任何其他请求
	// （包括定时器、其他 I/O 回调），哪怕它们早就该被触发了。
	function blockingWork(iterations: number): number {
		let total = 0;
		for (let i = 0; i < iterations; i++) {
			total += Math.sqrt(i);
		}
		return total;
	}

	const BLOCKING_ITERATIONS = 50_000_000;
	let timerFired = false;
	const timerScheduledAt = performance.now();
	setTimeout(() => {
		timerFired = true;
	}, 0);

	const blockStart = performance.now();
	blockingWork(BLOCKING_ITERATIONS);
	const blockEnd = performance.now();

	console.log(
		`[❌ 同步阻塞] blockingWork 跑了 ${(blockEnd - blockStart).toFixed(2)}ms；` +
			`理论上 0ms 后就该触发的 setTimeout，在它跑完之前 timerFired 仍然是 -> ${timerFired}` +
			`（哪怕这个定时器在 ${(blockStart - timerScheduledAt).toFixed(2)}ms 前就已经被注册）`,
	);
	console.log(
		"[✅ 正确做法] 生产代码里应改用异步 API（如 fs.promises.readFile 而不是 fs.readFileSync），" +
			"或者把重计算丢给 Worker Thread（见第 05 章「子进程与 Worker Threads」），" +
			"避免独占事件循环所在的主线程。",
	);
}

// ===== 8. 忘记处理 AbortSignal / 超时导致资源泄漏 =====
async function demoMissingAbortHandling(): Promise<void> {
	console.log("\n===== 8. 忘记处理 AbortSignal / 超时导致资源泄漏 =====");

	// ❌ 错误写法：发起一个"至多等 10ms"的竞速，但从不 clearTimeout 那个
	// 用来实现"慢任务"的定时器——即便主任务已经通过 race 提前返回，
	// 那个定时器依然会在 50ms 后触发一次没人关心的 resolve，在真实服务里，
	// 这类"没人 clearTimeout/没人 abort"的悬空定时器/连接积累多了，
	// 就是典型的资源泄漏：进程会一直被这些没人关心的挂起任务拖住，
	// 既浪费内存，触发多了甚至会拖慢/拖住进程退出。
	//
	// 注意：函数本身把 slow 定时器的句柄返回出来，只是为了让这个演示脚本
	// 能确定性地清理收尾、正常退出——这一行"返回句柄"不是"修复"，
	// 现实中的 bug 恰恰就是调用方根本拿不到、也不会想着去 clearTimeout 它。
	function wrongRaceWithTimeout(): { result: Promise<string>; leakedTimer: NodeJS.Timeout } {
		let leakedTimer!: NodeJS.Timeout;
		const slow = new Promise<string>((resolve) => {
			leakedTimer = setTimeout(() => resolve("慢任务完成"), 50);
		});
		const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("超时"), 10));
		return { result: Promise.race([slow, timeout]), leakedTimer };
	}
	const wrongStart = performance.now();
	const { result: wrongResultPromise, leakedTimer } = wrongRaceWithTimeout();
	const wrongResult = await wrongResultPromise;
	console.log(
		`[❌ 无 AbortSignal] race 结果 -> "${wrongResult}"，耗时 ${(performance.now() - wrongStart).toFixed(2)}ms；` +
			"但那个 50ms 的 slow 定时器依然在后台占用着资源，直到它自己触发才会被回收，无法提前释放。",
	);
	// 仅为了让本脚本能立刻、确定性地退出，手动清理掉这个"泄漏"的定时器——
	// 真实的错误代码里不会有这一行。
	clearTimeout(leakedTimer);

	// ✅ 正确写法：用 AbortController 把"外部不再关心结果"这件事
	// 传递给真正在执行的任务，任务内部监听 signal 主动清理自己的资源
	async function correctRaceWithAbort(): Promise<string> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10);

		try {
			await delay(50, undefined, { signal: controller.signal });
			return "慢任务完成";
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				return "超时（已主动中止，底层定时器已被清理）";
			}
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	}
	const correctStart = performance.now();
	const correctResult = await correctRaceWithAbort();
	console.log(
		`[✅ 使用 AbortSignal] 结果 -> "${correctResult}"，耗时 ${(performance.now() - correctStart).toFixed(2)}ms；` +
			"10ms 超时后 controller.abort() 会让 delay() 内部主动清理自己的定时器，不会留下悬空资源。",
	);
}

async function main(): Promise<void> {
	demoLooseEquality();
	await demoDanglingPromise();
	demoForInOnArray();
	demoSharedMutableClosure();
	demoAnyEscape();
	demoFloatingPointPrecision();
	demoSyncBlockingInHandler();
	await demoMissingAbortHandling();

	console.log("\n[pitfalls] 全部陷阱演示运行完毕，脚本正常退出。");
}

await main();
