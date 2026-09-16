# 作用域、闭包与 this 绑定

> 这一篇是 JS 里公认最容易让"另一门语言过来的人"栽跟头的部分：`var`/`let`/`const` 的作用域差异、闭包捕获的到底是变量还是值、`this` 到底由谁决定。搞不清楚这几点，写出来的代码会在你完全想不到的地方产生 bug。

## 学习目标

- 说清楚 `var`/`let`/`const` 的作用域差异，理解经典的"循环 + `setTimeout`"陷阱
- 理解闭包捕获的是变量本身（绑定），不是某个时刻的值
- 掌握 `this` 的四种绑定规则：默认、隐式、显式、`new`
- 知道箭头函数的 `this` 是词法作用域决定的，以及 `call`/`apply`/`bind` 的用法
- 理解为什么解构出来的类方法会丢失 `this`，以及如何用箭头函数类字段修复

## 闭包：捕获的是变量，不是值

闭包（closure）指的是一个函数"记住"了它被创建时所在的作用域，即使外部函数已经执行完毕，内部函数依然能访问那个作用域里的变量。计数器工厂是最经典的例子：

```ts
function createCounter(start = 0) {
	let count = start;
	return {
		increment: () => ++count,
		reset: () => {
			count = start;
		},
		get value() {
			return count;
		},
	};
}

const counter = createCounter(10);
console.log(`counter.increment() -> ${counter.increment()}`);
console.log(`counter.increment() -> ${counter.increment()}`);
counter.reset();
console.log(`counter.value after reset -> ${counter.value}`);
```

真实输出：

```text
counter.increment() -> 11
counter.increment() -> 12
counter.value after reset -> 10
```

`createCounter` 执行完之后，它的局部变量 `count` 按理说应该被回收，但因为返回的三个函数都引用了 `count`，JS 引擎会保留这个作用域不被回收，三个函数共享同一个 `count` 绑定——这就是"闭包"这个词的字面意思：把变量"闭合"在了函数里。**关键理解**：闭包捕获的是变量这个**绑定（binding）**本身，不是创建闭包那一刻变量的值快照。这个理解方式看起来抽象，但能直接解释下面这个经典陷阱。

## `var`/`let`/`const` 与循环 + `setTimeout` 的经典陷阱

```ts
console.log("--- var 循环 ---");
for (var varIndex = 0; varIndex < 3; varIndex++) {
	setTimeout(() => console.log(`var 回调看到的 i = ${varIndex}`), 0);
}

console.log("--- let 循环 ---");
for (let letIndex = 0; letIndex < 3; letIndex++) {
	setTimeout(() => console.log(`let 回调看到的 i = ${letIndex}`), 0);
}
```

真实输出（`setTimeout` 回调是异步执行的，所以两段同步的 `console.log("---")` 会先打印，回调统一排在最后）：

```text
--- var 循环 ---
--- let 循环 ---
...（中间是本文件其余同步代码的输出）
var 回调看到的 i = 3
var 回调看到的 i = 3
var 回调看到的 i = 3
let 回调看到的 i = 0
let 回调看到的 i = 1
let 回调看到的 i = 2
```

这正是那个"经典面试题"的真实行为：**`var` 没有块级作用域，只有函数作用域**（或者说全局作用域）。整个 `for` 循环里只存在**一个** `varIndex` 变量，三次循环创建的三个箭头函数闭包的都是同一个绑定。等到事件循环真正执行这些回调时，循环早已结束，`varIndex` 的值已经是循环退出条件成立时的 `3`，所以三个回调看到的都是 `3`。

**`let`（以及 `const`）有块级作用域**：`for` 循环每进入一次新的迭代，JS 引擎会为 `letIndex` 创建一个**全新的绑定**，把上一轮的值复制过来作为初始值。三次循环产生了三个独立的 `letIndex` 绑定，三个闭包各自捕获了属于自己那一轮的变量，所以能正确打印出 `0`、`1`、`2`。这也是为什么现代 JS/TS 代码里几乎不再用 `var`——`let`/`const` 的块级作用域行为更符合直觉，能规避这整类问题。**实践准则很简单：永远优先用 `const`，需要重新赋值时用 `let`，`var` 视为历史遗留、新代码不应该再出现。**

## `this` 的四种绑定规则

和多数语言里"`this`/`self` 在方法定义时就已经确定指向哪个实例"不同，JS 里 `this` 的值是**在函数被调用的那一刻，根据调用方式动态决定的**——同一个函数用不同方式调用，`this` 可能完全不同。规则可以归纳成四种，优先级从低到高：

```ts
function whoAmI(this: ThisHolder | undefined, tag: string): void {
	console.log(`${tag}: this?.label = ${this?.label ?? "undefined（默认绑定）"}`);
}

// 1. 默认绑定：直接调用，ESM 模块顶层是严格模式，this 是 undefined
whoAmI.call(undefined, "default-binding");

// 2. 隐式绑定：作为对象的方法调用，this 指向调用它的对象
const holder = { label: "holder", whoAmI };
holder.whoAmI("implicit-binding");

// 3. 显式绑定：call / apply 手动指定 this
whoAmI.call({ label: "call-target" }, "explicit-call");
whoAmI.apply({ label: "apply-target" }, ["explicit-apply"]);
const boundWhoAmI = whoAmI.bind({ label: "bound-target" });
boundWhoAmI("explicit-bind");

// 4. new 绑定：构造函数调用时，this 指向新创建的实例
class Person {
	name: string;
	constructor(name: string) {
		this.name = name;
	}
}
const ada = new Person("Ada");
console.log(`new-binding: ada.name = ${ada.name}`);
```

真实输出：

```text
default-binding: this?.label = undefined（默认绑定）
implicit-binding: this?.label = holder
explicit-call: this?.label = call-target
explicit-apply: this?.label = apply-target
explicit-bind: this?.label = bound-target
new-binding: ada.name = Ada
```

**默认绑定**：函数不通过任何对象调用（"裸调用"）。ES Module 顶层默认就是严格模式，此时 `this` 是 `undefined`；如果是非严格模式的传统脚本，`this` 会指向全局对象（浏览器里是 `window`，Node.js CommonJS 模块里是 `module.exports` 或全局对象，视上下文而定）——这也是严格模式被引入的原因之一：避免裸调用时 `this` 意外指向全局对象，污染全局状态。

**隐式绑定**：函数作为某个对象的方法被调用（`obj.method()`），`this` 指向调用它的那个对象——注意，决定 `this` 的是**调用语法**（`.` 前面写的是谁），不是函数定义在哪里。

**显式绑定**：用 `call`/`apply`/`bind` 手动指定 `this`。`call` 和 `apply` 的区别只在于参数传递方式（`call` 逐个传参，`apply` 传一个参数数组），效果相同；`bind` 不会立即调用函数，而是返回一个 **`this` 被永久锁定**的新函数，之后不管这个新函数怎么被调用（哪怕再用 `call` 尝试覆盖），`this` 都不会再变。

**`new` 绑定**：用 `new` 调用构造函数（或类的 `constructor`）时，JS 会创建一个全新对象，让 `this` 指向这个新对象，函数执行完后（如果没有显式返回对象）自动返回这个新对象。这是四种规则里优先级最高的一种。

## 箭头函数：没有自己的 `this`

箭头函数刻意不参与上面这套动态绑定规则——它的 `this` **在定义时就按照词法作用域确定**，也就是"箭头函数外层最近的普通函数（或模块顶层）的 `this` 是什么，箭头函数的 `this` 就是什么"，之后无论怎么调用都不会改变。这个特性直接决定了它在下面这个场景里的实用价值。

## 类方法解构后丢失 `this`，用箭头函数类字段修复

```ts
class Ticker {
	count = 0;
	constructor(private readonly label: string) {}

	// 普通方法：this 由「调用方式」决定，一旦脱离 ticker.xxx() 的调用形式就会丢失
	tickMethod(): string {
		this.count++;
		return `${this.label}: ${this.count}`;
	}

	// 箭头函数类字段：定义时就把 this 词法绑定到实例，不受调用方式影响
	tickArrow = (): string => {
		this.count++;
		return `${this.label}: ${this.count}`;
	};
}

const ticker = new Ticker("normal-call");
console.log(ticker.tickMethod());

const { tickMethod } = ticker; // 解构出裸函数，脱离了 ticker 这个调用上下文
try {
	console.log(tickMethod());
} catch (error) {
	console.log(`解构后直接调用 tickMethod() 报错：${(error as Error).message}`);
}

const { tickArrow } = ticker;
console.log(tickArrow());
```

真实输出：

```text
normal-call: 1
解构后直接调用 tickMethod() 报错：Cannot read properties of undefined (reading 'count')
normal-call: 2
```

`tickMethod` 是一个普通方法，它的 `this` 完全依赖"隐式绑定"规则——只有通过 `ticker.tickMethod()` 这种"点调用"语法调用，`this` 才指向 `ticker`。一旦把它解构成一个独立变量 `const { tickMethod } = ticker`，再调用 `tickMethod()`，就变成了"裸调用"，触发的是默认绑定规则，`this` 变成 `undefined`，访问 `this.count` 直接抛出运行时错误。这种 bug 在 React 类组件的事件处理函数、Node.js 里把某个对象的方法当回调传给 `setTimeout`/事件监听器时非常常见——传递方法引用的那一刻，实际上已经把它和原来的调用上下文（`.` 前面的对象）剥离了。

`tickArrow` 是一个**箭头函数类字段**：它在类实例初始化时就被创建，创建那一刻所处的词法作用域就是 `constructor` 内部，此时的 `this` 已经确定指向当前实例，之后这个箭头函数无论被怎样传递、怎样调用，`this` 都不会再变。这正是社区里"用箭头函数类字段代替普通方法，规避 `this` 丢失问题"这个惯用法的原理——本质上是用箭头函数"没有自己的 `this`、只认词法作用域"这个特性，把动态绑定变成了静态绑定。

## 小结

`var` 只有函数作用域，循环里所有迭代共享同一个绑定，是"循环 + `setTimeout`"经典陷阱的根源；`let`/`const` 有块级作用域，每次迭代都会创建新绑定，能规避这个问题——新代码应该只用 `let`/`const`。`this` 由调用方式动态决定，遵循默认、隐式、显式、`new` 四种绑定规则，优先级依次升高。箭头函数不参与这套动态规则，它的 `this` 在定义时就按词法作用域锁定,这正是"把类方法解构出来传递会丢失 `this`，改成箭头函数类字段就不会"这个常见修复手法的底层原理。
