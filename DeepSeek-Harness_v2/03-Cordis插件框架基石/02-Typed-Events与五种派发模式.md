# Typed Events 与五种派发模式：互不相识的插件怎么协作

这一篇要回答的问题是：审批、超时、观测这些策略插件彼此不认识，甚至不知道对方有没有被装配，它们怎么在同一个调用点上各自拦截、又不互相踩踏？

结论有三句。服务方法调用要求调用方认识对方，事件则让发布者只管在关键时刻广播，监听者任意挂载、零耦合。Cordis 的 `emit`、`parallel`、`serial`、`bail`、`waterfall` 五种派发模式，回答的是同一个问题：多个监听器之间，谁等谁、谁能改谁的结果、谁能一票否决。dsh 的拦截点几乎都用 `waterfall`，它是环绕式中间件，铁律是不想接管就必须调用 `next()`。

## 为什么不直接调方法

`session-stats` 通过 `inject` 拿到服务再调 `register()`，是直接调用，双方共享方法签名。但工具执行流程不适合这样：审批策略要在执行前决定允许、拒绝还是询问用户，超时策略要包一层计时，观测策略要在结果出来后记日志。这些策略彼此不认识。若用直接调用，工具注册表就得写死"先审批检查，再超时包装，再观测记录"的链条，每多一个策略就要改链条本身。

用事件的话，工具注册表只在"这个调用即将执行"的时刻广播，不关心谁在听。`docs/architecture.md` 的"新行为该挂在哪里"判断表里有一行："拦截一次请求、工具或回合，用它的 `agent/*` 或 `tools/*` 事件"。但只有广播还不够，审批要"任何一个监听器都能一票拒绝且要等它异步判断完"，日志只需"通知一下不用等"，重写请求配置要"每个监听器在前一个的基础上继续改"。这就是为什么有五种模式。

## 五种模式的区别

`docs/cordis-primer.md` 用一张表概括了它们，这里保留，因为它确实是并列枚举：

| 模式 | 是否等待 | 有返回值 | 语义 |
|---|---|---|---|
| `emit` | 否 | 否 | 按注册顺序通知，纯观察 |
| `parallel` | 是 | 否 | 所有监听器并发执行，全部完成才返回 |
| `serial` | 是 | 是 | 按注册顺序依次询问，第一个给出有效答案的胜出 |
| `bail` | 否 | 是 | `serial` 的同步版本 |
| `waterfall` | 自身同步返回，监听器可为 async | 是 | 环绕式中间件，每层可加工或短路 |

几个使用判断。日志、遥测这种不关心结果的用 `emit`。互相独立的收尾动作，需要等全部完成，用 `parallel`。"多个候选人抢答，第一个接受的赢"用 `serial` 或 `bail`，有效答案指非 `null`、`false`、`undefined`。审批、拦截、重写这类"层层设卡"的用 `waterfall`。一个常见误用是把 `emit` 当成"广播后能拿到结果"，它的返回类型是 `void`，监听器返回什么调用方都拿不到，也不会等。

## 声明合并与 `@mode` 标注

事件同样靠声明合并获得类型：在 `interface Events` 里写上事件名及其参数、返回类型，`ctx.on` 和 `ctx.emit` 就会强制校验拼写与回调签名。只想使用别处声明的事件、又不想产生运行时依赖，教程给的做法是一句 `import type {} from './stats.ts'`。

dsh 在此之上加了更严的规矩：每个事件的 JSDoc 必须带 `@mode` 标签，说明它用哪种模式派发。`packages/core/agent/src/runtime-types.ts` 中 `agent/pre-step` 的声明写着 `@mode waterfall`，参数里最后一个是 `next: () => Promise<PreStepDecision>`。这个标签不是装饰，`docs/cordis-primer.md` 提到生成的目录会核对声明与实际派发点是否一致。声明里还有一行 "Scope-filtered dispatch"，意思是这个事件的派发经过 `@deepseek-ai/dsh-scope` 的过滤，挂在某个 Agent 作用域里的监听器只收到属于那个 Agent 的事件。`dsh-scope` 是不依赖 Agent 循环的独立作用域库：子作用域继承祖先的贡献，祖先能观察后代的活动，反向都不行，销毁作用域即回收它名下的一切。

## waterfall：环绕式中间件

`docs/cordis-primer.md` 对 waterfall 的定义是：监听器收到 `(...args, next)`，调用 `next()` 把可能已被包装的结果交给下一层，不调用就是短路，值通过 `next()` 的返回值向外传递。教程的最小例子最能看清这个结构：

```ts
// docs/cordis-tutorial/04-events.md
ctx.on('demo/transform', async (input, next) => {      // 监听器 1：包一层
  return (await next()).toUpperCase()
})
ctx.on('demo/transform', async (input, next) => {      // 监听器 2：命中则短路
  if (input.includes('blocked')) return '** blocked **'
  return next()
})
// waterfall('demo/transform', 'hello', async () => 'hello')          -> HELLO
// waterfall('demo/transform', 'blocked words', async () => ...)      -> ** BLOCKED **
```

第二次调用的调用栈是这样的：监听器 1 先跑，调用 `next()` 进入监听器 2；监听器 2 发现输入含 `blocked`，不调用 `next()`，直接返回替换文本，传给 `waterfall` 的最内层默认函数根本没有机会执行；监听器 1 拿到这段文本后，在它经过自己的一刻转成大写。所以结果是 `** BLOCKED **`。

铁律由此而来。教程写道，只观察或只标注的监听器必须调用 `next()`，不调用是刻意短路；日志监听器忘了 `next()`，会静默吞掉所有下游的默认行为。dsh 把它升格为仓库规范，`AGENTS.md` 写着 "Waterfall listeners MUST call `next()` to delegate"。这个坑之所以要写成铁律，是因为它极难发现：没有报错，只有"某个功能诡异地不生效"。写监听器前该问的是，这次调用我要接管决策，还是只是路过。

## 真实案例一：agent/pre-step

`agent/pre-step` 是"模型即将看到什么消息"的拦截点，派发代码在 `packages/core/agent-loop/src/agent.ts` 的 `preStep()`：认领收件箱消息，组装系统提示词与动态上下文，然后调用 `this.dispatch.waterfall('agent/pre-step', {...}, defaultFn)`。第三个参数就是最内层默认行为：决策为 `enter`，消息是刚认领的消息加上渲染好的上下文。没有任何监听器，或所有监听器都乖乖 `next()`，走的就是这条默认路径。监听器可以追加内容，也可以返回 `{ kind: 'reject' }` 拒绝整个 step。

`packages/core/agent-loop/tests/interception.spec.ts` 里有个叫 `NativeGuard` 的示例，值得一看，因为它证明了所谓"钩子系统"在 Cordis 里不需要专门的 hook 协议或外部命令通道，就是一个普通插件在 `apply(ctx)` 里挂几个 `ctx.on(...)`。它一次覆盖了几个拦截点：`agent/created` 时注入一条常驻指令；`agent/pre-step` 里遇到包含 `rm -rf` 的文本就直接 reject（短路），否则 `return next()`；`tools/pre-execute` 里按名字拒绝危险工具。

## 真实案例二：tools/pre-execute

`tools/pre-execute` 是工具真正执行前的最后一道闸门，声明在 `packages/core/tools/src/index.ts`。监听器返回 `PreToolDecision`，一个四选一的可辨识联合：`allow` 放行；`deny` 带理由拒绝，模型会看到一条 `isError` 的工具结果；`cancel` 走规范的派发前取消路径，用来把取消和拒绝区分开；`ask` 升级为向用户请求批准，宿主不支持审批时按 `deny` 处理。声明注释里还有一条实现约束：异步闸门必须观察 `exec.signal`，注册表在它们结束后会重新检查取消状态，但绝不会丢弃它们的 promise。

同一个测试文件里有端到端验证：注册一个 `danger` 工具，再挂一个监听器对它返回 `deny`，让 MockAdapter 发出对它的调用，最后断言执行体里的 `ran` 标志仍是 `false`，且日志里的 `tool/result` 是 `isError: true`、文本包含拒绝理由。`deny` 在真正的执行代码之前就短路了整条链路。

这里体现了一个设计取舍：结果由决策数据决定，而不是由监听器顺序决定。只要有一个监听器返回 `deny`，无论它挂得早晚，最终都是拒绝。

## 边界

第一，waterfall 的正确性靠监听器自觉调用 `next()`，框架层面没有强制，只有仓库规范与代码评审兜底。第二，事件的类型安全依赖声明合并，本身不产生运行时代码，`@mode` 与实际派发方法一致靠生成目录的校验去保证。第三，事件的作用域过滤意味着同一事件名在不同 Agent 之间是隔离的，监听器写在宿主层还是 Agent 作用域里，会直接决定它能看到谁的事件。

## 小结

- 事件让发布者只广播、监听者任意挂载，五种模式的差别在于是否等待、顺序、有无返回值，以及谁能改谁的结果。
- dsh 的拦截点几乎全是 `waterfall`，声明处必须标 `@mode`，监听器接管就短路、路过就 `next()`，忘写 `next()` 会无声吞掉下游。
- `agent/pre-step` 与 `tools/pre-execute` 证明了钩子就是普通插件：默认行为作最内层函数传入，`deny`/`reject` 短路整条链路。

对应原课程：`03-Cordis插件框架基石/02-Typed-Events与五种派发模式.md`
