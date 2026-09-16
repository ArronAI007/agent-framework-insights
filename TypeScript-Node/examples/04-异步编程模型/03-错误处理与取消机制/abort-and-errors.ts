// ===== 自定义 Error 子类：让错误携带结构化信息，而不只是一句字符串 =====
// extends Error 之后，instanceof 检查能在 catch 块里精确区分「这是哪一种错误」，
// 比在错误消息字符串里做子串匹配可靠得多，也是很多校验库/框架的标准做法。
class ValidationError extends Error {
	constructor(
		message: string,
		public readonly field: string,
	) {
		super(message);
		this.name = "ValidationError";
	}
}

class NotFoundError extends Error {
	constructor(public readonly resourceId: string) {
		super(`资源不存在: ${resourceId}`);
		this.name = "NotFoundError";
	}
}

function validateAge(age: number): void {
	if (age < 0 || age > 150) {
		throw new ValidationError(`age 取值不合法: ${age}`, "age");
	}
}

// ===== try/catch/finally 在 async 函数里的语义 =====
// async 函数内部 throw 出的同步异常、以及 await 到的 rejected Promise，
// 都会被外层的 try/catch 当作同一件事捕获——这正是 async/await 作为
// Promise 语法糖最大的价值：可以用写同步代码的 try/catch 心智去处理异步错误。
async function demoTryCatchFinally(): Promise<void> {
	try {
		validateAge(-5);
	} catch (error) {
		// instanceof 区分错误类型：不同类型的错误可能需要完全不同的处理策略
		if (error instanceof ValidationError) {
			console.log(`[try/catch] 捕获到 ValidationError，字段=${error.field}，消息=${error.message}`);
		} else if (error instanceof NotFoundError) {
			console.log(`[try/catch] 捕获到 NotFoundError，资源=${error.resourceId}`);
		} else {
			console.log(`[try/catch] 捕获到未知错误 -> ${String(error)}`);
		}
	} finally {
		// finally 无论 try 是否抛错都会执行，常用于释放资源（关闭连接、清理临时文件等）
		console.log("[try/catch] finally 块执行——无论成功失败都会跑到这里");
	}
}

// ===== AbortController / AbortSignal：跨 API 统一的取消机制 =====
// AbortController 不是 Promise 专属的取消方案——fetch、fs 的部分 API、以及很多用户自定义的
// 异步函数都约定接受一个 signal 参数，靠同一套机制统一实现"取消"。
// 这里用它包装一个"永远不会 resolve 的 Promise"，靠超时触发 abort 来强制它失败。
function neverResolves(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		// 如果调用方已经在传入前就 abort 了，直接立刻 reject，不用等事件触发
		if (signal.aborted) {
			reject(new Error("任务尚未开始就已经被取消"));
			return;
		}
		signal.addEventListener("abort", () => {
			reject(new Error(`任务被取消，原因: ${String(signal.reason)}`));
		});
		// 注意：这个 Promise 本身除了 abort 事件，没有任何其他途径会 resolve/reject，
		// 完全依赖外部的取消信号来终结它——这正是"给一个天然不会结束的操作加超时"的标准写法。
	});
}

async function demoAbortController(): Promise<void> {
	const controller = new AbortController();
	const timeoutMs = 50;
	setTimeout(() => controller.abort(`超过 ${timeoutMs}ms 未完成，主动超时`), timeoutMs);

	const startedAt = Date.now();
	try {
		await neverResolves(controller.signal);
	} catch (error) {
		const elapsed = Date.now() - startedAt;
		const message = error instanceof Error ? error.message : String(error);
		console.log(`[AbortController] ${elapsed}ms 后捕获到取消错误 -> ${message}`);
	}
}

// ===== unhandledRejection：Promise 的 reject 没有被任何 catch 处理时触发 =====
// 生产代码里应该保证每个 Promise 链都有 catch/try 兜底；这里故意制造一次
// "没人处理的 rejection"，靠监听 process 上的 unhandledRejection 事件来演示
// Node 如何暴露这种"本该被处理却被漏掉"的错误。
function triggerUnhandledRejection(): void {
	// 故意不 await、也不 .catch()，让这个 rejection 变成"未处理"状态
	Promise.reject(new Error("故意制造的未处理 rejection，用来演示 unhandledRejection 事件"));
}

async function demoUnhandledRejection(): Promise<void> {
	const caught = new Promise<void>((resolve) => {
		process.once("unhandledRejection", (reason) => {
			const message = reason instanceof Error ? reason.message : String(reason);
			console.log(`[unhandledRejection] 捕获到未处理的 rejection -> ${message}`);
			resolve();
		});
	});
	triggerUnhandledRejection();
	await caught;
}

async function main(): Promise<void> {
	await demoTryCatchFinally();
	console.log("---");
	await demoAbortController();
	console.log("---");
	await demoUnhandledRejection();
}

await main();
