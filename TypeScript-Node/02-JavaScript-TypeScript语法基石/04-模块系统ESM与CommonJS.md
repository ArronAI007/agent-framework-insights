# 模块系统：ESM 与 CommonJS

> Node.js 生态目前同时存在两套模块系统：历史悠久的 CommonJS（CJS）和现在的官方标准 ECMAScript Modules（ESM）。这一篇讲清楚 Node.js 到底怎么判断一个文件该按哪套规则解析、两套系统在语义上的本质区别，以及它们互相调用对方模块时需要注意的地方。

## 学习目标

- 理解 `package.json` 的 `"type": "module"` 字段如何决定 `.js` 文件的解析方式，以及 `.mjs`/`.cjs` 显式后缀的作用
- 说清楚 ESM 的 `import`/`export` 静态特性和 CJS 的 `require` 动态特性的本质区别
- 掌握 Node.js 里从 ESM 侧导入 CJS 模块的互操作规则
- 知道 `import.meta.url` 如何替代 CJS 里的 `__dirname`

## `package.json` 的 `type` 字段如何决定解析方式

Node.js 判断一个 `.js` 文件该按 ESM 还是 CJS 规则解析，规则是：

1. 如果文件后缀是 **`.mjs`**，无条件按 **ESM** 解析，不受任何配置影响。
2. 如果文件后缀是 **`.cjs`**，无条件按 **CommonJS** 解析，同样不受任何配置影响。
3. 如果文件后缀是 **`.js`**，则查找该文件所在目录及其上层目录中**最近的** `package.json`，读取它的 `"type"` 字段：`"type": "module"` 按 ESM 解析，`"type": "commonjs"` 或字段缺失按 CommonJS 解析（**CommonJS 是没有 `type` 字段时的默认值**）。

这门课程的 `TypeScript-Node/package.json` 里写了 `"type": "module"`，所以这个项目下所有 `.js` 文件默认都按 ESM 处理。`.mjs`/`.cjs` 这两个显式后缀存在的意义，正是为了在**不改变整个包的 `type` 设置**的前提下，让某一个具体文件强制使用另一套模块系统——本章的示例代码就用到了这一点：`legacy-cjs.cjs` 用 `.cjs` 后缀强制声明"这个文件就是 CommonJS"，不受项目整体 `"type": "module"` 的影响。

## 静态 `import`/`export` vs 动态 `require`

两套模块系统最根本的区别不在语法（`import`/`export` 关键字 vs `require`/`module.exports` 函数），而在于**模块依赖关系是在什么时候确定的**：

**ESM 是静态的**：`import`/`export` 语句必须写在模块顶层，不能出现在 `if`、函数体内部这样的运行时分支里（想要按条件加载模块，需要用返回 Promise 的动态 `import()` 函数，这是有意区分开的两套机制）。这个限制换来的好处是：工具链在**代码还没运行之前**，仅通过静态分析源码，就能百分之百确定"这个模块依赖哪些模块、导出了哪些名字"。这正是 tree-shaking（打包时删除未被使用的导出）、以及 TypeScript 能在编译期检查"你 import 的这个名字，对方模块到底有没有导出"的基础。

**CommonJS 是动态的**：`require()` 是一个普通的函数调用，可以出现在任何位置——`if (condition) { require("a") } else { require("b") }` 完全合法，`module.exports` 也可以在运行时被任意修改。这种灵活性是历史遗留的产物（CommonJS 诞生早于 ESM 成为标准），代价是工具链很难仅通过静态分析就确定完整的依赖关系,tree-shaking 对 CJS 模块的支持天然比 ESM 弱。

## ESM 侧导入 CJS 模块：两种方式

真实项目里经常需要在 ESM 代码里使用一个只提供 CommonJS 产物的老依赖，Node.js 提供了官方的互操作规则。本节示例代码分为三个文件：`math-esm.ts` 导出两个 ESM 函数，`legacy-cjs.cjs` 用 CommonJS 语法导出一个函数，`use-esm.ts` 演示如何消费它们。

先看纯 ESM 之间的调用：

```ts
// math-esm.ts
export function add(a: number, b: number): number {
	return a + b;
}

export function multiply(a: number, b: number): number {
	return a * b;
}
```

```ts
// use-esm.ts（节选）
import { add, multiply } from "./math-esm.js";

console.log(`add(2, 3) = ${add(2, 3)}`);
console.log(`multiply(4, 5) = ${multiply(4, 5)}`);
```

有一处很容易让人困惑的细节：**导入语句里写的是 `./math-esm.js`，但源文件其实是 `math-esm.ts`**。这不是笔误——`moduleResolution: "NodeNext"` 要求 `import` 说明符写"编译产物应该有的后缀"，而不是源文件的实际后缀。因为 `.ts` 编译后就是 `.js`，所以哪怕现在还没编译、直接用 `tsx` 跑源码，`import` 里也要写成 `.js`，TypeScript 和 `tsx` 都知道把它映射回同目录下的 `math-esm.ts`。这是从 CommonJS 时代"随便省略后缀"迁移过来的开发者最容易踩的一个坑。

再看 CJS 模块：

```js
// legacy-cjs.cjs
function shout(message) {
	return `${message.toUpperCase()}!!!`;
}

module.exports = shout;
```

从 ESM 侧消费它，有两种常见方式：

**方式一：`createRequire`，在 ESM 里手动造一个 `require`**

```ts
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const shoutViaRequire = require("./legacy-cjs.cjs") as (message: string) => string;
console.log(`shoutViaRequire: ${shoutViaRequire("hello from require")}`);
```

ESM 模块本身没有全局的 `require` 函数（这是 CJS 独有的），`node:module` 提供的 `createRequire` 能基于当前模块的 URL 构造出一个行为和 CommonJS 里的 `require` 完全一样的函数。这种方式的好处是语义上和传统 CJS 用法完全一致，适合"只是偶尔要拉一个 CJS 依赖"的场景。因为 `require()` 的返回值类型永远是 `any`，需要自己用 `as` 手动标注出正确的类型。

**方式二：直接用 ESM 的 `import` 语法默认导入**

```ts
// @ts-expect-error TS7016: legacy-cjs.cjs 没有类型声明文件
import shoutViaImportRaw from "./legacy-cjs.cjs";
const shoutViaImport = shoutViaImportRaw as (message: string) => string;
console.log(`shoutViaImport: ${shoutViaImport("hello from default import")}`);
```

Node.js 的 CJS/ESM 互操作规则规定：**从 ESM 侧 `import` 一个 CommonJS 模块时，整个 `module.exports` 会被当作这个模块的 `default` 导出**。因为 `legacy-cjs.cjs` 是纯 JS、没有配套的类型声明文件，TypeScript 默认会报 `TS7016`（隐式 `any`，「找不到该模块的声明文件」）；真实项目里遇到这种情况，标准做法是给这个 CJS 依赖补一份 `.d.ts` 声明文件（或者安装社区维护的 `@types/*` 包）。这里为了不额外增加示例文件数量，直接用 `@ts-expect-error` 标注这处已知的、预期内的类型缺失，再手动把结果标注成正确的函数类型——这也是接入无类型第三方 CJS 包时一个诚实、常见的临时手段。

实际运行两种方式，输出完全一致：

```text
shoutViaRequire: HELLO FROM REQUIRE!!!
shoutViaImport: HELLO FROM DEFAULT IMPORT!!!
```

反过来——**CJS 模块不能用 `require()` 同步加载 ESM 模块**，这是一条更硬性的限制（因为 ESM 的加载本身是异步的），只能用动态 `import()`（返回 Promise）。这个方向的互操作细节比较边缘，这里不展开，只需要知道"ESM 可以用两种方式拉取 CJS，反过来 CJS 只能异步拉取 ESM"这个不对称性。

## `import.meta.url`：ESM 里没有 `__dirname`

CommonJS 模块里，`__dirname`（当前文件所在目录）、`__filename`（当前文件路径）是 Node.js 自动注入的模块级变量。这两个变量在 ESM 模块里**不存在**——ESM 是浏览器和 Node.js 共享的标准，浏览器环境本身就没有"文件系统路径"这个概念，所以标准里不可能包含 `__dirname` 这种 Node.js 专属的东西。

ESM 提供的替代方案是 **`import.meta.url`**：一个字符串，值是当前模块自身的 `file://` URL：

```ts
console.log(`import.meta.url = ${import.meta.url}`);
```

真实输出（路径按你本机的实际位置变化，这里是本课程仓库里的路径，中文目录名被自动做了 URL 编码）：

```text
import.meta.url = file:///Users/arron/Desktop/ArronAI/agent-framework-insights/TypeScript-Node/examples/02-JavaScript-TypeScript%E8%AF%AD%E6%B3%95%E5%9F%BA%E7%9F%B3/04-%E6%A8%A1%E5%9D%97%E7%B3%BB%E7%BB%9FESM%E4%B8%8ECommonJS/use-esm.ts
```

如果需要把它转换成传统的文件系统路径（比如拼接同目录下的其他文件），标准做法是配合 `node:url` 提供的 `fileURLToPath`：

```ts
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

这几行代码本质上就是在 ESM 模块里"手动重建" CJS 曾经自动提供的 `__filename`/`__dirname`，是 ESM 项目里一个高频出现的样板代码。`createRequire(import.meta.url)` 之所以需要传入 `import.meta.url` 作为参数，也是同一个原因——它需要知道"当前模块在文件系统里的位置"，才能正确解析相对路径的 `require` 调用。

## 小结

Node.js 按「`.mjs` 强制 ESM、`.cjs` 强制 CJS、`.js` 看最近 `package.json` 的 `type` 字段」这套优先级判断一个文件该按哪套模块系统解析，没有 `type` 字段时默认是 CommonJS。ESM 的 `import`/`export` 是静态的，依赖关系在运行前就能确定，是 tree-shaking 和编译期类型检查的基础；CJS 的 `require`/`module.exports` 是动态的，更灵活但工具链更难静态分析。从 ESM 导入 CJS 模块，可以用 `createRequire` 手动构造一个 `require` 函数，也可以直接用 ESM 的默认导入语法（`module.exports` 整体会被当作 `default`），反过来 CJS 只能用异步的 `import()` 加载 ESM，不对称。ESM 模块里没有 `__dirname`/`__filename`，需要用 `import.meta.url` 配合 `fileURLToPath` 自己推导。
