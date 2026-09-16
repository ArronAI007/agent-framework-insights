// ===== 工具函数：模拟一个耗时的异步任务 =====
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== Promise 状态机：pending -> fulfilled / pending -> rejected，且不可逆 =====
// 一个 Promise 一旦 settle（变成 fulfilled 或 rejected），状态和结果值就永久固定，
// 后续再调用 resolve/reject 都不会有任何效果——这里故意调用两次 resolve 来验证这一点。
const settledOnce = new Promise<string>((resolve, reject) => {
	resolve("第一次 resolve 生效");
	resolve("第二次 resolve —— 会被忽略");
	reject(new Error("resolve 之后再 reject 也没用"));
});
settledOnce.then((value) => console.log(`[状态机] settledOnce -> ${value}`));

// ===== Promise.all：快速失败（fail-fast）=====
// 只要有一个任务 reject，Promise.all 立刻整体 reject，不会等其他任务跑完；
// 其他仍在进行中的任务不会被取消，只是它们的结果不再被 Promise.all 关心。
async function demoPromiseAll(): Promise<void> {
	const taskA = delay(30).then(() => "A 完成");
	const taskB = delay(10).then(() => {
		throw new Error("B 失败（10ms 后）");
	});
	const taskC = delay(50).then(() => "C 完成（会跑完，但结果不会被 Promise.all 用到）");

	try {
		const results = await Promise.all([taskA, taskB, taskC]);
		console.log(`[Promise.all] 不应该走到这里 -> ${results}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.log(`[Promise.all] 整体 reject，捕获到最先失败的错误 -> ${message}`);
	}
	// 等 taskC 真正跑完，证明它没有被取消——只是 Promise.all 已经不再等它了
	await delay(60);
	console.log("[Promise.all] 60ms 后，taskC 其实也已经在后台跑完了");
}

// ===== Promise.allSettled：等全部完成，收集每一个的成功/失败结果 =====
// 不管成功还是失败，Promise.allSettled 都会等所有任务 settle 之后统一返回，
// 每一项结果都是 { status: "fulfilled", value } 或 { status: "rejected", reason } 的形状。
async function demoPromiseAllSettled(): Promise<void> {
	const results = await Promise.allSettled([
		delay(20).then(() => "任务1 成功"),
		delay(10).then(() => {
			throw new Error("任务2 失败");
		}),
		delay(15).then(() => "任务3 成功"),
	]);
	for (const [index, result] of results.entries()) {
		if (result.status === "fulfilled") {
			console.log(`[Promise.allSettled] 第 ${index} 项 fulfilled -> ${result.value}`);
		} else {
			const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
			console.log(`[Promise.allSettled] 第 ${index} 项 rejected -> ${reason}`);
		}
	}
}

// ===== async generator：逐步产出数据，用 for await...of 消费 =====
// async function* 声明的生成器每次 yield 的是一个 Promise（这里 yield 的值会被自动包装），
// for await...of 会依次 await 每一次 yield，天然适合「边产出边消费」的流式场景，
// 比如分页拉取远程数据、逐条处理文件行等，而不需要一次性把所有数据攒进内存再处理。
async function* fetchPagesLazily(totalPages: number): AsyncGenerator<string, void, unknown> {
	for (let page = 1; page <= totalPages; page++) {
		await delay(10); // 模拟每一页都要等一次网络请求
		yield `第 ${page} 页数据（共 ${totalPages} 页）`;
	}
}

async function demoAsyncGenerator(): Promise<void> {
	for await (const pageData of fetchPagesLazily(3)) {
		console.log(`[async generator] 消费到 -> ${pageData}`);
	}
	console.log("[async generator] 所有分页消费完毕");
}

// ===== 依次运行三个演示，避免输出交叉难以阅读 =====
async function main(): Promise<void> {
	await demoPromiseAll();
	console.log("---");
	await demoPromiseAllSettled();
	console.log("---");
	await demoAsyncGenerator();
}

await main();
