// interface：描述 buildGreeting 返回值的形状
export interface Greeting {
	message: string;
	loud: boolean;
}

// 带类型标注的导出函数：参数和返回值类型都显式写出
export function greet(name: string): string {
	return `Hello, ${name}!`;
}

// 故意不标注返回类型，让 TypeScript 通过控制流分析自己推断出结构类型。
// `satisfies Greeting` 只做一次性的形状校验，不会像显式标注那样改变推断出的类型。
function buildGreeting(name: string, loud: boolean) {
	const message = loud ? greet(name).toUpperCase() : greet(name);
	return { message, loud } satisfies Greeting;
}

const normal = buildGreeting("TypeScript", false);
console.log(normal.message);

const shouted = buildGreeting("Node.js", true);
console.log(shouted.message);
