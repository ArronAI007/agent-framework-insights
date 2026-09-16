// 一个普通的 ESM 模块：用 export 静态导出两个函数。
// 静态导出意味着这些绑定在「编译/解析阶段」就确定了，工具链（tsc、打包器）
// 可以据此做 tree-shaking 和跨文件的类型检查，这是 ESM 相对 CommonJS 的关键优势之一。
export function add(a: number, b: number): number {
	return a + b;
}

export function multiply(a: number, b: number): number {
	return a * b;
}
