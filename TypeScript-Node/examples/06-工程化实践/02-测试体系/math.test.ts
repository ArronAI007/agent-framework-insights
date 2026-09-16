// ===== 用 Vitest 给 math.ts 写测试 =====
// 演示的是"怎么给自己的代码写测试"这件事本身：describe 分组、
// it 描述行为、expect 断言，以及用 toThrow 验证异常路径。

import { describe, expect, it } from "vitest";
import { add, divide, DivisionByZeroError } from "./math.js";

describe("math", () => {
	describe("add", () => {
		it("returns the sum of two positive numbers", () => {
			expect(add(2, 3)).toBe(5);
		});

		it("handles negative numbers correctly", () => {
			expect(add(-2, 5)).toBe(3);
		});
	});

	describe("divide", () => {
		it("returns the quotient when divisor is not zero", () => {
			expect(divide(10, 2)).toBe(5);
		});

		it("throws DivisionByZeroError when dividing by zero", () => {
			expect(() => divide(1, 0)).toThrow();
			expect(() => divide(1, 0)).toThrow(DivisionByZeroError);
		});

		it("includes the dividend in the error message", () => {
			expect(() => divide(7, 0)).toThrow("被除数: 7");
		});
	});
});
