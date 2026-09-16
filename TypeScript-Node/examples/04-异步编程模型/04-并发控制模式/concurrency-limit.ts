// ===== 为什么需要限制并发 =====
// Promise.all 是"天真并发"：数组里的所有任务在调用的一瞬间就已经全部启动了，
// Promise.all 只是负责等它们都完成。如果这些任务是"批量调用外部 API"，
// 天真并发意味着 100 条数据就会同时发出 100 个请求——很容易触发对方的限流，
// 或者直接打满本机的连接数/内存。真实场景通常需要"限制同时在跑的任务数"。

// ===== runWithConcurrencyLimit：自己实现的受限并发执行器 =====
// 思路：维护一个"正在运行的任务数"，每当有任务完成，就从剩余任务里再取一个补上，
// 始终保持"同时在跑的任务数不超过 limit"，不依赖任何第三方库。
async function runWithConcurrencyLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let nextIndex = 0;

	// worker：一个"循环领取任务"的执行单元，领到就跑，跑完继续领下一个，直到任务耗尽
	async function worker(): Promise<void> {
		while (nextIndex < tasks.length) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			results[currentIndex] = await tasks[currentIndex]!();
		}
	}

	// 同时启动 min(limit, tasks.length) 个 worker，它们会互相"抢"剩余的任务，
	// 这样任意时刻真正在执行的任务数量都不会超过 limit。
	const workerCount = Math.min(limit, tasks.length);
	const workers = Array.from({ length: workerCount }, () => worker());
	await Promise.all(workers);

	return results;
}

// ===== 模拟异步任务：记录"任务开始时的时间戳"，用来验证并发是否真的被限制住 =====
function makeTask(label: string, durationMs: number, startedAt: number[]): () => Promise<string> {
	return () =>
		new Promise((resolve) => {
			startedAt.push(Date.now());
			console.log(`任务 ${label} 开始，相对时间 +${Date.now() - startedAt[0]!}ms`);
			setTimeout(() => resolve(`${label} 完成`), durationMs);
		});
}

async function demoNaiveConcurrency(): Promise<void> {
	console.log("===== limit=Infinity（等价于 Promise.all 的天真并发，全部同时开始）=====");
	const startedAt: number[] = [Date.now()];
	const tasks = Array.from({ length: 5 }, (_, i) => makeTask(`T${i}`, 30, startedAt));
	const results = await runWithConcurrencyLimit(tasks, Number.POSITIVE_INFINITY);
	console.log(`全部完成 -> ${results.join(", ")}`);
}

async function demoLimitedConcurrency(): Promise<void> {
	console.log("===== limit=2（受限并发，同时最多 2 个任务在跑）=====");
	const startedAt: number[] = [Date.now()];
	const tasks = Array.from({ length: 5 }, (_, i) => makeTask(`T${i}`, 30, startedAt));
	const results = await runWithConcurrencyLimit(tasks, 2);
	console.log(`全部完成 -> ${results.join(", ")}`);
}

async function main(): Promise<void> {
	await demoNaiveConcurrency();
	console.log("---");
	await demoLimitedConcurrency();
}

await main();
