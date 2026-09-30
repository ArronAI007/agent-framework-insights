# 对外协议 SDK、ACP 与生态兼容 Hooks：把 dsh 当黑盒用，或者把别人的扩展翻译进来

这一篇要回答的问题是：外部程序想在不了解 `dsh` 内部包结构的前提下驱动它，或者用户想把已有的 Claude Code、Codex hook 脚本直接拿来用，`dsh` 分别提供了什么接口，各自的边界划在哪里。

结论有三句。第一，`packages/sdk` 是任意语言可实现的通用 stdio JSON-RPC 协议，与 Python SDK 驱动同一套 wire protocol，调用方通过 profile 加有序 patches 决定运行时的组成，SDK 只管协议。第二，`packages/acp` 直接采用业界标准 `@agentclientprotocol/sdk`，只做面向程序化客户端的自动化服务器，刻意做窄。第三，`packages/hooks` 不发明新的 hook 协议，而是把外部 shell hook 的字节格式翻译到 `dsh` 已有的类型化拦截点上，字节级兼容与内部语义分成两层。

## 通用 SDK：协议稳定，组成由调用方决定

`packages/sdk/README.md` 的定位是：SDK 家族让另一个进程通过按行分隔的 JSON-RPC 驱动完整的 DeepSeek Harness 运行时。协议包定义公开消息，TypeScript 客户端用一个具名 profile 和有序 patches 启动 `dsh`，服务端在 stdio 上接受请求。客户端可以打开 session、发送 prompt、观察 session 事件、Agent 状态变化和 subagent 完成。这些包不负责创建或配置开发者项目，也不定义另一个应用，真正可运行的 `dsh --profile sdk` 应用在 `packages/bundle/sdk-app`。

这条边界划得很清楚：协议是稳定的、可被任何语言实现的契约，"这个 Agent 装了哪些工具、连哪家模型"由调用方经 profile 和 patches 决定。它与上一篇的 Python SDK 是设计上的孪生。`client.ts` 的模块注释直接写明，Python SDK 的 `HarnessClient` 是其 design twin，两者驱动同一份运行时协议。区别在目标用户：TypeScript 客户端假设调用方"仓库邻近"，接受显式的 `dshBin`，不给就解析同版本的 `@deepseek-ai/dsh` 可执行文件，不做打包；Python 则为不懂 Node 的用户多做了单文件分发。

协议本身是换行分隔的 JSON-RPC 2.0，帧的判定规则和 Python 端一致：`id` 加 `method` 是请求，只有 `id` 是响应，只有 `method` 是通知。畸形行被忽略，handler 失败转成错误帧。方法命名用方向区分风格：客户端到服务端是 `名词/动词`，共三个：`initialize`、`session/prompt`（返回一个 durable enqueue 回执）、`shutdown`；服务端到客户端是 `名词.事件`，共四个：`session.event`（运行时内所有 session、不过滤）、`session.status`（整个 Agent 的 running 与 idle 切换）、`subagent.started`、`subagent.finished`（仅进程内运行）。类型层用 `HarnessSdkRequestMap` 和 `HarnessSdkNotificationMap` 把这张表变成编译期约束。服务端 `handleRequest` 就是对这三个方法的 switch 分派，遇到未知方法抛错。

有两个约束值得记住。一是 stdout 只能是协议帧，服务端 README 要求诊断走 stderr，不要在组合树里放 stdout logger，否则客户端无法逐字节解析。二是 `HarnessClient` 自己 spawn 子进程，而不走 `dsh-subprocess` 服务，模块注释解释了原因：它运行在任何 harness context 之外，属于该 seam 文档化的"SDK 托管传输"例外。它还用 EOF、SIGTERM、SIGKILL 三级阶梯把子进程收拾到静止。高层封装 `DeepSeekHarness` 支持 `await using`，`run()` 返回 `finalResponse`。

## ACP：直接用行业标准，并且故意做窄

`packages/acp` 只有一个包 `dsh-acp`，让受信任的程序和自动化通过标准 Agent Client Protocol 驱动持久的 `dsh` Agent：创建、列出、恢复、关闭会话，挂载标准 MCP 服务器，选择模型与推理强度，发送文本与图片 prompt，接收语义更新，回答权限提示，取消工作，全程无需人工在环。它面向进程外 subagent、测试运行器和脚本控制器，刻意省略 `dsh` 专有的展示数据和交互式 UI 特性。仓库内配套的客户端是 `subagent/subagent-acp`。

关键选择是不自造协议：包依赖 `@agentclientprotocol/sdk`（当前钉在 1.4.0），直接使用 `AgentSideConnection`、`ndJsonStream`、`PROTOCOL_VERSION`、`RequestError` 等，把 Node 的 stdin、stdout 适配成 Web Streams 后交给协议 SDK 装配请求处理器。这避免了"看起来像 ACP 但细节不同"的兼容性负担。

`initialize` 遵循只声明真正挂载了的能力：图片 prompt 是否可用由 `supportsAcpImagePrompts()` 根据当前路由与附件存储算出，音频和嵌入式上下文一律 false，声明 HTTP 形态的 MCP 与 `close`、`list`、`resume` 三种会话能力，`authMethods` 为空，`authenticate` 立即成功，因为这个服务器信任调用方。`session/new` 会先校验绝对工作目录与 MCP 声明，再创建真实的持久化 Agent，并返回完整的配置选项状态。

```text
initialize / authenticate / session/new / session/list / session/resume
session/close / session/set_config_option / session/prompt
session/cancel / $/cancel_request，通知 session/update，请求 session/request_permission
```

README 明确列出不支持的表面：`session/load`、删除、fork、附加目录、SSE 或 ACP-transport MCP、modes、commands、plans、terminals、客户端文件系统操作和 elicitation。相对早期，它新增的是持久会话：现在可以跨进程重启 list、resume、close；`session/resume` 恢复日志而不重放旧更新，`session/close` 则做安静取消、更新排空、后代释放、持久化刷盘，只释放被寻址的 Agent 范围。启动方式是 `dsh --profile acp`，对应 bundle `packages/bundle/acp-app`，它在权限提示上提供一次性的允许或拒绝选项，客户端可自动应答。窄的好处是每个调用只做协议要求的事，人机交互能力属于 Web host 与 client 模块，不进这条路径。

## Hooks：翻译外部协议，而不是重新发明

`packages/hooks` 让 Agent 运行复用为 Claude Code 或 Codex 写的 shell hook：把对应集成指向一份现有的 `hooks.json`，就能在会话开始、prompt 到达、工具运行、运行停止时执行受支持的 command hook。hook 可以用模型可见的消息阻止 prompt 或工具调用，添加对话上下文，或要求运行继续。每个集成只支持其来源工具文档化的 command-hook 子集。

设计洞察是：`dsh` 本来就有一套类型化的拦截点，写原生 hook 就是往这些拦截点挂普通 Cordis 插件。`hooks-claude-code` 与 `hooks-codex` 没有新增能力，只是把外部协议的字节格式翻译成对已有拦截点的调用。两个桥接构造给 shell 命令的 stdin payload 各自贴合生态：Claude Code 桥接的基础字段有 `session_id`、`transcript_path`、`cwd`、`hook_event_name`；Codex 桥接是纯 snake_case，额外带 `model`、`turn_id`、`permission_mode`，且不带结尾换行。两边的 `transcript_path` 现在都是固定空值（前者空字符串，后者 null），因为持久化 seam 不再暴露产物路径，代码注释把它记为一个 durable consumer gap。

事件到拦截点的映射，是这套兼容层最值得细读的部分。工具调用的内部流水线是 `tools/pre-execute`、守卫、`tools/execute`、`tools/post-execute`、`finalizeContent`、`tools/result`。`PreToolUse` 挂在 `tools/pre-execute`，一个瀑布式的允许、拒绝或询问门；hook 判 deny 就返回 `deny`，判 ask 就返回 `ask`，否则 `next()`。`PostToolUse` 挂在 `tools/post-execute`，可以带反馈拦截或附加上下文；关键的细节是即便自己的 hook 没有拦截，也要 `next()` 委托给后面的监听器，再把自己的上下文并到下游决策上，这样一个后续监听器仍能拦截或替换。`UserPromptSubmit` 对应 `agent/pre-step`，`SessionStart` 挂在 `agent/created`，在第一个回合前被 await，产出的上下文用 `agent.inject()` 注入，hook 失败只告警不阻塞启动。

`Stop` 的处理最精巧：它映射到 `agent/turn-stopping`。一个要求继续的 Stop hook 并不需要专门的"阻止停止"API，只需调用 `agent.steer()` 注入一条新消息，turn 收尾时重新检查队列，发现有待处理输入就自然再跑一步。代码里有一条 TODO（stop-loop-guard）：连续强制继续的次数目前没有上限，需要 hook 自己限制。这也印证了 `agent/turn-stopping` 不投票否决、只通过队列决定是否继续的设计。

Codex 桥接映射结构相同，但只支持前五类事件，没有 `SubagentStart` 与 `SubagentStop`，`PreToolUse` 也只有阻止一态，没有 ask，因为 Codex 的 hook 协议本身只有阻止或不阻止，桥接如实反映上游能力，不凭空多造选项。Claude Code 桥接则多支持两个 subagent 事件：`SubagentStart` 可为仍在运行的 subagent 附加上下文（仅限进程内），`SubagentStop` 仅观察。

两个桥接共用底层 `hook-protocol` 库处理脏活：`matcher.ts` 做匹配（Claude Code 支持字面量或正则，Codex 只支持正则），`runner.ts` 执行 shell 命令并处理超时与中止，`codec.ts` 把退出码、stdout、stderr 解析成中立的 `HookOutput`，`merge.ts` 按 `deny > ask > allow` 合并多个 hook 的结果，`detached.ts` 追踪发出去不等结果的 hook，确保插件卸载时能等待或中止。`SessionStart` 在两个桥接里的 detached 程度不同：Codex 侧真 detached，没有拦截点等它；Claude Code 侧虽然登记到 `detached`，但 `agent/created` 处理器最后会 `await run`，因为上下文必须在第一个回合前落位。

## 代价与边界

三条路径的共同代价，是协议一旦对外就要承担兼容责任。SDK 只有三个请求和四个通知，表面很小，能做的事就受限于此；ACP 明确放弃了一长串交互能力；hooks 只支持来源工具的命令子集，并且 `transcript_path` 这类字段拿不到真实值。这些限制是有意的取舍：对外表面越小，内部越能自由演化。

## 小结

- `packages/sdk` 用一份简单的 NDJSON envelope 规则承载 Python 与 TypeScript 两份独立客户端，profile 加 patches 决定运行时组成，SDK 不越界。
- `packages/acp` 直接采用业界标准包，只暴露自动化所需的窄表面，能力声明与实际挂载一致，并支持跨重启的持久会话。
- `packages/hooks` 把外部协议的字节格式与内部拦截点严格分层，`Stop` 通过 `steer()` 复用现有的 turn 收尾机制，而不是新增一个专门 API。

对应原课程篇目：`DeepSeek-Harness/06-跨语言边界与部署形态/04-对外协议SDK-ACP与生态兼容Hooks.md`
