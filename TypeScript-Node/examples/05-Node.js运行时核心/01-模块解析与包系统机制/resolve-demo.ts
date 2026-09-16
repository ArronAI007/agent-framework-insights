import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ===== ESM 下没有 __dirname / __filename，用 import.meta.url 重新推导 =====
// CommonJS 里 __dirname/__filename 是模块加载器自动注入的两个"隐藏变量"，
// 但 ESM 规范里没有这两个东西——ESM 模块用 import.meta.url 代替，
// 它是一个形如 file:///Users/xxx/foo.ts 的 URL 字符串，需要用 node:url 的
// fileURLToPath 转换回操作系统原生的文件路径格式，才能配合 node:path 的 API 使用。
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
console.log(`import.meta.url        -> ${import.meta.url}`);
console.log(`fileURLToPath 得到的路径 -> ${currentFilePath}`);
console.log(`当前文件所在目录         -> ${currentDirPath}`);

// ===== 解析内置模块：import.meta.resolve =====
// import.meta.resolve 是 ESM 标准提供的解析 API，同步返回一个模块说明符
// 实际会被解析到的 URL——注意内置模块（node: 前缀）解析后得到的仍然是
// "node:path" 本身，而不是某个磁盘文件路径，因为内置模块是编译进 Node 二进制的，
// 根本不对应文件系统里的某个 .js 文件，这一点很容易被"resolve 出来的一定是文件路径"这个直觉误导。
const resolvedBuiltin = import.meta.resolve("node:path");
console.log(`import.meta.resolve("node:path") -> ${resolvedBuiltin}`);

// ===== 解析第三方包：拿真实安装在 node_modules 里的包举例 =====
// 用本项目已经安装的 typescript 包做例子：import.meta.resolve 会按 Node 的模块解析算法，
// 从当前文件所在目录开始逐级向上查找 node_modules/typescript，
// 再读取它 package.json 里的 exports 字段，找到 "." 对应的真实入口文件。
const resolvedTypescript = import.meta.resolve("typescript");
console.log(`import.meta.resolve("typescript") -> ${resolvedTypescript}`);

// ===== 用 createRequire 桥接：在 ESM 里也能用 require.resolve =====
// createRequire 是 Node 官方提供的"在 ESM 模块里获得一个可用的 require 函数"的方式，
// 常用于需要 require.resolve 语义（同步、返回本地文件系统路径而不是 URL）的场景。
// 对比可见：require.resolve 对第三方包返回的是普通文件路径，
// 而 import.meta.resolve 返回的是 file:// 协议的 URL——两者语义一致，只是返回值形态不同。
const require = createRequire(import.meta.url);
const requireResolvedTypescript = require.resolve("typescript");
console.log(`require.resolve("typescript")     -> ${requireResolvedTypescript}`);

// ===== package.json 的 exports 字段：查看 typescript 包实际声明的公开入口 =====
// 直接读取 typescript 包的 package.json，可以看到它的 exports 字段只声明了
// "." 和几个 "./unstable/xxx" 子路径——这意味着 typescript 包只允许
// import "typescript" 或 import "typescript/unstable/xxx" 这些被显式声明过的路径，
// 直接 import "typescript/lib/typescript.js" 这种没在 exports 里列出的深层路径会被拒绝解析。
const typescriptPackageJsonUrl = import.meta.resolve("typescript/package.json");
const typescriptPackageJsonPath = fileURLToPath(typescriptPackageJsonUrl);
const typescriptPkg = JSON.parse(
	await (await import("node:fs/promises")).readFile(typescriptPackageJsonPath, "utf8"),
) as { exports?: Record<string, unknown> };
console.log(`typescript 包的 exports 字段 -> ${JSON.stringify(typescriptPkg.exports, null, 2)}`);
