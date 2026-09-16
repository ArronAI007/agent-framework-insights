import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ===== fs/promises：readFile / writeFile / mkdir 的 Promise 版本 =====
// Node 的文件系统 API 提供三套并行的风格：
//   - 同步版（fs.readFileSync）：会阻塞整个事件循环，只适合启动阶段/脚本类场景
//   - 回调版（fs.readFile(path, cb)）：Node 最早的异步风格，容易写出回调地狱
//   - Promise 版（fs/promises 或 fs.promises）：能配合 async/await，是目前的推荐写法
// 三者背后是同一套底层实现（libuv 线程池），差别只在"给调用方的接口形状"。
async function demoReadWriteFile(): Promise<void> {
	// 写到 os.tmpdir() 下，避免污染仓库；mkdtemp 会在系统临时目录里创建一个随机命名的子目录，
	// 用固定前缀 + 随机后缀，避免和其他并发运行的进程/测试冲突。
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "ts-node-course-"));
	const filePath = path.join(tempDir, "note.txt");

	try {
		await writeFile(filePath, "先写入这一行文本\n第二行文本", "utf8");
		const content = await readFile(filePath, "utf8");
		console.log(`[fs/promises] 写入后读回的内容 -> ${JSON.stringify(content)}`);
	} finally {
		// 用完立刻清理临时文件/目录，不给系统留垃圾
		await rm(tempDir, { recursive: true, force: true });
		console.log(`[fs/promises] 已清理临时目录 -> ${tempDir}`);
	}
}

// ===== mkdir 的 { recursive: true }：一次性创建多级不存在的目录 =====
async function demoRecursiveMkdir(): Promise<void> {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "ts-node-course-nested-"));
	const nestedDir = path.join(tempDir, "a", "b", "c");
	await mkdir(nestedDir, { recursive: true });
	console.log(`[mkdir recursive] 一次性创建了多级目录 -> ${nestedDir}`);
	await rm(tempDir, { recursive: true, force: true });
}

// ===== Buffer 是什么：Uint8Array 的子类 =====
// Buffer 是 Node 特有的二进制数据容器，本质上是 JS 标准的 Uint8Array 的子类，
// 这意味着所有 Uint8Array 支持的操作（按下标访问字节、length、slice 等）Buffer 都支持，
// Buffer 在此基础上额外提供了编码转换、和字符串互操作等 Node 生态特有的便利方法。
function demoBufferIsUint8ArraySubclass(): void {
	const buf = Buffer.from("hi");
	console.log(`[Buffer] buf instanceof Uint8Array -> ${buf instanceof Uint8Array}`);
	console.log(`[Buffer] buf instanceof Buffer -> ${buf instanceof Buffer}`);
}

// ===== 字符串与 Buffer 互转，展示 hex / base64 两种编码 =====
function demoEncodingConversion(): void {
	const original = "TypeScript + Node.js 教程";
	const buf = Buffer.from(original, "utf8");
	const hexEncoded = buf.toString("hex");
	const base64Encoded = buf.toString("base64");
	console.log(`[编码转换] 原始字符串 -> ${original}`);
	console.log(`[编码转换] utf8 -> hex    -> ${hexEncoded}`);
	console.log(`[编码转换] utf8 -> base64 -> ${base64Encoded}`);

	// 反向转换：从 hex/base64 编码的 Buffer 转回原始字符串，验证是无损的
	const fromHex = Buffer.from(hexEncoded, "hex").toString("utf8");
	const fromBase64 = Buffer.from(base64Encoded, "base64").toString("utf8");
	console.log(`[编码转换] hex -> utf8 还原    -> ${fromHex}`);
	console.log(`[编码转换] base64 -> utf8 还原 -> ${fromBase64}`);
}

// ===== 直接操作 Buffer 字节 =====
// Buffer 支持像数组一样用下标读写单个字节（0-255 的整数），
// 这里把一个全是 "?" 的 Buffer，逐字节改写成 "ABCDE"。
function demoDirectByteAccess(): void {
	const buf = Buffer.alloc(5, "?"); // 分配 5 字节，初始值全部填充为 "?" 的字符码
	console.log(`[字节操作] 初始内容 -> ${buf.toString("utf8")}`);
	buf[0] = 0x41; // 'A'
	buf[1] = 0x42; // 'B'
	buf[2] = 0x43; // 'C'
	buf[3] = 0x44; // 'D'
	buf[4] = 0x45; // 'E'
	console.log(`[字节操作] 逐字节写入后 -> ${buf.toString("utf8")}`);
	console.log(`[字节操作] 第 0 个字节的十进制值 -> ${buf[0]}`);
}

async function main(): Promise<void> {
	await demoReadWriteFile();
	console.log("---");
	await demoRecursiveMkdir();
	console.log("---");
	demoBufferIsUint8ArraySubclass();
	console.log("---");
	demoEncodingConversion();
	console.log("---");
	demoDirectByteAccess();
}

await main();
