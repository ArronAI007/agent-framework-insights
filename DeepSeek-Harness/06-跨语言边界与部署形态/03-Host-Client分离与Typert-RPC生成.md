# Host/Client 分离与 Typert RPC 生成

> dsh 的 Web 前端要调用 Host 进程里的业务方法——创建一个目标、给一条消息打标注、暂停某个 Agent——如果这些调用手写客户端代码,每加一个方法就要在两端各写一遍类型、各写一遍序列化、各写一遍出错处理,而且没有任何机制保证两端类型不会跑偏。dsh 的答案是 Typert：一套在**编译期**扫描 Host 侧带 `@Remote`/`@RemoteScope` 装饰器的方法、生成 Client 端类型化调用契约的代码生成体系。本篇拆开这套生成流水线,并顺着"服务端事件怎么被推给浏览器"这条曾经平行、如今也并入 Typert 的推送链路,和前面章节讲过的会话事件流做一次呼应。

## 学习目标

- 理解为什么 Host↔Client 之间需要在编译期生成 RPC 契约,而不是手写 API 客户端代码或者跑运行时反射。
- 掌握 `@Remote`/`@RemoteScope` 两个装饰器的语义差异,以及它们各自解决什么样的调用场景。
- 搞清楚 Typert 四个子包(`generator`/`registry`/`protocol`/`loader`)各自的职责边界,以及它们在构建期和运行期分别扮演什么角色。
- 理解 Typert Gateway 的职责边界——它只认领有严格描述符的两段式 endpoint;旧的 API Proxy(`packages/host/apiproxy`)已被整体删除,未被认领的请求由特性包自有的精确 Fetch 路由处理或直接返回 404,不再有"落回旧代理"这条逃生通道。
- 理解流式推送现在也被纳入了 Typert 本身——`@Remote({ mode: 'stream' })` 是和 `@Remote('name')`/`@RemoteScope` 并列的第三种调用形态,方法返回一个 `AsyncIterable` 或 `RemoteStream<Out, In>`,由 Gateway 通过 `/api/remote.mux` WebSocket 逐帧转发;Client 拿到的是带 `send`/`end`/`dispose` 的 `RemoteStreamHandle`,还可以沿同一条逻辑流反向给正在运行的 Host 方法送数据(uplink),不再需要一套独立于 Typert 之外的推送协议。
- 能把第 04 章讲过的会话事件流,和这里 `SessionController.follow()`/`control()` 这类流式 Remote 方法对应起来,理解事件从 agent-loop 内部一路走到浏览器的完整路径。

## 背景与设计动机

手写一个 RPC 客户端最大的问题不是工作量,而是**类型一致性无法被编译器保证**。Host 侧一个方法的参数改了名字或类型,Client 侧对应的调用代码不会自动报错——除非有一套机制,让"Host 方法的真实签名"成为 Client 类型的唯一来源。dsh 选择在**编译期**做这件事:用 TypeScript Compiler API 分析 Host 侧源码,找到所有标了 `@Remote`/`@RemoteScope` 的方法,生成一份 Client 能直接 `import` 的类型化调用契约。跑在 tsdown 构建流程内部的这套分析和生成逻辑,就是 Typert。

`docs/api-gateway.md` 用一张组件职责表说明了 Typert 生态里各部分的分工：

```text
// docs/api-gateway.md:84-93
| Location | Package or entry | Responsibility |
|---|---|---|
| Shared | @deepseek-ai/dsh-typert-protocol | Declares decorators, Gateway bindings, merge-extensible protocol maps, invocation descriptors, and provider types; starts no TypeScript analysis and registers no Cordis services |
| Build | @deepseek-ai/dsh-typert-generator | Strictly analyzes Remote signatures, the type graph, lookups, Contexts, and source locations from the Host ts.Program, then generates Host and Host-for-Client artifacts |
| Host | @deepseek-ai/dsh-typert-registry and Loader | Places generated Host descriptors, schemas, and business-package registrations in ctx.typert, and holds lookup and Context providers |
| Host | @deepseek-ai/dsh-api-session-controller | Owns the application Agent/Session identity policy and configures the corresponding Typert lookups |
| Host | @deepseek-ai/dsh-api-gateway | Provides ctx.typertGateway, claims Remote endpoints, validates request values, resolves objects or Contexts, and invokes live Cordis services |
| Client | @deepseek-ai/dsh-api-gateway/client | Provides ctx.remote and remote.<namespace> child Services, mounts generated descriptors as concrete methods, and initiates and cancels calls through the Connection |
| Client | @deepseek-ai/dsh-api-remotes/client | Explicitly selects and mounts the /remote contributions allowed by the application and brings the corresponding declaration merges into business code |
| Both | @deepseek-ai/dsh-client-connection | Provides the RPC carrier, request correlation, trust boundary, cancellation, response envelope, and the /api HTTP bridge |
```

对应到目录结构：

```text
packages/typert/
├── protocol/    # 装饰器定义、Gateway 绑定、调用描述符的类型协议(共享,不做任何 TS 分析)
├── generator/   # 编译期:扫描 Host ts.Program,生成 Host/Client 产物
├── registry/    # 运行期:Host 侧的反射 + Zod schema 注册表
└── loader/      # 运行期:Host 侧插件加载时自动装载生成产物
```

`docs/api-gateway.md` 还给出了整条链路的分层：

```text
// docs/api-gateway.md:162
The API layers are organized as `remotes → gateway → connection → webserver`.
```

## 核心机制详解

### `@Remote` 与 `@RemoteScope`:两种不同的调用语义

`docs/api-gateway.md` 对两个装饰器的语义做了明确区分：

```text
// docs/api-gateway.md:9-13
`@Remote`/`@RemoteScope` — Business services use `@Remote` or `@RemoteScope` to
select the methods exposed to the Client. Unmarked methods do not enter the
generated Client types or runtime contributions and cannot be called through
`ctx.remote`.

`@Remote` denotes calling a Cordis service registered on the root Host
Context. Complex Host objects cannot cross the wire directly; the business
package must declare their association with a wire identity through
`TypertLookupMap` and register a default resolution provider with
`ctx.typert.lookups` at runtime. For example, an `Agent` parameter named
`agent` in the Host signature produces an `agentId` wire field...

`@RemoteScope(key)` first resolves an identity to a scoped Context through
`ctx.typert.contexts`, then obtains the service from that Context and invokes
the method. It applies when the method itself depends on scoped composition
and does not need to receive objects such as `Agent` explicitly.
```

用文档给出的示例代码来对照理解这两种语义：

```ts
// docs/api-gateway.md:17-54
export class GoalService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @Remote('create')
  createForClient(
    agent: Agent,
    request: CreateGoalRequest,
    signal: AbortSignal,
  ): CreateGoalResult {
    signal.throwIfAborted()
    return this.create(agent, request)
  }

  @RemoteScope('agent', 'current')
  currentForClient(): CreateGoalResult {
    return { accepted: true }
  }

  private create(_agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    return { accepted: request.objective.length > 0 }
  }
}
```

`createForClient` 用 `@Remote('create')`:方法签名里显式接收一个 `Agent` 类型的参数——这个复杂的 Host 内部对象不能直接跨越 wire 传输,所以生成器会把它翻译成一个"身份字段"(比如 `agentId`),Client 调用时传的是这个 id 字符串,Gateway 收到请求后再用注册在 `ctx.typert.lookups` 里的解析器,把 id 还原回真实的 `Agent` 对象,再传给方法。而 `currentForClient` 用 `@RemoteScope('agent', 'current')`:不需要把 `Agent` 作为显式参数接收,而是先靠某个身份(比如"当前 Agent")解析出一个**Scoped Context**,再从这个 Context 里取出服务实例、调用方法——适用于"方法本身依赖于某个作用域内的组合关系,而不需要显式接收 `Agent` 之类对象"的场景。

真实业务代码里,`@Remote` 被广泛使用——比如 `packages/feedback/message-feedback/src/index.ts` 里的 `MessageFeedbackService`：

```ts
// packages/feedback/message-feedback/src/index.ts:117-185(节选)
/** Session-log service; cold operations never construct a Session or Agent. */
export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['sessionPersistence', 'sessions']

  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageFeedback')
    // ...校验 maxNoteBytes 为正的安全整数...
    this.maxNoteBytes = config.maxNoteBytes
  }

  @Remote('list')
  list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult> {
    return this.enqueue(request.sessionId, () => this.withSession(request.sessionId, false, events =>
      success(Object.freeze({ items: Object.freeze(currentItems(request.sessionId, events).map(snapshotItem)) }))))
  }

  @Remote('put')
  put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult> {
    const note = this.resolveNote(request.note)
    if (!note.ok) return Promise.resolve(note)
    return this.enqueue(request.sessionId, () => this.withSession(request.sessionId, true, async (events, append) => {
      // ...检查目标 assistant/message 事件存在、做 ifVersion 乐观并发校验、
      // 幂等 no-op 保留版本且不追加事件...
    }))
  }
}
```

相比之下,`@RemoteScope` 目前在这个仓库里主要还停留在文档演示层面——`goal`/`message-feedback`/`commands` 等业务包里能找到大量 `@Remote` 的真实用例,但没有找到业务代码里实际使用 `@RemoteScope` 的例子。这提示 `@RemoteScope` 是为"方法依赖作用域组合关系"这一类场景预留的能力,当前业务代码的调用形态还没有走到需要它的复杂度。

装饰器本身的定义在 `packages/typert/protocol/src/index.ts` 里,是标准的 TC39 Stage 3 装饰器语法(`ClassMethodDecoratorContext`),内部靠一个 module-private 的 `WeakMap` 把标记信息挂到类原型上：

```ts
// packages/typert/protocol/src/index.ts:198-216
export function RemoteScope(
  key: Extract<keyof TypertContextMap, string>,
  exportName?: string,
): RemoteMethodDecorator {
  validateName('Scope key', key)
  if (exportName !== undefined) validateName('Remote export name', exportName)
  return function <This extends object, Args extends unknown[], Result>(
    _method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void {
    addMarkerInitializer(context, { kind: 'context', context: key }, exportName)
  }
}
```

装饰器本身"不启动任何 TypeScript 分析,不注册任何 Cordis 服务"——它只是在方法上打一个可被后续扫描识别的标记,真正的分析工作全部发生在下一节讲的 generator 里。

### 编译期扫描:`analyzer.ts` 怎么找到 `@Remote` 方法

Typert 的生成流程绑定在 tsdown 构建过程里:

```text
// docs/api-gateway.md:97
The root build runs `build:lib:host`, `build:lib:client`, and `build:web` in
order. The Host lib phase first runs `tsc -b tsconfig.host.json`, then
`tsdown --env.DSH_BUILD_FACE host`; the normal Host Project Reference graph
compiles the Typert generator, which runs during this tsdown pass with the
Host aggregate as its only `ts.Program` seed. The Client lib phase then runs
`tsc -b tsconfig.client.json` and `tsdown --env.DSH_BUILD_FACE client`,
consuming the newly generated Remote Client declarations and runtime
contributions without starting Typert again.
```

也就是说,Typert 只在编译 Host 那一次运行,拿到完整的 `ts.Program` 作为分析入口;Client 那一次编译只是消费上一步已经生成好的产物,不会重复跑分析。真正识别 `@Remote`/`@RemoteScope` 装饰器的核心逻辑在 `packages/typert/generator/src/analyzer.ts` 的 `remoteMarker()` 方法里,用 TS Compiler API 检查每个类成员上的装饰器表达式：

```ts
// packages/typert/generator/src/analyzer.ts:1321-1380(节选,当前版本比课程原写作时多了一段专门解析 `mode: 'stream'` 选项对象的分支)
private remoteMarker(member: ts.ClassElement) {
  let found: ...
  for (const decorator of ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : []) {
    const expression = decorator.expression
    let marker: typeof found
    if (this.isTypeMetaSymbol(expression, 'Remote')) {
      marker = { kind: 'direct' }
    } else if (ts.isCallExpression(expression)
      && this.isTypeMetaSymbol(expression.expression, 'Remote')) {
      if (expression.arguments.length !== 1) this.fail(expression, 'Remote() requires one name or options object')
      const argument = expression.arguments[0]
      if (argument === undefined) this.fail(expression, 'Remote() requires one name or options object')
      const exportName = stringLiteralValue(argument)
      if (exportName !== undefined) {
        if (!isRemoteSegment(exportName)) this.fail(argument, 'Remote() name must contain only RPC endpoint segment characters')
        marker = { kind: 'direct', exportName }
      } else {
        // 参数不是字符串字面量,就必须是形如 `{ mode: 'stream' }` 的选项对象——
        // 严格要求"只有这一个属性、属性名是 mode、值只能是字符串字面量 'stream'"
        if (!ts.isObjectLiteralExpression(argument) || argument.properties.length !== 1) {
          this.fail(argument, 'Remote() options must contain exactly mode: "stream"')
        }
        const [property] = argument.properties
        const mode = ts.isPropertyAssignment(property) && memberName(property.name) === 'mode'
          ? stringLiteralValue(property.initializer)
          : undefined
        if (mode !== 'stream') this.fail(property, 'Remote() options must contain exactly mode: "stream"')
        marker = { kind: 'direct', mode }
      }
    } else if (ts.isCallExpression(expression)
      && this.isTypeMetaSymbol(expression.expression, 'RemoteScope')) {
      // ...解析 RemoteScope(context, exportName?) 的参数
      marker = { kind: 'context', context, ...exportName === undefined ? {} : { exportName } }
    } else {
      continue
    }
    if (found !== undefined) this.fail(decorator, 'a method can have only one Remote invocation decorator')
    found = marker
  }
  return found
}
```

`@Remote({ mode: 'stream' })` 是这次架构收敛新增的第三种调用形态——它和 `@Remote('name')` 共享同一个 `kind: 'direct'` 标记(都是"直接从根 Context 拿服务实例"这条语义),只是多带一个 `mode: 'stream'` 字段,告诉后续的生成器和 Gateway"这个方法返回的是一个 `AsyncIterable`,要按流式帧转发,而不是等它 resolve 出一个值再一次性返回"。这里能看到几个"严格分析"的约束落地:装饰器参数必须是字符串字面量或者形如 `{ mode: 'stream' }` 的选项对象,不接受别的形状;同一个方法上不能同时出现两个 Remote 相关装饰器。扫描的入口 `collectInvocations()` 遍历每个可达源文件里的每个类声明,逐方法调用 `remoteMarker()`,一旦发现方法被标记就进一步校验它必须是`public`、非 `static`、有实现体、非泛型：

```ts
// packages/typert/generator/src/analyzer.ts:1032-1063(节选,行号随文件从约 1260 行增长到 3285 行而整体后移,逻辑本身未变)
private collectInvocations(registration, reachable) {
  const result: InvocationModel[] = []
  for (const sourceFile of reachable) {
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement)) continue
      const marked = statement.members.flatMap((member) => {
        const invocation = this.remoteMarker(member)
        if (invocation === undefined) return []
        if (!ts.isMethodDeclaration(member)) {
          this.fail(member, 'Remote decorators require a public instance method')
        }
        return [{ method: member, invocation }]
      })
      const first = marked[0]
      if (first === undefined) continue
      const binding = this.gatewayBinding(statement)
      if (binding === undefined) {
        this.fail(first.method, 'Remote methods require TypertRemoteService or readonly typertGateway = bindTypertRemote(this, serviceKey)')
      }
      for (const { method, invocation } of marked) {
        result.push(this.invocationModel(registration, binding, method, invocation))
      }
    }
  }
  return result
}
```

扫描完成后,生成器会产出五份文件,分别服务于 Host 侧运行时反射、Host 侧类型系统、Client 侧运行时挂载、Client 侧类型系统、以及编辑器的"跳转到定义"：

```text
// docs/api-gateway.md:105-111
| File | Consumer | Contents |
|---|---|---|
| typert.host.js | Host Loader | Runtime reflection for the Host face, strict invocation descriptors, and schema registration values |
| typert.host.d.ts | Host type system | Generated declarations for the Host face |
| typert.remote-client.js | api-remotes | A mountable TypertRemoteContribution containing strict descriptors and runtime codecs |
| typert.remote-client.d.ts | Client type system | Declaration merges for TypertRemoteNamespaceMap and TypertRemoteScopeMap, plus Client-safe type references |
| typert.remote-client.d.ts.map | Editor | Maps generated method properties back to Remote method declarations in the Host package |
```

### 运行时反射与 Zod schema 注册表

`packages/typert/registry` 是运行期在 Host 侧承接生成产物的地方。核心类 `TypertRegistry` 通过 `register()` 方法原子地注册一个包的 schema、反射信息和调用描述符,借助 Cordis 的 `ctx.effect` 让整批注册跟随插件生命周期一起撤销：

```ts
// packages/typert/registry/src/service.ts:500-521(行号后移,逻辑与两处 /* v8 ignore else */ 覆盖率注释外的内容完全一致)
register(contribution: TypertContribution): TypertDisposer {
  const packageRecord = this.validatePackage(contribution)
  const schemaRecords = this.validateSchemas(contribution)
  const invocations = contribution.invocations
  this.localStore.validate(invocations)
  const owner = {}
  const { schemas, packages, localStore } = this
  return this.ctx.effect(function* () {
    packages.set(packageRecord.key, packageRecord)
    for (const record of schemaRecords) schemas.set(record.key, record)
    localStore.commit(owner, invocations)
    yield () => {
      if (packages.get(packageRecord.key) === packageRecord) packages.delete(packageRecord.key)
      for (const record of schemaRecords) {
        if (schemas.get(record.key) === record) schemas.delete(record.key)
      }
      localStore.withdraw(owner, invocations)
    }
  }, 'typert.register()')
}
```

`toJSONSchema()` 把注册进来的 Zod schema 投影成标准 JSON Schema,供请求/返回值校验之外的场景复用：

```ts
// packages/typert/registry/src/service.ts:589-590
toJSONSchema(key: string, params?: z.core.ToJSONSchemaParams) {
  return z.toJSONSchema(this.resolve(key).schema, params)
}
```

而 `packages/typert/loader` 是把这些生成产物真正"装进" Host 运行时的那一层——它监听 Cordis 的插件加载/卸载事件,当一个插件包挂载时,自动 `import()` 该包导出的 `./typert` 子路径(也就是生成器产出的 `typert.host.js`),校验其 `TYPERT` manifest 结构后调用 `ctx.typert.register(manifest)`;插件卸载时同步撤销注册。它本身"不做任何 TS 分析或 schema 生成",纯粹是运行期的装载胶水。

### Gateway:两个装饰器最终怎么变成一次真实调用

`packages/api/gateway` 里的 `TypertGatewayService` 是编译期产物在运行期真正发挥作用的地方。它在 Connection 层拦截 `/api` 路径下的请求：

```ts
// packages/api/gateway/src/index.ts:197-261(节选,构造函数现在同时挂载了两条通路)
export class TypertGatewayService extends Service implements TypertGateway {
  static inject = ['typert']

  /** Carrier adapter shared by the WebSocket mux and local Host transports. */
  readonly wireStream: TypertGatewayWireStream = {
    open: (endpoint, payload, uplink, peer, signal) =>
      this.openWireStream(endpoint, payload, uplink, peer, signal, new AbortController()),
    failure: error => rpcError(error),
  }

  private srcClaims: ReadonlySet<string> | undefined
  private remoteEvents: RegisteredRemoteEventSource | undefined
  private readonly remoteEventClients = new Map<RemoteEventClientId, RemoteEventClient>()
  // ...

  constructor(ctx: Context, config: Config) {
    super(ctx, 'typertGateway')
    ctx.inject(['connection'], (connectionCtx) => {
      connectionCtx.connection.rpc.intercept(
        '/api',
        endpoint => this.claimsEndpoint(endpoint),
        (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer),
      )
    })
    ctx.inject(['connection', 'webServer'], (webCtx) => {
      // 单独开一条 WebSocket upgrade 路由,承载所有 `mode: 'stream'` 的 Remote 方法
      const mux = new RemoteStreamMuxServer(
        (endpoint, payload, uplink, peer, control) =>
          this.openWireStream(endpoint, payload, uplink, peer, control.signal, control),
        this.wireStream.failure,
        resolved.websocketHeartbeatIntervalMs,
        resolved.streamInboxBytes,
      )
      // ...把 mux 挂到 REMOTE_STREAM_MUX_PATH('/api/remote.mux')这个 WebUpgradeRoute 上...
    })
  }
```

普通的一问一答调用走 `/api` 这条 HTTP intercept 路径;而流式 Remote 方法(`mode: 'stream'`)现在直接是 Gateway 自己内建的一条 WebSocket 通路——`RemoteStreamMuxServer`,不再是课程更早版本描述的那套独立于 Typert 之外、挂在 `packages/host/apiproxy` 里的 `FrameQueue`/`mux()`/`WebSocketDownlinks` 三件套(那几个类和它们所在的包已经不存在了)。真正执行一次调用的逻辑被拆成了两半:`prepareInvocation()` 负责"解析描述符 → 校验参数 → 解析身份/Context → 构造 invocation(含 uplink)→ 找到可调用的方法",`invokePrepared()`(一问一答)和 `openStream()`(流式)各自只负责按 `descriptor.mode` 分流调用:

```ts
// packages/api/gateway/src/index.ts:672-725(节选)——prepareInvocation():两条路径共用的准备阶段
private async prepareInvocation(request, control): Promise<PreparedInvocation> {
  const endpoint = endpointOf(request.namespace, request.method)
  const descriptor = this.resolveDescriptor(request.namespace, request.method, endpoint)
  assertExactArguments(request.args, descriptor, endpoint)
  const receiverContext = await this.resolveReceiverContext(descriptor, request.args, endpoint)
  const receiver: unknown = receiverContext.get(descriptor.service)
  // ...校验 receiver 存在、校验 binding...
  const args = await Promise.all(descriptor.parameters.map(parameter =>
    this.resolveParameter(parameter, request.args, endpoint)))
  const signal = methodSignal(request, control)
  // 为这次调用构造一个 invocation:它携带 Client 上行流(uplink)的
  // 数据源和校验 codec,还会被挂进 receiverContext
  const invocation = new GatewayInvocation(
    { namespace: request.namespace, method: request.method, args: request.args },
    descriptor.service,
    request.peer ?? this.operatorPeer(),
    signal,
    {
      source: request.uplink ?? EMPTY_ASYNC_ITERABLE,
      codec: descriptor.uplink?.codec ?? SRC_JSON_CODEC,
      endpoint,
      abort: (reason) => { control.abort(reason) },
    },
  )
  if (descriptor.cancellation !== undefined) args.push(signal)
  // 方法运行在一个绑定了"本次调用"的 Service 视图上:Cordis 会把
  // this.ctx 重绑到访问方 Context,所以方法内读到的 this.ctx.invocation
  // 就是这次调用,而不需要把任何 per-call 状态塞进参数列表
  const callReceiver = receiverContext.extend({ invocation }).get(descriptor.service) as object
  const implementation = descriptor.implementation ?? descriptor.method
  const method: unknown = Reflect.get(callReceiver, implementation)
  // ...校验 method 是函数...
  return { endpoint, descriptor, receiver: callReceiver, args, method: ..., invocation }
}
```

```ts
// packages/api/gateway/src/index.ts:331-395(节选)——invoke()/openStream() 按 mode 互斥分流
async invoke(request: InvokeRemoteRequest): Promise<unknown> {
  return this.invokePrepared(await this.prepareInvocation(request, new AbortController()))
}

private async invokePrepared(prepared: PreparedInvocation): Promise<unknown> {
  if (prepared.descriptor.mode !== undefined) {
    throw new TypertGatewayError('gateway/signature-invalid', prepared.endpoint,
      'stream Remote methods must be opened through the stream carrier')
  }
  try {
    return await Reflect.apply(prepared.method, prepared.receiver, prepared.args) as unknown
  } finally {
    // A unary call's uplink is readable only while the method runs.
    await prepared.invocation.close()
  }
}

private async openStream(request, control): Promise<AsyncIterable<unknown>> {
  const prepared = await this.prepareInvocation(request, control)
  if (prepared.descriptor.mode === undefined) {
    await prepared.invocation.close()
    throw new TypertGatewayError('gateway/signature-invalid', prepared.endpoint,
      'unary Remote methods cannot be opened through the stream carrier')
  }
  // ...校验 prepared.method 返回的是 Iterable/AsyncIterable(否则 gateway/result-invalid),
  // 再把它接到 wire stream 上返回...
}
```

`resolveReceiverContext` 这一步依然是 `@Remote` 和 `@RemoteScope` 两种语义分叉的地方:前者直接从根 Context 拿服务实例,后者先经过 `ctx.typert.contexts` 解析出 Scoped Context 再取服务。而 `Reflect.get`/`Reflect.apply` 这两行,依然是"编译期生成的描述符"最终变成"运行期真实方法调用"的落点——描述符里记录的 `service`/`implementation` 字段告诉 Gateway 该去哪个服务、调哪个方法,而不需要为每个 Remote 方法手写一段 dispatch 代码。互斥校验(`invokePrepared()` 拒绝 `mode !== undefined` 的流式描述符,`openStream()` 拒绝 `mode === undefined` 的一问一答描述符,两条路都先保证 `invocation.close()` 被正确执行)保证了"这个方法到底是一问一答还是持续推流"这件事,在编译期由装饰器决定、在运行期由 Gateway 强制,调用方不可能张冠李戴。

`prepareInvocation()` 里新出现的 `GatewayInvocation` 及其 `source: request.uplink`/`codec` 两个字段,是在 2026 年 9 月的 remote-duplex-stream(#4648)之后整条链路新增的能力:**流式 Remote 方法不再只能单向地"Host 推给 Client",Client 还可以沿同一条逻辑流反向送数据**。这个反向通道在类型层的落点是 `RemoteStream<Out, In>` 的两个类型参数——Host 方法返回的值带一个 `STREAM_UPLINK` 类型级标记,声明"我读哪种 uplink item";生成的 Client 方法返回的 `RemoteStreamHandle` 则在这份声明上长出三个方法：

```ts
// packages/typert/protocol/src/types.ts:106-127(节选)
export interface RemoteStreamHandle<Out, In> extends AsyncIterable<Out> {
  /** Send one uplink item. Items sent before the stream has opened are queued... */
  send(item: In): void
  /** Half-close the uplink: the Host's `uplink()` iteration ends. Idempotent... */
  end(): void
  /** Cancel the logical stream: send `cancel` unless a terminal frame has arrived... */
  dispose(): void
}
```

Host 方法侧则把这条反向流读成 `AsyncIterable<In>`——靠的正是上面 `receiverContext.extend({ invocation })` 这行:方法执行期间 `this.ctx.invocation.uplink<In>()` 就是这次调用的上行流,uplink 既不进 `args` 也不参进参数列表。`<In>` 类型不是装饰用的:分析器为一个流式方法建模返回类型时,会同时抽出 `result` 和 `uplink` 两个边界(`analyzer.ts:1201` 的 `remoteResultType(method, mode)` 返回 `{ result, uplink }`,uplink 的边界为 `...:uplink` 单独生成),Gateway 在运行期用生成的 `descriptor.uplink.codec` 逐条校验 Client 送上来的每一项——毕竟它来自浏览器。`docs/api-gateway.md:58` 把这套契约浓缩成一句话:

```text
// docs/api-gateway.md:58(节选)
`@Remote({ mode: 'stream' })` marks a method that returns `Iterable`,
`AsyncIterable`, or `RemoteStream<Out, In>`: the Gateway delivers each
yielded item... over its multiplexed `/api/remote.mux` WebSocket or an
in-process carrier, and the generated Client method returns a
`RemoteStreamHandle<Out, In>` that iterates the items and exposes `send`,
`end`, and `dispose` for the Client-to-Host uplink of the same logical
stream. The second type argument of `RemoteStream<Out, In>` declares the
uplink item type; the Gateway validates each item the Client sends, because
it arrives from the browser, with the generated `In` codec before the Host
method reads it through `this.ctx.invocation.uplink<In>()`. The uplink
enters neither `args` nor the parameter list...
```

Client 侧对称地消费同一份生成产物,`ctx.remote.<namespace>.<method>()` 这样的调用最终落到 Connection 的 RPC 层：

```text
// docs/api-gateway.md:121
The Client Remote calls `connection.rpc.call('/api', '<namespace>/<method>', { args }, signal)`;
the HTTP carrier maps this to `POST /api/<namespace>/<method>`, with a payload
containing only a named `args` object.
```

### Gateway 与 Connection 的分层:API Proxy 已经退场

课程更早期版本在这里讲的是"Typert Gateway 与旧有 API Proxy 按 endpoint 分流共存"——那段历史已经翻篇了。承载 API Proxy 的 `packages/host/apiproxy` 包被整体删除(连同 `packages/client/connection/src/websocket-downlink.ts`),`docs/api-gateway.md` 里"unclaimed requests fall back to the existing API Proxy"这句话也换成了新的收尾：

```text
// docs/api-gateway.md:126-127(节选)
The Typert Gateway claims only two-segment endpoints that have a strict
descriptor or active SRC marker; it projects binary Remote fields into
JSON-compatible metadata and result-relative byte attachments, which
Connection frames as multipart responses. Feature-owned exact Fetch routes
handle responses outside the RPC envelope, and other requests return 404.
Connection owns transport, RPC ids, response envelopes, and request
cancellation, while Gateway owns the Remote data protocol and business
dispatch.
```

也就是说,"判断一个请求走哪条路径"的规则还在(两段式 endpoint + 严格描述符 → Gateway),但"找不到就落回旧的 API Proxy"这条逃生通道没有了——未被认领的请求要么命中某个特性包自己在 Connection 上注册的**精确 Fetch 路由**(用于 RPC envelope 之外的响应,比如某个直接吐文件的下载端点),要么直接 404。同一句话里还藏着一个新增职责:Gateway 现在负责把二进制 Remote 结果(`Uint8Array` 字段,比如读到的工作区文件内容)投影成"JSON 兼容的 metadata + 结果相对路径的字节附件",由 Connection 打包成 multipart 响应发回——二进制不再需要先转 base64 挤进 JSON。"逐端点逐步覆盖"的迁移期也随之结束了:现有的 Host↔Client 业务调用全部走 Typert,已经没有需要"新旧分流"的对象。

### 平行的另一条链路:会话事件怎么被推给浏览器(收敛进流式 Remote)

Typert 处理的是"Client 主动发起一次调用,等 Host 返回结果"这种单请求单响应模式。但 dsh 还有另一类完全不同的通信需求——Host 侧持续产生的会话事件(模型的流式输出、工具调用、审批请求)需要被**主动推送**给浏览器。课程更早期版本里,这条推送链路是一套独立于 Typert 之外的手工协议(`packages/host/apiproxy` 的 `FrameQueue` + `events.mux()`、`packages/client/connection` 的 `WebSocketDownlinks`)。随着 `mode: 'stream'` 这轮 remote-stream 统一(含 #4648 的 remote duplex stream 及配套的 Gateway uplink/`RemoteStreamHandle` 工作)落地,这套三件套连同整个 `apiproxy` 包一起被删除,推送被收敛进 Typert 本身——会话事件流现在就是**两个 `mode: 'stream'` 的 Remote 方法**:

```ts
// packages/api/session-controller/src/index.ts:136,455-463,501-503(节选)
export class SessionController extends TypertRemoteService {
  // ...
  constructor(ctx, config, internals = {}) {
    super(ctx, 'sessionController', { namespace: 'session' })
    // ...
  }

  /** Follow one Session log from its opening or resume cursor. */
  @Remote({ mode: 'stream' })
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    return this.history.follow(request, signal)
  }

  /** Stream a complete live-control baseline followed by replacement frames. */
  @Remote({ mode: 'stream' })
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    return this.controlState.control(signal)
  }
}
```

但这不意味着那句话过时了——`docs/api-gateway.md` 对会话事件的边界声明还原文摆着,只是要读准它的精确含义：

```text
// docs/api-gateway.md:161(节选)
Session event streams, pagination, incremental reduce, projection, and
entity substreams still require a separate data protocol and registration
model; even when they reuse the Connection, they must not masquerade as
Remote methods or enter invocation descriptors.
```

"separate data protocol"指的不是"另一套推送协议",而是**流内部的 frame 词汇表**——会话事件没有被拆成 `session/assistant-chunk`、`session/tool-call` 这样一群细粒度 Remote 方法(那样每个事件类型都要进描述符表,正是"must not masquerade"要避免的);真正的做法是把事件流收敛成**一个**流式 Remote(`session/follow`),流里逐条送行的 `snapshot`/records/`assistant-stream` 是这个 frame 数据协议的内容,不进调用描述符。

`follow()` 的实现本身也回应了旧 `FrameQueue` 设计的两个软肋("连接后订阅,错过就没有补救"/"快照与增量由两套机制拼出来")。它的订阅结构和旧 `mux()` 相似(全局监听 `session/event` 和 `session/created`),但语义是 journal 化的——先送一个完整快照帧,再以逐 seq 校验的增量帧断点续接：

```ts
// packages/api/session-controller/src/history.ts:119-165,179-234(节选)
async *follow(request, signal): AsyncIterable<SessionFollowFrame> {
  validateFollowRequest(request)
  // 每条跟随一个 Deque:事件先全部进缓冲,异步快照源准备好之后统一回放
  const buffered = new Deque<
    | { readonly type: 'event'; readonly event: SessionEvent }
    | { readonly type: 'assistant-stream'; readonly frame: ..., readonly ordinal: number }
  >()
  const disposeEvent = this.ctx.on('session/event', (session, event) => {
    if (session.id !== target) return
    buffered.pushBack({ type: 'event', event })
    notify()
  }, { global: true })
  const disposeCreated = this.ctx.on('session/created', (session) => {
    if (session.id !== target) return
    // 冷 session 打开时的构造种子事件没有 session/event 通知,这里按快照游标补播
  }, { global: true })
  // request.assistantStream === true 时再订阅 'agent/assistant-stream'(可选的增量流)
  try {
    using source = await this.sourceFor(address, signal, true)
    // 永远先送一帧完整快照:header + cursor + records + hasMore + projections + assistantStream 基线
    yield {
      type: 'snapshot',
      header: wireHeader(source.header),
      cursor,
      records: pageRecords(page.events),
      hasMore: page.hasMore,
      // ...projections、opt-in 的 assistantStream 基线...
    }
    // 之后从 Deque 逐条回放 durable 事件,并以 seq 连续性做围墙
    while (!follower.closed && !signal.aborted) {
      const item = buffered.popFront()
      if (item === undefined) { await new Promise<void>((resolve) => { wake = resolve }); continue }
      if (item.type === 'assistant-stream') { /* ordinal 水位线之内的丢弃,之外的送出 */ continue }
      const expectedSeq = SessionSeq(nextOffset)
      if (item.event.seq < expectedSeq) continue
      if (item.event.seq !== expectedSeq) {
        throw new RemoteError('gateway/internal', `session event stream skipped seq ${String(expectedSeq)}`, {})
      }
      nextOffset = SessionLogOffset(nextOffset + 1)
      yield entryFor(item.event)
    }
  } finally {
    this.closeFollowers.delete(close)
    signal.removeEventListener('abort', onAbort)
  }
}
```

订阅"session 集合层面"的元事件(哪个 session 新建了、进入/离开 running、有了动静),走的不是单 session 的 `follow` 流,而是 Typert 的远程事件机制——`SessionController` 以 `{ namespace: 'session' }` 注册,声明了五种远程事件：

```ts
// packages/api/session-controller/src/remote-events.ts:2-11(节选)
type SessionControllerRemoteEvent =
  | 'api-session/activity'
  | 'api-session/added'
  | 'api-session/error'
  | 'api-session/removed'
  | 'api-session/status'
```

Client 侧对称地订阅同一个命名空间：

```ts
// packages/api/session-controller/src/client/index.ts:116-124(节选)
ctx.remote.$on('api-session/added', (summary) => { sessions.handleSessionAdded(summary) })
ctx.remote.$on('api-session/removed', (sessionId) => { sessions.handleSessionRemoved(sessionId) })
ctx.remote.$on('api-session/status', (sessionId, running) => { /* ... */ })
ctx.remote.$on('api-session/activity', (sessionId, updatedAt) => { /* ... */ })
ctx.remote.$on('api-session/error', (sessionId, message) => { /* ... */ })
```

Client 也不是裸着消费 `session/follow` 的原始 frame——`@deepseek-ai/dsh-api-gateway/client` 导出的 `RemoteJournalStream` 基类把"opening snapshot + 逐条增量 + 游标续接 + 缺口检测"做成了可复用骨架,`packages/api/session-controller/src/client/transport.ts` 的 `SessionEventStream` 继承它,调那个生成的流式 Remote 方法(拿到 `RemoteStreamHandle`),把 frame 译成 `SessionJournalChange` 喂给会话状态：

```ts
// packages/api/session-controller/src/client/transport.ts:137-200(节选)
export class SessionEventStream extends RemoteJournalStream<
  SessionJournalPage, SessionHistoryRecord, number, ClientSessionPageRequest, SessionAssistantStreamFrame
> {
  // 游标就是 durable event 的 seq(起点 emptyCursor: -1);相邻判据是 follows: right === left + 1
  protected override async * follow(request, signal) {
    for await (const frame of this.remote.session.follow({
      address: this.address,
      assistantStream: true,
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
    }, signal)) {
      if (frame.type === 'snapshot') {
        // 快照帧翻译成一个 'opened' journal 帧:cursor + records + hasMore + projections
        yield { type: 'opened', cursor: frame.cursor, page: { records: frame.records, hasMore: frame.hasMore, ... } }
      }
      // ...
    }
  }
}
```

物理通道还是上一节构造函数里那条 `/api/remote.mux` WebSocket(`RemoteStreamMuxServer`),但协议的组法已经和一问一答完全同构:每个流式 Remote 调用在 mux 上开一条逻辑流、按描述符校验、带 codec、带取消。不再存在"第二条、让 Typert 管不着的推送协议"。

### 前后呼应:`assistant/chunk` 事件的完整旅程

第 04 章讲过 dsh 会话事件流里的 `assistant/chunk` 事件——LLM 流式返回的每一段增量都会被记录成一条会话事件。现在可以把这条事件从产生到出现在浏览器里的完整路径串起来:

```text
agent-loop 内部流式循环
  packages/core/agent-loop/src/agent.ts
    for await (const chunk of stream) {
      this.session.append('assistant/chunk', { turn, step, chunk })
    }

Session.append() 写日志并同步触发 Cordis 事件
  packages/core/session/src/index.ts
    this.log.push(event)
    invokeContainedSessionObservers(entry.emitCtx, 'session/event', ...)
    // 等价于 ctx.emit('session/event', session, event)

history.follow() 的 ctx.on('session/event') 监听器把它压进 Deque
  packages/api/session-controller/src/history.ts
    buffered.pushBack({ type: 'event', event }); notify()

follow 生成器从 Deque 弹出、做 seq 连续性检查、yield 成 frame
  (完整 snapshot 帧已在 follow 开头先送过,这里送的是后续 durable 增量帧)

Gateway 把它作为流式 Remote 的 stream item,由 openWireStream 送出
  RemoteStreamMuxServer 在 /api/remote.mux 这条 WebSocket 上逐帧序列化

Client 的 SessionEventStream(RemoteJournalStream)把 frame 译成 journal change
  publish(change) → 写入会话状态 → DOM 渲染出逐字打字的效果
```

第 04 章讲的"assistant/chunk 事件如何在会话日志里被追加",和本篇讲的"这条事件如何被推到浏览器里逐字打字",正好是同一条数据在两个不同抽象层次上的描述——前者关心事件本身的语义和持久化,后者关心这条事件如何跨越进程边界、跨越协议边界,最终变成浏览器里的一次 DOM 更新。值得强调的是这条路径现在有多"纯":推送链路**就是** `@Remote({ mode: 'stream' })` 声明出来的一个普通 Remote 方法,享受同一套描述符、同一套 codec 校验、同一套取消语义,只是它不 resolve 出一个值,而是持续送出 `AsyncIterable` 的每一项。`docs/api-gateway.md:161` 说的"separate data protocol"指的是这条流内部的 frame 词汇表(snapshot/records/assistant-stream),不是 Typert 之外的"另一套协议"。

## 常见问题/易踩坑

- **`@Remote` 和 `@RemoteScope` 该怎么选？** 如果方法需要接收一个复杂的 Host 内部对象(比如 `Agent`)作为参数,用 `@Remote`,让生成器把这个对象翻译成一个身份字段;如果方法本身依赖某种作用域组合关系、不需要显式接收这类对象,才考虑 `@RemoteScope`。从当前代码库的实际使用情况看,`@Remote` 是绝大多数场景的默认选择。
- **为什么 Typert 只在编译 Host 那一次运行，不在编译 Client 时重新扫描？** 因为 Remote 方法的"真相"只存在于 Host 侧的源码里,Client 侧编译只需要消费已经生成好的类型声明和运行时契约,没有必要也不应该重复分析。
- **一个 endpoint 请求如果没被 Typert 认领,会怎么样？** 会命中某个特性包自己在 Connection 上注册的精确 Fetch 路由(用于 RPC envelope 之外的响应),否则直接 404。旧的"落回 API Proxy"逃生舱口已经随 `packages/host/apiproxy` 的删除一起消失——现在所有 Host↔Client 业务调用都走 Typert 一条路。
- **会话事件流是不是也应该打上 `@Remote`?** 现在它就是——`SessionController` 的 `follow()`/`control()` 正是 `@Remote({ mode: 'stream' })` 方法,推送不再绕开 Typert。但细化到"每个事件类型一个方法"(`session/assistant-chunk` 之类)依然是错的:那样事件词汇表会挤进调用描述符表,正是 `docs/api-gateway.md` 说"must not masquerade as Remote methods"要避免的;正确形态就是现在这样——一个流式 Remote 方法,内部承载自己的 frame 数据协议。

## 小结

Typert 解决的核心问题是:把"Host 方法的真实签名"变成 Client 类型的唯一可信来源,靠编译期分析而不是运行期反射或手写胶水代码来保证两端类型一致。`@Remote`/`@RemoteScope` 装饰器只是在方法上打一个标记,真正的重活——分析类型图、生成 Host/Client 双份产物、在运行期把描述符接回真实的 Cordis 服务调用——分别由 `generator`(编译期)和 `registry`/`loader`/`gateway`(运行期)完成。而"会话事件推送"这条曾经的平行链路(`FrameQueue` → `mux()` → WebSocket),如今也已经被收敛进同一套体系:它是 `@Remote({ mode: 'stream' })` 的 `session/follow`/`session/control`,经 `RemoteStreamMuxServer` 在 `/api/remote.mux` 上逐帧传输,Client 侧由 `RemoteJournalStream` 骨架还原成"snapshot + 增量"的 journal 语义;`RemoteStream<Out, In>` 的双类型参数与 `RemoteStreamHandle` 的 `send`/`end`/`dispose` 还让 Client 可以沿同一条流反向给 Host 方法送数据(uplink,#4648)。Host↔Client 的全部通信——一问一答、持续推送、双向流——最终都统一在同一套"编译期契约 + 运行期描述符"的架构里。
