# Protocol / Server / Client 架构

> 前两篇讲的 RPC 模式和 SDK，解决的是"单个客户端驱动单个 Pi 进程"的问题；`packages/protocol`、`packages/server`、`packages/client` 这三个包合起来，解决的是一个更进一步、也更复杂的问题——一个服务端如何同时管理多个会话、支持多个客户端并发连接和断线重连。这是一套独立于 `--mode rpc` 的实验性协议栈，并且从 2026 年下半年起被重新设计为通用应用组合运行时 **Chord**（`@earendil-works/chord`）之上的一层"路由式远程服务传输"，不再是一份写死了 `prompt`/`steer`/`abort` 等 Agent 专属命令的协议。

## 学习目标

- 分清 `packages/coding-agent` 的 JSONL RPC 协议与 `packages/protocol`/`server`/`client` 这套 CBOR 二进制协议是两套不同的东西，理解各自的定位
- 理解为什么这套协议现在建立在 `@earendil-works/chord` 之上：协议层只负责"把一次服务调用路由到正确的服务端/会话目标"，不再感知 Agent 领域概念
- 读懂 `framing.ts` 的长度前缀分帧算法和 `codec.ts` 的编解码校验流程（这部分自基线版本以来基本没有变化）
- 理解协议 v8 的信封模型：`RequestEnvelope`/`CancelEnvelope`（客户端 → 服务端）与 `ResponseEnvelope`/`ServiceEventEnvelope`/`AttachmentEnvelope`（服务端 → 客户端）
- 理解 `Server`/`SessionRouter` 如何把请求路由到 Chord 暴露的会话能力，`Client` 如何做请求/响应关联、服务订阅与本地 Unix 服务发现

## 先说清楚：这是另一套协议，而且刚经历了一次彻底重写

容易混淆的一点是：本文要讲的 `@earendil-works/pi-protocol`、`@earendil-works/pi-server`、`@earendil-works/pi-client` 三个包，和第一篇讲的 `pi --mode rpc`（基于 stdin/stdout 的 JSONL 协议）**不是同一套东西**，两者互不依赖，`pi --mode rpc` 依然稳定地实现在 `packages/coding-agent/src/modes/rpc/` 里，服务于"一个子进程对一个客户端"的场景。

而 `packages/protocol` 这套栈在最近一个多月的开发周期里发生了一次根本性的重写：早期版本（协议 v1）自己定义了一整套"会话快照广播"协议——`Command`（`prompt`/`steer`/`abort`/`set_model`/…）、`SessionSnapshot`、`ServerEvent` 全部是协议层内置的领域概念。现在协议已经升到 **v8**，并且把这些领域概念全部剥离了出去，改为依赖一个新增的、与 Pi 本身无关的独立包 `@earendil-works/chord`（"应用组合运行时"，面向插件/服务/可复制状态这一类通用问题，详见其 README 里的自我定位："it is not a Pi package: it does not depend on any other Pi workspace package"）。协议层现在只承担一件事：**把一次不透明的 Chord 服务调用（`ServiceCall`），可靠地路由到某个服务端或某个会话**，至于这次调用具体是"发一条 prompt"还是"切换模型"，协议本身完全不关心，那是 Chord 服务实现方的事。

三个包的 README 都依然明确标注为 **Experimental（实验性）**，API 和行为都还在快速变化。

## 分层关系总览

```
@earendil-works/chord —— 与 Pi 无关的通用运行时：facet、service、replicated state、remote service adapter
        ↑                   Server/Client 依赖它的"远程服务"原语实现协议
packages/protocol   —— 线格式（wire format）：路由信封 schema、CBOR 编解码、字节分帧
        ↑                依赖
packages/server      —— 服务端：接受连接、握手、把请求路由到会话/服务端级 Chord 服务
        ↑                依赖
packages/client      —— 客户端：连接状态机、请求/响应关联、服务订阅、本地 Unix 服务发现
```

`packages/protocol` 依然是最底层、完全运行时无关的包，只关心"字节怎么变成消息、消息长什么样"。`packages/server` 在其之上加了"把请求路由给谁"的逻辑，但业务语义（一次调用到底做什么）被下放给了应用通过 `ServerHost` 接口提供的 Chord 服务。`packages/client` 同样不再理解"会话"是什么，它只知道如何对一个 `RpcTarget`（服务端级或会话级）发起 Chord 服务调用、订阅服务状态。

## protocol 包：线格式与编解码（基本未变）

### 线格式：4 字节长度前缀 + CBOR

`packages/protocol/README.md` 给出的线格式没有变化：

1. 一个 4 字节的无符号大端整数，表示后续负载长度
2. 一个 definite-length（确定长度）的 CBOR 项，包含消息本体

这个格式依然实现在 `packages/protocol/src/framing.ts` 里，`encodeFrame()`/`FrameDecoder` 的核心逻辑（按 64KB 块累积负载、`DEFAULT_MAX_FRAME_LENGTH = 16 * 1024 * 1024` 即 16 MiB 上限、`end()` 检测半截帧）自基线版本以来保持稳定——这一层是整个协议栈里最"底层、通用、不随业务概念变化"的部分，也印证了当初分层设计的价值：即便上层的消息 schema 被完全重写，字节分帧这一层完全不需要跟着动。

### codec.ts：带 schema 校验的编解码

`packages/protocol/src/codec.ts` 依然是"先校验 schema、再编码成 CBOR、套上帧头"的流程，`parseClientMessage()`/`parseServerMessage()` 用 typebox 的 `Check()` 校验，`ClientMessageDecoder`/`ServerMessageDecoder` 在解码端做同样的校验并在失败后把自己标记为失败状态、拒绝继续处理。唯一的变化是"协议值合法性"的检查（`isProtocolValue()`）现在直接复用 Chord 提供的 `isJsonValue()`，因为协议里携带的业务负载（`call`/`result`/`update`）本来就是 Chord 定义的 `JsonValue` 类型——这是协议层向 Chord 让渡"什么是合法的业务数据"这一职责的又一处体现。

### protocol.ts：从"会话快照协议"到"路由信封协议"

这是变化最大的部分。当前 `packages/protocol/src/protocol.ts`（原来叫 `schemas.ts`）定义的核心概念是：

- **`ServerId`**：一个规范的小写 UUIDv4，标识"逻辑上的一个 Pi 服务端实例"，`isServerId()` 用正则做格式校验
- **`RpcTarget`**：一次调用要路由到哪里，是下面两种目标的联合类型：
  - **`ServerTarget`**：`{ serverId }`，服务端级调用（比如列出会话、创建会话）
  - **`SessionTarget`**：`{ serverId, sessionId, attachmentId }`，会话级调用，注意比以前多了一个 `attachmentId`——因为现在一个会话可以同时被多个"连接的挂载点（presentation）"附着，`attachmentId` 用来区分是哪一次挂载发起的调用
- **`RequestEnvelope`**：`{ type: "request", id, target, call }`，`call` 是一个不透明的 `JsonValue`（本质是一个 Chord `ServiceCall` 信封），协议层不解析它的内容，只负责把它连同 `target` 一起送到正确的地方
- **`CancelEnvelope`**：`{ type: "cancel", id, target }`，用于取消一个尚未完成的 `RequestEnvelope`——这是 v1 版本没有的能力，说明新协议原生支持"长时间运行的调用可以被主动取消"
- **`ResponseEnvelope`**：`{ type: "response", id, ok, result | error }`，`ok: true` 带 `result`，`ok: false` 带 `ProtocolError`（`{ code, message }`）
- **`ServiceEventEnvelope`**：`{ type: "service_update", subscriptionId, update }`，取代了 v1 里"会话快照广播"式的 `session_snapshot`/`session_progress` 事件——现在服务端不再主动广播"某个会话的完整状态"，而是按 Chord 的订阅（subscription）模型，只推送客户端已订阅的具体服务的增量更新
- **`AttachmentEnvelope`**：`{ type: "attachment", attachment: SessionTarget | null }`，服务端可以主动通知客户端"你当前这个连接被路由到的会话变了"（或被摘除），这是一种带外（out-of-band）通知，独立于任何一次具体的请求/响应

握手部分变化不大：客户端先发 `ClientHello`（`{ type: "hello", version }`），服务端校验版本后回 `ServerHello`（带上自己的 `serverId`）或 `ServerHelloError`。

对照来看，v1 协议里"会话是什么、有哪些字段、能发哪些命令"这些都在协议 schema 里写死；v8 协议里协议层只剩下"信封长什么样、往哪儿路由、怎么取消、怎么订阅"这几个纯粹的路由概念，`call`/`result`/`update` 里到底装的是"发一条 prompt"还是别的什么，完全交给协议之外的 Chord 服务层决定。这是一次很典型的"收窄职责边界"式重构：协议包变薄了，但可扩展性变强了——以后要新增一种 Agent 能力，不需要再给协议本身加新的消息类型和新的协议版本号,只需要在 Chord 服务层加一个新服务。

## server 包：从"会话状态机"到"服务路由器"

### Server：握手与连接管理

`packages/server/src/server.ts` 里的入口类现在直接叫 `Server`（不再带 `Pi` 前缀，这个改名——`feat(agent): remove pi prefixes from client and server APIs`——发生在这次重写过程中，是一个信号：这套协议栈正在往"不特定于 Pi、可被其他基于 Chord 的应用复用"的方向靠拢）。握手流程和之前一致：新连接必须先发 `hello`，版本不匹配直接 `failProtocol`，握手有默认 `DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000` 毫秒超时。`Server` 依然通过构造函数注入 `ServerListener[]`，把"连接是怎么建立的"完全交给调用方决定（Unix socket 是目前唯一内置实现，见下文）。

### SessionRouter：把请求路由给 Chord 会话

`packages/server/src/session-router.ts` 的 `SessionRouter` 取代了旧版的 `LiveSessionManager`，是这次重写里改动最大的一块。它不再维护一个"会话快照"和一个针对固定命令集合的大 `switch`，而是：

```typescript
// packages/server/src/session-router.ts
async executeServiceCall(
	call: ServiceCall,
	target: RpcTarget,
	client: object,
	publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => Promise<void>,
	context: Context,
): Promise<JsonValue | undefined> {
	const admitted = await this.runForClient(client, () =>
		this.startServiceCall(client, target, call, publish, context),
	);
	return admitted.result;
}
```

`call` 是一个不透明的 `ServiceCall`，`SessionRouter` 自己完全不解析它的语义,只负责：找到 `target` 对应的已挂载会话（`HostedSession`）、确认这次调用来自哪个连接的挂载点（`ClientAttachment`）、把调用转发给应用通过 `ServerHost.openSession()` 返回的 `RoutedSessionHandle`（其 `attachClient()` 会给每个连接返回一个 `RoutedSessionAttachment`，真正的 `invokeService()` 在这一层实现）。至于 `invokeService()` 内部怎么处理"这是不是一次 prompt 调用"，那是 `packages/agent`/`packages/coding-agent` 里 Chord 服务实现的职责，`SessionRouter` 完全不需要知道。

几个从旧版延续下来、依然值得关注的设计：

- **acquire 去重**：`openingSessions: Map<string, Promise<HostedSession>>` 依然用来防止同一个会话 ID 被并发打开两次
- **多挂载点**：一个 `HostedSession` 现在可以同时有多个 `ClientAttachment`（对应server README 里说的"multi-presentation attachment"），每个挂载点独立持有自己的操作集合，互不干扰
- **优雅清理**：`removeSession()` 会先并发释放所有挂载点（`releaseAttachment()`），任何一个失败都会被收集进 `SessionCleanupError`（一个 `AggregateError` 子类）统一抛出，而不是第一个失败就中断整个清理流程

### ServerHost：应用需要实现的边界

`packages/server/src/types.ts` 里的 `ServerHost<TMetadata>` 接口取代了旧版的 `PiServerService`，是应用方接入这套协议栈唯一需要实现的边界：

- `resolveSession(sessionId, context)`：把一个会话 ID 解析成持久化元数据（`TMetadata extends SessionMetadata`），解析失败应抛出可跨协议边界的错误
- `openSession(metadata, context)`：返回一个 `RoutedSessionHandle`，其 `attachClient()` 是"某个连接挂载到这个会话"时被调用的入口，真正返回一个能 `invokeService()`/`release()` 的 `RoutedSessionAttachment`
- `serverServices`：一个 `RoutedServerServiceHost`，处理服务端级（不针对具体会话）的调用，比如"列出所有会话"

这个接口本身没有任何字段提到 `prompt`/`compact`/`fork` 这类 Agent 概念——它是一层纯粹的"路由到 Chord 服务"的适配层,具体能力由 `packages/coding-agent` 或 `packages/agent` 侧实现的 Chord facet 决定。

### errors.ts：受控的错误跨界（模式不变，错误码变了）

`packages/server/src/errors.ts` 里"可以安全跨协议边界的错误" vs "只能记日志、绝不外传的内部错误"这个基本模式没有变化,但具体的错误码集合变了：现在是 `RemoteServiceErrorCode`（来自 Chord）叠加 Pi 服务端自己的 `wrong_server`/`session_not_found`/`session_ambiguous`/`session_not_attached`/`server_draining` 五种。值得注意的是新增了 `session_ambiguous`（会话 ID 匹配了不止一个会话）和 `wrong_server`（请求的 `serverId` 和当前服务端实例不匹配）——这两种错误在旧协议里没有对应物,是"支持本地服务发现、多个服务端实例可能同时存在"这个新场景倒逼出来的错误分类。

## client 包：从"会话租约"到"通用 Chord 服务客户端"

### Connection：状态机基本不变

`packages/client/src/connection.ts` 的 `Connection` 类依然把连接生命周期显式建模为 `"disconnected" | "connecting" | "connected"` 三态,`connect()` 建连、发 `hello`、等服务端 `hello`/`hello_error` 的流程和之前一致。

### Client：不再有"会话租约"，改为通用的请求 + 订阅

这是客户端侧变化最大的地方。旧版 `PiClient` 提供的是 `acquireSession()`/`createSession()` 返回 `PiSessionHandle`、区分 `exclusive`/`shared` 两种租约模式的高层会话 API；当前的 `Client`（`packages/client/src/client.ts`）不再有这套语义,只提供三个更底层、和 Chord 直接对应的方法：

```typescript
// packages/client/src/client.ts
/** Invoke one low-level protocol call against an explicit routed target. */
request(target: RpcTarget, call: ServiceCall, signal?: AbortSignal): Promise<ServiceResult>;

async serviceCatalogue(target: RpcTarget, signal?: AbortSignal): Promise<readonly ServiceCatalogueEntry[]>;

async subscribeService(
	target: RpcTarget,
	serviceId: string,
	mode: ServiceMode,
	listener: (update: ServiceProviderUpdate) => void | Promise<void>,
	signal?: AbortSignal,
): Promise<ServiceSubscription>;
```

`request()` 是最基础的一次性调用；`serviceCatalogue()` 让客户端可以查询某个 target 上有哪些 Chord 服务可用（`createServiceCatalogueCall()` 是 Chord 提供的标准控制调用）；`subscribeService()` 则实现了"先拿一份权威快照、再持续接收增量更新"的订阅模式——`ServiceSubscription.start()` 需要调用方显式调用才开始交付排队中的更新，这是为了让调用方有机会先把快照安装进本地状态、再开始应用后续的增量,避免"快照还没装好、增量已经先到"的竞态。

一个会话现在只对应客户端里的一个 `attachment: SessionTarget | undefined` 字段（单数,不再是可以并存多个的"租约"集合）,通过 `onAttachmentChange()` 监听服务端主动推来的 `AttachmentEnvelope`。想要实现"多个只读观察者 tab 同时看一个会话"这种旧版靠 `shared` 租约支持的场景,现在需要在更上层（应用自己的 Chord 服务实现）里处理,协议/客户端包本身不再内置这个概念。

### unix.ts：新增本地 Unix 服务发现

`packages/client/src/unix.ts` 里 `createUnixTransportFactory()` 的机制（路径长度校验、`#pendingBytes` 背压、`#writeTail` 写入串行化、Windows 平台直接报错）延续了下来,但新增了一个之前没有的能力——**本地服务发现**：

```typescript
// packages/client/src/unix.ts
export interface DiscoverUnixServersOptions {
	/** Directory containing server-addressed Unix sockets. */
	directory: string;
	/** Maximum time for each connection and handshake. Defaults to 1,000 ms. */
	timeoutMs?: number;
}

export async function discoverUnixServers(options: DiscoverUnixServersOptions): Promise<UnixServerRoute[]>;
```

配合服务端侧 `packages/server/src/transports/unix/address.ts` 里的 `getUnixSocketPath(serverId, serverDirectory)`——它规定每个服务端实例的 socket 文件名就是 `${serverId}.sock`，`discoverUnixServers()` 只需要 `readdir()` 一个约定目录，筛出文件名符合 UUID 格式的 `.sock` 文件，再并发（用 `MAX_CONCURRENT_DISCOVERY_PROBES = 16` 限流）逐个尝试连接并完成握手,握手成功的才被视为"可达的服务端",最终按 `serverId` 排序返回。这个设计把"发现"这件事完全建立在文件系统约定之上,不需要额外的注册中心或广播协议——本质上是把 Unix socket 目录当成了一个简易的服务注册表,任何在本机运行、遵守这个命名约定的 Pi 服务端实例都能被同机的客户端自动找到。这对"IDE 插件想找到当前用户机器上正在运行的 Pi 后台服务,但不知道具体的 `serverId`"这类场景是刚需能力。

## 端到端流程小结（更新版）

把新架构串起来看一次完整的交互：客户端通过某个 `ByteTransportFactory`（例如 `createUnixTransportFactory`，或先用 `discoverUnixServers()` 找到目标服务端再连接）建立连接 → 发送 `hello` → 服务端校验版本、回一个带 `serverId` 的 `hello` → 客户端对一个 `ServerTarget` 调用 `request()`，`call` 里是一个"创建会话"的 Chord 服务调用 → 服务端的 `Server` 把请求交给 `SessionRouter`，后者调用 `ServerHost.openSession()` 拿到一个 `RoutedSessionHandle` → 客户端拿到新会话的 `sessionId`，对一个 `SessionTarget` 调用 `subscribeService()` 订阅这个会话暴露的 Chord 服务（比如"对话状态"服务）→ 服务端把每次状态变化编码成 `ServiceEventEnvelope` 推给客户端，客户端的 `ServiceStateDecoder` 把增量应用到本地缓存的快照上 → 应用调用完毕后客户端断开或服务端主动摘除挂载点，触发 `AttachmentEnvelope`，最终 `SessionRouter.releaseAttachment()` 释放挂载点，会话没有挂载点后由应用侧的 Chord 服务决定是否真正释放运行时资源。

## 小结与思考题

`packages/protocol`/`server`/`client` 这套栈最近经历的重写,本质上是把"Agent 领域概念"（会话、prompt、模型切换……）从协议层彻底剥离,下沉到一个与 Pi 无关的通用运行时 Chord 里去实现,协议包自己只剩下最纯粹的"信封 + 路由 + 分帧"职责。这是一次教科书式的"分层收窄"重构：短期看,协议 v1 到 v8 之间几乎所有面向业务的类型（`Command`、`SessionSnapshot`、会话租约）都被删除或迁移了,代价不小；但换来的是协议包不再需要因为"Agent 又多了一个新命令"而升版本号,新增能力只需要在 Chord 服务层添加新服务即可。

思考题：

1. 旧版协议把"这次调用要做什么"（`prompt`/`steer`/`abort`……）直接编码在协议消息的类型字段里,新版协议把 `call` 变成了一个协议层不解析的不透明 `ServiceCall`。这种"变成不透明信封"的设计,对协议自身的可测试性、可观测性（比如想在服务端记录一条审计日志,写清楚"客户端发起了什么调用"）分别有什么影响？你会在哪一层补上这个能力？
2. `discoverUnixServers()` 依赖"socket 文件名 = `serverId`"这个文件系统约定来发现本机服务。如果同一台机器上因为异常退出残留了一个 socket 文件,但对应进程早已不在了,发现流程要怎么处理这种"文件存在但连不上"的情况？源码里的哪个环节负责兜底？
3. 新版 `Client` 不再区分 `exclusive`/`shared` 两种会话访问模式,这个语义如果还需要,应该在协议层重新加回来,还是应该完全交给运行在会话之上的具体 Chord 服务自己实现（比如某个服务的语义就是"同一时刻只允许一个订阅者做写操作"）？两种选择分别会给协议的通用性带来什么影响？
