# 类型体操实战：keyof / typeof / infer

> "类型体操"这个说法容易让人觉得是纯炫技、脱离实际的智力游戏——这一篇刻意反着来：每一个例子都先给出一个具体的工程场景，再展示"如果没有这个类型工具，会怎样"，最后才是类型体操本身。`keyof`、`typeof`（类型层面的）、`infer` 是这一章前面几篇用到的所有工具里，唯三还没有专门讲透的关键字，这一篇把它们讲完，同时收束整个类型系统深潜。

## 学习目标

- 理解 `keyof` 如何从一个类型提取出"属性名联合类型"
- 理解类型层面的 `typeof` 和运行时 `typeof` 是两回事，知道怎么用它从值反推类型
- 理解 `infer` 如何在条件类型里"捕获"一个尚未命名的子类型
- 能写出 `DeepReadonly<T>`、`UnwrapPromise<T>` 这类递归/提取型的工具类型，并说清楚它们分别解决什么问题

## `DeepReadonly<T>`：冻结一份配置对象

**场景**：应用启动时加载的配置对象经常被多个模块共享读取。如果某处代码手滑改了配置里一个嵌套字段（哪怕只是本地调试时临时改了一下忘记改回去），会产生一种极难排查的 bug——配置在运行时被悄悄污染，而污染点可能和真正报错的地方隔着好几层调用。内置的 `Readonly<T>` 只能锁住第一层属性，嵌套对象内部仍然可写，这个场景需要**递归**地把每一层都变成只读。

```ts
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

function deepFreeze<T>(value: T): DeepReadonly<T> {
	if (value !== null && typeof value === "object") {
		Object.values(value as object).forEach(deepFreeze);
		Object.freeze(value);
	}
	return value as DeepReadonly<T>;
}

const frozenConfig: DeepReadonly<AppConfig> = deepFreeze(rawConfig);
```

真实输出：

```text
运行时修改冻结配置报错：Cannot assign to read only property 'port' of object '#<Object>'
frozenConfig.server.port（未被改动）=8080
```

`DeepReadonly<T>` 是一个**递归条件类型**：先判断 `T` 是不是数组（用 `infer U` 从数组类型里捕获出元素类型，下一节详细讲 `infer`），是的话对元素类型 `U` 递归调用 `DeepReadonly`，外层包一个 `readonly` 数组；不是数组但是个对象（`T extends object`），就用映射类型遍历每个属性，属性值类型同样递归调用 `DeepReadonly`；如果都不是（`T` 是 `string`/`number`这类原始类型），直接返回 `T` 本身——原始类型没有"可写的内部结构"，不需要再处理。这个"数组 → 对象 → 原始类型兜底"的三层判断结构，是写递归工具类型的标准模式。

光有类型层面的 `DeepReadonly` 还不够——`frozenConfig.server.port = 9090` 只在**编译期**报错，如果代码里用 `as` 断言绕过类型检查，运行时这次赋值依然会真的执行。所以配套写了 `deepFreeze` 函数，递归调用运行时的 `Object.freeze`，让"类型上不可变"和"运行时真的不可变"保持一致——上面的真实输出就是证据：即使用 `@ts-expect-error` 强行绕过编译期检查去做这次赋值，运行时依然抛出了 `TypeError: Cannot assign to read only property`，配置对象没有被真的改动。**这是这个例子想强调的一点：类型体操应该和运行时行为对应，只在类型层面自欺欺人（类型上标了 `readonly`，运行时该改还是能改）不能真正防住 bug。**

## `UnwrapPromise<T>`：从异步函数类型里提取 resolve 值类型

**场景**：写一个通用的"给任意异步函数加重试逻辑"的工具函数时，包装函数的返回类型应该和被包装函数**最终 resolve 出来的类型**精确对应，而不是笼统地返回 `Promise<unknown>`，逼着调用方到处写类型断言。这需要在类型层面"打开"一个 `Promise<...>` 类型，把里面的 `R` 取出来。

```ts
type UnwrapPromise<T> = T extends (...args: infer Args) => Promise<infer R> ? (...args: Args) => R : T;

async function fetchUserName(id: number): Promise<string> {
	return id === 1 ? "Ada" : "Unknown";
}

type FetchUserName = typeof fetchUserName;
type UnwrappedFetchUserName = UnwrapPromise<FetchUserName>; // (id: number) => string
```

真实输出：

```text
resolvedName=Ada
unwrappedSignatureCheck(1)=Ada
```

`infer` 关键字只能出现在条件类型的 `extends` 从句里，作用是"声明一个新的类型变量，让 TS 在做结构匹配时自动把匹配到的那部分子类型填进去"。`T extends (...args: infer Args) => Promise<infer R> ? ... : T` 这行的意思是：如果 `T` 长得像"一个接受若干参数、返回 `Promise<某个类型>` 的函数"，就把它的参数列表类型捕获进 `Args`、把 `Promise` 里包着的类型捕获进 `R`，条件成立时返回类型 `(...args: Args) => R`（同样的参数列表，但直接返回 `R` 而不是 `Promise<R>`）；如果 `T` 根本不长这个样子，原样返回 `T`。

`UnwrapPromise<FetchUserName>` 展开后得到 `(id: number) => string`——`infer` 帮我们从函数签名里"抠出"了原本藏在 `Promise<...>` 泛型参数位置的 `string`，不需要手写第二份类型来描述"这个异步函数 resolve 出来的到底是什么"。真实项目里更常见的做法是直接用 TS 内置的 `Awaited<T>`（它就是标准库版本的"从 Promise 提取内部类型"，而且能处理"Promise 套 Promise"这种嵌套情况）——示例里 `withRetry` 函数用的正是 `Awaited<ReturnType<F>>` 这个组合：`ReturnType<F>` 取出函数 `F` 的返回类型（也就是 `Promise<string>`），`Awaited<...>` 再把 `Promise` 剥开拿到 `string`。手写 `UnwrapPromise` 的意义在于理解 `Awaited` 内部大致是怎么工作的——它的真实实现比这里的简化版本更复杂（要处理嵌套 Promise、thenable 对象等边界情况），但核心机制就是这里展示的 `infer` 捕获。

## `typeof` + `keyof`：从一份真实配置对象推导出配置项类型

**场景**：项目里经常会有一份"功能开关"或"路由表"之类的配置对象，同时又想在类型层面约束"只能用这份配置里真实存在的 key"。如果手写一份独立的联合类型（`type FeatureKey = "darkMode" | "checkoutV2" | ...`），配置对象改了、类型忘了同步改，就会出现类型和实际数据脱节的问题——这正是第 01 篇 `as const` 那节埋下的伏笔，这里补全"从值反推类型"的完整链路。

```ts
const featureConfig = {
	darkMode: { enabled: true, rolloutPercent: 100 },
	checkoutV2: { enabled: false, rolloutPercent: 0 },
	betaSearch: { enabled: true, rolloutPercent: 25 },
} as const;

type FeatureKey = keyof typeof featureConfig; // "darkMode" | "checkoutV2" | "betaSearch"：从值反推出联合类型

function isFeatureEnabled(key: FeatureKey): boolean {
	return featureConfig[key].enabled;
}
```

真实输出：

```text
isFeatureEnabled("darkMode")=true
isFeatureEnabled("checkoutV2")=false
```

这里有两个关键字要分清楚，它们经常被搞混：

- **`typeof`（类型层面）**：写在类型位置上的 `typeof someValue`，意思是"取出 `someValue` 这个值的类型"，和运行时判断值的类型的 `typeof`（比如 `typeof payload === "string"`）不是一回事——虽然是同一个关键字，但出现在类型位置还是表达式位置，语义完全不同。`typeof featureConfig` 取出的就是 `featureConfig` 那个对象字面量的完整类型（因为加了 `as const`，这个类型精确到每个字段的字面量值）。
- **`keyof`**：取出一个对象类型所有属性名组成的联合类型。`keyof typeof featureConfig` 组合起来，就是"先拿到 `featureConfig` 的值类型，再取出它所有的键"，结果是 `"darkMode" | "checkoutV2" | "betaSearch"`。

`isFeatureEnabled` 的参数类型直接用 `FeatureKey` 约束，调用时传入不存在的键（比如 `"unknownFeature"`）会在编译期报错。更重要的是**这条类型定义和 `featureConfig` 这份运行时数据是自动同步的**——以后新增一个功能开关，只需要往 `featureConfig` 里加一行，`FeatureKey` 会自动多出这个新键，`isFeatureEnabled` 的参数类型也跟着自动更新,不需要另外去改一处手写的类型定义。这正是"用 `typeof` + `keyof` 从运行时数据反推类型"这个惯用法的价值：**消灭"一份数据、两份定义"的重复，把类型和数据的同步关系交给编译器保证，而不是靠人记得同步修改**。

## 小结

`keyof` 从一个类型提取属性名联合类型，`typeof`（类型层面）从一个值反推出它的完整类型，两者组合（`keyof typeof someConstObject`）能从一份 `as const` 声明的运行时数据自动推导出对应的联合类型，避免维护两份容易失步的重复定义。`infer` 只能出现在条件类型的 `extends` 从句里，用来"捕获"匹配到的子类型片段——`UnwrapPromise<T>` 用它从函数返回的 `Promise<R>` 里抠出 `R`，这也是 TS 内置 `Awaited<T>` 的核心机制。`DeepReadonly<T>` 展示了"数组 → 对象 → 原始类型兜底"的递归条件类型标准写法，同时提醒一个容易被忽视的原则：类型层面的不可变应该和运行时的不可变（比如 `Object.freeze`）保持一致，否则类型系统给的"安全感"只是错觉。这一篇也是整个类型系统章节里最"重"的部分——如果这几个例子都能看懂背后的机制，说明第 01-04 篇打的地基已经扎实了。下一篇转向类和面向对象类型系统，会相对轻松一些。
