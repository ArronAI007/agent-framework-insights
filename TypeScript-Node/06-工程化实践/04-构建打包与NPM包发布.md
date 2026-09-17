# 构建打包与 NPM 包发布

> 第 06 章最后一篇，讲一个 TS 项目怎么变成别人能 `npm install` 的东西。这里刻意不引入 `tsup`/`esbuild` 这类打包工具作为新依赖——用项目里已经有的 `typescript` 本身（`tsc`）就足够把一个库编译成可发布的产物,这也更符合"先掌握最基础的工具链，再按需引入更快的打包器"这个学习顺序。这一篇的重点不是"怎么写一个库"，而是"编译产物的目录结构、`package.json` 里那几个字段、以及 `npm publish` 前该做哪些检查"，这些和写什么业务逻辑无关，是每个要发布 npm 包的项目都得过一遍的流程。

## 学习目标

- 用 `tsc` 把一个 TS 库编译成 `dist/`，理解 `outDir`/`declaration`/`declarationMap` 各自的作用
- 理解 `package.json` 里 `main`/`types`/`exports`/`files` 字段怎么配合，让消费者既拿到编译产物又拿到类型
- 掌握 `npm pack --dry-run` 预览发布内容、`npm version` 语义化版本升级、`npm publish` 的基本流程
- 理解 `.npmignore` 和 `files` 白名单两种控制发布内容方式的取舍

## 用 `tsc` 编译出可发布的 `dist/`

假设有一个要发布的小库，源码在 `src/index.ts`：

```ts
export function add(a: number, b: number): number {
	return a + b;
}
```

主 `tsconfig.json`（日常开发、编辑器类型检查用）通常是 `noEmit: true`（本课程 `TypeScript-Node/tsconfig.json` 就是这么配的——这个仓库本身不需要编译产物，只需要类型检查），但要发布的库不能没有编译产物，所以额外准备一份专门用于构建的配置，继承主配置、再打开发布必需的选项：

```json
// tsconfig.build.json
{
	"extends": "./tsconfig.json",
	"compilerOptions": {
		"rootDir": "src",
		"outDir": "dist",
		"declaration": true,
		"declarationMap": true,
		"noEmit": false
	}
}
```

- `outDir: "dist"`：编译产物统一输出到 `dist/` 目录，和 `src/` 源码分开，`dist/` 通常会被 `.gitignore` 排除（不提交编译产物到仓库），但需要被发布进 npm 包。
- `rootDir: "src"`：显式声明"所有源文件的公共根目录是 `src/`"——不设置这个字段时，TypeScript 7 会报错（`error TS5011`），但仍然会继续把编译产物写到一个你可能不想要的目录结构里，因为它需要一个明确的基准来决定 `dist/` 里的文件层级该怎么摆；漏掉这一步，实测会得到 `dist/src/index.js` 而不是期望的 `dist/index.js`，这个多出来的 `src/` 层级会让下一节 `package.json` 里写的 `main`/`types` 路径全部对不上。
- `declaration: true`：除了编译出 `.js`，额外为每个源文件生成对应的 `.d.ts` 类型声明文件——**这是让 TS 消费者能拿到类型提示的关键**，没有这个选项，`dist/` 里只有 `.js`，消费者装了这个包之后编辑器里完全没有类型信息。
- `declarationMap: true`：让 `.d.ts` 文件附带 source map（`.d.ts.map`），使得消费者在编辑器里"跳转到定义"时能直接跳到原始的 `.ts` 源码，而不是跳到生成的 `.d.ts` 声明文件——体验上的细节提升，不是必需项，但成本很低、值得默认打开。

实测编译（`tsc -p tsconfig.build.json`）之后 `dist/` 的真实产物：

```text
dist/index.js
dist/index.d.ts
dist/index.d.ts.map
```

`dist/index.d.ts` 的真实内容：

```text
export declare function add(a: number, b: number): number;
//# sourceMappingURL=index.d.ts.map
```

## `package.json`：`main`/`types`/`exports`/`files` 怎么配合

编译产物有了，还需要在 `package.json` 里告诉 npm 和消费者的工具链"怎么找到这些产物"：

```json
{
	"name": "@example/math-utils",
	"version": "1.0.0",
	"type": "module",
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"default": "./dist/index.js"
		}
	},
	"files": ["dist"]
}
```

- `main`：CommonJS 时代遗留下来的字段，`require("@example/math-utils")` 或者不支持 `exports` 字段的老旧工具链会按这个路径去找入口文件。哪怕项目全面转向 ESM（`"type": "module"`），保留这个字段依然有意义，作为不认识 `exports` 字段的旧工具的兜底。
- `types`：告诉 TypeScript 编译器"这个包的类型声明文件在哪"——没有这个字段（或者对应的 `exports.types`），消费者用 TS 引用这个包时会拿不到任何类型提示，除非自己额外装一个 `@types/xxx` 包（前提是社区恰好维护了一份）。
- `exports`：现代 Node/打包工具都认这个字段，作用是显式声明这个包"对外暴露哪些入口"——`"."` 对应包名本身被直接 `import` 时该解析到哪个文件，还可以定义更多条目支持子路径导出（比如 `"./utils"` 对应 `dist/utils.js`）。**`exports` 里的 `types` 条件必须放在其他条件（比如 `default`）之前**——Node/TS 按对象里 key 出现的顺序依次匹配条件，`types` 放在后面会导致工具链先匹配到别的条件、根本读不到类型信息。`exports` 字段一旦存在，还会产生一个容易被忽略的副作用：包外部代码试图 `import` 这里没有显式声明的路径（比如直接 `import xxx from "@example/math-utils/dist/index.js"`）会被直接拒绝——这是刻意的封装边界，逼迫消费者只通过包作者显式暴露的入口使用这个包。
- `files`：一个白名单数组，声明"`npm publish` 时应该把哪些路径打进最终的 tarball"。这里只写了 `"dist"`，意味着源码 `src/`、`tsconfig.build.json` 等开发时才需要的文件都不会被发布出去，消费者装下来的包体积更小，也不会意外泄露构建脚本、内部注释等不打算公开的内容。**`package.json` 本身、`README`、`LICENSE` 这几个文件不需要写进 `files` 数组——npm 无条件总是会把它们打包进去**,这是很多人第一次配置 `files` 时会漏掉的认知点（以为不写进去就不会被发布，结果发现它们其实是被 npm 特殊处理、强制包含的）。

## `npm pack --dry-run`：先看看会发布哪些文件

`npm publish` 之前，先用 `npm pack --dry-run` 预览一遍实际会打进 tarball 的文件列表——这是"生米煮成熟饭之前的最后一道检查"，因为一旦真的 `publish` 出去，哪怕几秒后撤回，那个版本号也已经被永久占用，不能重新发布同名同版本号的包。实测输出：

```text
npm notice
npm notice 📦  @example/math-utils@1.0.0
npm notice Tarball Contents
npm notice 94B dist/index.d.ts
npm notice 176B dist/index.d.ts.map
npm notice 48B dist/index.js
npm notice 268B package.json
npm notice Tarball Details
npm notice name: @example/math-utils
npm notice version: 1.0.0
npm notice filename: example-math-utils-1.0.0.tgz
npm notice package size: 466 B
npm notice unpacked size: 586 B
npm notice shasum: 101f7d95bac31e86dd5b7193a08a4ea7c9af89ee
npm notice integrity: sha512-DBJfsex1gUy+L[...]AhMy7SoID+4+A==
npm notice total files: 4
npm notice
example-math-utils-1.0.0.tgz
```

`Tarball Contents` 这四行就是最终会被发布出去的完整文件列表——`dist/` 下的三个编译产物，加上 npm 强制包含的 `package.json`（这次示例没有额外放 `README`/`LICENSE`，否则这里也会出现）。如果这个列表里出现了不该公开的文件（比如不小心漏掉 `files` 白名单、把 `src/` 或者内部脚本也带上了），就是在这一步发现并修正，而不是发布之后才后悔。

## `npm version`：语义化版本升级

修改版本号不建议手动改 `package.json` 里的 `"version"` 字段，用 `npm version <bump-type>` 命令——它会自动按语义化版本（SemVer，`主版本号.次版本号.修订号`）规则计算出新版本号、更新 `package.json`，并且（在 git 仓库里）自动创建一次版本提交和一个对应的 git tag：

```bash
npm version patch   # 修订号 +1：向后兼容的 bug 修复
npm version minor    # 次版本号 +1：向后兼容的新功能
npm version major    # 主版本号 +1：不兼容的破坏性变更
```

实测从 `1.0.0` 开始依次执行 `npm version patch` 和 `npm version minor` 的真实输出：

```text
v1.0.1
v1.1.0
```

`patch` 把 `1.0.0` 升到 `1.0.1`（只改最后一位），`minor` 接着把 `1.0.1` 升到 `1.1.0`（次版本号 +1 的同时，修订号重置为 0）——这正是 SemVer 规则的字面体现：更高优先级的版本号位发生变化时，比它优先级更低的位要归零，不能直接理解成"随便挑一位加一"。消费者依赖这个包时在 `package.json` 里写的版本范围（`^1.0.0`、`~1.0.0` 这类前缀）也是基于这套规则工作的——`^1.0.0` 意味着"允许自动升级到不改变主版本号的任何新版本"，如果发布方把一个破坏性变更错误地当成 `minor`/`patch` 发布出去，所有用 `^` 依赖它的下游项目都会在不知情的情况下拉到一个不兼容的版本，这是坚持 SemVer 语义诚实性的现实意义。

## `.npmignore` vs `files` 白名单：该用哪个

控制"哪些文件会被发布"有两种互斥的机制：

- **`.npmignore`**：黑名单思路，类似 `.gitignore`，列出不想发布的路径，其余的默认都会被发布。
- **`package.json` 的 `files` 字段**：白名单思路，只有列出来的路径才会被发布，其余的默认都不发布。

两者同时存在时，**`files` 白名单优先生效**，`.npmignore` 会被忽略。实践上更推荐白名单思路（这也是本文示例采用的方式）：黑名单需要持续维护——项目里新增一种不该发布的文件类型（比如新加了一个 `scripts/` 目录放构建脚本），如果忘记同步更新 `.npmignore`，它就会被意外发布出去；白名单则是"默认拒绝"，新增的任何文件类型除非显式加进 `files`，否则天然就不会被发布，出错的方向是"该发的没发出去"（构建时就会被发现，比如消费者装完发现少了某个文件），而不是"不该发的悄悄发出去了"（可能要等到有人翻开 tarball 内容才会被注意到）,后者的排查成本和潜在风险都更高。

## 小结

不引入额外打包工具，用项目已有的 `tsc` 加一份继承主配置、打开 `outDir`/`declaration`/`declarationMap` 的 `tsconfig.build.json`，就能把 TS 库编译成带完整类型声明的 `dist/` 产物；`rootDir` 必须显式声明，否则 TypeScript 7 会报错（`error TS5011`）并把产物写到多一层 `dist/src/` 的目录结构里。`package.json` 里 `main` 兜底 CommonJS 消费者，`types`/`exports.types` 让 TS 消费者拿到类型，`exports` 是现代工具链认的入口声明（`types` 条件必须写在前面），`files` 白名单控制发布范围（`package.json`/`README`/`LICENSE` 会被 npm 无条件包含,不需要额外声明）。`npm pack --dry-run` 是发布前必做的预览步骤，`npm version <patch|minor|major>` 按 SemVer 规则自动升级版本号并打 git tag。`files` 白名单相比 `.npmignore` 黑名单更安全，出错时的方向是"漏发"而不是"错发"。到这里，第 06 章「工程化实践」全部结束——从项目结构、测试体系、调试与性能剖析，到今天的构建与发布，覆盖的是把前面几章学到的语言和运行时知识，真正用在一个要交付给别人使用的项目上需要的工程环节。下一章是这门课程最后一章，会先深入内存模型与垃圾回收的原理层面，再落到性能优化实战和常见陷阱清单，最后是课程总结。
