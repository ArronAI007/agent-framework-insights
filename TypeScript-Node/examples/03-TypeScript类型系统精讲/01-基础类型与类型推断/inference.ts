// ===== let vs const：类型宽化（widening）=====
// let 声明时，TS 会把字面量类型「宽化」成它所属的基础类型（widen 到 string），
// 因为 let 变量之后可能被重新赋值成同一类型的任意其他值。
let widenedGreeting = "hello"; // 推断类型：string
// const 声明时不存在「之后被重新赋值」的可能，TS 直接保留字面量类型本身。
const literalGreeting = "hello"; // 推断类型：不是 string，而是 "hello" 这个字面量类型

// 用赋值验证宽化的实际效果：
widenedGreeting = "world"; // 合法，widenedGreeting 的类型是 string
// literalGreeting = "world"; // 如果取消注释会编译报错：不能将类型“"world"”分配给类型“"hello"”
console.log(`widenedGreeting=${widenedGreeting}, literalGreeting=${literalGreeting}`);

// ===== any vs unknown：为什么应该几乎总用 unknown =====
// any 会关闭这个值上的所有类型检查，之后随便调用什么方法、访问什么属性都不会报错，
// 相当于在类型系统里开了个无底洞——错误会一路传播到运行时才爆炸。
function decodeWithAny(payload: any): string {
	// payload.toUpperCase() 即便 payload 实际上是个 number，这里也不会报错，
	// 只会在真正运行到这一行时抛出运行时异常。
	return payload.toUpperCase();
}

// unknown 表示「类型未知」，但和 any 不同：unknown 上几乎不能做任何操作，
// 必须先收窄（narrow）到具体类型，TS 才允许你调用方法/访问属性。
function decodeWithUnknown(payload: unknown): string {
	if (typeof payload === "string") {
		// 进入这个分支后，TS 已经把 payload 的类型从 unknown 收窄成 string
		return payload.toUpperCase();
	}
	if (typeof payload === "number") {
		return payload.toFixed(2);
	}
	return String(payload);
}

console.log(`decodeWithAny("boom") -> ${decodeWithAny("boom")}`);
console.log(`decodeWithUnknown(42) -> ${decodeWithUnknown(42)}`);
console.log(`decodeWithUnknown("boom") -> ${decodeWithUnknown("boom")}`);

// ===== const 断言（as const）：把数组变成只读元组 =====
// 不加 as const，TS 会把这个数组推断成 string[]：长度可变，元素可以是任意 string。
const mutableRoles = ["admin", "editor", "viewer"]; // 推断类型：string[]

// 加上 as const 之后，TS 会做三件事：
// 1. 数组变成只读元组类型 readonly ["admin", "editor", "viewer"]（固定长度、固定顺序）
// 2. 每个元素都从 string 收窄成对应的字面量类型（"admin" / "editor" / "viewer"）
// 3. 数组本身变成只读，push/pop/元素赋值在编译期就会报错
const readonlyRoles = ["admin", "editor", "viewer"] as const;
// readonlyRoles.push("guest"); // 如果取消注释会编译报错：类型“readonly ["admin", "editor", "viewer"]”上不存在属性“push”
// readonlyRoles[0] = "editor"; // 如果取消注释会编译报错：无法分配到 "0" ，因为它是只读属性

type Role = (typeof readonlyRoles)[number]; // "admin" | "editor" | "viewer"：从值反推出联合类型，避免手写重复的类型定义
const currentRole: Role = "editor"; // 合法：属于联合类型里的一员
console.log(`mutableRoles=[${mutableRoles.join(",")}], readonlyRoles=[${readonlyRoles.join(",")}], currentRole=${currentRole}`);

// ===== 上下文类型推断（contextual typing）：数组 .map() 回调参数 =====
const scores = [88, 92, 76, 100];
// TS 从 scores 的类型 number[] 反推出 .map() 期望的回调签名是 (value: number, index: number, array: number[]) => U，
// 所以这里的 score 参数不需要手写类型注解，TS 会根据「上下文」自动推断出它是 number。
const grades = scores.map((score) => (score >= 90 ? "A" : score >= 80 ? "B" : "C"));
console.log(`grades=[${grades.join(",")}]`);

// 上下文类型推断同样作用于事件回调、Promise 回调等场景，只要「调用点」能提供足够的类型信息，
// 回调参数就不需要显式标注类型——这也是 TS 在不写类型注解的情况下依然能报错的原因之一：
// 下面这一行如果把 score 当成 string 使用会直接编译报错。
const doubled = scores.map((score) => score * 2);
console.log(`doubled=[${doubled.join(",")}]`);
