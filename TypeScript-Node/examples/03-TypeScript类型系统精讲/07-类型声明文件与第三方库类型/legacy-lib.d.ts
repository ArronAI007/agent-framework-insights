// 手写的声明文件：legacy-lib.js 本身没有任何类型信息，
// 这个 .d.ts 文件给它「外挂」一份类型声明，之后 TS 就能对它做类型检查、
// 提供自动补全，就像它是一个原生用 TS 写的模块一样。
// TS 在 resolveJsonModule/NodeNext 解析下，会自动把同目录下同名的
// legacy-lib.js 和 legacy-lib.d.ts 配对：导入 "./legacy-lib.js" 时，
// 运行时加载 .js 的实现，类型检查阶段读取 .d.ts 里声明的类型。
export declare function formatCurrency(amount: number, currency: string): string;
