# 测试体系与 Test Runner

> 上一篇讲完了目录怎么组织，这一篇讲"怎么给自己写的代码写测试"——注意这个限定语："自己写的代码"。这篇文章的示例是一对独立的 `math.ts`/`math.test.ts`，教的是测试这件事本身怎么做，不是回头给这门课程前面章节的文章或示例代码去补测试套件（那些示例文件的价值在于演示语言/运行时特性，用真实运行输出验证过行为，不是这一章要覆盖的对象）。JS/TS 生态的测试框架选择很多，这一篇聚焦两个：Node 自带、不需要装任何依赖的 `node:test`，和这门课程实际在用、生态上事实标准级别的 Vitest。

## 学习目标

- 了解 Node 内建 `node:test` runner 的基本用法和 `node --test` 命令
- 理解 Vitest 相对 Jest 的定位差异：原生 ESM/TS 支持、更快的执行速度
- 掌握测试文件的命名约定（`*.test.ts` 就近放置）
- 会用 `describe`/`it`/`expect` 写出基本的单元测试，覆盖正常路径和异常路径

## Node 内建 `node:test`：不需要任何依赖

Node 从 v18 开始把一个测试 runner 内建进了标准库，模块名是 `node:test`，断言用的是同样内建的 `node:assert`：

```ts
// 仅用于演示 node:test 的语法，不是本课程的可执行示例文件
import { test } from "node:test";
import assert from "node:assert/strict";

test("加法计算正确", () => {
	assert.strictEqual(1 + 2, 3);
});
```

用 `node --test` 命令运行（会自动发现项目里所有匹配 `*.test.ts`/`*.test.js` 等约定命名的文件并执行）。它最大的优势是**零依赖**——不需要在 `package.json` 里装任何 `devDependencies`，只要有 Node 就能跑测试，这对写一个几十行的小工具库、或者不想引入额外依赖的场景很有吸引力。仓库里 `PI/` 目录整理的真实开源项目 pi 就是这么选的：`PI/02-仓库全景与工程实践` 提到它的 `packages/tui` 包用的正是 `node:test`，而不是仓库里其他包统一使用的 Vitest——这是一个实际存在于生产代码里的例子，说明"够用就不必引入额外依赖"这条原则在真实项目中确实会被采纳。

`node:test` 的短板也很直接：断言库（`node:assert`）比 Vitest/Jest 的 `expect` API 表达力弱不少（没有链式的 `.toHaveBeenCalledWith(...)` 这类丰富的匹配器）；mock、快照测试等进阶能力虽然近几个 Node 版本在陆续补齐（`node:test` 现在也有内建的 `t.mock`），但生态成熟度和文档丰富程度依然不如社区方案；IDE 的测试面板集成、覆盖率报告等周边工具链也不如 Vitest 完善。

## Vitest：定位与相对 Jest 的优势

Vitest 是这门课程实际选用的测试框架（见 `TypeScript-Node/package.json` 的 `devDependencies`），定位是 Jest 的"精神续作"——API 高度兼容 Jest（`describe`/`it`/`expect`/`vi.fn()` 这些 Jest 用户熟悉的写法基本可以直接照搬），但底层实现完全不同，换来几个实打实的优势：

- **原生 ESM/TS 支持**：Vitest 构建在 Vite 之上，直接利用 Vite 的模块转换管线，`.ts` 文件、ESM 的 `import`/`export` 语法开箱即用，不需要像 Jest 那样额外配置 `ts-jest` 或者 Babel 转译层——本课程这套 `NodeNext` 模块解析 + ESM 的项目配置，Vitest 几乎零配置就能跑起来，这也是第 01 章工具链搭建时选它而不是 Jest 的直接原因。
- **执行速度**：得益于 Vite 的按需编译和模块缓存，以及 Vitest 默认的多进程/多线程并行执行策略，同等规模的测试套件，Vitest 的冷启动和增量运行通常明显快于 Jest（尤其是在文件监听模式下，改一个文件只重新跑受影响的测试，而不是整个套件）。
- **和 Vite 生态的天然契合**：如果项目本身用 Vite 构建（前端项目里很常见），Vitest 复用同一套 `vite.config.ts` 里的别名、插件配置，不需要为测试环境单独再维护一份构建配置。

这不代表 Jest 已经过时——Jest 生态更老、插件更多、在一些遗留的 CommonJS 项目里迁移成本更低。但对于一个从零开始、面向 ESM/TS 的新项目（正是本课程这种场景），Vitest 通常是更省心的默认选择。

## 测试文件命名约定与基本用法

延续上一篇「项目结构」提到的就近放置原则，测试文件命名为 `<被测文件名>.test.ts`，和被测文件放在同一目录。本篇配套的示例就是这个约定的具体体现：

`examples/06-工程化实践/02-测试体系/math.ts` 导出两个函数：

```ts
export function add(a: number, b: number): number {
	return a + b;
}

export class DivisionByZeroError extends Error {
	constructor(dividend: number) {
		super(`除数不能为 0（被除数: ${dividend}）`);
		this.name = "DivisionByZeroError";
	}
}

export function divide(dividend: number, divisor: number): number {
	if (divisor === 0) {
		throw new DivisionByZeroError(dividend);
	}
	return dividend / divisor;
}
```

`divide` 在除数为 0 时不是返回 `Infinity`/`NaN`（JS 原生 `1 / 0` 的行为），而是主动抛出一个自定义的 `DivisionByZeroError`——这是一个有意的设计选择：让"除以零"这种明显的调用错误在最早的地方就以异常形式暴露出来，而不是让 `NaN` 这种"沉默的坏值"混进后续计算，等到很远的下游才发现结果不对、还得倒查是哪一步出的问题。

对应的 `examples/06-工程化实践/02-测试体系/math.test.ts` 用 Vitest 写测试：

```ts
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
```

几个值得注意的用法细节：

- `describe` 是纯粹的分组容器，可以嵌套（外层按"被测模块"分组，内层按"被测函数"再分一层），本身不包含断言逻辑，只影响测试报告里的层级展示和失败定位。
- `it`（`test` 是它的别名）描述一个具体的行为期望，命名建议用一句能读出来的话说清楚"在什么条件下应该发生什么"，而不是"test1"这种无信息量的名字——这一点延续了第 04-05 章一直在遵循的测试命名规范。
- 断言异常路径用 `expect(() => 会抛错的调用).toThrow(...)`：**必须把调用包在一个箭头函数里传给 `expect`**，而不是直接调用后把返回值传给 `expect`——如果写成 `expect(divide(1, 0)).toThrow()`，`divide(1, 0)` 在传参这一步就已经抛出异常了，异常会直接冒泡出测试函数、导致这个测试用例本身因为"未捕获异常"而失败,而不是被 `toThrow()` 正常捕获断言。`toThrow` 除了不传参数只检查"是否抛出"，还可以传一个具体的 Error 子类（检查异常类型）或者一段子字符串（检查错误消息是否包含它），本篇的例子里三种用法都覆盖到了。

## 真实运行结果

```bash
cd TypeScript-Node
npx vitest run "examples/06-工程化实践/02-测试体系/math.test.ts"
```

真实输出：

```text
 RUN  v5.0.1 /Users/arron/Desktop/ArronAI/agent-framework-insights/TypeScript-Node


 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  19:40:41
   Duration  80ms (transform 67%, import 21%, worker 6%, tests 6%)
```

5 个测试用例全部通过：`add` 的两个正常路径用例，`divide` 的一个正常路径用例，以及 `divide(1, 0)` 除以零抛错的两个用例（一个只检查"是否抛出"，一个额外检查异常消息内容）。

## 小结

Node 内建的 `node:test` runner 不需要任何额外依赖，用 `node --test` 就能跑，适合零依赖的小工具库场景，本课程配套的真实项目 pi 里 `packages/tui` 这个包就实际用的是它；Vitest 基于 Vite 构建，原生支持 ESM/TS、执行速度更快，API 又高度兼容 Jest，是本课程从零开始的 ESM/TS 项目采用的默认选择。测试文件延续"就近放置"的约定，命名为 `<被测文件>.test.ts`。`describe` 负责分组、`it`/`test` 描述具体行为期望、`expect` 做断言；断言异常路径时要把调用包进箭头函数传给 `expect`，不能直接调用后传返回值。再次强调：本章示例演示的是"怎么给自己的代码写测试"这门手艺本身，不是要求给这门课程前面几章的文章或示例代码补测试。下一篇讲调试、性能剖析和内存泄漏排查，会用到 `--inspect`、`--prof`、`process.memoryUsage()` 这些诊断工具，并引用第 07 章即将出现的 `gc-demo.ts` 作为排查内存泄漏的实操对象。
