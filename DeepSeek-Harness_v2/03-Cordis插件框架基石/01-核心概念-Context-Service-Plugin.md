# Context、Service、Plugin：Cordis 的三个基本概念到底怎么用

这一篇要回答的问题是：`dsh` 说"一切皆插件"，落到代码上，一个插件长什么样、它怎么找到别的能力、加载顺序由谁决定？

结论有三句。Context 是一个按名字索引的服务仓库，`ctx.tools` 这样的属性读取会被 Proxy 拦下来去仓库里查找，调用方只认名字，不认具体实现。Plugin 是往仓库里读写的独立单元，通过 `inject` 声明"没有这些服务我就不该启动"，加载顺序由依赖关系算出来，与配置文件里的书写顺序无关。Service 是一种特殊的 Plugin，既是插件，又充当一份可被继承、可被替换的能力契约。

## 没有它会怎样

一个 Agent Harness 至少要装配模型适配器、工具注册表、会话持久化、沙箱策略、审批流程、遥测。如果用普通的 `import` 加手写初始化函数拼起来，会撞上两类问题。

第一类是启动顺序。工具注册表要在系统提示词组装器之后启动，因为它要往提示词里塞工具 schema；审批流程又要在工具注册表之后启动。依赖超过五六个模块，手写的顺序表就成了没人敢改的脆弱清单，改错的后果轻则某个服务读到 `undefined`，重则启动时整个进程崩溃。第二类是能力不可替换。"用 SQLite 存会话"和"用本地文件系统存会话"如果都是写死在初始化代码里的两份实现，换后端就得改所有调用点。

Cordis 的回答是把每种能力都变成 Context 里的一个名字。`docs/cordis-primer.md` 对此的概括是：其他插件通过 key 找服务，而不是 import 一个具体实现。`docs/architecture.md` 敢说"没有特权核心可以打补丁"，底气也在这里：模型适配器、Agent 循环、会话日志全部是插件，替换任何一层都不需要碰调用方。

## 插件的三种写法

Cordis 接受三种形态作为插件，内部统一抽象成 `Plugin` 类型（`vendor/cordis/src/registry.ts`）：函数 `(ctx, config)`、带 `apply` 方法的对象、以及构造函数。三者共享同一组元数据字段：`name`、`Config`、`inject`、`provide`、`intercept`。

```ts
// docs/cordis-tutorial/01-first-plugin.md
export function apply(ctx: Context) {}                          // 函数
export const objectPlugin = { name: 'object-plugin', apply(ctx: Context) {} }  // 对象
export class MyService extends Service {                        // 类
  constructor(ctx: Context) { super(ctx, 'myTutorialService') }
}
```

三者的分工比较自然。函数插件最常见，没有状态，只在加载时执行一段注册逻辑。对象插件与函数插件等价，只是把 `apply` 和元数据打包成一个对象，适合需要在配置里内联一段逻辑的场合。类插件，也就是 `Service` 子类，用于插件本身要被别的插件持有引用、调用方法的长生命周期服务。

选哪种写法不影响加载顺序。`inject` 声明启动的前置条件，`provide` 声明对外发布的服务名，这两者构成 Cordis 解析顺序的全部依据。教程里有一句提醒很关键：配置里的条目是并发启动的，列表位置不保证任何先后，顺序来自服务依赖。

## Context：一个会做查找的 Proxy

`docs/cordis-api/context.md` 描述 Context 时用的词是 proxy：普通属性读取走服务解析器，`extend()`、`isolate()`、`intercept()` 则创建带作用域的子 Context，不会改动父级。所以 `ctx.tools`、`ctx.llm`、`ctx.sessions` 看起来是普通取属性，实际每次都要问仓库"当前作用域下叫这个名字的实现是谁"。这层间接性是解耦的关键：两个互不 import 对方类型的插件，只要认同一个服务名，就能协作。

读写仓库的底层原语是 `ctx.get` 和 `ctx.provide`（`vendor/cordis/src/reflect.ts`）。`get` 默认是 strict 模式，只返回提供者 Fiber 当前处于 active 的实现，找不到就返回 `undefined`。`provide` 登记一个由当前 Fiber 拥有的服务实现，返回一个注销函数，Fiber 卸载时也会自动注销并唤醒依赖它的插件。`ctx.<key>` 这个语法糖背后就是 `ctx.get(key)`，而 `Service` 子类构造函数里的 `super(ctx, name)` 背后就是 `ctx.provide(name, this)`。

注意 `provide` 返回注销函数这个细节。它不是随手设计的返回值，而是下一篇要讲的"注册即副作用"在最底层的体现：谁提供了服务，谁就自动拿到收回它的手柄。

## inject：依赖是持续追踪的

`docs/cordis-tutorial/03-services.md` 用 `greeter` 和 `consumer` 两个最小插件讲这条机制。提供方继承 `Service`，构造时 `super(ctx, 'greeter')`；消费方只写 `export const inject = ['greeter']`，然后在 `apply` 里直接用 `ctx.greeter.greet('world')`。

`inject` 的行为有两点反直觉。第一，只要 `greeter` 还不存在，消费方的 Fiber 就停在 `PENDING` 状态，`apply` 根本不会被调用。第二，依赖不是启动时检查一次就完，而是运行期持续追踪：教程写明，必需的服务如果在运行中消失，比如提供者被卸载或热替换，所有依赖它的插件会一并被卸载，服务回来后再自动重新加载。这意味着热重载一个服务提供者时，"下游怎么办"这件事完全由 `inject` 关系驱动，没有人需要手写"服务替换时的善后逻辑"。

依赖不都是硬性的。能在服务缺失时降级运行的场景，教程给的替代写法是在使用点直接 `ctx.get('greeter')`，拿到 `undefined` 就走降级分支。两者的区别是：`inject` 表示"没有它我就不该启动"，`ctx.get` 表示"没有它我也能跑，只是少一项能力"。该选哪个，取决于这项能力对插件本身是不是必需的。

## 一个真实的最小插件

`packages/session/session-stats/src/index.ts` 全文只有 29 行，是看清一个"能上生产的插件到底有多薄"的好样本，核心是三行：

```ts
// packages/session/session-stats/src/index.ts
export const name = 'session-stats'
export const inject = ['sessionProjections']
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(sessionStatsProjectionDefinition)
}
```

它的存在理由就是往 `sessionProjections` 服务里注册一个投影单元，所以对该服务是硬依赖：宿主没装配会话投影服务，这个插件就永远停在 `PENDING`，既不做事也不报错。统计逻辑（整段日志的轮次、步数计数和耗时折叠）在 `./projection.ts` 的纯函数定义里，插件文件只关心"往哪个服务里挂"。文件头注释里那句"the plugin owns only the fold; delivery is the seam's"说得很准：插件只负责折叠，投递是能力接缝的事。

另一个例子是 `session-log-export`，它 `inject` 了 `commands` 和 `connection` 两个服务，`apply` 里用 `ctx.effect(() => ctx.commands.register({...}), 'session-log-download: command')` 注册一条 `export` 命令。课程材料特别澄清了一点：`ctx.tools`、`ctx.sessionProjections`、`ctx.commands` 这几个注册表的 `register()` 内部本来就已经包成了 effect，所以外面再套一层 `ctx.effect()` 对卸载正确性不是必需的。显式套一层的价值在第二个参数，那个标签会出现在 Fiber 的 effect 诊断清单里，排错时能一眼认出这笔注册来自哪个插件、注册的是什么。

## Service 作为契约：SpillStore

`Service` 子类除了当插件用，还承担"定义一份服务契约"的角色。`packages/spill/spill/src/index.ts` 里的 `SpillStore` 是体量合适的例子：

```ts
// packages/spill/spill/src/index.ts（节选）
declare module '@deepseek-ai/cordis' {
  interface Context { spillStore: SpillStore }
}
export abstract class SpillStore extends Service {
  constructor(ctx: Context) { super(ctx, 'spillStore') }
  abstract saveText(input: SaveTextSpill): Promise<SpillRef>
}
```

这个包自己不提供任何实现，只声明"存在一个叫 `spillStore` 的服务，它必须有 `saveText`"。真正把内容存到宿主文件系统的是另一个独立的包 `dsh-spill-local`，它去继承 `SpillStore` 并实现 `saveText`。这对应 `docs/architecture.md` 里 Capability seam 的三个角色：Service Definition 声明契约，Service Provider 实现契约，Consumer 通过 `ctx.spillStore` 使用契约。三个角色可以合并在一个包里，就像 `session-stats` 那样，也可以拆成三个包，拆开的好处是换存储后端只需换 Provider，另外两方都不动。

契约必须是 `Service` 抽象类而不是纯接口，还有一条实际后果：`SpillStore` 注释写明，一个 Context 下只允许一个实现，加载第二个会抛错，这是 Cordis 标准的重复服务行为，不用自己写检测代码。

## 声明合并只管编译期

上面代码里的 `declare module '@deepseek-ai/cordis' { interface Context { spillStore: SpillStore } }` 常被误解。它不生成任何运行时代码，删掉之后 `ctx.provide('spillStore', this)` 照样工作，`ctx.spillStore` 照样能在运行时读到值。它唯一的作用是让 TypeScript 知道 `Context` 上多了一个类型为 `SpillStore` 的字段，从而给 `ctx.spillStore.saveText(...)` 提供类型检查和补全。教程的措辞是：不生成代码，没有它服务照样能用，只是消费者失去类型安全。

同理，`inject` 与 `import` 不能混为一谈。`inject` 是运行时服务依赖，`import type {} from '@deepseek-ai/dsh-tools'` 只为拿到类型合并，却不把 `'tools'` 放进 `inject`，意味着对该服务只是"有就借用类型信息"，而不是"启动前必须等它"。

## 边界与代价

这套机制有两个容易踩的边界。其一是"什么都不打印也没报错"：几乎总是 `inject` 里某个服务名没有任何插件提供，Fiber 停在 `PENDING`。这是合法状态，Cordis 不会为此报警，课程提到可以用 `ctx.registry` 遍历 Fiber 状态来诊断，具体用法课程材料中未展开。其二是服务名冲突：同一 Context 重复 `provide` 同名服务直接抛错。

代价方面，按名字查找让"这一刻 `ctx.shell` 指向谁"成了一个需要运行时回答的问题，而不是靠跳转定义就能看到的。课程材料在这一篇没有展开这一点的排查手段。

## 小结

- Context 是按名字索引的服务仓库，`ctx.<key>` 走 Proxy 查找，底层是 `ctx.get` 与返回注销函数的 `ctx.provide`。
- Plugin 有函数、对象、`Service` 子类三种写法，`inject` 声明硬依赖并被持续追踪，服务消失会连带卸载依赖者，回来再重载；软依赖用 `ctx.get`。
- Service 抽象类是能力契约的载体，声明合并只服务于类型，不产生运行时行为。

对应原课程：`03-Cordis插件框架基石/01-核心概念-Context-Service-Plugin.md`
