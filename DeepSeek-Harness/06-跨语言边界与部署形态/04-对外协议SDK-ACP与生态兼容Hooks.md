# 对外协议 SDK、ACP 与生态兼容 Hooks

> 前两篇讲的是"dsh 内部怎么把 Host 和 Client 连起来",本篇要讲的是"外部世界怎么把 dsh 整体当成一个黑盒来用"。dsh 对外暴露了三条完全不同的接入路径:一条是给任意语言用的通用 stdio JSON-RPC 协议(`packages/sdk`),一条是对接业界标准 Agent Client Protocol 的自动化服务器(`packages/acp`),还有一条是让用户直接复用 Claude Code/Codex 现有 hook 脚本、不用重写的生态兼容层(`packages/hooks`)。这三条路径解决的是同一类问题的三个不同侧面——"怎么在不深入了解 dsh 内部包结构的前提下,让外部程序驱动它、或者扩展它"。

## 学习目标

- 理解 `packages/sdk` 这个通用 SDK 和上一篇讲的 Python SDK 的关系——两者驱动的是同一套 wire protocol,但 `packages/sdk` 更底层、面向"仓库邻近的 TypeScript 消费者"。
- 理解 `packages/sdk/protocol` 定义的 newline-delimited JSON-RPC 2.0 消息格式,以及请求/响应/通知三种帧如何靠 `id`/`method` 字段的有无区分。
- 掌握 `packages/acp` 的定位:一个基于业界标准 `@agentclientprotocol/sdk` 包实现的自动化专用 ACP 服务器,面向程序化客户端而非产品 UI。
- 理解 `packages/hooks` 的生态兼容层设计——不是重新发明一套 hook 协议,而是把外部 shell hook 协议翻译到 dsh 内部规范的扩展点上。
- 搞清楚 `PreToolUse`/`PostToolUse`/`Stop` 等 Claude Code/Codex hook 事件,分别映射到 dsh 内部的哪些扩展点(`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping` 等)。

## 背景与设计动机

一个 Agent 运行时如果只能通过自己的 Web UI 使用,它的价值会被严重限制。dsh 团队显然意识到了这一点,所以在"直接 npm 依赖"和"浏览器 WebSocket 连接"这两条路径之外,又开辟了三条面向外部集成的路径。`packages/sdk/README.md` 用一句话概括了这一整组包的定位：

```text
// packages/sdk/README.md:12,27-31(节选)
The SDK family lets another process drive a complete DeepSeek Harness
runtime over newline-delimited JSON-RPC. Its protocol package defines the
public messages, the TypeScript client launches `dsh` with a named profile
and ordered patches, and the server accepts SDK requests over stdio. Clients
can open sessions, send prompts, and observe session events, agent status
changes, and subagent completions. The TypeScript client and Python SDK use
the same protocol, and these packages do not create developer projects or
define another application.

| Package | Role |
|---|---|
| protocol/ | Wire protocol: the newline-delimited JSON-RPC transport and the named request, result, and notification types |
| client/   | TypeScript client that spawns a runtime subprocess and drives agent turns through the high-level and protocol-level APIs |
| server/   | `jsonrpc` plugin that serves out-of-process SDK clients over stdio |
```

"不负责创建、配置、构建或启动开发者项目"——这条边界划得很清楚:SDK 只负责协议,不负责替调用方决定"你的 Agent 应该由哪些插件组成"。这和上一篇讲的 Python SDK 是同一种哲学的两个体现:协议是稳定的、可以被任何语言实现的契约,而"这个 Agent 到底装了哪些工具、连了哪个 LLM"完全由调用方通过 **profile + 有序 patches** 决定——值得注意的是 `cordis.yml` 这个说法也已经从 README 里消失了,取而代之的是"the TypeScript client launches `dsh` with a named profile and ordered patches";真正可运行的 `dsh --profile sdk` 应用本身被挪进了 `packages/bundle/sdk-app`(README 的 Related documentation 里点名了这个 bundle:"the `dsh --profile sdk` application that boots the JSON-RPC server")。

## 核心机制详解

### `packages/sdk`:通用 stdio JSON-RPC,Python SDK 的"设计双胞胎"

`packages/sdk/client/README.md` 直接点名了这个包和 Python SDK 的关系：

```text
// packages/sdk/client/README.md:12
`dsh-sdk-client` lets TypeScript programs start and drive a complete
DeepSeek Harness runtime over stdio JSON-RPC. Use `DeepSeekHarness` to open
sessions, send text or image prompts, collect event and notification
streams, and obtain the last committed assistant response when the runtime
becomes idle; use `HarnessClient` for direct protocol requests and
subscriptions. Callers may provide `dshBin`; otherwise the client resolves
the same-version `@deepseek-ai/dsh` executable. The client owns the
subprocess across runs, exposes typed transport and protocol failures, and
reaps it on `close()` or `await using`.
```

"设计双胞胎"(design twin)这个措辞并没有消失,只是从 README 的 Summary 挪进了 `client.ts` 的模块注释(下文会引用:"The design twin is the Python SDK's `HarnessClient`")。两者驱动的是同一套 wire protocol、同一种"spawn 子进程 + stdio 通信"的思路,启动方式也收敛到了同一个形态——**给一个 profile、给一串有序 patches**;区别只在于目标用户:Python SDK 面向完全不了解 Node 生态的用户,所以多背了一层"把整个运行时打成单文件 exe"的分发优化(上一篇的内容),而这个 TypeScript 版本假设调用方本来就"仓库邻近"(repo-adjacent)、清楚自己在启动哪个运行时,所以它接受一个显式的 `dshBin`,不给就解析同版本的 `@deepseek-ai/dsh` 可执行文件,不做任何打包封装。旧 README 里"the launch spec is fully explicit (`command`/`args`)"那句话已经不再成立——启动规格不再是原生的 `command`/`args`,而是 profile 加 patches。

协议本身定义在 `packages/sdk/protocol`,用的是标准的换行分隔 JSON-RPC 2.0：

```ts
// packages/sdk/protocol/src/transport.ts:1-9
/**
 * Newline-delimited JSON-RPC 2.0 over byte streams. Frames with `id` and
 * `method` are requests, `id` alone is a response, and `method` alone is a
 * notification. Malformed lines are ignored; handler failures become error frames.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/transport
 */
```

三种帧的判定规则——`id`+`method` 是请求,只有 `id` 是响应,只有 `method` 是通知——和上一篇 Python `client.py` 里 `_handle_message()` 的判定逻辑完全对应,再次印证"设计双胞胎"这个说法不是场面话。写帧的实现同样是"一行 JSON + 换行符"：

```ts
// packages/sdk/protocol/src/transport.ts:260-262
private write(message: Record<string, unknown>): void {
  this.output.write(`${JSON.stringify(message)}\n`)
}
```

请求方法命名遵循"`名词/动词`"的规范(客户端→服务端),通知则用"`名词.事件`"(服务端→客户端)——两种命名风格本身就在帮读者一眼分辨消息方向：

```text
// packages/sdk/protocol/README.md:38-46(节选)
| Direction | Method | Payload types |
|---|---|---|
| client→server | `initialize` | `InitializeParams` → `InitializeResult` |
| client→server | `session/prompt` | `SessionPromptParams` → `SessionPromptResult` (durable enqueue receipt) |
| client→server | `shutdown` | no params → `{}` |
| server→client | `session.event` | `SessionEventNotification` (every session in the runtime, unfiltered) |
| server→client | `session.status` | `SessionStatusNotification` (whole-agent `running`/`idle` transition) |
| server→client | `subagent.started` | `SubagentStartedNotification` |
| server→client | `subagent.finished` | `SubagentFinishedNotification` (in-process runs only) |
```

对应的强类型定义把这份表格变成了编译期可检查的类型约束：

```ts
// packages/sdk/protocol/src/types.ts:107-119
export interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}

export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}
```

Server 端(`@deepseek-ai/dsh-sdk-jsonrpc-server`)是一个把这三个方法接到真实 Cordis 运行时上的分派器：

```ts
// packages/sdk/server/src/server.ts:248-259
async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return this.initialize(params as unknown as InitializeParams)
    case 'session/prompt':
      return this.prompt(params as unknown as SessionPromptParams)
    case 'shutdown':
      return this.shutdown()
    default:
      throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
  }
}
```

这里同样能看到本课程反复出现的"stdout 只能是协议帧"原则：

```text
// packages/sdk/server/README.md:42-44
### stdout is the protocol
Stdout carries only JSON-RPC frames, so clients can parse every byte;
diagnostics belong on stderr. Keep stdout loggers out of the composed tree.
```

Client 端的 `HarnessClient` 类自己 spawn 子进程,而不是走 dsh 内部统一的 `dsh-subprocess` 服务——文档专门解释了这个例外：

```text
// packages/sdk/client/src/client.ts:1-13(模块注释节选)
Low-level JSON-RPC client for a DeepSeek Harness SDK runtime subprocess.
HarnessClient owns the child process: it spawns the runtime, speaks the
@deepseek-ai/dsh-sdk-protocol wire over the child's stdio, fans server
notifications out to subscriptions, and tears the child down to quiescence
through a private EOF → SIGTERM → SIGKILL ladder. The design twin is the
Python SDK's HarnessClient (python/sdk); both drive the same runtime
protocol. This client runs OUTSIDE any harness context, so it spawns
directly rather than through the dsh-subprocess service — the seam's
documented exception for SDK-managed transports.
```

"运行在任何 harness context 之外"——这句话点出了这类 SDK 客户端的本质:它们不是 dsh 内部的一个插件,而是完全独立于 dsh 进程空间之外的调用方,理所当然不能依赖只有 Cordis 插件才能访问的内部服务。高层封装 `DeepSeekHarness` 提供了更友好的使用方式：

```ts
// packages/sdk/client/README.md:32-46
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

await using harness = new DeepSeekHarness({
  profile: 'sdk',
  patches: ['./automation.cordis.yml'],
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: ReasoningEffortId('max'),
  maxTokens: 49_152,
})
const result = await harness.run('say hi')
console.log(result.finalResponse)
```

### ACP:基于业界标准协议的自动化服务器

`packages/acp` 这个组如今只包含一个包,实现代码在子目录 `packages/acp/acp` 里。组的定位说明是这样写的：

```text
// packages/acp/README.md:12
The acp group provides one package: a server that lets programs and
automation run persistent DeepSeek Harness agents over the standard Agent
Client Protocol. A client can create, list, resume, and close sessions;
attach standard MCP servers; select model options; send text and image
prompts; receive semantic updates; answer permission prompts; and cancel
work without a human in the loop. The matching client for spawning such a
server from another harness lives in `subagent/subagent-acp`.
```

包自己的 Summary 更具体：

```text
// packages/acp/acp/README.md:12
`dsh-acp` lets trusted programs automate persistent DeepSeek Harness agents
through the standard ACP: create or resume sessions, select a model and
reasoning effort, attach MCP servers, submit or cancel work, receive
semantic updates, and close sessions independently. Choose it for
out-of-process subagents, test runners, and scripted controllers; it
intentionally omits DSH-specific presentation data and interactive UI
features. Persistence supports listing, resuming, and closing sessions
across process restarts, but deletion, forks, transcript replay, and
additional directories are unsupported. Run `pnpm dsh --profile acp` to
start the server; use `dsh-subagent-acp` as the repository client.
```

这里有个值得注意的演进:早期文档那句"an interoperability transport, not a presentation or human-interaction layer"已经不再出现,取而代之的是"持久会话"这个新卖点——ACP 服务器现在挂载了 session persistence,能跨进程重启 list/resume/close,不再是"创建一次性 agent、用完即弃"的形态。

值得特别指出的一点是,这个包依赖的是业界通用的 `@agentclientprotocol/sdk`(版本已从早年的 `0.25.1` 升到 `1.4.0`),这是源自 Zed 发起的 [Agent Client Protocol](https://agentclientprotocol.com) 规范的官方 TypeScript SDK。除了协议 SDK 本身,它还依赖 dsh 自己的品牌常量包 `@deepseek-ai/dsh-brand`(用于 `agentInfo` 之类的稳定标识),并通过一长串 `peerDependencies`(agent、attachment、llm、mcp-client、session、session-persistence、token-meter、user-approval 等)声明"我必须在怎样的组合里才能运行"：

```json
// packages/acp/acp/package.json:29-33
"dependencies": {
  "@agentclientprotocol/sdk": "1.4.0",
  "@deepseek-ai/dsh-brand": "workspace:^",
  "@deepseek-ai/schemastery": "workspace:^"
}
```

也就是说,dsh 这边没有自造一套"看起来像 ACP 但细节不一样"的协议,而是直接调用了这个业界标准包提供的类型和运行时(`AgentSideConnection`、`ndJsonStream`、`PROTOCOL_VERSION`、`RequestError` 等)。建立 stdio 连接的方式,是把 Node 的标准输入输出流适配成 Web Streams API,再交给协议 SDK 的 app 工厂装配请求处理器：

```ts
// packages/acp/acp/src/index.ts:374-392(节选)
const stream: Stream = config.stream ?? ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
)
const app = createAcpAgentApp({ name: 'deepseek-harness-acp' })
  .onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params))
  .onRequest(methods.agent.authenticate, async ({ params }) => {
    await implementation.authenticate(params)
    return {}
  })
  .onRequest(methods.agent.session.new, ({ params, signal }) => implementation.newSession(params, signal))
  .onRequest(methods.agent.session.list, ({ params, signal }) => implementation.listSessions(params, signal))
  ...
const connection = app.connect(stream)
const conn: AgentContext = connection.client
```

`initialize` 的响应遵循"只声明真正挂载了的能力"这条原则(README 里叫 "Truthful capability and configuration state"):图片能力取决于当前配置的路由与附件存储是否支持(运行时用 `supportsAcpImagePrompts()` 算出来),音频、嵌入式上下文一律不支持,同时显式声明 HTTP 形态的 MCP 与 `close`/`list`/`resume` 三种会话能力,并且不要求任何认证方式：

```ts
// packages/acp/acp/src/index.ts:176-190
async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
  // Single-version agent: the spec's "same version if supported, else
  // the latest supported" both resolve to this server's one version.
  imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model)
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
    agentCapabilities: {
      mcpCapabilities: { http: true },
      promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    },
    authMethods: [],
  }
},
```

`authenticate` 则直接返回成功——这个服务器信任它的调用方,不做额外鉴权。`session/new` 创建一个真实的、可持久化的 dsh Agent 实例,和普通的 Agent 创建流程没有区别,只是包了一层 ACP 的 session 语义,并且在"发布"这个 session 之前先校验工作目录、MCP 声明等参数,最后连同一整套配置选项状态一起返回：

```ts
// packages/acp/acp/src/index.ts:196-231(节选)
async newSession(params: NewSessionRequest, signal: AbortSignal): Promise<NewSessionResponse> {
  assertOpen()
  validateWorkspaceParams(params)
  const sessionId = brandString<SessionId>(randomUUID())
  ...
  record = await AcpSession.create(ctx, {
    sessionId,
    cwd: params.cwd,
    mcpServers: params.mcpServers,
    agentOptions: agentOptions(config),
    fallbackSelection: initialSelection(config),
    signal,
    notify,
  })
  ...
  return { sessionId, configOptions }
},
```

完整的方法清单("The calls a client makes")能看出这个 ACP 服务器"故意做得很窄"的克制设计——只暴露标准 ACP v1 的自动化表面,每个调用只做协议要求的最小事情,不试图去覆盖 UI 层的职责：

```text
// packages/acp/acp/README.md:60-74(节选)
One connection can run several sessions at once, each independent. The calls a client makes:

| Call | What you get |
|---|---|
| `initialize` | Stable ACP v1 plus `session/list`, `session/resume`, `session/close`, and Streamable HTTP MCP support; image prompts only when the durable attachment store and configured exact route support them. |
| `authenticate` | Immediate success; the server requires no authentication. |
| `session/new` | A fresh persistent agent whose absolute workspace and stdio or HTTP MCP servers are validated before publication, plus its complete configuration-option state. |
| `session/list` | Deterministic newest-first pages of persisted, resumable root sessions; an optional absolute `cwd` filter uses physical-directory identity where possible. |
| `session/resume` | A persisted inactive session whose canonical workspace is verified before composition; its log is restored without replaying old updates. |
| `session/close` | Quiescent cancellation, update draining, descendant disposal, persistence flush, and disposal of only the addressed Agent scope. |
| `session/set_config_option` | A serialized update to the advertised `model` or `reasoning_effort`, returning the complete resulting state. |
| `session/prompt` | Ordered text, resource links, and supported images, one prompt at a time per session; settlement follows Agent idle and ordered update delivery. |
| `session/cancel` / `$/cancel_request` | The prompt-owned cancellation path; without an ACP prompt in flight it cancels autonomous work, while unknown session ids are no-ops. |
| `session/update` | Committed assistant messages and thoughts, generic tool lifecycle, configuration changes, and context usage, serialized per session. |
| `session/request_permission` | A permission prompt with one-shot allow/reject choices; your client can answer automatically. |
```

与之配套的是明确的能力边界——README 用一段话把"不支持什么"列了个干净:

```text
// packages/acp/acp/README.md:76
Unsupported surfaces are omitted or rejected: `session/load`, deletion,
fork, additional directories, SSE or ACP-transport MCP, modes, commands,
plans, terminals, client filesystem operations, and elicitation.
```

可运行的示例也不再是仓库根目录下的 `examples/acp-agent`——那个示例目录已经不存在了,真正装好这套 ACP 服务器的是 bundle `packages/bundle/acp-app`(`@deepseek-ai/dsh-acp-app`),用 `dsh --profile acp` 启动：

```text
// packages/bundle/acp-app/README.md:12
The automation-only ACP stdio application as a `dsh` profile bundle over
`dsh-base`. It inherits the base's disabled module-HMR policy; its patch
sets the coding-agent persona and default model route, mounts an app-owned
zero-option command provider, and starts `dsh-acp` only after that provider
accepts the invocation. `dsh --profile acp --help` therefore writes help
and exits without claiming stdin or stdout.
```

这也解释了为什么 `initialize` 响应里那些人机交互能力(editor navigation、transcript replay、plans、terminals、elicitation 等)要么干脆不声明、要么直接拒绝——这个服务器的假设受众是脚本、测试运行器和另一个 Agent,本身就不需要这些人机交互特性,它们属于 Web host/client 模块的职责范围。

### hooks-claude-code / hooks-codex:翻译外部协议,而不是重新发明

`packages/hooks/README.md` 一句话点出了这个子系统存在的动机——让用户能复用已经写好的 hook 脚本,而不必为 dsh 重写一套：

```text
// packages/hooks/README.md:12
The hooks group lets agent runs reuse shell hooks written for Claude Code
or Codex. Point the matching integration at an existing `hooks.json` to run
supported command hooks when sessions start, prompts arrive, tools run, or
runs stop. These hooks can block prompts or tool calls with model-visible
messages, add conversation context, or require the run to continue. Choose
this group to preserve existing hook configurations; each integration
supports only the command-hook subset documented by its source tool.
```

这段新 Summary 没再明说那句 "the harness's typed interception points",但这个设计洞察并没有消失——它只是挪到了 README 的 Related documentation 在链向的 "Interception extension-points" Agent Note 里:dsh 内部本来就有一套类型化的拦截点,写一个原生 hook 其实就是往这些拦截点上挂一个普通的 Cordis 插件。`hooks-claude-code`/`hooks-codex` 不是给 dsh 新增一种能力,而是**把外部 shell hook 的协议格式,翻译成对这些已有拦截点的调用**——用户完全不需要知道 dsh 内部长什么样,只要有一份能被 Claude Code 或 Codex 识别的 `hooks.json`,指给这个桥接插件就能直接生效。

两个桥接包构造给外部 shell 命令的 stdin payload 格式并不相同,分别贴合各自生态的既有约定。Claude Code 桥接用近似驼峰/蛇形混合的字段名：

```ts
// packages/hooks/hooks-claude-code/src/index.ts:327-345(节选)
function base(agent: Agent | undefined, event: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    // The persistence seam exposes no artifact path; the field stays empty
    // (a durable consumer gap recorded in this package's README).
    transcript_path: '',
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}
...
function preToolPayload(exec: ToolExecution): Record<string, unknown> {
  return { ...base(exec.agent, 'PreToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }
}
```

注意 `transcript_path` 如今被固定为常量——持久化 seam 不再暴露产物路径(代码注释里把这个缺口明确记为"a durable consumer gap"),此前那个"从 `sessionPersistence` 里 locate 真实路径"的实现整个撤掉了;`base()` 也不再需要 `ctx` 参数。

Codex 桥接则是纯 snake_case,并且额外携带 `model`/`turn_id`/`permission_mode` 字段,还特别注明"不带结尾换行符"这个和 Claude Code 桥接不一样的细节：

```ts
// packages/hooks/hooks-codex/src/index.ts:1-9(模块注释)
/**
 * Bridge for unmodified Codex command hooks on harness interception points. It
 * supports five points (SessionStart, prompt/tool pre/post, Stop), regex-only
 * matchers, snake_case payloads without a trailing newline, no hook environment
 * or command substitution, and no pre-tool approval or rewrite path; only
 * blocking decisions are honored. Shared execution and parsing live in
 * `dsh-hook-protocol`.
 * @module @deepseek-ai/dsh-hooks-codex
 */
```

```ts
// packages/hooks/hooks-codex/src/index.ts:297-308(节选)
function base(agent: Agent | undefined, event: string, model: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    // The persistence seam exposes no artifact path; the field stays null
    // (a durable consumer gap recorded in this package's README).
    transcript_path: null,
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
    model,
    permission_mode: 'default',
  }
}
```

这种"每个桥接自己贴合外部协议的具体字节格式,但都翻译到同一套内部拦截点"的分层,正是这个生态兼容层的核心价值——它把"跟外部生态的字节级兼容"和"跟 dsh 内部的语义对接"清晰地分成了两层,后者两个桥接包完全共用。

### PreToolUse/PostToolUse/Stop 到底映射到哪个内部扩展点

这是这套兼容层里最值得细读的部分。dsh 内部的规范扩展点定义在 Agent Note 里,概括为一句话:每次工具调用都走 `tools/pre-execute` → 守卫 → `tools/execute` → 派发 → `tools/post-execute` → `finalizeContent` → `tools/result` 这条流水线,`tools/pre-execute` 是"允许/拒绝/询问"的瀑布式门,`tools/post-execute` 是"接受/带反馈拦截/替换内容/附加上下文"的检查转换瀑布。

**`PreToolUse` → `tools/pre-execute`**(两个桥接包结构完全一致,以 Claude Code 版为例)：

```ts
// packages/hooks/hooks-claude-code/src/index.ts:244-250
ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
  const turn = lastTurn(ctx, exec.agent)
  const merged = await runPoint('PreToolUse', exec.name, preToolPayload(exec), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
  if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
  if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
  return next()
})
```

**`PostToolUse` → `tools/post-execute`**：

```ts
// packages/hooks/hooks-claude-code/src/index.ts:253-271
ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
  const turn = lastTurn(ctx, exec.agent)
  const merged = await runPoint('PostToolUse', exec.name, postToolPayload(exec, result), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
  const context = contextFrom(merged)
  if (merged.decision === 'deny') {
    return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }], ...context ? { additionalContexts: [context] } : {} }
  }
  // Our hooks did not block. DELEGATE so a later listener can still block/replace,
  // then fold our context onto its decision (a downstream block carries it too).
  const downstream = await next()
  if (!context) return downstream
  if (downstream.kind === 'block') {
    return { ...downstream, additionalContexts: prependContext(context, downstream.additionalContexts) }
  }
  return {
    ...downstream,
    additionalContexts: prependContext(context, downstream.additionalContexts),
  }
})
```

**`Stop` → `agent/turn-stopping`**——这一点尤其精妙:dsh 内部本来就有一个"回合即将停止"的通知点,一个返回"继续"的 Stop hook 只需要调用 `agent.steer()` 往对话里注入一条新消息,就能让机器观察到待处理输入、自然地再跑一步,完全不需要一个专门的"阻止停止"API：

```ts
// packages/hooks/hooks-claude-code/src/index.ts:273-284
// A blocking Stop hook steers at the stopping boundary, which makes the
// machine observe pending input and run another step.
// TODO(stop-loop-guard): cap consecutive forced continuations; hooks must self-limit meanwhile.
ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
  const merged = await runPoint('Stop', '', stopPayload(agent), { agent, turn, signal })
  if (merged.decision === 'deny') {
    // A blocking Stop hook forces continuation.
    const text = merged.reason ?? 'continue: blocked by Stop hook'
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: CONTEXT_SOURCE }))
  }
})
```

**`UserPromptSubmit` → `agent/pre-step`** 同样对应一个明确的内部拦截点;**`SessionStart` 的情形更微妙**——它如今不再映射到一个"session-start"事件,而是挂在 `agent/created` 拦截点上,在第一个回合开始前被 **await**,把 hook 产出的上下文直接 `agent.inject()` 注入新 session(hook 失败只告警、不阻塞启动)：

```ts
// packages/hooks/hooks-claude-code/src/index.ts:209-221
ctx.on('agent/created', async ({ agent, source, signal }) => {
  const ownerSignal = signal === undefined ? detached.signal : AbortSignal.any([signal, detached.signal])
  const run = runPoint('SessionStart', source, sessionStartPayload(agent, source), { agent, signal: ownerSignal })
    .then((merged) => {
      const context = contextFrom(merged)
      if (context) agent.inject(context)
    })
    .catch((error: unknown) => {
      ctx.logger.warn(`hooks-claude-code: SessionStart hook failed: ${String(error)}`)
    })
  detached.track(run)
  await run
})
```

用户视角的能力清单如今排在每个桥接 README 的正面(标题就叫 "What your hooks can do"),不再用"Harness point 映射表"当门面：

```text
// packages/hooks/hooks-claude-code/README.md:56-64
| Your hook | When it runs | What it can do |
|---|---|---|
| `SessionStart` | when a session starts | attach context the model sees in that session |
| `UserPromptSubmit` | when the agent receives a prompt | block the prompt, or attach extra context |
| `PreToolUse` | before a tool runs | block the tool, or ask for approval before it runs |
| `PostToolUse` | after a tool runs | block the result with feedback, or attach extra context |
| `Stop` | when the run is about to stop | force another step with a reason |
| `SubagentStart` | when a subagent starts | attach context to a still-running subagent (in-process only) |
| `SubagentStop` | when a subagent ends | observe only — cannot block or add context |
```

而"每个 hook 究竟挂到 dsh 哪个内部拦截点"这个问题,如今收进实现章节的一段 "Hook point mapping" 说明里：

```text
// packages/hooks/hooks-claude-code/README.md:87(节选)
Each supported event programs against one harness extension point: `SessionStart` adds context through awaited `agent/created` initialization before the first turn, `UserPromptSubmit` and `PreToolUse` are waterfalls that can reject the incoming action (`agent/pre-step`, `tools/pre-execute`), `PostToolUse` is a waterfall that can block with feedback or add context to the downstream decision (`tools/post-execute`), and `Stop` is a serial listener whose blocking result forces another step through `steer()` (`agent/turn-stopping`). The two subagent events emit into the child lifecycle (`subagent/start`, `subagent/end`).
```

Codex 桥接的映射结构相同,只是它只支持前五类事件,不支持 `SubagentStart`/`SubagentStop`(Codex 生态本身当前的 hook 事件集合更小,`PreToolUse` 也没有 allow/ask 两态)：

```text
// packages/hooks/hooks-codex/README.md:54-60
| Your hook | When it runs | What it can do |
|---|---|---|
| `SessionStart` | when a session starts | attach context the model sees in that session |
| `UserPromptSubmit` | when the agent receives a prompt | block the prompt, or attach extra context |
| `PreToolUse` | before a tool runs | block the tool |
| `PostToolUse` | after a tool runs | block the result with feedback, or attach extra context |
| `Stop` | when the run is about to stop | force another step with a reason |
```

两个桥接包共用同一个 `hook-protocol` 底层库,承载真正跟外部世界打交道的脏活——`matcher.ts` 做规则匹配(CC 支持字面量或正则,Codex 只支持正则)、`runner.ts` 真正执行 shell 命令并处理超时/中止、`codec.ts` 把"exit code + stdout + stderr"解析成中立的 `HookOutput`、`merge.ts` 按 `deny > ask > allow` 的优先级合并多个 hook 的结果、`detached.ts` 追踪那些"发出去不等结果"的 fire-and-forget hook 以确保插件卸载时能正确等待或中止它们。顺便一提,`SessionStart` 是否属于 detached 在两个桥接里不一样:Codex 侧的 `SessionStart` 是真 detached(README 明说"the one emit point and runs detached",没有拦截点会等它),而 CC 侧的 `SessionStart` 虽然也用 `detached.track()` 登记,但 `agent/created` 处理器最后会 `await run`——注入的上下文必须在第一个回合之前落位,这是"awaited `agent/created` initialization"这句话的代码落点。

## 常见问题/易踩坑

- **`packages/sdk` 和 `python/sdk` 是不是同一个东西的两份实现？** 不完全是。两者驱动的是设计上高度一致的 wire protocol("design twin"),但 `packages/sdk` 假设调用方清楚自己在启动哪个运行时——给 `profile` + 有序 `patches`,必要时再给一个显式 `dshBin`(不给就解析同版本的 `@deepseek-ai/dsh` 可执行文件)——不做任何单文件打包;Python SDK 则为了让完全不懂 Node 的用户也能用,额外做了"把整个运行时打成单文件 exe"这层分发优化。
- **ACP 是不是给 IDE 插件用的？** 仓库里的文档没有明确提到 IDE 插件这个场景,反而反复强调面向程序化客户端:进程外子代理、测试运行器、脚本控制器,"不是产品 UI"。ACP 协议本身在业界(比如 Zed 编辑器)确实常被用作 IDE 接入 Agent 后端的协议,但 dsh 这边的实现克制地只做了协议服务端本身,没有为任何特定的 IDE 场景做定制。
- **写一个"原生 hook"和用 hooks-claude-code 桥接,效果一样吗？** 语义上是等价的——两者最终都是往 `tools/pre-execute`/`tools/post-execute`/`agent/turn-stopping` 等同一套内部拦截点上挂逻辑。区别只在于:原生 hook 是一个直接写 TypeScript、以 Cordis 插件形式存在的扩展;而 hooks-claude-code/hooks-codex 桥接是"用一份 `hooks.json` 配置外部 shell 命令,由桥接插件负责协议翻译"。
- **Codex 的 `PreToolUse` 为什么没有 `ask` 这一态？** 因为 Codex 生态本身的 hook 协议只有"block/不 block"两种结果(退出码是否为 2),没有第三种"询问用户"的中间态,桥接只能忠实反映这个上游协议的能力边界,不会凭空多造一个 Codex 协议本身不支持的选项。

## 小结

`packages/sdk`、`packages/acp`、`packages/hooks` 这三条对外路径,表面上服务的是完全不同的场景——语言无关的黑盒驱动、业界标准协议对接、生态脚本复用——但背后遵循的是同一条设计原则:**协议是稳定的、可以被独立实现的契约,业务逻辑和内部实现细节永远不应该泄漏到协议层面**。`packages/sdk` 靠一份简单到几行注释就能说清楚的 NDJSON envelope 规则,承载了 Python SDK 和 TypeScript SDK 两份独立实现;`packages/acp` 靠直接采用业界标准包,避免了自造协议带来的兼容性负担;`packages/hooks` 靠把外部协议格式和内部拦截点严格分层,让"跟 Claude Code/Codex 生态字节级兼容"这件麻烦事,完全不影响 dsh 内部"typed interception points"这套核心扩展机制的整洁性。这三条路径共同构成了 dsh"作为黑盒被外部世界驱动"的完整版图。
