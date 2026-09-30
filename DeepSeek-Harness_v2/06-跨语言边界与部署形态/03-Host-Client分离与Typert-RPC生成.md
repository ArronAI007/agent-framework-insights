# Host/Client 分离与 Typert RPC 生成：让 Host 方法签名成为 Client 类型的唯一来源

这一篇要回答的问题是：Web 前端要调用 Host 进程里的业务方法，比如创建目标、给消息打标注、暂停某个 Agent，两端的类型、序列化、取消和错误处理怎样才能不靠手写、也不会悄悄跑偏；模型输出这类持续产生的事件又怎样推到浏览器。

结论有三句。第一，`dsh` 用 Typert 在编译期扫描 Host 侧带 `@Remote` 或 `@RemoteScope` 的方法，生成 Client 可直接 import 的类型化契约，Host 的真实签名是唯一来源。第二，运行期由 Gateway 拿生成的描述符校验请求、解析身份、调用真实的 Cordis 服务，未被认领的请求要么命中特性包自己的精确 Fetch 路由，要么直接 404，没有旧代理可以回落。第三，会话事件推送也并入了 Typert：它是 `@Remote({ mode: 'stream' })` 的普通方法，走同一套描述符、校验和取消语义，而流内部的 frame 词汇表另成一套数据协议。

## 手写客户端解决不了的问题

手写 RPC 客户端最大的问题不是工作量，而是类型一致性没有任何机制保证：Host 侧一个参数改了名字或类型，Client 侧对应调用不会自动报错。`dsh` 的做法是用 TypeScript Compiler API 分析 Host 源码，找到所有标了 `@Remote` 或 `@RemoteScope` 的方法，生成一份 Client 能直接 import 的调用契约。这套分析和生成逻辑跑在 tsdown 构建流程内部，就是 Typert。

它分成四个子包，`docs/api-gateway.md` 里有一张组件职责表。`typert/protocol` 是共享的类型协议，声明装饰器、Gateway 绑定和调用描述符，不启动任何 TypeScript 分析，也不注册 Cordis 服务；`generator` 在构建期从 Host 的 `ts.Program` 分析出 Remote 签名、类型图和源码位置，产出 Host 与 Client 产物；`registry` 和 `loader` 在运行期把生成产物装进 Host 的 `ctx.typert`。整条链路的分层是 `remotes → gateway → connection → webserver`：Connection 管传输、RPC id、响应信封和取消，Gateway 管 Remote 数据协议与业务分发。

## 两个装饰器，三种调用形态

`@Remote` 表示调用注册在根 Host Context 上的 Cordis 服务。复杂的 Host 对象不能直接过线，业务包要通过 `TypertLookupMap` 声明它与线上身份的对应关系，并在运行时向 `ctx.typert.lookups` 注册默认解析器。比如 Host 签名里名为 `agent` 的 `Agent` 参数，会在 wire 上变成 `agentId` 字段，Gateway 收到后再用解析器还原成真实对象。`@RemoteScope(key)` 则先经 `ctx.typert.contexts` 把一个身份解析成 Scoped Context，再从该 Context 取服务调用，适用于方法本身依赖作用域内的组合关系、不需要显式接收 `Agent` 之类对象的情况。

未加装饰器的方法不会进入生成的 Client 类型和运行时贡献，也就无法通过 `ctx.remote` 调用，暴露面是显式白名单。真实业务里 `@Remote` 用得很广，比如 `MessageFeedbackService` 的 `list` 与 `put`，而在业务包里没有找到 `@RemoteScope` 的实际使用，它更像是为更复杂的作用域场景预留的能力。

第三种形态是 `@Remote({ mode: 'stream' })`，方法返回 `AsyncIterable` 或 `RemoteStream<Out, In>`。装饰器本身只是在原型上打标记，标准 TC39 Stage 3 语法，真正的严格检查在生成器里：`analyzer.ts` 的 `remoteMarker()` 只接受字符串字面量名或恰好形如 `{ mode: 'stream' }` 的选项对象，同一方法上不能有两个 Remote 装饰器；`collectInvocations()` 进一步要求被标记的必须是 public、非 static、有实现体、非泛型的实例方法，且所在类要通过 `TypertRemoteService` 或 `bindTypertRemote` 绑定网关。这些约束宁可让构建失败，也不放过含糊的声明。

## 编译一次，产物两面

构建顺序是 `build:lib:host`、`build:lib:client`、`build:web`。Typert 只在 Host 那一遍 tsdown 中运行，以 Host 聚合的 `ts.Program` 为唯一种子；Client 那一遍只消费上一步生成好的产物，不再分析。原因很直接：Remote 方法的真相只存在于 Host 源码里。

生成器产出五份文件：`typert.host.js`（Host Loader 用的运行时反射、严格调用描述符和 schema 注册值）、`typert.host.d.ts`、`typert.remote-client.js`（可挂载的 `TypertRemoteContribution`，含描述符和运行时 codec）、`typert.remote-client.d.ts`（对 `TypertRemoteNamespaceMap` 等的声明合并）、以及 `.d.ts.map`，让编辑器能从生成的 Client 方法跳回 Host 源码里的声明。运行期，`TypertRegistry.register()` 原子地登记一个包的 schema、反射信息和描述符，并借 `ctx.effect` 让整批注册随插件卸载而撤销，这与整套系统"注册必须可逆"的纪律一致；`loader` 监听插件加载，自动 import 该包导出的 `./typert` 子路径，校验 manifest 后调用 `ctx.typert.register`。

## Gateway 怎样把描述符变成真实调用

`TypertGatewayService` 在 Connection 上拦截 `/api` 路径，一问一答走 HTTP，Client 侧的调用最终落到 `connection.rpc.call('/api', '<namespace>/<method>', { args }, signal)`，HTTP 载体把它映射为 `POST /api/<namespace>/<method>`，载荷里只有一个具名的 `args` 对象。执行被拆成两半：`prepareInvocation()` 负责解析描述符、校验参数个数、解析身份或 Context、取得 receiver、构造带 uplink 的 `GatewayInvocation`；随后 `invokePrepared()` 与 `openStream()` 按描述符的 `mode` 互斥分流。

```ts
if (prepared.descriptor.mode !== undefined) {
  throw new TypertGatewayError('gateway/signature-invalid', prepared.endpoint,
    'stream Remote methods must be opened through the stream carrier')
}
return await Reflect.apply(prepared.method, prepared.receiver, prepared.args)
```

反过来，`openStream()` 会拒绝一问一答的描述符。方法到底是一问一答还是持续推流，由装饰器在编译期决定，由 Gateway 在运行期强制，调用方不可能张冠李戴。`Reflect.get` 与 `Reflect.apply` 是描述符变成真实方法调用的落点，描述符里的 `service` 和 `implementation` 字段告诉 Gateway 调哪个服务的哪个方法，不需要为每个 Remote 方法手写分发代码。per-call 状态不进参数列表，而是通过 `receiverContext.extend({ invocation })` 让方法内读到 `this.ctx.invocation`。

认领规则也很收敛：Gateway 只认领有严格描述符的两段式 endpoint。旧的 API Proxy（`packages/host/apiproxy`）已被整体删除，未被认领的请求要么命中特性包在 Connection 上注册的精确 Fetch 路由（用于 RPC 信封之外的响应，例如直接吐文件的下载端点），要么 404。二进制 Remote 结果（`Uint8Array` 字段）被 Gateway 投影为 JSON 兼容的元数据加结果相对路径的字节附件，由 Connection 打成 multipart 响应，不必先转 base64。

## 流式 Remote 与反向通道

流式方法由 Gateway 内建的 `RemoteStreamMuxServer` 通过 `/api/remote.mux` 这条 WebSocket 多路复用，每个流式调用在其上开一条逻辑流，同样带描述符校验、codec 和取消。2026 年 9 月的 remote-duplex-stream（#4648）之后，流不再只能 Host 单向推给 Client：`RemoteStream<Out, In>` 的第二个类型参数声明 uplink 的元素类型，生成的 Client 方法返回 `RemoteStreamHandle<Out, In>`，除迭代 `Out` 外还有 `send`、`end`、`dispose` 三个方法，Host 方法内通过 `this.ctx.invocation.uplink<In>()` 把它读成 `AsyncIterable<In>`。因为这些数据来自浏览器，Gateway 会用生成的 `In` codec 逐条校验后再交给 Host 方法；uplink 既不进 `args`，也不进参数列表。

## 会话事件怎样走到浏览器

会话事件是最典型的持续推送需求。早期版本里，这条链路是独立于 Typert 的手工协议（`apiproxy` 里的 `FrameQueue`、`mux()`，Client 侧的 `WebSocketDownlinks`），这套东西随 `apiproxy` 整体删除，推送被收敛进 Typert。现在 `SessionController` 以 `{ namespace: 'session' }` 注册，会话事件流就是它上面的两个 `@Remote({ mode: 'stream' })` 方法：`follow(request, signal)` 跟随单个 Session 日志，`control(signal)` 送出完整的 live-control 基线加替换帧。

`docs/api-gateway.md` 里仍有一句边界声明：会话事件流、分页、增量 reduce、投影和实体子流仍需要单独的数据协议和注册模型，即便复用 Connection，也不得伪装成 Remote 方法进入调用描述符。这句话的精确含义不是"另一套推送协议"，而是流内部的 frame 词汇表。会话事件没有被拆成 `session/assistant-chunk`、`session/tool-call` 这样每种事件一个 Remote 方法，那样事件类型会挤进描述符表；实际做法是一个流式 Remote，流里逐条送出的 `snapshot`、records、`assistant-stream` 帧属于 frame 数据协议。

`follow()` 的实现解决了旧设计的"订阅之后错过就没有补救"。它先用 `ctx.on('session/event')` 把事件缓冲进 Deque，待快照源就绪后永远先送一帧完整快照（header、cursor、records、hasMore、projections），再从 Deque 回放 durable 增量，并逐条校验 seq 连续性：seq 小于期望的跳过，不等于期望的直接抛 `gateway/internal` 错误。这样快照与增量是同一套 journal 语义，不是两套机制拼接。Client 侧的 `RemoteJournalStream` 基类把"opening snapshot、增量、游标续接、缺口检测"做成可复用骨架，`SessionEventStream` 继承它，把 frame 译成 journal change 喂给会话状态。至于 session 集合层面的元事件（新建、删除、状态、活动、错误），走的是另一条机制，Typert 的远程事件，声明了五种 `api-session/*` 事件，Client 用 `ctx.remote.$on` 订阅。

把一次模型输出串起来：agent-loop 每收到流式片段就 `session.append('assistant/chunk', ...)`；`Session.append()` 写日志并触发 `session/event`；`follow()` 的监听器压入 Deque；生成器做 seq 检查后 yield 成帧；Gateway 通过 `RemoteStreamMuxServer` 在 WebSocket 上逐帧送出；Client 的 `SessionEventStream` 还原成 journal change，最终渲染出逐字效果。同一条数据，在会话日志层面是事件的语义与持久化，在这里是它如何跨越进程与协议边界。

## 我的看法

这里有两点是基于材料的判断。一是 `@RemoteScope` 的收益目前缺乏业务代码佐证：文档里有示例，仓库业务包里没找到实际用例，如果长期没有使用者，它带来的额外分析与运行时分支就是一份需要维护的成本。二是构建期生成的价值高度依赖"Typert 只跑一遍 Host 编译"这条构建顺序；材料里把顺序写进了文档，但如果有人绕开根构建单独编译 Client，Client 拿到的产物可能过期，材料中没有展开对此的保护措施。

## 小结

- Host 方法签名是 Client 类型的唯一来源：装饰器打标记，`generator` 在 Host 编译时严格分析并产出双面产物，Client 只消费。
- 运行期 Gateway 用描述符做校验、身份解析和真实服务调用，一问一答与流式互斥分流，未被认领的请求要么走精确 Fetch 路由要么 404。
- 推送不再是 Typert 之外的第二套协议：会话事件是 `@Remote({ mode: 'stream' })` 的 `follow` 与 `control`，带 uplink 的 `RemoteStreamHandle` 让 Client 也能沿同一条流反向送数据。

对应原课程篇目：`DeepSeek-Harness/06-跨语言边界与部署形态/03-Host-Client分离与Typert-RPC生成.md`
