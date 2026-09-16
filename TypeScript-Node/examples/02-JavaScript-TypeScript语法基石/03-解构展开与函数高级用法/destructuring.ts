// ===== 嵌套对象解构 + 默认值 + 重命名 =====
interface UserProfile {
	id: number;
	name: string;
	address?: {
		city: string;
		zip?: string;
	};
}

const profile: UserProfile = {
	id: 1,
	name: "Ada",
	address: { city: "Shanghai" },
};

const {
	name: userName, // 重命名：把 name 解构成 userName
	address: { city, zip = "unknown" } = { city: "N/A" }, // 嵌套解构 + 整体默认值 + 字段默认值
} = profile;
console.log(`userName=${userName}, city=${city}, zip=${zip}`);

const guest: UserProfile = { id: 2, name: "Guest" }; // 没有 address 字段
const {
	address: { city: guestCity } = { city: "N/A" },
} = guest;
console.log(`guestCity=${guestCity}`); // address 缺失时落到整体默认值

// ===== 数组展开合并 =====
const left = [1, 2, 3];
const right = [4, 5, 6];
const merged = [...left, ...right];
console.log(`merged=[${merged.join(",")}]`);

// ===== 对象展开合并：同名字段以「后写的为准」 =====
const defaults = { theme: "light", fontSize: 14 };
const overrides = { fontSize: 18 };

const settings = { ...defaults, ...overrides }; // overrides 在后，fontSize 取 18
console.log(`settings=${JSON.stringify(settings)}`);

const reversedOrder = { ...overrides, ...defaults }; // defaults 在后，fontSize 被覆盖回 14
console.log(`reversedOrder=${JSON.stringify(reversedOrder)}`);

// ===== 剩余参数（收集为数组）vs 展开运算符（把数组打散） =====
function sum(...nums: number[]): number {
	// nums 是剩余参数：调用方传入的多个实参被收集成一个数组
	return nums.reduce((acc, n) => acc + n, 0);
}
console.log(`sum(...left, ...right)=${sum(...left, ...right)}`); // 展开运算符把数组打散成实参列表

// ===== 函数重载：按入参类型返回不同格式的字符串 =====
function format(value: string): string;
function format(value: number): string;
function format(value: string | number): string {
	// 这一行是唯一的实现签名，不对外暴露；调用方只能看到上面两条重载签名
	return typeof value === "number" ? value.toFixed(2) : value.trim();
}
console.log(`format("  hello  ") -> "${format("  hello  ")}"`);
console.log(`format(3.14159) -> "${format(3.14159)}"`);

// ===== 可选参数 vs 默认参数：类型推断上的差异 =====
// tag 是可选参数，类型会被推断为 string | undefined，调用方必须自己处理 undefined
function logOptional(message: string, tag?: string): void {
	console.log(`[optional] tag=${tag ?? "(none)"} message=${message}`);
}
// level 是默认参数，类型直接就是 number（不带 undefined），因为不传时会用默认值兜底
function logDefault(message: string, level = 1): void {
	console.log(`[default] level=${level} message=${message}`);
}
logOptional("hello");
logDefault("world");
