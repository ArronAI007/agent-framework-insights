// ===== interface 的声明合并（declaration merging）=====
// 同名 interface 可以声明多次，TS 会自动把它们的成员合并成一个接口——
// 这是 interface 和 type 之间最本质的差异之一，常被库作者用来做「模块扩展」。
interface Window {
	appVersion: string;
}
interface Window {
	buildTime: string;
}
// 合并后的 Window 同时拥有 appVersion 和 buildTime 两个属性
const appWindow: Window = { appVersion: "1.0.0", buildTime: "2026-09-16" };
console.log(`appWindow=${JSON.stringify(appWindow)}`);

// type 别名不支持声明合并：如果取消注释下面两行会编译报错：
// type Config = { a: string };
// type Config = { b: string }; // 错误：标识符“Config”重复

// ===== 联合类型（|）与交叉类型（&）=====
type Id = string | number; // 联合类型：值只要满足其中一种即可
type WithTimestamps = { createdAt: string } & { updatedAt: string }; // 交叉类型：必须同时满足两边的形状

const numericId: Id = 42;
const stringId: Id = "user_42";
const record: WithTimestamps = { createdAt: "2026-01-01", updatedAt: "2026-09-16" };
console.log(`numericId=${numericId}, stringId=${stringId}, record=${JSON.stringify(record)}`);

// ===== 可辨识联合（discriminated union）=====
// 每个成员都带一个共同的字面量字段（这里是 kind），TS 能根据这个字段的值
// 把联合类型精确收窄到某一个具体成员。
interface Circle {
	kind: "circle";
	radius: number;
}
interface Square {
	kind: "square";
	side: number;
}
interface Triangle {
	kind: "triangle";
	base: number;
	height: number;
}
type Shape = Circle | Square | Triangle;

function area(shape: Shape): number {
	// switch 对 kind 做穷尽匹配：每个 case 分支里，TS 会把 shape 收窄到对应的具体类型，
	// 比如在 "circle" 分支里，shape.radius 是合法访问，但 shape.side 会编译报错。
	switch (shape.kind) {
		case "circle":
			return Math.PI * shape.radius ** 2;
		case "square":
			return shape.side ** 2;
		case "triangle":
			return (shape.base * shape.height) / 2;
		default: {
			// 穷尽性检查（exhaustiveness check）：如果 Shape 新增了一个成员但忘记在
			// switch 里处理，default 分支里 shape 的类型就不再是 never，
			// 赋值给 never 类型的变量会在编译期直接报错，提醒你漏掉了分支。
			const _exhaustive: never = shape;
			throw new Error(`未处理的 shape.kind: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

const shapes: Shape[] = [
	{ kind: "circle", radius: 2 },
	{ kind: "square", side: 3 },
	{ kind: "triangle", base: 4, height: 5 },
];
for (const shape of shapes) {
	console.log(`area(${shape.kind}) = ${area(shape).toFixed(2)}`);
}
