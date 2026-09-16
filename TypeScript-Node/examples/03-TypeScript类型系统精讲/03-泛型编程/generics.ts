// ===== 泛型约束（extends）：pluck 只能取「对象自身存在的字段」=====
// K extends keyof T 约束了 key 参数必须是 T 的某个真实存在的属性名，
// 这样 T[K] 才能精确推断出「取出这个字段之后的类型」，而不是笼统的 unknown。
function pluck<T, K extends keyof T>(obj: T, key: K): T[K] {
	return obj[key];
}

interface Product {
	id: number;
	title: string;
	price: number;
}

const product: Product = { id: 1, title: "Mechanical Keyboard", price: 299 };
const title = pluck(product, "title"); // 推断出 title: string
const price = pluck(product, "price"); // 推断出 price: number
// pluck(product, "sku"); // 如果取消注释会编译报错："sku" 不满足约束 keyof Product
console.log(`title=${title} (typeof ${typeof title}), price=${price} (typeof ${typeof price})`);

// ===== 泛型类：Stack<T> =====
// push/pop/peek 都围绕同一个内部数组操作，T 保证了无论存的是什么类型，
// 出栈时拿到的还是同一种类型，不需要调用方做类型断言。
class Stack<T> {
	#items: T[] = [];

	push(item: T): void {
		this.#items.push(item);
	}

	// 空栈时 pop 没有元素可弹出，返回类型体现为 T | undefined，
	// 强制调用方处理「栈已空」这种情况，而不是假装永远有值。
	pop(): T | undefined {
		return this.#items.pop();
	}

	peek(): T | undefined {
		return this.#items.at(-1);
	}

	get size(): number {
		return this.#items.length;
	}
}

const numberStack = new Stack<number>();
numberStack.push(1);
numberStack.push(2);
numberStack.push(3);
console.log(`numberStack.peek()=${numberStack.peek()}, size=${numberStack.size}`);
console.log(`numberStack.pop()=${numberStack.pop()}`);
console.log(`numberStack.pop()=${numberStack.pop()}`);
console.log(`numberStack.pop()=${numberStack.pop()}`);
const emptyPop = numberStack.pop(); // 栈已空，返回 undefined（类型上就是 T | undefined 里的 undefined 分支）
console.log(`empty stack pop()=${emptyPop}`);

// ===== 泛型默认类型参数 =====
// ApiResponse<T = unknown> 允许调用方省略类型参数，此时 T 落到默认值 unknown，
// 强制使用方在读取 data 之前先做类型收窄；也可以显式传入具体类型获得精确的 data 类型。
interface ApiResponse<T = unknown> {
	success: boolean;
	data: T;
	error?: string;
}

const rawResponse: ApiResponse = { success: true, data: { anything: "goes" } }; // T 落到默认值 unknown
const typedResponse: ApiResponse<Product> = { success: true, data: product }; // 显式传入 Product，data 的类型精确到 Product
console.log(`rawResponse.success=${rawResponse.success}`);
console.log(`typedResponse.data.title=${typedResponse.data.title}`);

// ===== 协变直觉：只读视角下，数组可以安全地「当作」父类型数组使用 =====
// Dog[] 本身不是 Animal[] 的子类型（可变数组允许 push，若允许协变会破坏类型安全：
// 往被当作 Dog[] 使用的数组里 push 一只 Cat 会在运行时炸穿 Dog 专属逻辑）。
// 但 readonly Dog[] 没有写入操作，把它当作 readonly Animal[] 使用是安全的——
// 这就是「只读视角下的协变」直觉：放弃写权限，换来「更宽泛类型」的可替换性。
interface Animal {
	name: string;
}
interface Dog extends Animal {
	breed: string;
}

function announceAnimals(animals: readonly Animal[]): string {
	// 这里只读取，不写入，所以传入 readonly Dog[] 是安全的
	return animals.map((animal) => animal.name).join(", ");
}

const dogs: readonly Dog[] = [
	{ name: "Rex", breed: "Labrador" },
	{ name: "Fido", breed: "Poodle" },
];
console.log(`announceAnimals(dogs)=${announceAnimals(dogs)}`); // readonly Dog[] 被当作 readonly Animal[] 使用，编译通过
