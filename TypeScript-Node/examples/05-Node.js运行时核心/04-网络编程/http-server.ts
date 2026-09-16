import http from "node:http";

// ===== node:http：创建服务器的最小示例 =====
// createServer 接受一个 (req, res) => void 的请求处理器，Node 会为每个到达的请求
// 调用一次这个处理器——不需要引入任何框架（Express/Koa 等）就能跑一个真实的 HTTP 服务。
const server = http.createServer((req, res) => {
	if (req.url === "/api/status" && req.method === "GET") {
		const payload = JSON.stringify({ ok: true, receivedAt: new Date().toISOString() });
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(payload);
		return;
	}
	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: false, error: "not found" }));
});

// ===== 监听端口 0：让操作系统分配一个当前空闲的随机端口 =====
// 教学/测试场景下用端口 0 而不是写死一个固定端口号，能避免"端口被占用"的冲突问题；
// listen() 的回调触发后，可以通过 server.address() 拿到操作系统实际分配的端口号。
server.listen(0, "127.0.0.1", () => {
	void runClientRequest();
});

async function runClientRequest(): Promise<void> {
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("未能获取到服务器监听地址");
	}
	const baseUrl = `http://127.0.0.1:${address.port}`;
	console.log(`[http-server] 服务器已监听 -> ${baseUrl}`);

	// ===== fetch：Node 内置的全局 API，不需要额外安装任何 HTTP 客户端库 =====
	// Node 18+ 默认全局提供 fetch，行为和浏览器里的 fetch 基本一致（同一份 undici 实现），
	// 这意味着写服务端脚本调用自己/别的 HTTP 服务，不再需要 axios/node-fetch 这类第三方依赖。
	const response = await fetch(`${baseUrl}/api/status`);
	const body = (await response.json()) as { ok: boolean; receivedAt: string };
	console.log(`[http-server] fetch 自身状态码 -> ${response.status}`);
	console.log(`[http-server] fetch 返回的 JSON -> ${JSON.stringify(body)}`);

	const notFoundResponse = await fetch(`${baseUrl}/nope`);
	console.log(`[http-server] 未知路由状态码 -> ${notFoundResponse.status}`);

	// ===== HTTP keep-alive 简述 =====
	// Node 的全局 fetch（基于 undici）默认会对同一个 origin 复用底层 TCP 连接（keep-alive），
	// 避免每次请求都重新走一次 TCP 三次握手；上面两次 fetch 请求同一个 baseUrl，
	// 实际上很可能复用了同一条连接——这也是为什么"频繁请求同一个后端"场景下
	// keep-alive 能显著降低延迟：省掉的是重复建立连接的开销，而不是请求本身的处理时间。

	// 演示结束，关闭服务器，让进程能自然退出（否则 http server 会一直持有事件循环）
	server.close(() => {
		console.log("[http-server] 服务器已关闭，进程即将退出");
	});
}
