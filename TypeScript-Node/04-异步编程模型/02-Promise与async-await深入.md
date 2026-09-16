# Promise 与 async/await 深入

> 上一篇讲清楚了宏任务和微任务的执行顺序，这一篇往上一层，讲 `Promise` 这个抽象本身，以及建在它之上的 `async`/`await` 语法糖。大多数语言都有类似 `Promise`/`Future`/`Task` 的异步值容器，这一篇不会重新讲"什么是异步"，重点放在 JS 这套实现里几个容易在迁移时踩坑的细节：状态一旦确定就不可逆、`Promise.all`/`allSettled`/`race`/`any` 四者语义差异很大却经常被用混、以及 async generator 这个不那么常见的组合。

## 学习目标

- 理解 Promise 状态机：`pending` -> `fulfilled`/`rejected`，且状态一旦确定不可逆转
- 明确 `async`/`await` 只是 Promise 之上的语法糖，不是另一套独立机制
- 分清 `Promise.all`（快速失败）/`Promise.allSettled`（等全部完成）/`Promise.race`/`Promise.any` 四者的语义与适用场景
- 掌握 async generator（`async function*`）和 `for await...of` 的组合用法

## Promise 状态机：一旦 settle，就不可逆转

一个 `Promise` 只有三种状态：`pending`（进行中）、`fulfilled`（成功）、`rejected`（失败）。从 `pending` 变成 `fulfilled` 或 `rejected` 这个动作叫 settle（尘埃落定），settle 之后状态和携带的值就永久固定，**之后再调用 `resolve`/`reject` 都不会有任何效果**——这一点很容易被以为"Promise 是个普通对象，字段应该能被后续代码继续修改"的直觉误导。

```ts
const settledOnce = new Promise<string>((resolve, reject) => {
	resolve("第一次 resolve 生效");
	resolve("第二次 resolve —— 会被忽略");
	reject(new Error("resolve 之后再 reject 也没用"));
});
settledOnce.then((value) => console.log(`[状态机] settledOnce -> ${value}`));
```

真实输出：

```text
[状态机] settledOnce -> 第一次 resolve 生效
```

只有最早调用的那一次 `resolve` 生效，后续的 `resolve`/`reject` 调用全部被静默忽略——不会报错，也不会有任何提示。这个"只认第一次"的设计是故意的：它保证了一个 Promise 代表的异步操作，最终结果永远是唯一确定的一个值，不会出现"回调 A 以为成功了，回调 B 却看到失败了"这种不一致。

## `async`/`await` 是 Promise 的语法糖

`async function` 声明的函数，调用后永远返回一个 Promise——哪怕函数体里没有显式 `return` 一个 Promise，返回值也会被自动包装成 `Promise.resolve(返回值)`；如果函数体内 `throw` 了异常，返回的 Promise 会变成 `rejected`，异常值就是 reject 的 reason。`await expression` 做的事情等价于给 `expression`（如果它本身不是 Promise，会先被 `Promise.resolve()` 包一层）挂一个 `.then`，然后"暂停"当前 `async` 函数的执行，直到这个 Promise settle，再决定是把值当作 `await` 表达式的结果继续往下跑，还是把 reject 的 reason 当成异常从 `await` 那一行"抛出来"。

这层"语法糖"的本质意味着：**`try`/`catch` 能捕获 `await` 到的 rejected Promise，是因为 `await` 本身就是"把 reject 转换成同步风格的 throw"这个动作**，不是 JS 引擎给 `async` 函数开了什么特殊的错误处理通道。这一点在下一篇讲错误处理时会更细地展开。

## `Promise.all`：快速失败（fail-fast）

`Promise.all(iterable)` 接受一组 Promise，等它们**全部** fulfilled 才 resolve，返回值是按原顺序排列的结果数组；但只要其中**任意一个** reject，`Promise.all` 立刻整体 reject，不会等其他还在进行中的任务跑完。

```ts
const taskA = delay(30).then(() => "A 完成");
const taskB = delay(10).then(() => {
	throw new Error("B 失败（10ms 后）");
});
const taskC = delay(50).then(() => "C 完成（会跑完，但结果不会被 Promise.all 用到）");

try {
	const results = await Promise.all([taskA, taskB, taskC]);
	console.log(`[Promise.all] 不应该走到这里 -> ${results}`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.log(`[Promise.all] 整体 reject，捕获到最先失败的错误 -> ${message}`);
}
await delay(60);
console.log("[Promise.all] 60ms 后，taskC 其实也已经在后台跑完了");
```

真实输出：

```text
[Promise.all] 整体 reject，捕获到最先失败的错误 -> B 失败（10ms 后）
[Promise.all] 60ms 后，taskC 其实也已经在后台跑完了
```

有两个细节值得注意：第一，`Promise.all` 拿到的错误只会是**最先** reject 的那一个，taskB 在 10ms 时失败，taskA（30ms）、taskC（50ms）到底是否也会失败根本不会被观察到；第二，`Promise.all` 整体 reject **不代表**其他任务被取消了——taskC 依然会在后台跑完它自己的 50ms 定时器，只是它的结果不再被任何人关心。JS 原生的 Promise 没有"取消"这个概念（下一篇会讲用 `AbortController` 单独实现取消），reject 只是"这个 `Promise.all` 组合出的新 Promise 不再等待"，不等于"底层任务停止运行"。

适用场景：多个任务**互相依赖、缺一不可**时用 `Promise.all`——比如同时请求"用户信息"和"用户权限"两个接口渲染一个页面，任何一个失败页面都无法正常展示，快速失败、尽早暴露问题是合理的选择。

## `Promise.allSettled`：等全部完成，收集每一项的成功/失败结果

`Promise.allSettled` 不管成功还是失败都会等所有 Promise settle 完，返回一个数组，每一项的形状是 `{ status: "fulfilled", value }` 或 `{ status: "rejected", reason }`。

```ts
const results = await Promise.allSettled([
	delay(20).then(() => "任务1 成功"),
	delay(10).then(() => {
		throw new Error("任务2 失败");
	}),
	delay(15).then(() => "任务3 成功"),
]);
```

真实输出：

```text
[Promise.allSettled] 第 0 项 fulfilled -> 任务1 成功
[Promise.allSettled] 第 1 项 rejected -> 任务2 失败
[Promise.allSettled] 第 2 项 fulfilled -> 任务3 成功
```

适用场景：多个任务**互相独立、允许部分失败**时用 `Promise.allSettled`——比如批量给 100 个用户发送通知，第 37 个用户的设备离线导致发送失败，不应该影响其余 99 个用户正常收到通知，需要的是"哪些成功了、哪些失败了、失败的原因分别是什么"这样一份完整报告，而不是任意一个失败就让整批操作直接报错终止。

## `Promise.race` 与 `Promise.any`

这两个方法都只关心"最先 settle 的那一个"，区别在于对失败的处理：

- `Promise.race`：谁**最先 settle**（不管成功失败）就用谁的结果——如果最先 settle 的那个是 rejected，`Promise.race` 就整体 reject。常见用法是"给一个请求加超时"：把真正的请求 Promise 和一个"N 秒后 reject"的定时器 Promise 一起 race，谁先到就用谁的结果。
- `Promise.any`：只关心**最先成功**的那一个，会忽略中途的失败，只有当**全部**都失败时才整体 reject（reject 的 reason 是一个 `AggregateError`，包含每一项的失败原因）。典型场景是"同时向多个镜像/多个 CDN 节点发起请求，哪个先返回就用哪个"，个别节点失败很正常，不应该被当作"整体失败"。

## async generator：逐步产出数据，用 `for await...of` 消费

`async function*` 声明的函数结合了 generator（`yield` 惰性产出值）和 async 函数（内部能 `await`）两种能力，每次 `yield` 的值会被自动包装成一个已 resolve 的 Promise，配合 `for await...of` 可以写出"边等待、边产出、边消费"的流式处理逻辑，不需要一次性把所有数据攒进内存。

```ts
async function* fetchPagesLazily(totalPages: number): AsyncGenerator<string, void, unknown> {
	for (let page = 1; page <= totalPages; page++) {
		await delay(10); // 模拟每一页都要等一次网络请求
		yield `第 ${page} 页数据（共 ${totalPages} 页）`;
	}
}

for await (const pageData of fetchPagesLazily(3)) {
	console.log(`[async generator] 消费到 -> ${pageData}`);
}
```

真实输出：

```text
[async generator] 消费到 -> 第 1 页数据（共 3 页）
[async generator] 消费到 -> 第 2 页数据（共 3 页）
[async generator] 消费到 -> 第 3 页数据（共 3 页）
[async generator] 所有分页消费完毕
```

这种模式最适合"分页拉取远程数据"这类场景：调用方用一个简单的 `for await...of` 循环消费数据，完全不需要关心"什么时候该发下一页请求"这种细节，all 一次性拉全量数据换来的内存压力，也被换成了"按需产出、按需消费"。

## 小结

Promise 是一个三态状态机（`pending`/`fulfilled`/`rejected`），一旦 settle 就不可逆转，多次调用 `resolve`/`reject` 只有第一次生效。`async`/`await` 是 Promise 之上的语法糖：`async` 函数返回值自动包装成 Promise，`await` 把"等待 Promise settle 再继续/抛错"变成了同步风格的写法。`Promise.all` 快速失败、适合"互相依赖、缺一不可"的场景；`Promise.allSettled` 等全部完成、适合"互相独立、允许部分失败"的场景；`Promise.race` 关心最先 settle 的（常用于超时）；`Promise.any` 关心最先成功的、忽略中途失败（常用于多源竞速）。async generator 结合 `yield` 的惰性产出和 `await` 的异步等待，配合 `for await...of` 能写出内存友好的流式消费逻辑。下一篇讲错误处理和取消机制，会详细展开 `try`/`catch` 在 `async` 函数里的行为、自定义 Error 子类、以及用 `AbortController` 弥补 Promise 原生不支持取消这个缺陷。
