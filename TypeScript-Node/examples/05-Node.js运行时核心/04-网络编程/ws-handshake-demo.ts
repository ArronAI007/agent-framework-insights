import { createHash } from "node:crypto";

// ===== WebSocket 握手：本质上是一次带特殊头部的 HTTP GET 请求 =====
// WebSocket 连接建立的第一步完全跑在 HTTP 协议之上：客户端发一个 HTTP 请求，
// 带上 Upgrade: websocket、Connection: Upgrade，以及一个随机生成的
// Sec-WebSocket-Key；服务端如果同意升级协议，就返回状态码 101 Switching Protocols，
// 并带上一个 Sec-WebSocket-Accept 头——这个值不是随便给的，而是按 RFC 6455
// 规定的算法，由客户端发来的 Sec-WebSocket-Key 计算出来的，用来证明服务端
// "确实读懂了这是一个 WebSocket 握手请求"，而不是被一个不理解 WebSocket 的
// 中间代理误转发的普通 HTTP 请求。握手成功之后，同一条 TCP 连接才会被双方
// 切换成 WebSocket 的二进制帧协议——本文件只演示握手这一步的计算，不实现后续的帧解析。

// RFC 6455 第 1.3 节规定的固定 GUID：拼接在客户端 Key 后面参与哈希计算，
// 这个字符串是协议写死的常量，所有实现都必须用这同一个值。
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ===== Sec-WebSocket-Accept 计算：SHA-1(key + GUID) 再 base64 编码 =====
function computeAcceptValue(secWebSocketKey: string): string {
	return createHash("sha1")
		.update(secWebSocketKey + WEBSOCKET_GUID, "utf8")
		.digest("base64");
}

// ===== 用 RFC 6455 官方例子核对实现是否正确 =====
// RFC 6455 第 1.3 节给出的示例：客户端 Sec-WebSocket-Key 是 "dGhlIHNhbXBsZSBub25jZQ=="，
// 规范里写明服务端应该回复的 Sec-WebSocket-Accept 是 "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="——
// 下面直接拿这组官方例子跑一遍自己的实现，核对算出来的值是否和规范一致，
// 而不是仅凭"这是 RFC 里的例子"就假设自己的代码一定对。
const RFC6455_EXAMPLE_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const RFC6455_EXPECTED_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

const computedAccept = computeAcceptValue(RFC6455_EXAMPLE_KEY);
console.log(`[RFC 6455 核对] 客户端 Sec-WebSocket-Key -> ${RFC6455_EXAMPLE_KEY}`);
console.log(`[RFC 6455 核对] 本实现计算出的 Accept    -> ${computedAccept}`);
console.log(`[RFC 6455 核对] 规范文档给出的期望 Accept -> ${RFC6455_EXPECTED_ACCEPT}`);
console.log(`[RFC 6455 核对] 两者是否一致 -> ${computedAccept === RFC6455_EXPECTED_ACCEPT}`);

if (computedAccept !== RFC6455_EXPECTED_ACCEPT) {
	throw new Error("握手计算结果和 RFC 6455 官方示例不一致，实现有误");
}

// ===== 一个最小的"握手请求 -> 握手响应"演示（只做字符串拼接，不真正建立连接）=====
// 生产环境请直接使用成熟的 ws 库（或框架内置的 WebSocket 支持）——它们正确处理了
// 分片帧、控制帧（ping/pong/close）、掩码（客户端到服务端的帧必须加掩码）等一整套
// 协议细节，这里只是把"握手阶段到底在算什么"这一步单独拆出来讲清楚。
function buildHandshakeResponse(secWebSocketKey: string): string {
	const accept = computeAcceptValue(secWebSocketKey);
	return [
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Accept: ${accept}`,
		"",
		"",
	].join("\r\n");
}

const exampleResponse = buildHandshakeResponse(RFC6455_EXAMPLE_KEY);
console.log("[握手响应示例] 服务端应该回复的原始 HTTP 响应头：");
console.log(exampleResponse.replace(/\r\n/g, "\\r\\n\n"));
