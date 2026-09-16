// ===== 闭包计数器工厂 =====
// 每次调用 createCounter 都会创建一个全新的、互不共享的 count 变量，
// 返回的三个函数共享同一个闭包环境。
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
console.log(`counter.increment() -> ${counter.increment()}`); // 11
console.log(`counter.increment() -> ${counter.increment()}`); // 12
counter.reset();
console.log(`counter.value after reset -> ${counter.value}`); // 10

// ===== var vs let 在循环 + setTimeout 中的经典陷阱 =====
// var 没有块级作用域，三次回调共享同一个变量，setTimeout 触发时循环早已结束，
// 拿到的都是循环结束后的最终值。
console.log("--- var 循环 ---");
for (var varIndex = 0; varIndex < 3; varIndex++) {
	setTimeout(() => console.log(`var 回调看到的 i = ${varIndex}`), 0);
}

// let 每次迭代都会创建一个新的绑定，闭包捕获的是各自那一轮的变量。
console.log("--- let 循环 ---");
for (let letIndex = 0; letIndex < 3; letIndex++) {
	setTimeout(() => console.log(`let 回调看到的 i = ${letIndex}`), 0);
}

// ===== this 的四种绑定规则 =====
interface ThisHolder {
	label: string;
}

function whoAmI(this: ThisHolder | undefined, tag: string): void {
	console.log(`${tag}: this?.label = ${this?.label ?? "undefined（默认绑定）"}`);
}

// 1. 默认绑定：直接调用，ESM 模块顶层是严格模式，this 是 undefined
whoAmI.call(undefined, "default-binding");

// 2. 隐式绑定：作为对象的方法调用，this 指向调用它的对象
const holder: ThisHolder & { whoAmI: typeof whoAmI } = { label: "holder", whoAmI };
holder.whoAmI("implicit-binding");

// 3. 显式绑定：call / apply 手动指定 this
whoAmI.call({ label: "call-target" }, "explicit-call");
whoAmI.apply({ label: "apply-target" }, ["explicit-apply"]);

// bind 返回一个 this 被永久锁定的新函数，之后无论怎么调用 this 都不会再变
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

// ===== 类方法解构后丢失 this，用箭头函数字段修复 =====
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
console.log(ticker.tickMethod()); // normal-call: 1

const { tickMethod } = ticker; // 解构出裸函数，脱离了 ticker 这个调用上下文
try {
	console.log(tickMethod());
} catch (error) {
	console.log(`解构后直接调用 tickMethod() 报错：${(error as Error).message}`);
}

const { tickArrow } = ticker; // 同样解构，但箭头函数字段的 this 已经在定义时锁死
console.log(tickArrow()); // normal-call: 2
