# TypeScript / Node.js 课程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在仓库新增 `TypeScript-Node/` 目录，产出一套面向"会其他语言、没系统学过 TS/Node"的开发者的 35 篇体系化教程（语言 + 运行时核心），配套可运行、可类型检查的示例代码，并把第七套课程接入仓库根 `README.md`。

**Architecture:** 单一共享 npm 工程（`TypeScript-Node/package.json` + `tsconfig.json`），`examples/` 目录结构镜像 7 章节编号；每篇 Markdown 正文引用 `examples/` 下对应的可运行 `.ts` 文件。写作按章节分组，用 subagent-driven-development 分任务执行。

**Tech Stack:** TypeScript (strict)、tsx（直接运行 .ts）、Node.js（本机 v26.5.0）、vitest（仅第 06 章教学示例使用）。

**本计划相对标准模板的调整说明：** 这是一个文档/教程创作项目，不是应用代码项目，因此不套用逐断言级别的红/绿 TDD 循环。每个 Task 的"最小完成单元"是"一篇文章 + 它引用的示例代码文件"，验证手段是：示例代码必须 `tsc --noEmit` 通过、能执行的示例必须 `npx tsx` 跑出与正文描述一致的输出、Markdown 代码围栏（```）成对、正文引用的文件路径必须真实存在。每个 Task 内仍然是"写 → 跑验证命令 → 确认结果 → 提交"的可执行步骤序列，只是被验证的对象是文档和示例代码,而不是单元测试断言。

---

## 全局文件地图

```
TypeScript-Node/
├── package.json
├── tsconfig.json
├── .gitignore
├── 00-课程导读/README.md
├── 01-环境搭建与工具链/{01..04}-*.md
├── 02-JavaScript-TypeScript语法基石/{01..05}-*.md
├── 03-TypeScript类型系统精讲/{01..07}-*.md
├── 04-异步编程模型/{01..04}-*.md
├── 05-Node.js运行时核心/{01..06}-*.md
├── 06-工程化实践/{01..04}-*.md
├── 07-进阶主题与总结/{01..04}-*.md
└── examples/
    ├── 01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.ts
    ├── 02-JavaScript-TypeScript语法基石/
    │   ├── 01-值类型引用类型与相等性/equality.ts
    │   ├── 02-作用域闭包与this绑定/closures-and-this.ts
    │   ├── 03-解构展开与函数高级用法/destructuring.ts
    │   ├── 04-模块系统ESM与CommonJS/{math-esm.ts,use-esm.ts,legacy-cjs.cjs}
    │   └── 05-迭代器生成器与集合类型/generators.ts
    ├── 03-TypeScript类型系统精讲/
    │   ├── 01-基础类型与类型推断/inference.ts
    │   ├── 02-接口类型别名与联合交叉类型/union-intersection.ts
    │   ├── 03-泛型编程/generics.ts
    │   ├── 04-高级类型-映射条件与模板字面量/mapped-conditional-template.ts
    │   ├── 05-类型体操实战/type-gymnastics.ts
    │   ├── 06-类与面向对象类型系统/classes.ts
    │   └── 07-类型声明文件与第三方库类型/{legacy-lib.js,legacy-lib.d.ts,consumer.ts}
    ├── 04-异步编程模型/
    │   ├── 01-事件循环与任务队列/event-loop-order.ts
    │   ├── 02-Promise与async-await深入/async-patterns.ts
    │   ├── 03-错误处理与取消机制/abort-and-errors.ts
    │   └── 04-并发控制模式/concurrency-limit.ts
    ├── 05-Node.js运行时核心/
    │   ├── 01-模块解析与包系统机制/resolve-demo.ts
    │   ├── 02-文件系统与Buffer/fs-buffer.ts
    │   ├── 03-Stream流式处理/streams.ts
    │   ├── 04-网络编程/{http-server.ts,ws-handshake-demo.ts}
    │   ├── 05-子进程与WorkerThreads/{worker-script.cjs,worker-main.ts,spawn-demo.ts}
    │   └── 06-进程生命周期/graceful-shutdown.ts
    ├── 06-工程化实践/02-测试体系/{math.ts,math.test.ts}
    └── 07-进阶主题与总结/
        ├── 01-内存模型与垃圾回收/gc-demo.ts
        ├── 02-性能优化实战/benchmark.ts
        └── 03-常见陷阱与最佳实践清单/pitfalls.ts
```

以上是最终状态;下面的 Task 会分批创建。

---

### Task 0: 脚手架 — npm 工程、tsconfig、全部 35 篇文章的标题骨架

**Files:**
- Create: `TypeScript-Node/package.json`
- Create: `TypeScript-Node/tsconfig.json`
- Create: `TypeScript-Node/.gitignore`
- Create: `TypeScript-Node/examples/.gitkeep`（临时占位，后续任务会被真实文件替换/可删除）
- Create: 全部 35 个 Markdown 文件路径（见"全局文件地图"），每个文件内容仅为一行 `# <文章标题>`（标题取自大纲，见下方 Task 1-4 的文件清单）

- [ ] **Step 1: 创建目录骨架**

```bash
cd /Users/arron/Desktop/ArronAI/agent-framework-insights
mkdir -p TypeScript-Node/00-课程导读
mkdir -p TypeScript-Node/01-环境搭建与工具链
mkdir -p TypeScript-Node/02-JavaScript-TypeScript语法基石
mkdir -p TypeScript-Node/03-TypeScript类型系统精讲
mkdir -p TypeScript-Node/04-异步编程模型
mkdir -p TypeScript-Node/05-Node.js运行时核心
mkdir -p TypeScript-Node/06-工程化实践
mkdir -p TypeScript-Node/07-进阶主题与总结
mkdir -p TypeScript-Node/examples
```

- [ ] **Step 2: 写 `package.json`（先写最小 shell，再用 npm 安装依赖，让 npm 自己写入版本号）**

```json
{
  "name": "typescript-node-course",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3: 安装依赖（不要手写版本号，让 npm 解析当前可用的最新版本）**

```bash
cd TypeScript-Node
npm install -D typescript tsx @types/node vitest
```

Expected: `package.json` 的 `devDependencies` 被 npm 自动写入四个包的版本号,`node_modules/`、`package-lock.json` 生成。

- [ ] **Step 4: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["examples/**/*.ts"]
}
```

- [ ] **Step 5: 写 `.gitignore`**

```
node_modules/
dist/
*.log
```

- [ ] **Step 6: 验证空工程可以类型检查（先放一个最小 hello 示例占位，Task 1 会替换成完整版）**

```bash
mkdir -p examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化
cat > examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.ts <<'EOF'
export function greet(name: string): string {
	return `Hello, ${name}!`;
}

console.log(greet("TypeScript"));
EOF
npm run typecheck
npx tsx examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.ts
```

Expected: `npm run typecheck` 无错误退出；`tsx` 命令输出 `Hello, TypeScript!`。

- [ ] **Step 7: 创建全部 35 篇文章的标题骨架文件**

依次创建以下文件,每个文件内容只有一行(文件标题,格式 `# 标题`)：

`00-课程导读/README.md`:
```markdown
# 课程导读
```

`01-环境搭建与工具链/`:
```
01-Node.js版本管理与安装.md      → # Node.js 版本管理与安装
02-TypeScript编译器与项目初始化.md → # TypeScript 编译器与项目初始化
03-包管理器与NPM生态.md          → # 包管理器与 NPM 生态
04-开发工具链与调试环境.md       → # 开发工具链与调试环境
```

`02-JavaScript-TypeScript语法基石/`:
```
01-值类型引用类型与相等性.md → # 值类型、引用类型与相等性
02-作用域闭包与this绑定.md   → # 作用域、闭包与 this 绑定
03-解构展开与函数高级用法.md → # 解构、展开与函数高级用法
04-模块系统ESM与CommonJS.md  → # 模块系统：ESM 与 CommonJS
05-迭代器生成器与集合类型.md → # 迭代器、生成器与集合类型
```

`03-TypeScript类型系统精讲/`:
```
01-基础类型与类型推断.md            → # 基础类型与类型推断
02-接口类型别名与联合交叉类型.md    → # 接口、类型别名与联合交叉类型
03-泛型编程.md                     → # 泛型编程
04-高级类型-映射条件与模板字面量.md → # 高级类型：映射类型、条件类型与模板字面量类型
05-类型体操实战-keyof-typeof-infer.md → # 类型体操实战：keyof / typeof / infer
06-类与面向对象类型系统.md          → # 类与面向对象类型系统
07-类型声明文件与第三方库类型.md    → # 类型声明文件与第三方库类型
```

`04-异步编程模型/`:
```
01-事件循环与任务队列.md    → # 事件循环与任务队列
02-Promise与async-await深入.md → # Promise 与 async/await 深入
03-错误处理与取消机制.md    → # 错误处理与取消机制
04-并发控制模式.md          → # 并发控制模式
```

`05-Node.js运行时核心/`:
```
01-模块解析与包系统机制.md    → # 模块解析与包系统机制
02-文件系统与Buffer二进制数据.md → # 文件系统与 Buffer 二进制数据
03-Stream流式处理.md          → # Stream 流式处理
04-网络编程-HTTP与WebSocket.md → # 网络编程：HTTP 与 WebSocket
05-子进程与WorkerThreads.md   → # 子进程与 Worker Threads
06-进程生命周期与优雅关闭.md  → # 进程生命周期与优雅关闭
```

`06-工程化实践/`:
```
01-项目结构与代码组织.md      → # 项目结构与代码组织
02-测试体系与Test-Runner.md   → # 测试体系与 Test Runner
03-调试性能剖析与内存泄漏排查.md → # 调试、性能剖析与内存泄漏排查
04-构建打包与NPM包发布.md     → # 构建打包与 NPM 包发布
```

`07-进阶主题与总结/`:
```
01-内存模型与垃圾回收.md      → # 内存模型与垃圾回收
02-性能优化实战.md            → # 性能优化实战
03-常见陷阱与最佳实践清单.md  → # 常见陷阱与最佳实践清单
04-课程总结与进阶方向.md      → # 课程总结与进阶方向
```

命令示例（对每个文件重复此模式）：

```bash
echo '# Node.js 版本管理与安装' > "01-环境搭建与工具链/01-Node.js版本管理与安装.md"
```

- [ ] **Step 8: 验证骨架完整性**

```bash
find TypeScript-Node -name "*.md" | wc -l
```

Expected: `36`（35 篇正文 + 00 章 README）。

- [ ] **Step 9: 提交**

```bash
cd /Users/arron/Desktop/ArronAI/agent-framework-insights
git add TypeScript-Node/
git commit -m "scaffold(TypeScript-Node): create npm project, tsconfig, and 35-article skeleton"
```

---

### Task 1: 第 01 章（环境搭建与工具链）+ 第 02 章（JS/TS 语法基石）—— 9 篇

**Files:**
- Modify（填充正文）: `TypeScript-Node/01-环境搭建与工具链/01-04-*.md`
- Modify（填充正文）: `TypeScript-Node/02-JavaScript-TypeScript语法基石/01-05-*.md`
- Create: `TypeScript-Node/examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.ts`（Task 0 已建最小版,本任务扩充为覆盖 `tsc`/`tsx`/`--watch` 对比的完整版）
- Create: `TypeScript-Node/examples/02-JavaScript-TypeScript语法基石/01-值类型引用类型与相等性/equality.ts`
- Create: `TypeScript-Node/examples/02-JavaScript-TypeScript语法基石/02-作用域闭包与this绑定/closures-and-this.ts`
- Create: `TypeScript-Node/examples/02-JavaScript-TypeScript语法基石/03-解构展开与函数高级用法/destructuring.ts`
- Create: `TypeScript-Node/examples/02-JavaScript-TypeScript语法基石/04-模块系统ESM与CommonJS/math-esm.ts`
- Create: `TypeScript-Node/examples/02-JavaScript-TypeScript语法基石/04-模块系统ESM与CommonJS/use-esm.ts`
- Create: `TypeScript-Node/examples/02-JavaScript-TypeScript语法基石/04-模块系统ESM与CommonJS/legacy-cjs.cjs`
- Create: `TypeScript-Node/examples/02-JavaScript-TypeScript语法基石/05-迭代器生成器与集合类型/generators.ts`

**读者假设：** 已经会另一门语言（Python/Java/Go 之类），因此不讲"什么是变量/函数/if"，直接讲 JS/TS 特有的坑和机制。

- [ ] **Step 1: 撰写第 01 章 4 篇（无需配套 `examples/` 代码，02 篇除外）**

逐篇必须覆盖的要点（写成完整 Markdown 正文，含至少一个可执行命令示例）：

- `01-Node.js版本管理与安装.md`：为什么 Node 版本管理很重要（ABI/LTS 节奏）；`nvm`/`fnm`/`volta` 三种版本管理器的选择建议；LTS vs Current 释义；`node -v`/`npm -v` 验证；Corepack 简介（为后续 pnpm/yarn 铺垫）。
- `02-TypeScript编译器与项目初始化.md`：`tsc --init` 生成的 `tsconfig.json` 关键字段逐一解释（`target`/`module`/`moduleResolution`/`strict`/`outDir`）；`tsc` 直接编译 vs `tsx`/`ts-node` 直接执行的取舍；引用并扩展 `examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.ts`，要求把示例文件扩展为同时演示 `npx tsc hello.ts && node hello.js`（编译执行）和 `npx tsx hello.ts`（直接执行）两条路径,并在文中给出两条命令的实际输出。
- `03-包管理器与NPM生态.md`：`package.json` 核心字段（`dependencies`/`devDependencies`/`scripts`/`exports`/`type`）；`npm`/`pnpm`/`yarn` 差异与 lockfile 机制；semver 语义（`^`/`~`/精确版本）；`npm ci` vs `npm install` 的场景区别。
- `04-开发工具链与调试环境.md`：ESLint + Prettier 定位与分工；VS Code 调试 `launch.json` 最小配置；`node --inspect`/Chrome DevTools 附加调试流程概览（详细内存剖析留给第 06 章第 3 篇）。

- [ ] **Step 2: 扩写 `examples/.../02-TypeScript编译器与项目初始化/hello.ts` 并验证**

要求文件同时展示: 一个带类型的导出函数、一个 `interface`、一处故意利用类型推断（不显式标注返回类型）。

```bash
cd TypeScript-Node
npm run typecheck
npx tsx "examples/01-环境搭建与工具链/02-TypeScript编译器与项目初始化/hello.ts"
```

Expected: typecheck 通过；tsx 输出与文章里贴的示例输出一致。

- [ ] **Step 3: 撰写第 02 章 5 篇 + 对应示例代码,逐篇验证**

`01-值类型引用类型与相等性.md` + `equality.ts`：
- 正文覆盖：原始值 vs 对象引用、`===` vs `==`、`Object.is` 与 `===` 的两处差异（`NaN`、`+0`/`-0`）、浅拷贝导致的别名 bug、`structuredClone`。
- `equality.ts` 必须包含：`console.log(NaN === NaN)`（false）、`console.log(Object.is(NaN, NaN))`（true）、`console.log(Object.is(0, -0))`（false）、一个对象别名修改导致意外共享状态的例子、`structuredClone` 深拷贝对比。

`02-作用域闭包与this绑定.md` + `closures-and-this.ts`：
- 正文覆盖：`var`/`let`/`const` 作用域差异、闭包捕获变量（非值）的经典 for 循环陷阱、`this` 的四种绑定规则（默认/隐式/显式/new）、箭头函数词法 `this`、`call`/`apply`/`bind`。
- `closures-and-this.ts` 必须包含：一个计数器闭包工厂函数、一个 `for (let i...)` vs `for (var i...)` 在 `setTimeout` 里行为不同的对比、一个类方法解构后丢失 `this` 后用箭头函数字段修复的例子。

`03-解构展开与函数高级用法.md` + `destructuring.ts`：
- 正文覆盖：数组/对象解构（含嵌套、默认值、重命名）、剩余参数与展开运算符在数组/对象上的区别、函数重载签名（`function f(x: string): string; function f(x: number): number;`）、可选参数与默认参数的类型推断差异。
- `destructuring.ts` 必须包含：一个嵌套对象解构+默认值+重命名的例子、数组展开合并、对象展开合并（含同名覆盖顺序）、一个真实可运行的函数重载实现。

`04-模块系统ESM与CommonJS.md` + `math-esm.ts`/`use-esm.ts`/`legacy-cjs.cjs`：
- 正文覆盖：`package.json` 的 `"type": "module"` 如何决定 `.js` 的解析方式、`.mjs`/`.cjs` 显式后缀、ESM 的 `import`/`export` 静态特性 vs CJS 的 `require` 动态特性、Node 里 `import` CJS 模块的互操作规则、`import.meta.url` 替代 `__dirname`。
- `math-esm.ts` 导出 `add`/`multiply` 两个函数；`use-esm.ts` 用 ESM `import` 语法消费它们并打印结果；`legacy-cjs.cjs` 用 `module.exports` 导出一个函数,在正文里展示如何从 ESM 的 `.ts` 文件里 `import` 这个 CJS 模块（用 `createRequire` 或默认导入两种方式各展示一次）。

`05-迭代器生成器与集合类型.md` + `generators.ts`：
- 正文覆盖：`Symbol.iterator` 协议、`for...of` 背后的机制、`function*` 生成器函数与 `yield`、`Map`/`Set`/`WeakMap`/`WeakSet` 与普通对象/数组的取舍。
- `generators.ts` 必须包含：一个实现了 `[Symbol.iterator]` 的自定义可迭代类（例如一个 `Range` 类）、一个生成器函数版本的斐波那契数列（惰性求值,取前 N 项）、一个 `Map` 用作缓存的例子。

每写完一个示例文件立刻验证：

```bash
cd TypeScript-Node
npm run typecheck
npx tsx "examples/02-JavaScript-TypeScript语法基石/<对应子目录>/<文件名>.ts"
```

Expected: typecheck 全部通过；每个可执行文件跑出的 console 输出要在对应文章里原样引用（不能编造输出）。

- [ ] **Step 4: 全量类型检查**

```bash
cd TypeScript-Node
npm run typecheck
```

Expected: 零错误。

- [ ] **Step 5: 提交**

```bash
cd /Users/arron/Desktop/ArronAI/agent-framework-insights
git add TypeScript-Node/01-环境搭建与工具链 TypeScript-Node/02-JavaScript-TypeScript语法基石 TypeScript-Node/examples/01-环境搭建与工具链 TypeScript-Node/examples/02-JavaScript-TypeScript语法基石
git commit -m "docs(TypeScript-Node): write chapter 01-02 (environment + JS/TS syntax basics)"
```

---

### Task 2: 第 03 章（TypeScript 类型系统精讲）—— 7 篇，全课程分量最重

**Files:**
- Modify（填充正文）: `TypeScript-Node/03-TypeScript类型系统精讲/01-07-*.md`
- Create: `TypeScript-Node/examples/03-TypeScript类型系统精讲/01-基础类型与类型推断/inference.ts`
- Create: `TypeScript-Node/examples/03-TypeScript类型系统精讲/02-接口类型别名与联合交叉类型/union-intersection.ts`
- Create: `TypeScript-Node/examples/03-TypeScript类型系统精讲/03-泛型编程/generics.ts`
- Create: `TypeScript-Node/examples/03-TypeScript类型系统精讲/04-高级类型-映射条件与模板字面量/mapped-conditional-template.ts`
- Create: `TypeScript-Node/examples/03-TypeScript类型系统精讲/05-类型体操实战/type-gymnastics.ts`
- Create: `TypeScript-Node/examples/03-TypeScript类型系统精讲/06-类与面向对象类型系统/classes.ts`
- Create: `TypeScript-Node/examples/03-TypeScript类型系统精讲/07-类型声明文件与第三方库类型/legacy-lib.js`
- Create: `TypeScript-Node/examples/03-TypeScript类型系统精讲/07-类型声明文件与第三方库类型/legacy-lib.d.ts`
- Create: `TypeScript-Node/examples/03-TypeScript类型系统精讲/07-类型声明文件与第三方库类型/consumer.ts`

- [ ] **Step 1: `01-基础类型与类型推断.md` + `inference.ts`**

正文覆盖：原始类型（`string`/`number`/`boolean`/`bigint`/`symbol`/`null`/`undefined`）、`any` vs `unknown` 的关键区别（为什么应该几乎总用 `unknown`）、字面量类型、`const` 断言（`as const`）、类型宽化（widening）规则（`let` 推断成宽类型,`const` 推断成字面量类型）、上下文类型推断（contextual typing，如回调参数）。

`inference.ts` 必须包含：`let`/`const` 声明同一个字符串字面量后类型分别是什么（用注释标注推断出的类型）、一个 `as const` 把数组变成只读元组的例子、一个 `unknown` 类型必须先做类型收窄（`typeof` 检查）才能使用的例子、一个数组 `.map()` 回调参数被上下文推断出元素类型的例子。

- [ ] **Step 2: `02-接口类型别名与联合交叉类型.md` + `union-intersection.ts`**

正文覆盖：`interface` vs `type` 的实际差异（声明合并、可扩展性）、联合类型（`|`）与交叉类型（`&`）、可辨识联合（discriminated union）模式、用 `never` 做穷尽性检查（exhaustiveness check）。

`union-intersection.ts` 必须包含：一个可辨识联合类型（例如 `Shape = Circle | Square | Triangle`，每种带 `kind` 字段）、一个 `switch` 对 `kind` 做穷尽匹配、`default` 分支里用 `const _exhaustive: never = shape` 触发编译期检查（并在正文里展示故意漏掉一个分支时 `tsc` 报错的真实错误信息）。

- [ ] **Step 3: `03-泛型编程.md` + `generics.ts`**

正文覆盖：泛型函数、泛型约束（`extends`）、泛型默认类型参数、泛型类（如 `Stack<T>`）、协变/逆变直觉（不深入形式化定义,给出"数组的只读视角可以协变"这类直觉例子）。

`generics.ts` 必须包含：一个带约束的泛型函数（`function pluck<T, K extends keyof T>(obj: T, key: K): T[K]`）、一个泛型 `Stack<T>` 类（`push`/`pop`/`peek`,含空栈时 `pop` 返回 `undefined` 的类型体现）、一个带默认类型参数的泛型接口。

- [ ] **Step 4: `04-高级类型-映射条件与模板字面量.md` + `mapped-conditional-template.ts`**

正文覆盖：映射类型语法（`[K in keyof T]`）、`Partial`/`Readonly`/`Pick`/`Record` 的手写实现原理、条件类型（`T extends U ? X : Y`）、分布式条件类型（union 输入会被逐个分发）、模板字面量类型。

`mapped-conditional-template.ts` 必须包含：手写一个 `MyPartial<T>` 映射类型并验证等价于内置 `Partial<T>`、一个分布式条件类型的例子（对 `string | number` 分别过滤出 `string` 的 `Extract`-like 类型,并展示如果用 `[T] extends [U]` 包一层元组会阻止分布）、一个模板字面量类型例子（例如根据 HTTP method 字符串拼出 `` `GET /users` `` 这类路由字符串的类型）。

- [ ] **Step 5: `05-类型体操实战-keyof-typeof-infer.md` + `type-gymnastics.ts`**

正文覆盖：`keyof`、`typeof`（类型层面,不是运行时 `typeof`）、`infer` 关键字在条件类型里提取子类型。**每个类型体操例子必须配一个直观的使用场景，不能是纯理论展示**（这是设计文档明确要求的风险点）。

`type-gymnastics.ts` 必须包含且每个都要有真实使用场景注释：
- `DeepReadonly<T>`（场景：冻结一份配置对象,防止运行时被意外修改，用递归映射类型 + 条件类型判断是否要继续递归进对象）；
- `UnwrapPromise<T>`（场景：写一个通用的"从任意返回 Promise 的函数类型里提取最终 resolve 值类型"的工具类型，用 `infer` 从 `Promise<infer R>` 提取 `R`）；
- 一个用 `typeof` + `keyof` 组合、从一个真实的 `const config = {...}` 对象值推导出配置项类型的例子（场景：避免维护两份重复的类型定义和运行时对象）。

- [ ] **Step 6: `06-类与面向对象类型系统.md` + `classes.ts`**

正文覆盖：`public`/`private`/`protected`/`readonly` 修饰符、参数属性简写（constructor 参数直接声明成员）、`abstract class`、`implements` vs `extends`、`static` 成员、getter/setter。

`classes.ts` 必须包含：一个抽象类（`abstract class Shape { abstract area(): number }`）+ 两个具体子类、一个用参数属性简写的类、一个 `private` 字段配 getter 对外暴露只读访问的例子。

- [ ] **Step 7: `07-类型声明文件与第三方库类型.md` + `legacy-lib.js`/`legacy-lib.d.ts`/`consumer.ts`**

正文覆盖：`.d.ts` 文件的作用、`declare module`/`declare function`、DefinitelyTyped（`@types/*`）生态、如何给一个没有类型的第三方 JS 库手写声明文件、模块声明文件与源文件同名共存时 TS 的解析规则。

- `legacy-lib.js`：一个没有类型的、用 `module.exports` 导出一个函数的"遗留 JS 库"（如 `function formatCurrency(amount, currency) {...}`）。
- `legacy-lib.d.ts`：手写的声明文件,声明 `formatCurrency` 的参数和返回值类型。
- `consumer.ts`：`import { formatCurrency } from "./legacy-lib.js"`，在有类型的情况下调用它，并展示如果传入错误类型的参数,`tsc` 会在编译期报错（正文里贴出这个报错信息作为演示）。

- [ ] **Step 8: 对本章全部 9 个示例文件跑验证**

```bash
cd TypeScript-Node
npm run typecheck
for f in \
  "examples/03-TypeScript类型系统精讲/01-基础类型与类型推断/inference.ts" \
  "examples/03-TypeScript类型系统精讲/02-接口类型别名与联合交叉类型/union-intersection.ts" \
  "examples/03-TypeScript类型系统精讲/03-泛型编程/generics.ts" \
  "examples/03-TypeScript类型系统精讲/04-高级类型-映射条件与模板字面量/mapped-conditional-template.ts" \
  "examples/03-TypeScript类型系统精讲/05-类型体操实战/type-gymnastics.ts" \
  "examples/03-TypeScript类型系统精讲/06-类与面向对象类型系统/classes.ts" \
  "examples/03-TypeScript类型系统精讲/07-类型声明文件与第三方库类型/consumer.ts" \
; do echo "=== $f ==="; npx tsx "$f"; done
```

Expected: `npm run typecheck` 零错误；每个文件跑出的输出要在对应文章里原样引用。

- [ ] **Step 9: 提交**

```bash
cd /Users/arron/Desktop/ArronAI/agent-framework-insights
git add TypeScript-Node/03-TypeScript类型系统精讲 TypeScript-Node/examples/03-TypeScript类型系统精讲
git commit -m "docs(TypeScript-Node): write chapter 03 (TypeScript type system deep dive)"
```

---

### Task 3: 第 04 章（异步编程模型）+ 第 05 章（Node.js 运行时核心）—— 10 篇

**Files:**
- Modify（填充正文）: `TypeScript-Node/04-异步编程模型/01-04-*.md`
- Modify（填充正文）: `TypeScript-Node/05-Node.js运行时核心/01-06-*.md`
- Create: `TypeScript-Node/examples/04-异步编程模型/01-事件循环与任务队列/event-loop-order.ts`
- Create: `TypeScript-Node/examples/04-异步编程模型/02-Promise与async-await深入/async-patterns.ts`
- Create: `TypeScript-Node/examples/04-异步编程模型/03-错误处理与取消机制/abort-and-errors.ts`
- Create: `TypeScript-Node/examples/04-异步编程模型/04-并发控制模式/concurrency-limit.ts`
- Create: `TypeScript-Node/examples/05-Node.js运行时核心/01-模块解析与包系统机制/resolve-demo.ts`
- Create: `TypeScript-Node/examples/05-Node.js运行时核心/02-文件系统与Buffer/fs-buffer.ts`
- Create: `TypeScript-Node/examples/05-Node.js运行时核心/03-Stream流式处理/streams.ts`
- Create: `TypeScript-Node/examples/05-Node.js运行时核心/04-网络编程/http-server.ts`
- Create: `TypeScript-Node/examples/05-Node.js运行时核心/04-网络编程/ws-handshake-demo.ts`
- Create: `TypeScript-Node/examples/05-Node.js运行时核心/05-子进程与WorkerThreads/worker-script.cjs`
- Create: `TypeScript-Node/examples/05-Node.js运行时核心/05-子进程与WorkerThreads/worker-main.ts`
- Create: `TypeScript-Node/examples/05-Node.js运行时核心/05-子进程与WorkerThreads/spawn-demo.ts`
- Create: `TypeScript-Node/examples/05-Node.js运行时核心/06-进程生命周期/graceful-shutdown.ts`

- [ ] **Step 1: `01-事件循环与任务队列.md` + `event-loop-order.ts`**

正文覆盖：调用栈、宏任务（`setTimeout`/`setImmediate`/I/O 回调）与微任务（`Promise.then`/`queueMicrotask`）的执行顺序、Node 特有的 `process.nextTick`（优先级高于普通微任务）、事件循环的六个阶段（timers/pending callbacks/poll/check/close callbacks 概览,不需要逐阶段展开源码）。

`event-loop-order.ts` 必须包含一段混合了 `console.log`、`setTimeout(fn, 0)`、`Promise.resolve().then()`、`queueMicrotask()`、`process.nextTick()` 的代码,正文里必须贴出实际运行得到的打印顺序（用 `npx tsx` 跑出真实结果,不能凭记忆编）。

- [ ] **Step 2: `02-Promise与async-await深入.md` + `async-patterns.ts`**

正文覆盖：`Promise` 状态机（pending/fulfilled/rejected 且不可逆）、`async`/`await` 是 Promise 的语法糖、`Promise.all`（快速失败）/`Promise.allSettled`（等全部完成）/`Promise.race`/`Promise.any` 的语义区别与选用场景、async generator（`async function*`）。

`async-patterns.ts` 必须包含：`Promise.all` 遇到一个 reject 立刻整体 reject 的例子、`Promise.allSettled` 收集所有成功/失败结果的例子、一个 async generator 逐步产出数据并用 `for await...of` 消费的例子。

- [ ] **Step 3: `03-错误处理与取消机制.md` + `abort-and-errors.ts`**

正文覆盖：`try/catch/finally` 在 `async` 函数里的语义、自定义 `Error` 子类（`class ValidationError extends Error`）、`AbortController`/`AbortSignal` 作为跨 API 统一的取消机制、`unhandledRejection`/`uncaughtException` 事件。

`abort-and-errors.ts` 必须包含：一个自定义 `Error` 子类并在 `catch` 里用 `instanceof` 区分错误类型、一个用 `AbortController` 实现超时取消的例子（例如包装一个永远不 resolve 的 Promise,用 `signal.addEventListener("abort", ...)` 在超时后 reject）、一个监听 `process.on("unhandledRejection", ...)` 并主动触发一次未处理 rejection 来演示的例子。

- [ ] **Step 4: `04-并发控制模式.md` + `concurrency-limit.ts`**

正文覆盖：为什么需要限制并发（例如批量请求外部 API 不能无限并发）、简单任务队列实现思路、`Promise.all` 天真并发 vs 受限并发的对比。

`concurrency-limit.ts` 必须实现一个 `runWithConcurrencyLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]>` 函数（不依赖第三方库,自己实现),并用几个 `setTimeout` 模拟的异步任务演示：先跑一次 `limit=Infinity`（等价于全部同时开始）,再跑一次 `limit=2`，在正文里贴出两次运行时打印的"任务开始时间戳"日志对比,证明并发数确实被限制住了。

- [ ] **Step 5: `01-模块解析与包系统机制.md` + `resolve-demo.ts`**

正文覆盖：Node 的模块解析算法概览（相对路径/裸模块说明符/`node_modules` 逐级向上查找）、`package.json` 的 `exports` 字段如何控制包的公开入口（子路径导出、条件导出 `import`/`require`/`types`）、ESM 下 `__dirname`/`__filename` 不存在,替代方案 `import.meta.url` + `fileURLToPath`。

`resolve-demo.ts` 必须包含：用 `import.meta.url` 和 `node:url` 的 `fileURLToPath` 算出当前文件所在目录并打印、用 `import.meta.resolve`（或 `require.resolve` 的 ESM 等价方式,取决于 Node 26 实际可用 API,写作时需要先用 `node --version` 确认该 API 可用）解析出某个内置模块（如 `node:path`）的真实路径并打印。

- [ ] **Step 6: `02-文件系统与Buffer二进制数据.md` + `fs-buffer.ts`**

正文覆盖：`node:fs/promises` 的 `readFile`/`writeFile`/`mkdir`（含 `{ recursive: true }`）、同步 API vs 异步 API vs Promise API 三套的取舍、`Buffer` 是什么（`Uint8Array` 的子类）、常见编码转换（`utf8`/`hex`/`base64`）。

`fs-buffer.ts` 必须包含：用 `fs/promises` 写一个临时文件再读回来（写到 `os.tmpdir()` 下,避免污染仓库）、一段字符串与 `Buffer` 互转并展示 `hex`/`base64` 两种编码输出、直接操作 `Buffer` 字节（如 `buf[0] = 0x41`）的例子。

- [ ] **Step 7: `03-Stream流式处理.md` + `streams.ts`**

正文覆盖：`Readable`/`Writable`/`Duplex`/`Transform` 四种流、背压（backpressure）概念、为什么应该用 `stream.pipeline()` 而不是手写 `.pipe()` 链（错误处理更可靠）。

`streams.ts` 必须包含：一个自定义 `Transform` 流（例如把流过的文本转成大写）、用 `node:stream/promises` 的 `pipeline()` 把一个 `Readable`（`Readable.from(["a", "b", "c"])`）经过这个 `Transform` 流到一个收集结果的 `Writable`，最终打印收集到的结果。

- [ ] **Step 8: `04-网络编程-HTTP与WebSocket.md` + `http-server.ts`/`ws-handshake-demo.ts`**

正文覆盖：`node:http` 创建服务器的最小示例、`fetch`（Node 内置全局）作为客户端、HTTP 长连接与 keep-alive 简述；WebSocket 部分**不引入 `ws` 第三方包**（保持 devDependencies 精简）,改为讲清楚 WebSocket 握手在 HTTP 层面究竟做了什么（`Upgrade: websocket` 请求头、`Sec-WebSocket-Key`/`Sec-WebSocket-Accept` 的 SHA-1 + Base64 计算规则）,并给出一个手写最小握手的教学示例（只做握手,不实现完整帧解析协议,文中明确说明生产环境应该用 `ws` 库）。

- `http-server.ts`：起一个 `node:http` 服务器,监听一个随机端口,注册一个返回 JSON 的路由,再用 `fetch` 请求它自己并打印响应,最后关闭服务器退出进程。
- `ws-handshake-demo.ts`：实现 WebSocket 握手所需的 `Sec-WebSocket-Accept` 计算（`crypto.createHash("sha1")` + 固定 GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` + base64），对着一个真实的 `Sec-WebSocket-Key` 例子算出结果并打印,和 RFC 6455 给出的官方例子核对是否一致。

- [ ] **Step 9: `05-子进程与WorkerThreads.md` + `worker-script.cjs`/`worker-main.ts`/`spawn-demo.ts`**

正文覆盖：`child_process.spawn`/`exec`/`execFile`/`fork` 的区别与选用场景、`worker_threads` 与子进程的本质区别（共享内存 `SharedArrayBuffer` vs 完全隔离的进程）、`parentPort`/`workerData` 通信模型。

- `spawn-demo.ts`：用 `child_process.spawn("node", ["-e", "console.log('hi from child')"])` 起一个子进程,收集 stdout,等待退出码。
- `worker-script.cjs`：一个纯 JS 的 worker 脚本,通过 `parentPort.postMessage` 把 `workerData` 传入的两个数字相加后传回。
- `worker-main.ts`：用 `new Worker(new URL("./worker-script.cjs", import.meta.url), { workerData: { a: 2, b: 3 } })` 起这个 worker,监听 `message` 事件拿到结果并打印,说明为什么这里 worker 脚本用 `.cjs` 而不是让 `tsx` 去处理 worker 内部的 TS（worker 线程默认不会经过启动主线程时的 `tsx` 加载器,直接跑 `.cjs` 最省心）。

- [ ] **Step 10: `06-进程生命周期与优雅关闭.md` + `graceful-shutdown.ts`**

正文覆盖：`process.on("exit")` 的限制（只能做同步收尾）、`SIGINT`/`SIGTERM` 信号处理、一个 HTTP 服务收到终止信号后"停止接收新连接、等现有请求完成、再退出"的标准优雅关闭模式。

`graceful-shutdown.ts` 必须实现：起一个 `node:http` 服务器,注册 `SIGTERM`/`SIGINT` 处理器,收到信号后调用 `server.close()` 并打印关闭进度日志,设置一个兜底超时（例如 5 秒后强制 `process.exit(1)`）。文中要说明这个文件设计为手动用 `Ctrl+C` 测试,不是自动化跑一次就结束的脚本。

- [ ] **Step 11: 对本任务全部示例文件跑验证**

```bash
cd TypeScript-Node
npm run typecheck
npx tsx "examples/04-异步编程模型/01-事件循环与任务队列/event-loop-order.ts"
npx tsx "examples/04-异步编程模型/02-Promise与async-await深入/async-patterns.ts"
npx tsx "examples/04-异步编程模型/03-错误处理与取消机制/abort-and-errors.ts"
npx tsx "examples/04-异步编程模型/04-并发控制模式/concurrency-limit.ts"
npx tsx "examples/05-Node.js运行时核心/01-模块解析与包系统机制/resolve-demo.ts"
npx tsx "examples/05-Node.js运行时核心/02-文件系统与Buffer/fs-buffer.ts"
npx tsx "examples/05-Node.js运行时核心/03-Stream流式处理/streams.ts"
npx tsx "examples/05-Node.js运行时核心/04-网络编程/http-server.ts"
npx tsx "examples/05-Node.js运行时核心/04-网络编程/ws-handshake-demo.ts"
npx tsx "examples/05-Node.js运行时核心/05-子进程与WorkerThreads/spawn-demo.ts"
npx tsx "examples/05-Node.js运行时核心/05-子进程与WorkerThreads/worker-main.ts"
```

Expected: typecheck 零错误；`graceful-shutdown.ts` 不在自动化列表里（它是交互式脚本，改为只做 `npx tsc --noEmit` 覆盖到即可,正文里注明手动测试方法）；其余每个命令都要有真实退出（`http-server.ts`/`spawn-demo.ts`/`worker-main.ts` 里必须显式调用 `process.exit(0)` 或让事件循环自然清空,不能挂起导致命令不退出）。

- [ ] **Step 12: 提交**

```bash
cd /Users/arron/Desktop/ArronAI/agent-framework-insights
git add TypeScript-Node/04-异步编程模型 TypeScript-Node/05-Node.js运行时核心 TypeScript-Node/examples/04-异步编程模型 TypeScript-Node/examples/05-Node.js运行时核心
git commit -m "docs(TypeScript-Node): write chapter 04-05 (async model + Node.js runtime core)"
```

---

### Task 4: 第 06 章（工程化实践）+ 第 07 章（进阶主题与总结）—— 8 篇

**Files:**
- Modify（填充正文）: `TypeScript-Node/06-工程化实践/01-04-*.md`
- Modify（填充正文）: `TypeScript-Node/07-进阶主题与总结/01-04-*.md`
- Create: `TypeScript-Node/examples/06-工程化实践/02-测试体系/math.ts`
- Create: `TypeScript-Node/examples/06-工程化实践/02-测试体系/math.test.ts`
- Create: `TypeScript-Node/examples/07-进阶主题与总结/01-内存模型与垃圾回收/gc-demo.ts`
- Create: `TypeScript-Node/examples/07-进阶主题与总结/02-性能优化实战/benchmark.ts`
- Create: `TypeScript-Node/examples/07-进阶主题与总结/03-常见陷阱与最佳实践清单/pitfalls.ts`

- [ ] **Step 1: `01-项目结构与代码组织.md`（无需配套 examples）**

正文覆盖：按功能而非按技术层组织目录（对比 `controllers/`+`models/`+`views/` 这种按层分 vs 按业务域分）、`src/`+`tests/` 惯例、桶文件（`index.ts` re-export）的利弊（编译性能/循环依赖风险）、`tsconfig.json` 的 `paths` 别名与何时不该用。

- [ ] **Step 2: `02-测试体系与Test-Runner.md` + `math.ts`/`math.test.ts`**

正文覆盖：Node 内建 `node:test` runner 概览（`node --test`）、Vitest 的定位与相对 Jest 的优势（原生 ESM/TS、更快）、测试文件命名约定、`describe`/`it`/`expect` 基本用法。**明确说明**：本章示例是"教读者怎么给自己的代码写测试"，不是给这门课程本身的文章或其余示例代码编写测试套件。

- `math.ts`：导出 `add`/`divide`（`divide` 在除数为 0 时抛出自定义错误）。
- `math.test.ts`：用 Vitest 写 `describe("math")` 块,覆盖 `add` 的正常情况和 `divide` 除以 0 抛错的情况（`expect(() => divide(1, 0)).toThrow()`）。

验证：
```bash
cd TypeScript-Node
npx vitest run "examples/06-工程化实践/02-测试体系/math.test.ts"
```
Expected: 全部测试通过,正文贴出真实的 vitest 输出摘要。

- [ ] **Step 3: `03-调试性能剖析与内存泄漏排查.md` + `gc-demo.ts` 复用说明**

正文覆盖：`node --inspect`/`--inspect-brk` 配合 Chrome DevTools 的连接流程、`--prof`+`node --prof-process` 生成 CPU profile 的命令、用 `process.memoryUsage()` 观察内存增长、堆快照（heap snapshot）定位泄漏的基本思路。本篇引用第 07 章 `01-内存模型与垃圾回收/gc-demo.ts`（该文件在 Step 6 创建）作为"如何用它排查内存泄漏"的实操对象,不重复建示例文件。

- [ ] **Step 4: `04-构建打包与NPM包发布.md`（无需新增 devDependencies，用已有的 `typescript` 演示）**

正文覆盖：用 `tsc`（而不是引入 `tsup`/`esbuild` 这类新依赖）把一个 TS 库编译成可发布的 `dist/`（`outDir`+`declaration: true`+`declarationMap`）、`package.json` 里 `main`/`types`/`exports`/`files` 字段如何配合让消费者既能拿到编译产物又能拿到类型、`npm publish` 流程（`npm pack --dry-run` 先看看会发布哪些文件、`npm version`、语义化版本升级规则）、`.npmignore`/`files` 白名单的取舍。文中给出一份独立的示例 `tsconfig.build.json`（继承主 `tsconfig.json` 但打开 `declaration`/`outDir`）作为代码块展示,不需要放进 `examples/` 目录（这是关于"另一个项目怎么发布"的说明性配置,不属于本课程工程本身）。

- [ ] **Step 5: `01-内存模型与垃圾回收.md` + `gc-demo.ts`**

正文覆盖：V8 堆的分代假设（新生代/老生代）简述、标记-清除与增量/并发 GC 概览（不需要讲 V8 源码级细节）、`WeakRef`/`FinalizationRegistry` 的用途与"不要依赖 GC 时机做业务逻辑"的告诫、`--expose-gc` 手动触发 GC 的调试用法。

`gc-demo.ts` 必须包含：一个故意用全局数组不断 `push` 制造"内存泄漏"的函数、用 `process.memoryUsage().heapUsed` 在泄漏前后打印对比、一个 `WeakRef` 包裹对象、在没有强引用后（配合 `--expose-gc` 手动 `global.gc()`）观察 `weakRef.deref()` 变成 `undefined` 的例子。文中需要说明运行方式：`node --expose-gc --import tsx gc-demo.ts`（因为 `--expose-gc` 是 Node flag,需要显式加）。

- [ ] **Step 6: `02-性能优化实战.md` + `benchmark.ts`**

正文覆盖：先测量再优化的原则、`performance.now()`/`console.time`/`console.timeEnd` 的用法、几个常见"直觉但错"的性能陷阱（字符串拼接 `+=` vs 数组 `join`、对象属性查找 vs `Map` 查找、不必要的深拷贝）。

`benchmark.ts` 必须包含至少两组真实基准测试（用 `performance.now()` 手写,不引入 `benchmark.js` 之类新依赖）：一组对比大量字符串拼接用 `+=` vs `Array.push` + `join("")`；一组对比高频查找用普通对象 vs `Map`。正文必须贴出在本机（Node v26.5.0）实际跑出的耗时数字,并说明"具体数字因机器而异,关注的是相对趋势"。

- [ ] **Step 7: `03-常见陷阱与最佳实践清单.md` + `pitfalls.ts`**

正文用清单体（每条"❌ 错误写法 / ✅ 正确写法"配简短解释）覆盖至少 8 条,必须包括：`==` 隐式转换陷阱、忘记 `await` 导致的悬空 Promise（silently swallowed rejection）、`for...in` 遍历数组的隐患（应该用 `for...of`/`.forEach`）、可变默认参数/闭包共享可变状态、`any` 类型逃逸导致类型系统形同虚设、浮点数精度问题（`0.1 + 0.2 !== 0.3`）、同步阻塞操作（如 `fs.readFileSync`）出现在请求处理路径里拖垮吞吐、忘记处理 `AbortSignal`/超时导致资源泄漏。

`pitfalls.ts` 对其中至少 4 条给出"错误写法 vs 正确写法"成对的可运行代码（用注释标注 `// ❌` / `// ✅`），运行后打印结果验证两种写法行为确实不同。

- [ ] **Step 8: `04-课程总结与进阶方向.md`（无需配套 examples）**

正文覆盖：
1. 回顾全课程 7 章 35 篇的知识地图（一段话概括,不逐篇罗列）；
2. 进阶方向建议：V8 引擎内部机制、Node.js 源码贡献、具体后端框架（NestJS/Fastify）深入、前端 TS 实践（React + TS）；
3. **明确的仓库内衔接**：本仓库的 `PI/` 课程整套是用 TypeScript 写成的真实生产级项目（终端编码 Agent），读完这套语言/运行时课程后,具备了读懂 `PI/03-Agent核心原理` 等章节里源码片段的语言基础；建议把 `PI/00-课程导读/README.md` 作为"学完 TS/Node 基础后的第一个实战阅读目标"，并简要说明 PI 课程会用到本课程学过的哪些概念（异步模型、模块系统、Stream、类型体操里的泛型/条件类型等在真实项目里随处可见）。

- [ ] **Step 9: 对本任务全部示例文件跑验证**

```bash
cd TypeScript-Node
npm run typecheck
npx vitest run "examples/06-工程化实践/02-测试体系/math.test.ts"
node --expose-gc --import tsx "examples/07-进阶主题与总结/01-内存模型与垃圾回收/gc-demo.ts"
npx tsx "examples/07-进阶主题与总结/02-性能优化实战/benchmark.ts"
npx tsx "examples/07-进阶主题与总结/03-常见陷阱与最佳实践清单/pitfalls.ts"
```

Expected: typecheck 零错误；vitest 测试全部通过；三个可执行文件均正常退出且输出被正文引用。

- [ ] **Step 10: 提交**

```bash
cd /Users/arron/Desktop/ArronAI/agent-framework-insights
git add TypeScript-Node/06-工程化实践 TypeScript-Node/07-进阶主题与总结 TypeScript-Node/examples/06-工程化实践 TypeScript-Node/examples/07-进阶主题与总结
git commit -m "docs(TypeScript-Node): write chapter 06-07 (engineering practices + advanced topics & summary)"
```

---

### Task 5: 全局一致性检查 + 接入仓库根 README.md

**Files:**
- Modify: `README.md`（根目录）
- Modify（如发现问题）: `TypeScript-Node/` 下任意文章

- [ ] **Step 1: Markdown 代码围栏成对检查**

```bash
cd /Users/arron/Desktop/ArronAI/agent-framework-insights
for f in $(find TypeScript-Node -name "*.md"); do
  n=$(grep -c '^```' "$f")
  if [ $((n % 2)) -ne 0 ]; then echo "ODD FENCE COUNT ($n): $f"; fi
done
echo "fence check done"
```

Expected: 无输出（除最后一行 `fence check done`）。如有文件被列出,回到对应 Task 修好。

- [ ] **Step 2: 正文引用的 `examples/` 路径存在性检查**

```bash
cd /Users/arron/Desktop/ArronAI/agent-framework-insights/TypeScript-Node
grep -rho 'examples/[^ )`]*\.\(ts\|cjs\|js\)' --include="*.md" . | sort -u | while read -r p; do
  [ -f "$p" ] || echo "MISSING FILE referenced in docs: $p"
done
```

Expected: 无输出。如有缺失,回到对应 Task 补齐文件或修正正文里的路径。

- [ ] **Step 3: 全量类型检查与全量测试**

```bash
cd /Users/arron/Desktop/ArronAI/agent-framework-insights/TypeScript-Node
npm run typecheck
npx vitest run
```

Expected: 两条命令都零错误退出。

- [ ] **Step 4: 更新根 `README.md` 顶部简介，把"六套"改为"七套"并说明第七套的不同性质**

把第 3 行：

```markdown
> 六套面向"彻底剖析"的中文技术课程,分别系统性拆解六个真实开源 Agent Harness 项目的架构：先会用，再懂原理，最后能扩展。每篇文章都摘录真实源码并逐段讲解设计动机，而不是停留在使用文档层面。
```

改为：

```markdown
> 七套中文技术课程：前六套面向"彻底剖析"，系统性拆解六个真实开源 Agent Harness 项目的架构（先会用，再懂原理，最后能扩展；每篇文章都摘录真实源码并逐段讲解设计动机），第七套是独立的 TypeScript / Node.js 体系化教程——不依附任何具体开源项目，面向"会其他语言、没系统学过 TS/Node"的开发者,补齐读懂前六套课程里那些 TypeScript 源码片段所需的语言与运行时基础。
```

- [ ] **Step 5: 在"## 课程六：OpenWorker"章节结尾（`---` 分隔线之前，即 `## 六个项目的架构哲学速览` 标题之前）插入"## 课程七"章节**

插入内容（`<details>` 目录部分需要用 Task 0-4 实际创建的 35 篇文件名逐一核对无误后再填,以下是基于本计划文件地图的完整版本）：

```markdown
## 课程七：TypeScript & Node.js —— 从入门到精通

不依附任何具体开源项目的独立体系化教程，面向"已经会其他编程语言、但没系统学过 TypeScript/Node.js"的开发者：从环境搭建、JS/TS 语法基石，到 TypeScript 类型系统精讲（含类型体操实战）、异步编程模型、Node.js 运行时核心（模块系统/Stream/网络编程/子进程与 Worker Threads），再到工程化实践与性能/内存进阶主题。每篇都配有可运行、可类型检查的示例代码（`TypeScript-Node/examples/`）。学完这套课程，再去读 PI 课程里的 TypeScript 源码片段会顺畅很多。

👉 从 [TypeScript-Node/00-课程导读/README.md](TypeScript-Node/00-课程导读/README.md) 开始。

<details>
<summary>展开完整目录（35 篇）</summary>

- **00-课程导读**：[README](TypeScript-Node/00-课程导读/README.md)
- **01-环境搭建与工具链**：[Node.js 版本管理与安装](TypeScript-Node/01-环境搭建与工具链/01-Node.js版本管理与安装.md) · [TypeScript 编译器与项目初始化](TypeScript-Node/01-环境搭建与工具链/02-TypeScript编译器与项目初始化.md) · [包管理器与 NPM 生态](TypeScript-Node/01-环境搭建与工具链/03-包管理器与NPM生态.md) · [开发工具链与调试环境](TypeScript-Node/01-环境搭建与工具链/04-开发工具链与调试环境.md)
- **02-JavaScript/TypeScript 语法基石**：[值类型、引用类型与相等性](TypeScript-Node/02-JavaScript-TypeScript语法基石/01-值类型引用类型与相等性.md) · [作用域、闭包与 this 绑定](TypeScript-Node/02-JavaScript-TypeScript语法基石/02-作用域闭包与this绑定.md) · [解构、展开与函数高级用法](TypeScript-Node/02-JavaScript-TypeScript语法基石/03-解构展开与函数高级用法.md) · [模块系统：ESM 与 CommonJS](TypeScript-Node/02-JavaScript-TypeScript语法基石/04-模块系统ESM与CommonJS.md) · [迭代器、生成器与集合类型](TypeScript-Node/02-JavaScript-TypeScript语法基石/05-迭代器生成器与集合类型.md)
- **03-TypeScript 类型系统精讲**：[基础类型与类型推断](TypeScript-Node/03-TypeScript类型系统精讲/01-基础类型与类型推断.md) · [接口、类型别名与联合交叉类型](TypeScript-Node/03-TypeScript类型系统精讲/02-接口类型别名与联合交叉类型.md) · [泛型编程](TypeScript-Node/03-TypeScript类型系统精讲/03-泛型编程.md) · [高级类型：映射、条件与模板字面量类型](TypeScript-Node/03-TypeScript类型系统精讲/04-高级类型-映射条件与模板字面量.md) · [类型体操实战：keyof / typeof / infer](TypeScript-Node/03-TypeScript类型系统精讲/05-类型体操实战-keyof-typeof-infer.md) · [类与面向对象类型系统](TypeScript-Node/03-TypeScript类型系统精讲/06-类与面向对象类型系统.md) · [类型声明文件与第三方库类型](TypeScript-Node/03-TypeScript类型系统精讲/07-类型声明文件与第三方库类型.md)
- **04-异步编程模型**：[事件循环与任务队列](TypeScript-Node/04-异步编程模型/01-事件循环与任务队列.md) · [Promise 与 async/await 深入](TypeScript-Node/04-异步编程模型/02-Promise与async-await深入.md) · [错误处理与取消机制](TypeScript-Node/04-异步编程模型/03-错误处理与取消机制.md) · [并发控制模式](TypeScript-Node/04-异步编程模型/04-并发控制模式.md)
- **05-Node.js 运行时核心**：[模块解析与包系统机制](TypeScript-Node/05-Node.js运行时核心/01-模块解析与包系统机制.md) · [文件系统与 Buffer 二进制数据](TypeScript-Node/05-Node.js运行时核心/02-文件系统与Buffer二进制数据.md) · [Stream 流式处理](TypeScript-Node/05-Node.js运行时核心/03-Stream流式处理.md) · [网络编程：HTTP 与 WebSocket](TypeScript-Node/05-Node.js运行时核心/04-网络编程-HTTP与WebSocket.md) · [子进程与 Worker Threads](TypeScript-Node/05-Node.js运行时核心/05-子进程与WorkerThreads.md) · [进程生命周期与优雅关闭](TypeScript-Node/05-Node.js运行时核心/06-进程生命周期与优雅关闭.md)
- **06-工程化实践**：[项目结构与代码组织](TypeScript-Node/06-工程化实践/01-项目结构与代码组织.md) · [测试体系与 Test Runner](TypeScript-Node/06-工程化实践/02-测试体系与Test-Runner.md) · [调试、性能剖析与内存泄漏排查](TypeScript-Node/06-工程化实践/03-调试性能剖析与内存泄漏排查.md) · [构建打包与 NPM 包发布](TypeScript-Node/06-工程化实践/04-构建打包与NPM包发布.md)
- **07-进阶主题与总结**：[内存模型与垃圾回收](TypeScript-Node/07-进阶主题与总结/01-内存模型与垃圾回收.md) · [性能优化实战](TypeScript-Node/07-进阶主题与总结/02-性能优化实战.md) · [常见陷阱与最佳实践清单](TypeScript-Node/07-进阶主题与总结/03-常见陷阱与最佳实践清单.md) · [课程总结与进阶方向](TypeScript-Node/07-进阶主题与总结/04-课程总结与进阶方向.md)

</details>
```

- [ ] **Step 6: 在"## 六个项目的架构哲学速览"标题正下方加一句范围澄清**

在该标题下方、表格之前插入一行：

```markdown
> 下表只对比前六套"开源项目源码剖析"课程；课程七是独立的语言/运行时教程，不在此对比范围内。
```

- [ ] **Step 7: 校验 README 改动**

```bash
cd /Users/arron/Desktop/ArronAI/agent-framework-insights
grep -c '^```' README.md
```

Expected: 偶数（README 里原本没有代码围栏改动,新增内容也不含代码围栏,数字应与改动前一致）。用 `git diff README.md` 走查一遍确认格式正确、链接路径与实际创建的文件名逐一对应。

- [ ] **Step 8: 提交**

```bash
cd /Users/arron/Desktop/ArronAI/agent-framework-insights
git add README.md
git commit -m "docs: add course七 (TypeScript & Node.js) entry to repo root README"
```

---

## 完成标准（Definition of Done）

- [ ] `TypeScript-Node/` 下 35 篇文章全部有实质内容（不是标题占位）。
- [ ] `cd TypeScript-Node && npm run typecheck` 零错误。
- [ ] `cd TypeScript-Node && npx vitest run` 全部通过。
- [ ] 所有正文引用的 `examples/` 文件路径真实存在。
- [ ] 所有 Markdown 文件代码围栏成对。
- [ ] 根 `README.md` 新增"课程七"入口，格式与其余六套一致，比较表范围已澄清。
- [ ] 5 个 Task 均已各自提交（不做一次性大提交）。
