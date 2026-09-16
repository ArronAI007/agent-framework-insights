// consumer.ts 从「遗留 JS 库」导入函数，但因为同目录下有 legacy-lib.d.ts，
// TS 在类型检查阶段会把 formatCurrency 当作有完整类型的函数对待，
// 而不是宽松的 any——这正是给无类型第三方库手写声明文件的意义。
import { formatCurrency } from "./legacy-lib.js";

console.log(`formatCurrency(1999, "CNY") -> ${formatCurrency(1999, "CNY")}`);
console.log(`formatCurrency(9.9, "USD") -> ${formatCurrency(9.9, "USD")}`);

// formatCurrency("1999", "CNY"); // 如果取消注释会编译报错：amount 声明的类型是 number，不能传字符串
