// ===== 调用栈：同步代码永远最先跑完 =====
// console.log 是同步调用，会立刻执行——不管后面注册了多少个异步任务，
// 只要调用栈上还有同步代码没跑完，事件循环就不会去处理任何队列。
console.log("[sync] 第 1 行");

// ===== 宏任务（macrotask）：setTimeout(fn, 0) =====
// 即使延迟写 0ms，setTimeout 的回调也不会立刻执行——它被丢进 timers 阶段的队列，
// 要等当前这一轮同步代码、以及后面所有微任务清空之后，才会被事件循环捞出来执行。
setTimeout(() => {
	console.log("[macrotask] setTimeout(fn, 0)");
}, 0);

// ===== 宏任务（macrotask）：setImmediate =====
// setImmediate 是 Node.js 独有的 API（浏览器没有），对应事件循环的 check 阶段，
// 语义是「本轮 poll 阶段的 I/O 事件处理完之后立刻执行」。
setImmediate(() => {
	console.log("[macrotask] setImmediate（check 阶段）");
});

// ===== 微任务（microtask）：Promise.then =====
// Promise 的 then/catch/finally 回调会被丢进「微任务队列」，
// 微任务队列的优先级高于任何宏任务——当前这一轮同步代码跑完后，
// 事件循环会先把微任务队列清空，才会去看宏任务队列。
Promise.resolve().then(() => {
	console.log("[microtask] Promise.resolve().then()");
});

// ===== 微任务（microtask）：queueMicrotask =====
// queueMicrotask 是标准 Web API，效果和 Promise.then 完全一样，都是排进微任务队列，
// 只是不需要先包一层 Promise，语义上更直接。
queueMicrotask(() => {
	console.log("[microtask] queueMicrotask()");
});

// ===== Node 特有：process.nextTick =====
// process.nextTick 有自己独立的队列，文档上说它的优先级比 Promise 微任务队列更高。
// 注意：下面正文会贴出本文件在当前项目（ESM，"type": "module"）下的真实打印顺序——
// 这个顺序在 ESM 和 CommonJS 下并不一样，是本篇专门要拆穿的一个"背书但不核实"的坑。
process.nextTick(() => {
	console.log("[nextTick] process.nextTick()");
});

console.log("[sync] 最后一行（仍在同一轮调用栈中）");
