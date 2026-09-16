import http from "node:http";

// ===== 这是一个交互式脚本，设计为手动用 Ctrl+C 测试，不会自动跑完退出 =====
// 启动方式：npx tsx "examples/05-Node.js运行时核心/06-进程生命周期/graceful-shutdown.ts"
// 启动后按 Ctrl+C（发送 SIGINT），观察打印出来的关闭日志；
// 也可以在另一个终端用 `kill -TERM <pid>` 发送 SIGTERM，效果等价。
// 因为这个脚本要等待外部信号才会退出，所以本篇不把它纳入 Step 11 的自动化验证列表，
// 只用 `npm run typecheck` 覆盖它的类型正确性。

let activeRequestsInFlight = 0;

const server = http.createServer((req, res) => {
	activeRequestsInFlight += 1;
	console.log(`[graceful-shutdown] 收到请求 ${req.url}，当前处理中的请求数 -> ${activeRequestsInFlight}`);
	// 模拟一个耗时 3 秒的请求处理，方便在关闭期间观察"等现有请求完成"这一步
	setTimeout(() => {
		activeRequestsInFlight -= 1;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
		console.log(`[graceful-shutdown] 请求 ${req.url} 处理完成，剩余处理中的请求数 -> ${activeRequestsInFlight}`);
	}, 3000);
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	const port = address !== null && typeof address !== "string" ? address.port : "unknown";
	console.log(`[graceful-shutdown] 服务器已启动 -> http://127.0.0.1:${port}`);
	console.log("[graceful-shutdown] 按 Ctrl+C 触发优雅关闭（可以先用浏览器/curl 访问一次上面的地址，再按 Ctrl+C，观察它等请求处理完才退出）");
});

// ===== process.on("exit")：只能做同步收尾，不能等异步操作 =====
// "exit" 事件触发时，事件循环实际上已经没有更多工作要做了——这个回调里
// 不能再注册新的异步任务（定时器、Promise 等都不会被执行），只适合做
// 日志打印这类纯同步的收尾工作。真正"等待现有请求处理完"这种异步逻辑，
// 必须在收到 SIGTERM/SIGINT 信号的时候就开始做，而不能指望在 exit 事件里做。
process.on("exit", (code) => {
	console.log(`[graceful-shutdown] process exit 事件，最终退出码 -> ${code}`);
});

// ===== 标准优雅关闭模式：停止接收新连接 -> 等现有请求完成 -> 退出 =====
function shutdown(signal: NodeJS.Signals): void {
	console.log(`[graceful-shutdown] 收到信号 ${signal}，开始优雅关闭...`);

	// server.close() 会立刻停止接受新连接，但不会强行打断已经在处理中的请求——
	// 它的回调会在"所有已建立的连接都已关闭"之后才触发。
	server.close(() => {
		console.log("[graceful-shutdown] 所有连接已关闭，进程正常退出");
		process.exit(0);
	});

	// 兜底超时：如果现有请求迟迟处理不完（比如卡死、或者故意拖了很久），
	// 不能让进程无限期挂起等下去——设置一个上限，超时后直接强制退出，
	// 避免优雅关闭本身变成了"永远关不掉"。
	const FORCE_EXIT_TIMEOUT_MS = 5000;
	setTimeout(() => {
		console.log(`[graceful-shutdown] 超过 ${FORCE_EXIT_TIMEOUT_MS}ms 仍未正常关闭，强制退出`);
		process.exit(1);
	}, FORCE_EXIT_TIMEOUT_MS).unref(); // unref：这个兜底定时器本身不应该阻止进程正常退出
}

// SIGINT：终端里按 Ctrl+C 发出的信号；SIGTERM：`kill <pid>` 默认发送的信号，
// 也是容器编排系统（如 Kubernetes）在停止容器前通知进程"该退出了"时使用的信号。
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
