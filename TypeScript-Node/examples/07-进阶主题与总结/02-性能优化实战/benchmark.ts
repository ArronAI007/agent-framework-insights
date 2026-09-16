// ===== 手写基准测试：先测量，再优化 =====
// 不引入 benchmark.js 之类的专用库，只用 performance.now() 手写计时——
// 这也是这一篇正文强调的态度：直觉判断"哪个写法快"经常是错的，
// 唯一可靠的依据是在目标运行时上实际测出来的数字。

interface BenchmarkResult {
	label: string;
	durationMs: number;
}

/** 统一的计时封装：跑一次 fn，返回耗时（毫秒，保留两位小数）。 */
function timeIt(label: string, fn: () => void): BenchmarkResult {
	const start = performance.now();
	fn();
	const end = performance.now();
	return { label, durationMs: Math.round((end - start) * 100) / 100 };
}

function printResult(result: BenchmarkResult): void {
	console.log(`[benchmark] ${result.label} -> ${result.durationMs.toFixed(2)}ms`);
}

// ===== 基准组 1：字符串拼接 += vs Array.push + join("") =====
// 直觉陷阱：字符串是不可变的，"+=" 在语义上每次都要生成一个新字符串；
// 现代 V8 对连续的字符串拼接做了 rope（绳）结构的优化，不是每次都真的
// 完整拷贝，但当拼接次数很大、且中间穿插了其他操作时，Array.push +
// join 通常仍然更快、更可预测。

const STRING_CONCAT_ITERATIONS = 200_000;

function benchmarkStringConcat(): void {
	console.log("\n===== 基准组 1：字符串拼接 =====");

	const concatResult = timeIt(`+= 拼接 ${STRING_CONCAT_ITERATIONS} 次`, () => {
		let result = "";
		for (let i = 0; i < STRING_CONCAT_ITERATIONS; i++) {
			result += "x";
		}
		// 故意读取一下长度，防止 JS 引擎把整个循环当成死代码优化掉
		if (result.length !== STRING_CONCAT_ITERATIONS) {
			throw new Error("拼接结果长度不符合预期");
		}
	});

	const pushJoinResult = timeIt(`Array.push + join 拼接 ${STRING_CONCAT_ITERATIONS} 次`, () => {
		const parts: string[] = [];
		for (let i = 0; i < STRING_CONCAT_ITERATIONS; i++) {
			parts.push("x");
		}
		const result = parts.join("");
		if (result.length !== STRING_CONCAT_ITERATIONS) {
			throw new Error("拼接结果长度不符合预期");
		}
	});

	printResult(concatResult);
	printResult(pushJoinResult);
}

// ===== 基准组 2：高频查找，普通对象 vs Map =====
// 直觉陷阱："对象字面量不就是个哈希表吗，跟 Map 应该差不多快"。
// 实际上普通对象要额外承担原型链查找、隐藏类（hidden class）转换等
// 开销，尤其是键的数量大、且是运行时动态确定（不是字面量里写死）的
// 场景下，Map 的查找路径更直接、性能更稳定可预测。

const LOOKUP_KEY_COUNT = 5_000;
const LOOKUP_ITERATIONS = 2_000_000;

function buildLookupKeys(): string[] {
	const keys: string[] = [];
	for (let i = 0; i < LOOKUP_KEY_COUNT; i++) {
		keys.push(`key-${i}`);
	}
	return keys;
}

function benchmarkObjectVsMapLookup(): void {
	console.log("\n===== 基准组 2：高频查找，普通对象 vs Map =====");

	const keys = buildLookupKeys();

	const plainObject: Record<string, number> = {};
	const map = new Map<string, number>();
	keys.forEach((key, index) => {
		plainObject[key] = index;
		map.set(key, index);
	});

	// 提前把要查找的 key 序列生成好，避免"拼接查找用的 key 字符串"这个
	// 额外开销混进计时区间，干扰对"查找本身"耗时的测量。
	const lookupSequence: string[] = new Array(LOOKUP_ITERATIONS);
	for (let i = 0; i < LOOKUP_ITERATIONS; i++) {
		lookupSequence[i] = keys[i % LOOKUP_KEY_COUNT] as string;
	}

	const objectResult = timeIt(`普通对象查找 ${LOOKUP_ITERATIONS} 次（${LOOKUP_KEY_COUNT} 个 key）`, () => {
		let sum = 0;
		for (let i = 0; i < LOOKUP_ITERATIONS; i++) {
			sum += plainObject[lookupSequence[i] as string] ?? 0;
		}
		if (sum <= 0) {
			throw new Error("查找结果不符合预期");
		}
	});

	const mapResult = timeIt(`Map 查找 ${LOOKUP_ITERATIONS} 次（${LOOKUP_KEY_COUNT} 个 key）`, () => {
		let sum = 0;
		for (let i = 0; i < LOOKUP_ITERATIONS; i++) {
			sum += map.get(lookupSequence[i] as string) ?? 0;
		}
		if (sum <= 0) {
			throw new Error("查找结果不符合预期");
		}
	});

	printResult(objectResult);
	printResult(mapResult);
}

// ===== 基准组 3（附加）：console.time/console.timeEnd 的等价写法 =====
// 正文提到 console.time/console.timeEnd 是 performance.now() 手写计时的
// 便捷封装，这里演示一次它的用法，行为上与上面 timeIt() 做的事等价。

function demoConsoleTime(): void {
	console.log("\n===== console.time / console.timeEnd 用法演示 =====");
	console.time("[benchmark] console.time 演示");
	let total = 0;
	for (let i = 0; i < 1_000_000; i++) {
		total += i;
	}
	console.timeEnd("[benchmark] console.time 演示");
	if (total <= 0) {
		throw new Error("累加结果不符合预期");
	}
}

benchmarkStringConcat();
benchmarkObjectVsMapLookup();
demoConsoleTime();

console.log("\n[benchmark] 全部基准测试运行完毕，脚本正常退出。");
