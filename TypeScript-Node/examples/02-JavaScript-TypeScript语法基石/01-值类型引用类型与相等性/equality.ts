// ===== 原始值：按值复制，互不影响 =====
let a = 1;
let b = a;
b = 2;
console.log(`原始值：a=${a}, b=${b}`);

// ===== 对象：变量保存的是引用，赋值只是复制了引用 =====
interface Counter {
	count: number;
}

const objA: Counter = { count: 1 };
const objB = objA; // 没有发生拷贝，objB 只是 objA 的别名
objB.count = 2;
console.log(`对象引用：objA.count=${objA.count}, objB.count=${objB.count}`);

// ===== === vs == =====
// TypeScript 对字面量比较会直接静态报错「没有重叠」，这里用一个不做类型收窄的
// 辅助函数接收参数，只是为了在不关闭 strict 的前提下演示运行时的真实行为。
function looseEquals(x: unknown, y: unknown): boolean {
	return x == y;
}
function strictEquals(x: unknown, y: unknown): boolean {
	return x === y;
}
console.log(`1 === "1" -> ${strictEquals(1, "1")}`); // false：类型不同直接判否，不做转换
console.log(`1 == "1" -> ${looseEquals(1, "1")}`); // true：== 会先做隐式类型转换再比较

// ===== Object.is 与 === 的两处已知差异 =====
// NaN === NaN 用字面量写会被 TypeScript 7 的静态检查直接拦下（TS2845：结果恒为 false），
// 所以这里也经过 strictEquals 中转，行为和裸写 `NaN === NaN` 完全一致。
console.log(`NaN === NaN -> ${strictEquals(NaN, NaN)}`); // false
console.log(`Object.is(NaN, NaN) -> ${Object.is(NaN, NaN)}`); // true
console.log(`Object.is(0, -0) -> ${Object.is(0, -0)}`); // false
console.log(`0 === -0 -> ${strictEquals(0, -0)}`); // true

// ===== 浅拷贝导致的别名 bug =====
interface CartItem {
	name: string;
	qty: number;
}

const original: CartItem[] = [{ name: "apple", qty: 1 }];
const shallowCopy = [...original]; // 只拷贝了数组这一层，元素对象仍然是同一个引用
const shallowItem = shallowCopy[0];
if (shallowItem) {
	shallowItem.qty = 99;
}
console.log(`浅拷贝后修改 shallowCopy，original[0].qty 也被改成了 ${original[0]?.qty}`);

// ===== structuredClone：真正的深拷贝 =====
const deepCopy = structuredClone(original);
const deepItem = deepCopy[0];
if (deepItem) {
	deepItem.qty = 1;
}
console.log(`深拷贝后修改 deepCopy，original[0].qty 仍然是 ${original[0]?.qty}，deepCopy[0].qty=${deepCopy[0]?.qty}`);
