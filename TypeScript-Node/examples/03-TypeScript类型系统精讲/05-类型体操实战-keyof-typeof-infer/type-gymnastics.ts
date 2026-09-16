// ===== DeepReadonly<T>：冻结一份配置对象，防止运行时被意外修改 =====
// 场景：应用启动时加载的配置对象经常被多处模块共享读取，如果某处代码手滑改了
// 配置里的一个嵌套字段，会产生极难排查的「配置在运行时被污染」问题。
// DeepReadonly 递归地把每一层都标记为 readonly，配合 Object.freeze 在类型和
// 运行时两个层面同时拒绝修改。
type DeepReadonly<T> = T extends (infer U)[]
	? readonly DeepReadonly<U>[]
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;

interface AppConfig {
	appName: string;
	server: {
		host: string;
		port: number;
	};
	featureFlags: string[];
}

const rawConfig: AppConfig = {
	appName: "shop-api",
	server: { host: "0.0.0.0", port: 8080 },
	featureFlags: ["checkout-v2", "dark-mode"],
};

// deepFreeze 是运行时对应的实现：递归调用 Object.freeze，
// 让「类型上不可变」和「运行时真的不可变」保持一致，而不是只在类型层面自欺欺人。
function deepFreeze<T>(value: T): DeepReadonly<T> {
	if (value !== null && typeof value === "object") {
		Object.values(value as object).forEach(deepFreeze);
		Object.freeze(value);
	}
	return value as DeepReadonly<T>;
}

const frozenConfig: DeepReadonly<AppConfig> = deepFreeze(rawConfig);
// frozenConfig.server.port = 9090; // 如果取消注释会编译报错：无法分配到 "port" ，因为它是只读属性
try {
	// @ts-expect-error —— 特意用运行时赋值验证 Object.freeze 真的生效了（严格模式下会抛出 TypeError）
	frozenConfig.server.port = 9090;
} catch (error) {
	console.log(`运行时修改冻结配置报错：${(error as Error).message}`);
}
console.log(`frozenConfig.server.port（未被改动）=${frozenConfig.server.port}`);

// ===== UnwrapPromise<T>：从任意返回 Promise 的函数类型里提取最终 resolve 值类型 =====
// 场景：写一个通用的「请求缓存」或「重试」工具函数时，需要在类型层面知道
// 「传进来的这个异步函数，最终 resolve 出来的到底是什么类型」，才能让缓存/重试
// 包装函数的返回类型和原函数保持一致，而不是让调用方到处写类型断言。
type UnwrapPromise<T> = T extends (...args: infer Args) => Promise<infer R> ? (...args: Args) => R : T;

async function fetchUserName(id: number): Promise<string> {
	return id === 1 ? "Ada" : "Unknown";
}

// withRetry 的返回类型用 UnwrapPromise<F> 从 F 反推出「同步版签名」，
// 这里只是用来演示类型提取，实际返回的还是 Promise——真实场景中常用于
// 「给这个异步函数包一层缓存」之类的函数，让包装函数的类型和原函数精确对应。
type FetchUserName = typeof fetchUserName;
type UnwrappedFetchUserName = UnwrapPromise<FetchUserName>; // (id: number) => string

async function withRetry<F extends (...args: never[]) => Promise<unknown>>(
	fn: F,
	...args: Parameters<F>
): Promise<Awaited<ReturnType<F>>> {
	try {
		return (await fn(...args)) as Awaited<ReturnType<F>>;
	} catch {
		return (await fn(...args)) as Awaited<ReturnType<F>>;
	}
}

const resolvedName = await withRetry(fetchUserName, 1);
console.log(`resolvedName=${resolvedName}`);
// 用一个类型层面的「占位变量」验证 UnwrapPromise 提取出的签名确实是 (id: number) => string：
const unwrappedSignatureCheck: UnwrappedFetchUserName = (id: number) => (id === 1 ? "Ada" : "Unknown");
console.log(`unwrappedSignatureCheck(1)=${unwrappedSignatureCheck(1)}`);

// ===== typeof + keyof：从真实的 const config 对象推导配置项类型 =====
// 场景：避免维护两份重复的类型定义——一份运行时用的 config 对象，一份手写的
// type ConfigKey = "..." | "..."。用 typeof 拿到 config 的值类型，
// 再用 keyof 取出它的键组成联合类型，config 对象和类型定义永远保持同步。
const featureConfig = {
	darkMode: { enabled: true, rolloutPercent: 100 },
	checkoutV2: { enabled: false, rolloutPercent: 0 },
	betaSearch: { enabled: true, rolloutPercent: 25 },
} as const;

type FeatureKey = keyof typeof featureConfig; // "darkMode" | "checkoutV2" | "betaSearch"：从值反推出联合类型

function isFeatureEnabled(key: FeatureKey): boolean {
	// key 的类型被 typeof + keyof 约束成 featureConfig 里真实存在的键，
	// 新增/删除一个 feature 只需要改 featureConfig 这一处，FeatureKey 会自动同步。
	return featureConfig[key].enabled;
}

console.log(`isFeatureEnabled("darkMode")=${isFeatureEnabled("darkMode")}`);
console.log(`isFeatureEnabled("checkoutV2")=${isFeatureEnabled("checkoutV2")}`);
// isFeatureEnabled("unknownFeature"); // 如果取消注释会编译报错："unknownFeature" 不满足约束 FeatureKey
