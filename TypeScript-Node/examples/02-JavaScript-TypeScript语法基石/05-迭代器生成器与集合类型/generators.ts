// ===== 自定义可迭代类：实现 Symbol.iterator 协议 =====
// 任何实现了 [Symbol.iterator]() 并返回一个「迭代器对象」（有 next() 方法）的类型，
// 都能被 for...of、展开运算符 ...、解构等语法直接消费——这正是 Array/Map/Set
// 在语言层面被特殊对待的底层协议，用户自定义类型同样可以接入。
class Range implements Iterable<number> {
	constructor(
		private readonly start: number,
		private readonly end: number,
		private readonly step = 1,
	) {}

	[Symbol.iterator](): Iterator<number> {
		let current = this.start;
		const { end, step } = this;
		return {
			next(): IteratorResult<number> {
				if (current >= end) {
					return { value: undefined, done: true };
				}
				const value = current;
				current += step;
				return { value, done: false };
			},
		};
	}
}

console.log(`[...new Range(0, 10, 2)] -> [${[...new Range(0, 10, 2)].join(",")}]`);
for (const n of new Range(1, 4)) {
	console.log(`for...of Range(1, 4) -> ${n}`);
}

// ===== 生成器函数：function* 与 yield =====
// 生成器函数每次调用只会执行到下一个 yield 就暂停，是天然的惰性序列。
// 这里用它实现一个理论上无限的斐波那契数列，只有真正被消费时才会继续计算。
function* fibonacci(): Generator<number, void, unknown> {
	let previous = 0;
	let current = 1;
	while (true) {
		yield previous;
		[previous, current] = [current, previous + current];
	}
}

function take<T>(iterable: Iterable<T>, count: number): T[] {
	const result: T[] = [];
	for (const value of iterable) {
		if (result.length >= count) break;
		result.push(value);
	}
	return result;
}

console.log(`前 10 项斐波那契数列 -> [${take(fibonacci(), 10).join(",")}]`);

// ===== Map 用作缓存：相比普通对象，键可以是任意类型且保持插入顺序 =====
const squareCache = new Map<number, number>();

function cachedSquare(n: number): number {
	const cached = squareCache.get(n);
	if (cached !== undefined) {
		console.log(`cache hit: ${n}`);
		return cached;
	}
	console.log(`cache miss: ${n}，开始计算`);
	const result = n * n;
	squareCache.set(n, result);
	return result;
}

console.log(`cachedSquare(5) -> ${cachedSquare(5)}`);
console.log(`cachedSquare(5) -> ${cachedSquare(5)}`); // 命中缓存
console.log(`cachedSquare(6) -> ${cachedSquare(6)}`);
console.log(`squareCache 当前大小 -> ${squareCache.size}`);
