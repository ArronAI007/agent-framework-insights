import { Readable, Writable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// ===== 自定义 Transform 流：把流过的文本转成大写 =====
// Transform 是 Duplex（既可读又可写）的特殊形式：写进去的每个 chunk 经过 _transform
// 处理后，再从可读端流出去——这是"数据在流经的过程中被加工一次"的标准实现方式。
class UppercaseTransform extends Transform {
	// _transform 是 Node 流机制的核心钩子：每收到一个上游写入的 chunk 就会调用一次。
	// 第三个参数 callback 必须被调用，用来告诉流"这个 chunk 处理完了，可以继续处理下一个"——
	// 忘记调用 callback 会导致整条流永久卡住。
	override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null, data?: unknown) => void): void {
		const text = chunk.toString("utf8").toUpperCase();
		this.push(text);
		callback();
	}
}

// ===== 收集结果的 Writable：把写入的每个 chunk 攒进数组，方便最后打印验证 =====
function createCollectingWritable(collected: string[]): Writable {
	return new Writable({
		write(chunk: Buffer | string, _encoding, callback) {
			collected.push(chunk.toString("utf8"));
			callback();
		},
	});
}

// ===== pipeline() vs 手写 .pipe() 链 =====
// .pipe() 链（a.pipe(b).pipe(c)）不会自动把错误从下游传播到上游，
// 任何一环出错都需要手动给每个流单独挂 error 监听器，稍不注意就会漏掉，
// 出错时上游/中间的流也可能不会被正确关闭，造成资源泄漏（文件句柄、socket 没释放）。
// node:stream/promises 的 pipeline() 统一处理了这些问题：任意一环出错会自动
// 销毁整条链上的所有流，并把错误通过一个 Promise reject 出来，可以直接 await/catch，
// 这也是 Node 官方文档现在明确建议"优先用 pipeline，而不是手写 pipe 链"的原因。
async function demoPipeline(): Promise<void> {
	const source = Readable.from(["a", "b", "c"]);
	const collected: string[] = [];
	const sink = createCollectingWritable(collected);

	await pipeline(source, new UppercaseTransform(), sink);

	console.log(`[pipeline] 收集到的结果 -> ${JSON.stringify(collected)}`);
	console.log(`[pipeline] 拼接后的完整字符串 -> ${collected.join("")}`);
}

// ===== 背压（backpressure）概念的最小示例 =====
// 当 Writable 端处理速度跟不上 Readable 端产出速度时，Writable.write() 会返回 false，
// 提示上游"我这边积压了，先别急着写"——手写 .pipe() 场景下 Node 会自动帮你处理这个信号
// （暂停 Readable，等 Writable 触发 "drain" 事件再恢复），pipeline() 内部同样自动处理了背压，
// 这也是为什么"自己纯手写循环调用 write() 而不理会返回值"在处理大文件/大流量时容易把内存写爆。
function demoBackpressureSignal(): void {
	const collected: string[] = [];
	// highWaterMark 故意设得很小（1 字节），且用 setImmediate 模拟"下游处理是异步的、
	// 不会立刻回调"——如果 write() 内部同步调用 callback，Node 会在同一个微任务里
	// 把缓冲区清空，根本观察不到背压信号；只有当写入速度真的快于消费速度时，
	// write() 才会返回 false，提示调用方"该缓一缓了"。
	const smallBufferSink = new Writable({
		highWaterMark: 1,
		write(chunk: Buffer | string, _encoding, callback) {
			collected.push(chunk.toString("utf8"));
			setImmediate(callback);
		},
	});
	// 单次写入的 chunk（1024 字节）本身就已经远超 highWaterMark（1 字节），
	// 所以第一次 write() 就会返回 false——这正是背压信号：写入速度已经超过了
	// highWaterMark 设定的缓冲上限，调用方应该等 "drain" 事件再继续写。
	const writeOk = smallBufferSink.write("x".repeat(1024));
	console.log(`[背压] write() 返回值（false 表示建议暂停写入）-> ${writeOk}`);
}

async function main(): Promise<void> {
	await demoPipeline();
	console.log("---");
	demoBackpressureSignal();
}

await main();
