# Host/Client 分离与 Typert RPC 生成

> dsh 的 Web 前端要调用 Host 进程里的业务方法——创建一个目标、给一条消息打标注、暂停某个 Agent——如果这些调用手写客户端代码,每加一个方法就要在两端各写一遍类型、各写一遍序列化、各写一遍出错处理,而且没有任何机制保证两端类型不会跑偏。dsh 的答案是 Typert：一套在**编译期**扫描 Host 侧带 `@Remote`/`@RemoteScope` 装饰器的方法、生成 Client 端类型化调用契约的代码生成体系。本篇拆开这套生成流水线,并顺着"服务端事件怎么被推给浏览器"这条平行链路,和前面章节讲过的会话事件流做一次呼应。

## 学习目标

- 理解为什么 Host↔Client 之间需要在编译期生成 RPC 契约,而不是手写 API 客户端代码或者跑运行时反射。
- 掌握 `@Remote`/`@RemoteScope` 两个装饰器的语义差异,以及它们各自解决什么样的调用场景。
- 搞清楚 Typert 四个子包(`generator`/`registry`/`protocol`/`loader`)各自的职责边界,以及它们在构建期和运行期分别扮演什么角色。
- 理解 Typert Gateway 是如何和已有的 API Proxy 共存的——两者按 endpoint 是否有 Remote 描述符分流。
- 理解流式推送现在也被纳入了 Typert 本身——`@Remote({ mode: 'stream' })` 是和 `@Remote('name')`/`@RemoteScope` 并列的第三种调用形态,方法返回一个 `AsyncIterable`,由 Gateway 逐帧转发给 Client,不再需要一套独立于 Typert 之外的推送协议。
- 能把第 04 章讲过的会话事件流,和这里 `SessionController.follow()`/`control()` 这类流式 Remote 方法对应起来,理解事件从 agent-loop 内部一路走到浏览器的完整路径。

## 背景与设计动机

手写一个 RPC 客户端最大的问题不是工作量,而是**类型一致性无法被编译器保证**。Host 侧一个方法的参数改了名字或类型,Client 侧对应的调用代码不会自动报错——除非有一套机制,让"Host 方法的真实签名"成为 Client 类型的唯一来源。dsh 选择在**编译期**做这件事:用 TypeScript Compiler API 分析 Host 侧源码,找到所有标了 `@Remote`/`@RemoteScope` 的方法,生成一份 Client 能直接 `import` 的类型化调用契约。跑在 tsdown 构建流程内部的这套分析和生成逻辑,就是 Typert。

`docs/api-gateway.md` 用一张组件职责表说明了 Typert 生态里各部分的分工：

```text
// docs/api-gateway.md:82-91
| Location | Package or entry | Responsibility |
|---|---|---|
| Shared | @deepseek-ai/dsh-typert-protocol | Declares decorators, Gateway bindings, merge-extensible protocol maps, invocation descriptors, and provider types; starts no TypeScript analysis and registers no Cordis services |
| Build | @deepseek-ai/dsh-typert-generator | Strictly analyzes Remote signatures, the type graph, lookups, Contexts, and source locations from the Host ts.Program, then generates Host and Host-for-Client artifacts |
| Host | @deepseek-ai/dsh-typert-registry and Loader | Places generated Host descriptors, schemas, and business-package registrations in ctx.typert, and holds lookup and Context providers |
| Host | @deepseek-ai/dsh-api-remotes | Owns the application Agent/Session identity policy and configures the corresponding Typert lookups |
| Host | @deepseek-ai/dsh-api-gateway | Provides ctx.typertGateway, claims Remote endpoints, resolves objects or Contexts, invokes live Cordis services, and validates request and return values |
| Client | @deepseek-ai/dsh-api-gateway/client | Provides ctx.remote and remote.<namespace> child Services, mounts generated descriptors as concrete methods, and initiates, validates, and cancels calls through the Connection |
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
// packages/feedback/message-feedback/src/index.ts:150-206(节选)
export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions']

  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageFeedback')
    this.maxNoteBytes = resolveMaxNoteBytes(config.maxNoteBytes)
  }

  @Remote('list')
  async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult> {
    const known = await this.inspectSession(request.sessionId)
    if (!known.ok) return known
    const row = this.requireTable().get(request.sessionId)
    const items = row !== undefined && sameIdentity(row, known.value.meta) ? row.items : EMPTY_ITEMS
    return success(snapshotList(items))
  }

  @Remote('put')
  put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult> {
    // ...
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
// packages/typert/generator/src/analyzer.ts:1308-1349(节选,当前版本比课程原写作时多了一段专门解析 `mode: 'stream'` 选项对象的分支)
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
      const exportName = stringLiteralValue(argument)
      if (exportName !== undefined) {
        if (!isRemoteSegment(exportName)) this.fail(argument, 'Remote() name must contain only RPC endpoint segment characters')
        marker = { kind: 'direct', exportName }
      } else {
        // 参数不是字符串字面量,就必须是形如 `{ mode: 'stream' }` 的选项对象——
        // 严格要求"只有这一个 key、值只能是字符串字面量 'stream'"
        if (!ts.isObjectLiteralExpression(argument) || argument.properties.length !== 1) {
          this.fail(argument, 'Remote() options must contain exactly mode: "stream"')
        }
        // ...校验唯一属性名是 mode、值是字符串字面量 'stream'...
        marker = { kind: 'direct', mode: 'stream' }
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
// packages/typert/generator/src/analyzer.ts:1032-1063(节选,行号随文件从约 1260 行增长到 3236 行而整体后移,逻辑本身未变)
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
// packages/api/gateway/src/index.ts:169-204(节选,构造函数现在同时挂载了两条通路)
export class TypertGatewayService extends Service implements TypertGateway {
  static inject = ['typert']

  private srcClaims: ReadonlySet<string> | undefined
  private remoteEvents: RegisteredRemoteEventSource | undefined
  private readonly remoteEventClients = new Map<RemoteEventClientId, RemoteEventClient>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'typertGateway')
    ctx.inject(['connection'], (connectionCtx) => {
      connectionCtx.connection.rpc.intercept(
        '/api',
        endpoint => this.claimsEndpoint(endpoint),
        (endpoint, payload, signal) => this.dispatchRpc(endpoint, payload, signal),
      )
    })
    ctx.inject(['connection', 'webServer'], (webCtx) => {
      // 单独开一条 WebSocket upgrade 路由,承载所有 `mode: 'stream'` 的 Remote 方法
      const mux = new RemoteStreamMuxServer(
        (endpoint, payload, signal) => this.openWireStream(endpoint, payload, signal),
        this.wireStream.failure,
        resolved.websocketHeartbeatIntervalMs,
      )
      // ...把 mux 挂到 REMOTE_STREAM_MUX_PATH 这个 WebUpgradeRoute 上...
    })
  }
```

普通的一问一答调用走 `/api` 这条 HTTP intercept 路径;而流式 Remote 方法(`mode: 'stream'`)现在直接是 Gateway 自己内建的一条 WebSocket 通路——`RemoteStreamMuxServer`,不再是课程更早版本描述的那套独立于 Typert 之外、挂在 `packages/host/apiproxy` 里的 `FrameQueue`/`mux()`/`WebSocketDownlinks` 三件套(那几个类和它们所在的包已经不存在了)。真正执行一次调用的逻辑被拆成了两半:`prepareInvocation()` 负责"解析描述符 → 校验参数 → 解析身份/Context → 找到可调用的方法",`invoke()`(一问一答)和 `stream()`(流式)各自只负责按 `descriptor.mode` 分流调用:

```ts
// packages/api/gateway/src/index.ts:597-621(节选)——prepareInvocation():两条路径共用的准备阶段
private async prepareInvocation(request: InvokeRemoteRequest): Promise<PreparedInvocation> {
  const endpoint = endpointOf(request.namespace, request.method)
  const descriptor = this.resolveDescriptor(request.namespace, request.method, endpoint)
  assertExactArguments(request.args, descriptor, endpoint)
  const receiverContext = await this.resolveReceiverContext(descriptor, request.args, endpoint)
  const receiver = receiverContext.get(descriptor.service) as unknown
  // ...校验 receiver 存在、校验 binding...
  const args = await Promise.all(descriptor.parameters.map(parameter =>
    this.resolveParameter(parameter, request.args, endpoint)))
  if (descriptor.cancellation !== undefined) args.push(request.signal ?? NEVER_ABORTED_SIGNAL)
  const implementation = descriptor.implementation ?? descriptor.method
  const method = Reflect.get(receiver, implementation) as unknown
  // ...校验 method 是函数...
  return { endpoint, descriptor, receiver, args, method: method as (...args: never[]) => unknown }
}
```

```ts
// packages/api/gateway/src/index.ts:298-330(节选)——invoke() 和 stream() 按 mode 互斥分流
async invoke(request: InvokeRemoteRequest): Promise<unknown> {
  const prepared = await this.prepareInvocation(request)
  if (prepared.descriptor.mode === 'stream') {
    throw new TypertGatewayError('gateway/signature-invalid', prepared.endpoint,
      'stream Remote methods must be opened through the stream carrier')
  }
  return await Reflect.apply(prepared.method, prepared.receiver, prepared.args) as unknown
}

async stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>> {
  const prepared = await this.prepareInvocation(request)
  if (prepared.descriptor.mode !== 'stream') {
    throw new TypertGatewayError('gateway/signature-invalid', prepared.endpoint,
      'unary Remote methods cannot be opened through the stream carrier')
  }
  // ...把 prepared.method 返回的 AsyncIterable 接到 wire stream 上...
}
```

`resolveReceiverContext` 这一步依然是 `@Remote` 和 `@RemoteScope` 两种语义分叉的地方:前者直接从根 Context 拿服务实例,后者先经过 `ctx.typert.contexts` 解析出 Scoped Context 再取服务。而 `Reflect.get`/`Reflect.apply` 这两行,依然是"编译期生成的描述符"最终变成"运行期真实方法调用"的落点——描述符里记录的 `service`/`implementation` 字段告诉 Gateway 该去哪个服务、调哪个方法,而不需要为每个 Remote 方法手写一段 dispatch 代码。互斥校验(`invoke()` 拒绝 `mode: 'stream'` 描述符,`stream()` 拒绝非流式描述符)保证了"这个方法到底是一问一答还是持续推流"这件事,在编译期由装饰器决定、在运行期由 Gateway 强制,调用方不可能张冠李戴。

Client 侧对称地消费同一份生成产物,`ctx.remote.<namespace>.<method>()` 这样的调用最终落到 Connection 的 RPC 层：

```text
// docs/api-gateway.md:121
The Client Remote calls `connection.rpc.call('/api', '<namespace>/<method>', { args }, signal)`;
the HTTP carrier maps this to `POST /api/<namespace>/<method>`, with a payload
containing only a named `args` object.
```

### Typert Gateway 与旧有 API Proxy 的分流共存

Typert 不是把整个 Host↔Client 通信推倒重来,而是作为一层新的、更类型安全的调用路径,和已经存在的 API Proxy 并存：

```text
// docs/api-gateway.md:123
The Typert Gateway claims only two-segment endpoints that have a strict
descriptor or active SRC marker; unclaimed requests fall back to the existing
API Proxy. The Connection owns transport, RPC ids, response envelopes, and
request cancellation, while the Gateway owns only the Remote data protocol
and business dispatch.
```

也就是说,判断一个请求走哪条路径的依据很简单——这个 endpoint 是不是"两段式"(`<namespace>/<method>`)并且能在生成的描述符表里找到:能找到就交给 Typert Gateway 处理,找不到就落回旧的 API Proxy。这种"新旧路径按 endpoint 特征分流"的策略,让 Typert 可以逐步覆盖越来越多的 Host 方法,而不需要一次性重写所有既有的 API Proxy 端点。

### 平行的另一条链路:会话事件怎么被推给浏览器

Typert 处理的是"Client 主动发起一次调用,等 Host 返回结果"这种单请求单响应模式。但 dsh 还有另一类完全不同的通信需求——Host 侧持续产生的会话事件(模型的流式输出、工具调用、审批请求)需要被**主动推送**给浏览器。`docs/api-gateway.md` 特意划清了这条边界：

```text
// docs/api-gateway.md(节选)
Session events, incremental data, and other streaming protocols are outside
this document's scope... even when they reuse the Connection, they must not
masquerade as Remote methods or enter invocation descriptors.
```

这条推送链路的起点是 `packages/host/apiproxy/src/api-proxy.ts` 里的 `FrameQueue`——一个简单的异步队列:核心逻辑往里 `push`,`AsyncIterable` 消费方往外 `iterate`：

```ts
// packages/host/apiproxy/src/api-proxy.ts:413-445
class FrameQueue<F> {
  private buffer: F[] = []
  private waiter: (() => void) | undefined
  private done = false

  push(item: F): void {
    if (this.done) return
    this.buffer.push(item)
    this.waiter?.()
  }

  end(): void {
    this.done = true
    this.waiter?.()
  }

  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<F> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        while (this.buffer.length > 0) yield this.buffer.shift() as F
        if (this.done || signal.aborted) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      cleanup()
    }
  }
}
```

`EventsApi.events.mux(request, signal)` 方法把这个队列跟真实的 Cordis 事件订阅接起来——为每个连接新建一个 `FrameQueue`,推送订阅基线帧,再监听 `session/event` 等事件,把新事件不断 `push` 进队列,最终把 `queue.iterate(signal, cleanup)` 作为返回值交给调用方：

```ts
// packages/host/apiproxy/src/api-proxy.ts:3429-3532(节选)
mux(_request, signal) {
  const queue = new FrameQueue<RpcRequest<MuxFrame>>()
  muxQueues.add(queue)
  for (const session of ctx.sessions.list()) {
    subscribeSession(queue, session)
  }
  const disposers = [
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type === 'tool/call') { /* ... */ }
      else if (event.type === 'turn/end') { openCalls.delete(session.id) }
      const view = viewFor(ctx, event, callId => openCalls.get(session.id)?.get(callId) ?? backscanArgs(session.events, callId), ctx.agents.get(session.id))
      queue.push(frame({ type: 'session/event', sessionId: session.id, event, ...view === undefined ? {} : { view } }))
    }),
    ctx.on('session/created', (session: Session) => { /* ... */ }),
    ctx.on('session/disposed', (session: Session) => { /* ... */ }),
  ]
  return queue.iterate(signal, () => {
    muxQueues.delete(queue)
    for (const dispose of disposers) dispose()
  })
},
```

`packages/client/connection/src/websocket-downlink.ts` 的 `WebSocketDownlinks` 类是这条链路在 WebSocket 侧的终点。`handleMux()` 在 WS upgrade 完成后直接调用上面的 `events.mux(...)`,拿到那个 `AsyncIterable`,然后用一个 `pump()` 循环逐帧消费、逐帧推给浏览器：

```ts
// packages/client/connection/src/websocket-downlink.ts:112-152(节选)
handleMux(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  this.upgrade(req, socket, head, signal => this.api.events.mux({
    rpcId: RpcId(randomUUID()),
    payload: {},
  }, signal))
}

private async pump<F extends Frame>(
  socket: WebSocket,
  frames: AsyncIterable<RpcRequest<F>>,
  abort: AbortController,
): Promise<void> {
  try {
    for await (const frame of frames) await send(socket, frame)
  } catch (error) {
    if (!abort.signal.aborted) {
      try { await send(socket, failureFrame(error)) } catch { /* socket 已经丢了 */ }
    }
  } finally {
    abort.abort()
    if (socket.readyState === WebSocket.OPEN) socket.close()
  }
}
```

`send()` 把每一帧包装成一个 `ServerRequest` 结构(`{ type: 'server-request', rpcId, method: frame.payload.type, payload }`),用原生 `socket.send(JSON.stringify(...))` 发出去：

```ts
// packages/client/connection/src/websocket-downlink.ts(节选)
function serverRequest(frame: RpcRequest<Frame>): ServerRequest {
  return { type: 'server-request', rpcId: frame.rpcId, method: frame.payload.type, payload: frame.payload }
}
```

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

api-proxy.ts 订阅这个事件,推入 FrameQueue
  ctx.on('session/event', (session, event) => {
    queue.push(frame({ type: 'session/event', sessionId: session.id, event }))
  })

FrameQueue.iterate() 把队列转成 AsyncIterable
  events.mux() 把这个 AsyncIterable 作为返回值

WebSocketDownlinks.pump() 逐帧消费并推送
  for await (const frame of frames) await send(socket, frame)
  socket.send(JSON.stringify({ type: 'server-request', method: 'session/event', payload: frame.payload }))

浏览器收到帧,渲染出逐字打字的效果
```

第 04 章讲的"assistant/chunk 事件如何在会话日志里被追加",和本篇讲的"这条事件如何被推到浏览器里逐字打字",正好是同一条数据在两个不同抽象层次上的描述——前者关心事件本身的语义和持久化,后者关心这条事件如何跨越进程边界、跨越协议边界,最终变成浏览器里的一次 DOM 更新。值得强调的是,这条推送链路完全不经过 Typert 的 `@Remote`/`@RemoteScope` 机制——`docs/api-gateway.md` 明确把"会话事件、增量数据、其他流式协议"排除在 Typert 的范围之外,它们和 Typert RPC 共享同一个底层 Connection 传输层,但走的是完全独立的 `mux`/`host` 两个事件流 endpoint,不会伪装成 Remote 方法进入调用描述符表。

## 常见问题/易踩坑

- **`@Remote` 和 `@RemoteScope` 该怎么选？** 如果方法需要接收一个复杂的 Host 内部对象(比如 `Agent`)作为参数,用 `@Remote`,让生成器把这个对象翻译成一个身份字段;如果方法本身依赖某种作用域组合关系、不需要显式接收这类对象,才考虑 `@RemoteScope`。从当前代码库的实际使用情况看,`@Remote` 是绝大多数场景的默认选择。
- **为什么 Typert 只在编译 Host 那一次运行，不在编译 Client 时重新扫描？** 因为 Remote 方法的"真相"只存在于 Host 侧的源码里,Client 侧编译只需要消费已经生成好的类型声明和运行时契约,没有必要也不应该重复分析。
- **一个 endpoint 请求怎么知道该走 Typert Gateway 还是走旧的 API Proxy？** 看这个两段式 endpoint 能不能在生成的描述符表里找到匹配项——找不到就自动落回 API Proxy,这个分流逃生舱口让 Typert 可以逐步扩大覆盖范围而不必推倒重写。
- **会话事件流是不是也应该打上 `@Remote`?** 不应该。`docs/api-gateway.md` 明确把这类流式推送协议排除在 Typert 范围之外——它们语义上是"服务端主动推送",而不是"客户端发起请求等待响应",硬套 Remote 语义只会让调用描述符表变得混乱。

## 小结

Typert 解决的核心问题是:把"Host 方法的真实签名"变成 Client 类型的唯一可信来源,靠编译期分析而不是运行期反射或手写胶水代码来保证两端类型一致。`@Remote`/`@RemoteScope` 装饰器只是在方法上打一个标记,真正的重活——分析类型图、生成 Host/Client 双份产物、在运行期把描述符接回真实的 Cordis 服务调用——分别由 `generator`(编译期)和 `registry`/`loader`/`gateway`(运行期)完成。这套 RPC 生成体系和"会话事件推送"这条平行链路(`FrameQueue` → `mux()` → WebSocket)共用底层 Connection,但被设计成两套边界清晰、互不越权的协议——一套负责"请求-响应",一套负责"服务端主动推送",各自服务于浏览器里不同的交互需求。
