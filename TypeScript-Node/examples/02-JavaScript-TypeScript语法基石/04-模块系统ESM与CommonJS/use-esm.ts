import { createRequire } from "node:module";
// NodeNext 模块解析要求 import 说明符写「编译产物」的后缀（.js），
// 即使源文件实际是 math-esm.ts —— tsc/tsx 都知道把 .js 映射回同目录下的 .ts 文件。
import { add, multiply } from "./math-esm.js";

console.log(`add(2, 3) = ${add(2, 3)}`);
console.log(`multiply(4, 5) = ${multiply(4, 5)}`);

// import.meta.url：ESM 里没有 CommonJS 那套 __dirname/__filename，
// 需要的话用 import.meta.url（当前模块的 file:// URL）配合 node:url 的
// fileURLToPath 自己推导出来。
console.log(`import.meta.url = ${import.meta.url}`);

// ===== 方式一：createRequire，在 ESM 里手动造一个 require() =====
// 适合「只是偶尔需要 require 一个 CJS 模块」的场景，用法和 CommonJS 里完全一样。
const require = createRequire(import.meta.url);
const shoutViaRequire = require("./legacy-cjs.cjs") as (message: string) => string;
console.log(`shoutViaRequire: ${shoutViaRequire("hello from require")}`);

// ===== 方式二：直接用 ESM 的 import 语法默认导入 CJS 模块 =====
// Node 的 CJS/ESM 互操作规则：从 ESM 侧 import 一个 CommonJS 模块时，
// 整个 module.exports 会被当作这个模块的 default 导出。
// legacy-cjs.cjs 是纯 JS、没有类型声明文件，TypeScript 默认会把它当隐式 any
// 报错（TS7016：Could not find a declaration file for module ...）。真实项目里
// 通常会给它补一个 .d.ts 声明；这里用 @ts-expect-error 标注这处已知的、
// 预期内的类型缺失，再手动把导入结果标注成明确的函数类型。
// @ts-expect-error TS7016: legacy-cjs.cjs 没有类型声明文件
import shoutViaImportRaw from "./legacy-cjs.cjs";
const shoutViaImport = shoutViaImportRaw as (message: string) => string;
console.log(`shoutViaImport: ${shoutViaImport("hello from default import")}`);
