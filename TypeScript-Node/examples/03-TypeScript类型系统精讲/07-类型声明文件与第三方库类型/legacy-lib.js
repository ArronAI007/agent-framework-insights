// 这是一个假设中的「遗留 JS 库」：没有任何类型信息，用 CommonJS 的 module.exports
// 导出一个函数。很多真实世界里年代较早、还没迁移到 TS 或 ESM 的 npm 包长这个样子。
// 本目录下的 package.json 把这个文件标记为 CommonJS 模块（type: "commonjs"），
// 这样 module.exports 才能在运行时正常工作——即便课程主项目的 package.json 整体是 "type": "module"。
function formatCurrency(amount, currency) {
	if (typeof amount !== "number" || Number.isNaN(amount)) {
		throw new TypeError("amount 必须是合法数字");
	}
	return `${amount.toFixed(2)} ${currency}`;
}

module.exports = { formatCurrency };
