// ===== 被测代码 =====
// 这不是这门课程本身的工具函数，而是"假装"是某个真实项目里
// 需要被测试覆盖的业务逻辑——math.test.ts 会对它写测试。

/** 两数相加。 */
export function add(a: number, b: number): number {
	return a + b;
}

/** 除数为 0 时抛出的自定义错误，携带被除数信息方便排查。 */
export class DivisionByZeroError extends Error {
	constructor(dividend: number) {
		super(`除数不能为 0（被除数: ${dividend}）`);
		this.name = "DivisionByZeroError";
	}
}

/** 两数相除；除数为 0 时抛出 DivisionByZeroError 而不是返回 Infinity/NaN。 */
export function divide(dividend: number, divisor: number): number {
	if (divisor === 0) {
		throw new DivisionByZeroError(dividend);
	}
	return dividend / divisor;
}
