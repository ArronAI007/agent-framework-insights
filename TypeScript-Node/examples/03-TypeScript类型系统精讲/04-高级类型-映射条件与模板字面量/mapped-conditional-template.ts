// ===== 映射类型：手写 MyPartial<T>，验证等价于内置 Partial<T> =====
// [K in keyof T] 遍历 T 的每个属性名 K，? 修饰符把每个属性标记为可选，
// T[K] 保持原有的属性值类型不变——这正是内置 Partial<T> 的实现原理。
type MyPartial<T> = {
	[K in keyof T]?: T[K];
};

interface Draft {
	title: string;
	body: string;
	tags: string[];
}

// 用赋值验证 MyPartial<Draft> 和内置 Partial<Draft> 结构等价：
// 下面这个对象只填了部分字段，如果 MyPartial 的实现不对（比如漏了 ?），这里会编译报错。
const partialDraft: MyPartial<Draft> = { title: "草稿标题" };
const builtinPartialDraft: Partial<Draft> = { title: "草稿标题" };
console.log(`partialDraft=${JSON.stringify(partialDraft)}`);
console.log(`builtinPartialDraft=${JSON.stringify(builtinPartialDraft)}`);

// 手写 Readonly<T> / Pick<T, K> / Record<K, V> 的实现原理（仅用于理解，不在运行时使用）：
type MyReadonly<T> = { readonly [K in keyof T]: T[K] };
type MyPick<T, K extends keyof T> = { [P in K]: T[P] };
type MyRecord<K extends string | number | symbol, V> = { [P in K]: V };

const readonlyDraft: MyReadonly<Draft> = { title: "t", body: "b", tags: [] };
const pickedDraft: MyPick<Draft, "title" | "body"> = { title: "t", body: "b" };
const draftCountByTag: MyRecord<"tech" | "life", number> = { tech: 3, life: 1 };
console.log(`readonlyDraft.title=${readonlyDraft.title}`);
console.log(`pickedDraft=${JSON.stringify(pickedDraft)}`);
console.log(`draftCountByTag=${JSON.stringify(draftCountByTag)}`);

// ===== 分布式条件类型：对 union 逐个成员分发 =====
// T extends U ? X : Y 当 T 是「裸类型参数」（未被包裹）且传入的是联合类型时，
// TS 会把联合类型拆开，对每个成员分别做一次条件判断，再把结果重新联合起来——这就是「分布式」。
type MyExtract<T, U> = T extends U ? T : never;

type Mixed = string | number | boolean;
type OnlyStrings = MyExtract<Mixed, string>; // 分布式展开：string | number | boolean 逐个判断，只留下 string
const onlyStringsExample: OnlyStrings = "kept"; // 合法：OnlyStrings 就是 string
console.log(`onlyStringsExample=${onlyStringsExample}`);

// 用 [T] extends [U] 把 T 包进元组，可以阻止分布式展开：
// 这时候 T 不再是「裸类型参数」，TS 会把整个联合类型当成一个整体去判断，
// 而不是逐个成员分发。
type IsStringNonDistributive<T> = [T] extends [string] ? true : false;
type MixedIsString = IsStringNonDistributive<Mixed>; // Mixed 整体（string | number | boolean）不满足 extends string，结果是 false
const mixedIsStringExample: MixedIsString = false;
console.log(`mixedIsStringExample=${mixedIsStringExample}`);

// 对比：不包裹元组的分布式版本，会对每个成员单独判断再联合结果
type IsStringDistributive<T> = T extends string ? true : false;
type EachIsString = IsStringDistributive<Mixed>; // 分布式展开后是 false | true | false，联合化简为 boolean
const eachIsStringExample: EachIsString = true; // boolean 允许 true 或 false
console.log(`eachIsStringExample=${eachIsStringExample}`);

// ===== 模板字面量类型：拼出 HTTP 路由字符串类型 =====
// 把字符串字面量联合类型代入模板，TS 会在类型层面做「字符串拼接」，
// 生成所有组合的字面量类型联合。
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
type Resource = "users" | "orders";
type Route = `${HttpMethod} /${Resource}`; // "GET /users" | "GET /orders" | "POST /users" | ...

const route: Route = "GET /users"; // 合法：属于 Route 联合类型里的一员
// const badRoute: Route = "PATCH /users"; // 如果取消注释会编译报错：PATCH 不在 HttpMethod 里
console.log(`route=${route}`);

// 模板字面量类型还能配合泛型函数，让调用方传入具体值时自动推导出拼接后的字面量类型：
function buildRoute<M extends HttpMethod, R extends Resource>(method: M, resource: R): `${M} /${R}` {
	return `${method} /${resource}`;
}
const built = buildRoute("POST", "orders"); // 推断出的类型精确到字面量 "POST /orders"
console.log(`built=${built}`);
