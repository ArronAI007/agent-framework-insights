// 显式 .cjs 后缀：无论 package.json 里的 "type" 是什么，
// Node 都会把这个文件按 CommonJS 规则解析（module/exports/require 都可用）。
function shout(message) {
	return `${message.toUpperCase()}!!!`;
}

module.exports = shout;
