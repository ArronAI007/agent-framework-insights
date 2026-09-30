# Registrations are Effects：卸载一个插件为什么能做到不多不少

这一篇要回答的问题是：`apply(ctx)` 里注册了工具、挂了监听器、起了定时器，插件被卸载时，这些东西凭什么能被全部、精确地撤销，而不靠人手写清理代码？

结论有三句。`ctx.effect()` 是最底层的原语：立即执行一段代码，收集它返回的清理函数，在卸载时按逆序回收。`ctx.on()`、`ctx.plugin()` 以及 dsh 各注册表的 `register()` 本身就是 effect 的封装，返回值就是撤销手柄，并且自动绑定到发起注册的 Fiber 上。这条原则要靠一种具体的测试来证明，即"卸载贡献者的 Fiber，断言它的贡献消失"。

## 手写卸载为什么一定会漏

设想一个插件做了三件事：往工具表塞一个工具，订阅一个事件，起一个 `setInterval` 心跳。要卸载它，可能因为配置热重载换新版，可能因为单元测试结束要清场，也可能因为一个子代理会话结束要回收专属能力。如果卸载靠逐条手写注销，这份代码必然落后于新增的注册代码：新加了一个订阅，忘了在卸载里补一行，就是内存泄漏或残留监听器，而且往往只在长时间运行或反复热重载后才暴露。

`AGENTS.md` 把对策浓缩成一句话："Registrations are effects：每一项贡献都经过 `ctx.effect()` / `ctx.on()`，注册表的 `register()` 返回撤销函数。"插件作者不需要记住"我注册了什么、所以要注销什么"，只要用 Cordis 提供的 API 注册，撤销就是自动的。这条规则在 dsh 里支撑三个具体场景：热重载时旧注册不会与新注册并存（`@deepseek-ai/cordis-plugin-hmr` 卸载旧插件、加载新代码）；测试里创建 Context、加载被测插件、断言、dispose 整棵 Fiber 树，测试之间不互相污染；一个会话或子代理结束，它专属的工具、提示词片段和监听器被干净拆掉，不影响其他会话。

## ctx.effect 的契约

`docs/cordis-api/fiber.md`（源码 `vendor/cordis/src/fiber.ts`）给出了精确契约，值得逐点看。`execute` 在调用 `ctx.effect` 的那一刻就立即执行，不是注册一个稍后触发的回调。它产出的清理函数被收集起来，在"手动调用 effect 返回的撤销函数"或"Fiber 卸载"两者先发生的那一刻执行，重复调用撤销函数是空操作。清理按逆序进行，类似 `defer`，后申请的先释放。Fiber 已被 dispose 后再调用会抛 `CordisError('INACTIVE_EFFECT')`，`execute` 返回的形态不合法则抛 `TypeError`。

实现上，`fiber.ts` 里 `disposables.splice(0).reverse()` 这一行就是逆序的字面实现，`disposing` 标志位保证二次调用是空操作。要注意"逆序"只保证启动顺序：教程明确说，多个异步清理函数并发运行，完成顺序不保证严格逆序。清理步骤之间若有先后依赖，应把它们写进同一个 disposer，在里面手动 `await`。

教程里的心跳例子说明了 `ctx.effect` 该用在哪里：

```ts
// docs/cordis-tutorial/02-lifecycle-and-effects.md
function heartbeat(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => console.log('tick'), 200)
    return () => { clearInterval(timer); console.log('heartbeat cleaned up') }
  })
}
```

`setInterval` 是 Cordis 完全不知道的资源，没有任何内建机制会清理它。`ctx.effect` 的意义正是把这类框架管不到的资源包一层：申请资源，返回释放函数，其余交给 Fiber 生命周期。运行输出依次是加载提示、若干次 `tick`、`heartbeat cleaned up`、`disposed`，清理一定先于 `disposed`，因为 `fiber.dispose()` 会等清理完成才 resolve。

## Fiber 的状态与 dispose 的完成条件

每个被加载的插件实例对应一个 Fiber，状态迁移是 `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`，`LOADING` 可以走向 `FAILED`（`apply` 抛错，或配置校验没通过）。`PENDING` 是上一篇讲过的"依赖未满足"状态，不是异常。

`fiber.dispose()` 的契约是卸载插件，并在清理彻底完成后才 resolve。`_unload()` 的实现对此有两个值得注意的选择：它用 `Promise.all` 等待这个 Fiber 收集到的全部 disposer，包括异步的；而任何一个 disposer 抛错都不会阻塞其他 disposer，错误被记录到 `ctx.logger.error`。也就是说，清理是"尽力而为、逐项隔离"的，一个坏的 disposer 不会让其他资源泄漏。教程还补充，`dispose()` 会递归卸载它挂载的子插件，因为 `ctx.plugin(child)` 本身就是一个 effect，所以拆除整棵子树只需 dispose 根节点。

## 谁天然就是 effect

教程明确说，日常几乎不用手写 `ctx.effect()`，因为内建注册 API 已经是 effect：`ctx.on` 的监听器随卸载移除，`ctx.plugin(child)` 的子插件随父级 dispose，服务注册是 effect，`ctx.tools.register(...)` 这类 harness 注册表也会把返回的 disposer 挂到调用它的插件上。

`dsh-tools` 的 `register()` 是这一点最清楚的实现：

```ts
// packages/core/tools/src/index.ts
register(definition: ToolDefinition): () => void {
  const name = definition.name
  // ...省略参数校验...
  return this.layers.effect(
    this.ctx,
    layer => layer.tools.insert(name, definition),
    { label: 'tools.register()' },
  )
}
```

`this.layers.effect(this.ctx, ...)` 是 `dsh-tools` 内部对 `ctx.effect()` 的一层封装，把"往内部层级结构里插入一条工具定义"包成绑定在当前 Fiber 上的 effect，`label` 用于诊断。注释里的规则也值得记住：工具可以全局注册，也可以注册在调用者的 Agent 作用域里，作用域内的工具遮蔽全局工具；同一层内重名，以及保留名 `run_code`，都会失败。命令注册表 `ctx.commands` 的 `register()` 走完全相同的封装，标签是 `'commands.register()'`。

对调用方而言，不需要知道 `register()` 内部怎么做 effect，只需要知道返回的函数就是撤销手柄。`packages/AGENTS.md` 把它写成仓库规范："注册表的贡献要通过 HMR-safety 测试证明可被撤销：dispose Fiber，观察它被移除"。

## 用测试证明：HMR-safety

`docs/testing.md` 的要求是"每个注册表都有一个 HMR-safety 测试（dispose 贡献者的 Fiber，断言清理）"。`packages/core/tools/tests/tools.spec.ts` 里有一个完全符合描述的测试，可以按步骤读：

```ts
// packages/core/tools/tests/tools.spec.ts
const ctx = await setup()
ctx.tools.register(echoTool)
expect(() => ctx.tools.register(echoTool)).toThrow('already registered')
const fiber = await ctx.plugin(Object.assign((inner: Context) => {
  inner.tools.register({ ...echoTool, name: 'scoped' })
}, { inject: ['tools'] }))
expect(ctx.tools.schemas().map(t => t.name)).toEqual(['echo', 'scoped'])
await fiber.dispose()
expect(ctx.tools.schemas().map(t => t.name)).toEqual(['echo'])
```

先在根 Context 注册 `echo`，顺带验证重名报错。再挂一个子插件，它在自己的 `apply` 里注册 `scoped`，拿到的 `fiber` 是这个子插件专属的句柄。此时列表是 `['echo', 'scoped']`。核心断言在 `await fiber.dispose()` 之后：只卸载子插件，列表变回 `['echo']`。`scoped` 随贡献者消失，`echo` 因为注册在根 Fiber 上，毫发无损。测试里没有任何手动清理代码，消失完全是 `register()` 内部 effect 封装的结果。原则的表述因此可以很精确：谁注册，卸载谁的 Fiber，谁的贡献就消失，且仅消失这一份。

紧随其后的另一个测试验证 `register()` 的返回值本身可调用：调用它，对应工具即从列表中消失。两者合起来说明撤销一份注册有两条等价路径，直接调用返回的撤销函数，或卸载发起注册的整个 Fiber，后者是前者的批量版本，会按逆序一次撤销该 Fiber 名下的全部注册。

## 边界

第一，effect 只管得到它的东西。插件里直接 `setInterval`，或往第三方库的事件总线 `addListener`，不用 `ctx.effect` 包裹，就永远不会随卸载释放，心跳例子存在的意义就在这里。第二，"逆序"不是严格串行的保证，前面已经说过。第三，这是一条靠规范和测试维持的纪律：给注册表新增能力时，忘写 HMR-safety 测试，就没有任何东西证明它遵守了原则，`packages/AGENTS.md` 因此把这个测试列为规范而不是建议。

## 小结

- `ctx.effect()` 立即执行、收集 disposer、卸载时逆序回收，二次调用无副作用；清理逐项隔离，一个失败不阻塞其他。
- `ctx.on()`、`ctx.plugin()`、`register()` 都是 effect 的封装，返回值即撤销手柄，绑定到发起注册的 Fiber，`dispose()` 递归拆除子树并等待清理完成。
- 用 HMR-safety 测试证明：卸载贡献者 Fiber，其贡献精确消失，其他 Fiber 的贡献不受影响。

对应原课程：`03-Cordis插件框架基石/03-Registrations-are-Effects可逆卸载.md`
