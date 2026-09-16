# 网络编程：HTTP 与 WebSocket

> 上一篇讲完了 Stream，这一篇用它作为基础，讲 Node 最核心的定位之一：写网络服务。`node:http` 不需要任何框架就能起一个真实可用的 HTTP 服务器；Node 18 之后全局内置的 `fetch` 让写客户端请求也不再需要额外依赖。WebSocket 部分这一篇不会引入 `ws` 第三方包（保持这门课的 devDependencies 精简），而是把 WebSocket 握手在 HTTP 层面到底做了什么彻底讲清楚——这是大多数人直接用 `ws` 库时被隐藏掉、但其实理解成本并不高的一段协议细节。

## 学习目标

- 用 `node:http` 写一个最小的 HTTP 服务器，理解请求处理器的基本形态
- 用 Node 内置的全局 `fetch` 发起客户端请求，了解 keep-alive 的作用
- 理解 WebSocket 握手在 HTTP 层面做了什么：`Upgrade` 头、`Sec-WebSocket-Key`/`Sec-WebSocket-Accept` 的计算规则
- 手写实现并用 RFC 6455 官方示例核对 `Sec-WebSocket-Accept` 的计算是否正确

## `node:http`：创建服务器的最小示例

```ts
import http from "node:http";

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

server.listen(0, "127.0.0.1", () => {
	// address 里能拿到操作系统实际分配的端口号
});
```

`createServer` 接受一个 `(req, res) => void` 的请求处理器，Node 为每个到达的请求调用一次——这就是最基础的 HTTP 服务器，不需要引入 Express/Koa 这类框架。监听端口传 `0` 是一个实用技巧：让操作系统自动分配一个当前空闲的端口，避免教学/测试场景下"端口被占用"的冲突问题，实际分配到的端口通过 `server.address()` 拿到。

## 用内置的全局 `fetch` 请求这个服务器

```ts
const response = await fetch(`${baseUrl}/api/status`);
const body = await response.json();
```

真实输出：

```text
[http-server] 服务器已监听 -> http://127.0.0.1:50284
[http-server] fetch 自身状态码 -> 200
[http-server] fetch 返回的 JSON -> {"ok":true,"receivedAt":"2026-09-16T11:23:43.738Z"}
[http-server] 未知路由状态码 -> 404
[http-server] 服务器已关闭，进程即将退出
```

Node 18 之后默认全局提供 `fetch`（底层由 undici 实现，行为和浏览器里的 `fetch` 基本一致），这意味着写服务端脚本调用自己或调用别的 HTTP 服务，不再需要 `axios`/`node-fetch` 这类第三方依赖。这里同时演示了访问已注册路由（`/api/status`，返回 200）和未知路由（`/nope`，返回 404）两种情况。

关于**长连接与 keep-alive**：Node 全局 `fetch`（undici）默认会对同一个 origin 尝试复用底层 TCP 连接——避免每次请求都重新走一遍 TCP 三次握手（以及如果是 HTTPS，还有额外的 TLS 握手）。上面例子里两次 `fetch` 都请求同一个 `baseUrl`，很可能复用了同一条连接。keep-alive 省掉的是"重复建立连接"这部分开销，不会让单次请求的服务端处理时间变快——它优化的是"频繁请求同一个后端"场景下的整体延迟，而不是单次请求本身的处理速度。

## WebSocket 握手：本质上是一次特殊的 HTTP 请求

WebSocket 常被当作一个和 HTTP 完全独立的协议来理解，但连接建立的**第一步**完全跑在 HTTP 协议之上：客户端发送一个普通的 HTTP `GET` 请求，带上几个特殊头部：

```text
GET /chat HTTP/1.1
Host: example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

`Upgrade: websocket` + `Connection: Upgrade` 这两个头告诉服务端"我想把这条 TCP 连接从 HTTP 协议切换成 WebSocket 协议"；`Sec-WebSocket-Key` 是客户端随机生成、经过 base64 编码的一段数据。如果服务端愿意升级，会返回状态码 `101 Switching Protocols`，并带上一个 `Sec-WebSocket-Accept` 头——这个值**不是**服务端随便给的，而是必须按 RFC 6455 规定的算法，由客户端发来的 `Sec-WebSocket-Key` 计算出来，用来向客户端证明"服务端确实理解并正确处理了这是一次 WebSocket 握手请求"，而不是被某个完全不认识 WebSocket 协议、只会机械地转发 HTTP 请求的中间代理误处理了。握手成功、双方都确认这一步之后，同一条 TCP 连接才会真正切换成 WebSocket 自己的二进制帧协议——这一步之后的帧格式解析，本篇不展开，生产代码请直接使用成熟的 `ws` 库处理。

## `Sec-WebSocket-Accept` 的计算规则

RFC 6455 第 1.3 节规定的算法是：把客户端的 `Sec-WebSocket-Key` 字符串，和一个协议写死的固定 GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` 直接拼接，对拼接结果算 SHA-1 哈希，再把哈希结果做 base64 编码：

```ts
import { createHash } from "node:crypto";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function computeAcceptValue(secWebSocketKey: string): string {
	return createHash("sha1")
		.update(secWebSocketKey + WEBSOCKET_GUID, "utf8")
		.digest("base64");
}
```

这个固定 GUID 存在的意义和 `Sec-WebSocket-Accept` 本身一样：防止普通的 HTTP 服务器（不理解 WebSocket 协议）意外地对一个"看起来像是"WebSocket 握手的请求给出一个"看起来合理"的响应——因为响应值的计算依赖这个协议规范里的固定常量，只有真正实现了 WebSocket 握手逻辑的服务端才能算出正确的值。

## 用 RFC 6455 官方示例核对实现

RFC 6455 第 1.3 节给出了一组官方示例：客户端 `Sec-WebSocket-Key` 是 `dGhlIHNhbXBsZSBub25jZQ==`，规范文档写明服务端应该回复的 `Sec-WebSocket-Accept` 是 `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`。这一步不能只是"引用规范里写的值"就假设自己的实现是对的，必须真的拿这组输入跑一遍自己的代码，核对输出是否和规范给出的期望值完全一致：

```ts
const RFC6455_EXAMPLE_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const RFC6455_EXPECTED_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

const computedAccept = computeAcceptValue(RFC6455_EXAMPLE_KEY);
```

真实输出（用 `npx tsx` 实际跑出来的结果）：

```text
[RFC 6455 核对] 客户端 Sec-WebSocket-Key -> dGhlIHNhbXBsZSBub25jZQ==
[RFC 6455 核对] 本实现计算出的 Accept    -> s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
[RFC 6455 核对] 规范文档给出的期望 Accept -> s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
[RFC 6455 核对] 两者是否一致 -> true
```

计算结果和 RFC 6455 官方示例给出的期望值**完全一致**——这证明了上面 `computeAcceptValue` 的实现（SHA-1 拼接固定 GUID 再 base64 编码）是正确的，不是凭空相信规范文档的描述，而是拿规范自己给出的测试向量实际验证过的。

基于这个核对过的函数，可以拼出一个最小的握手响应示例：

```text
HTTP/1.1 101 Switching Protocols\r\n
Upgrade: websocket\r\n
Connection: Upgrade\r\n
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n
\r\n
```

**再次强调**：这一篇只演示握手这一步的计算，不实现握手成功之后的帧编解码协议（数据帧的分片、掩码处理、ping/pong 控制帧等）——生产环境的 WebSocket 服务端/客户端应该直接使用成熟的 `ws` 库（或者框架内置的 WebSocket 支持），它们正确处理了协议里这些容易出错的细节；这一篇的目的仅仅是把"握手到底在算什么"这个经常被库隐藏掉的部分讲透。

## 小结

`node:http` 的 `createServer` 不需要任何框架就能起一个真实的 HTTP 服务，Node 18+ 内置的全局 `fetch` 让客户端请求不再需要额外依赖，keep-alive 复用 TCP 连接优化的是"频繁请求同一后端"场景下的整体延迟。WebSocket 连接建立的第一步是一次带 `Upgrade: websocket` 头的普通 HTTP 请求，服务端需要按 RFC 6455 规定的算法（`Sec-WebSocket-Key` + 固定 GUID 做 SHA-1、再 base64 编码）算出正确的 `Sec-WebSocket-Accept` 才能完成握手——这一篇实际跑了 RFC 6455 给出的官方测试向量，确认自己实现的计算结果和规范期望值完全一致。生产环境的完整 WebSocket 协议实现（帧解析、掩码、控制帧）应该使用 `ws` 库。下一篇讲子进程与 Worker Threads，会讲清楚"另开一个完全独立的进程"和"在同一进程内开一个新线程"这两种并行方式的本质区别，以及各自的适用场景。
