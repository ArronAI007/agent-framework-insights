# TypeScript 编译器与项目初始化

> Node.js 装好之后，下一步是把 TypeScript 工具链立起来。这一篇讲清楚 `tsconfig.json` 里那些关键字段到底在控制什么，以及"编译后执行"和"直接执行"这两条路径该怎么选。

## 学习目标

- 理解 `tsc --init` 生成的 `tsconfig.json` 里 `target`/`module`/`moduleResolution`/`strict`/`outDir` 分别控制什么
- 能说清楚 `tsc` 编译产物再运行 vs `tsx`/`ts-node` 直接运行 TS 文件，各自的取舍
- 跑通并读懂 `npx tsc hello.ts && node hello.js` 和 `npx tsx hello.ts` 两条命令的真实输出

## `tsc --init` 生成了什么

在一个空项目里执行：

```bash
npx tsc --init
```

会生成一份带有大量注释的 `tsconfig.json`。这门课的脚手架（`TypeScript-Node/tsconfig.json`）已经帮你精简、配置好了一份适合学习和实践的版本：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["examples/**/*.ts"]
}
```

逐一拆解几个最关键的字段：

### `target`

决定 TypeScript 把你的代码**降级编译到哪个 ECMAScript 版本**。设成 `ES2022` 意味着编译器相信运行环境原生支持 `ES2022` 的语法特性（比如类字段、`at()` 数组方法、顶层 `await` 等前置能力），不会把这些语法转译成更老的等价写法。选择依据很简单：**你的代码实际会跑在什么 Node.js 版本上**。Node.js 18+ 对 ES2022 的支持已经很完整，所以这里直接选 `ES2022` 而不是更保守的 `ES2020` 或 `ES2015`。

### `module` 与 `moduleResolution`

这两个字段几乎总是成对出现，且强烈建议保持一致。`NodeNext` 告诉 TypeScript："按照 Node.js 自己的模块解析规则来处理 `import`/`export`"——具体来说，就是尊重 `package.json` 里的 `"type": "module"` 字段，并要求 ESM 场景下的相对导入显式带上文件后缀（这一点会在下一章《模块系统》详细展开）。如果这两个字段不匹配（比如 `module` 设成 `NodeNext` 但 `moduleResolution` 设成过时的 `Node`），会遇到大量令人困惑的模块解析报错。

### `strict`

`strict: true` 是一个"总开关"，实际上同时打开了一组独立的严格性检查（`noImplicitAny`、`strictNullChecks`、`strictFunctionTypes` 等十余项）。**新项目应该无条件开启**，它是 TypeScript 类型系统真正发挥价值的前提——不开 `strict` 的 TypeScript，很大程度上只是"能补全的 JavaScript"。

这份配置还额外开启了 `noUncheckedIndexedAccess`，它不在 `strict` 默认范围内，但同样值得开：普通的 `strict` 模式下，`arr[i]` 的类型是 `T`，哪怕 `i` 越界也不会报错；开启 `noUncheckedIndexedAccess` 后，数组/对象的索引访问结果会被推断成 `T | undefined`，逼着你显式处理"取不到"的情况。你会在本章后面 `equality.ts` 示例里看到这个选项如何影响代码写法。

### `outDir`

控制 `tsc` 编译产物（`.js`/`.d.ts`/`.js.map`）输出到哪个目录，不设置的话默认和源文件同目录混放。这份课程的脚手架配置把 `noEmit` 设成了 `true`，也就是**完全不产出编译文件，只做类型检查**——这是一种常见于"用 `tsx` 直接跑、用 `tsc` 只做体检"工作流的配置方式，此时 `outDir` 就没有配置的必要了。如果你的项目需要真正产出可发布的 `.js` 文件（比如写一个要发到 npm 的库），才需要关注 `outDir`，这个场景会在第 06 章《构建打包与 NPM 包发布》里详细讲。

## `tsc` 编译执行 vs `tsx`/`ts-node` 直接执行

TypeScript 代码要跑起来，本质上永远要先变成 JavaScript——区别只在于"谁来做这一步、什么时候做"。

**`tsc` 编译执行**：先用 `tsc` 把 `.ts` 编译成 `.js`，再用 `node` 执行编译产物。这是最"原教旨"的路径,编译和执行是两个独立步骤,产物可以被检查、被打包、被发布。类型检查在编译期间完成，一旦编译通过，运行期不再有任何 TypeScript 相关的开销。

**`tsx`/`ts-node` 直接执行**：不产出中间 `.js` 文件，进程内即时把 TypeScript 转译成 JavaScript 再执行,对开发者来说体验上和直接跑 `node script.js` 几乎一样。`tsx` 底层用 esbuild 做转译，速度非常快，但**默认不做完整的类型检查**——它只是把类型标注"剥掉"，类似 Babel 处理 TS 的方式；`ts-node` 则可以选择接入完整的 `tsc` 类型检查，但相应地更慢。

**怎么选**：日常开发、跑脚本、跑示例代码，用 `tsx` 或 `tsx --watch`（文件变化自动重启，效果类似 nodemon）效率最高，这也是这门课所有 `examples/` 目录下代码的推荐运行方式。真正要类型安全打底，把类型检查交给独立的 `tsc --noEmit`（也就是本项目 `npm run typecheck` 背后做的事）作为 CI/提交前的强制关卡,两者分工，不冲突:开发时用 `tsx` 追求速度,提交前用 `tsc --noEmit` 追求正确性。发布产物（库/服务的最终构建）则仍然要走 `tsc`（或 esbuild/swc 等编译器）产出真正的 `.js` 文件。

## 动手验证：两条路径的真实输出

本节示例代码在 `examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.ts`，内容如下：

```ts
// interface：描述 buildGreeting 返回值的形状
export interface Greeting {
	message: string;
	loud: boolean;
}

// 带类型标注的导出函数：参数和返回值类型都显式写出
export function greet(name: string): string {
	return `Hello, ${name}!`;
}

// 故意不标注返回类型，让 TypeScript 通过控制流分析自己推断出结构类型。
// `satisfies Greeting` 只做一次性的形状校验，不会像显式标注那样改变推断出的类型。
function buildGreeting(name: string, loud: boolean) {
	const message = loud ? greet(name).toUpperCase() : greet(name);
	return { message, loud } satisfies Greeting;
}

const normal = buildGreeting("TypeScript", false);
console.log(normal.message);

const shouted = buildGreeting("Node.js", true);
console.log(shouted.message);
```

`greet` 的返回类型是显式标注的 `string`；`buildGreeting` 则故意不写返回类型，让 TypeScript 自己推断——推断结果是一个匿名的对象字面量类型 `{ message: string; loud: boolean }`，`satisfies Greeting` 只是让编译器额外确认一次"这个形状符合 `Greeting` 接口"，但不会像 `: Greeting` 那样把变量的类型收窄成接口本身（也就是说 `normal` 上仍然能访问到字面量类型携带的全部精确信息）。

### 路径一：`tsc` 编译 + `node` 执行

在项目根目录（`TypeScript-Node/`）下执行：

```bash
npx tsc --ignoreConfig "examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.ts"
node "examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.js"
```

这里有一个值得注意的细节：**如果直接执行 `npx tsc hello.ts` 而不加 `--ignoreConfig`，会直接报错**，因为项目目录里已经存在 `tsconfig.json`，而命令行里又显式传了文件名。当前使用的 TypeScript 7（`npx tsc --version` 输出 `Version 7.0.2`）在这种情况下选择直接报错而不是静默忽略配置文件：

```text
error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline. Use '--ignoreConfig' to skip this error.
```

这是比早期 TypeScript 版本更保守的行为——旧版本通常只是忽略 `tsconfig.json` 并继续编译，容易让人在不知情的情况下用错了编译选项；新版本选择显式报错,逼你要么去掉命令行文件参数（改用 `-p`/`--project` 走配置文件驱动的整体编译），要么用 `--ignoreConfig` 明确表达"我知道自己在干什么，就是要临时编译这一个文件"。加上 `--ignoreConfig` 后的真实输出是：

```text
$ npx tsc --ignoreConfig "examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.ts"
$ node "examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.js"
Hello, TypeScript!
HELLO, NODE.JS!
```

`tsc` 命令本身没有任何输出（说明没有类型错误），生成的 `hello.js` 会输出两行结果。查看生成的 `hello.js` 可以看到，`export`/`console.log` 逻辑被完整保留（因为 `target` 是 `ES2022`，已经原生支持 `export`，不需要降级成 `require`/`exports`）：

```js
export function greet(name) {
    return `Hello, ${name}!`;
}
console.log(greet("TypeScript"));
```

（本课程的 `examples/` 目录只保留 `.ts` 源文件，`hello.js` 是编译产物，验证完可以直接删掉，不需要提交到仓库。）

### 路径二：`tsx` 直接执行

```bash
npx tsx "examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.ts"
```

真实输出：

```text
$ npx tsx "examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.ts"
Hello, TypeScript!
HELLO, NODE.JS!
```

两条路径的最终输出完全一致——这是理所当然的，因为它们本质上都是"先转成 JS 再跑"，区别只在于转译发生的时机和位置。日常在这门课里跑 `examples/` 下的代码，统一用 `npx tsx <文件路径>` 即可,更快、也不会在目录里留下编译产物。

## 小结

`tsconfig.json` 里 `target` 决定编译到哪个 JS 版本、`module`/`moduleResolution` 决定模块解析规则（建议成对使用 `NodeNext`）、`strict` 是类型安全的总开关、`outDir` 控制产物落地位置（本课程脚手架用 `noEmit: true` 关闭了产物输出，只做类型检查）。`tsc` 编译执行和 `tsx`/`ts-node` 直接执行不是互斥的两条路，而是分工:开发阶段用 `tsx` 追求速度,类型正确性交给独立的 `tsc --noEmit`,真正要发布的产物才用 `tsc` 走完整编译。TypeScript 7 对"命令行传文件名 + 项目里有 tsconfig.json"这种组合会直接报错，需要显式加 `--ignoreConfig` 才会临时忽略配置文件,这是一个值得记住的版本行为差异。
