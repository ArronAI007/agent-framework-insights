import { spawn } from "node:child_process";

// ===== child_process.spawn：启动一个子进程，流式收集 stdout =====
// spawn 返回的子进程对象把 stdout/stderr 暴露成 Readable 流，适合处理
// "输出可能很大、或者需要边产出边处理"的场景（比如长时间运行的命令行工具）；
// 相比之下 exec/execFile 是把全部输出一次性攒进内存、通过回调一次性给你，
// 更适合"输出量小、只关心最终结果"的一次性命令。这里用 node -e "..." 当作子进程，
// 避免依赖系统上是否装了某个特定的 shell 命令，保证示例在任何机器上都能跑。
const child = spawn("node", ["-e", "console.log('hi from child')"]);

let stdoutData = "";
child.stdout.on("data", (chunk: Buffer) => {
	stdoutData += chunk.toString("utf8");
});

let stderrData = "";
child.stderr.on("data", (chunk: Buffer) => {
	stderrData += chunk.toString("utf8");
});

// ===== 等待子进程退出，拿到退出码 =====
// "close" 事件在子进程的 stdio 流都被完全消费完之后触发（相比 "exit" 事件更适合
// 用来确认"输出真的都收全了"），code 是子进程的退出码，0 表示正常退出。
child.on("close", (code) => {
	console.log(`[spawn] 子进程 stdout -> ${JSON.stringify(stdoutData.trim())}`);
	console.log(`[spawn] 子进程 stderr -> ${JSON.stringify(stderrData.trim())}`);
	console.log(`[spawn] 子进程退出码  -> ${code}`);
});
