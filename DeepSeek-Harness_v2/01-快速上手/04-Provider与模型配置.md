# Provider 与模型配置

这一篇回答的问题是：`dsh` 怎样做到核心循环不认识任何具体模型厂商，却能随时换模型、换 Key。结论有三句。`packages/llm/llm` 只定义厂商无关的请求与流式响应词汇表，`llm-deepseek`、`llm-pi-ai` 是往上面注册路由的两个平级适配器；一次对话用哪个 provider 和模型，记录在会话日志的请求头里，而不是某个全局变量；密钥走 `credentials`，非敏感偏好走 `settings`，配置同一个模型时两条路径也不合流。

## 厂商无关的词汇表

核心循环里没有 `import { OpenAI } from 'openai'` 这样的代码。请求由 `GenerateOptions` 描述，其中 `provider` 是一个字符串路由 key（例如 `'deepseek-official'`），循环只用它去查注册过的适配器实例，不关心适配器内部是走 HTTP 还是某个 SDK。其余字段也是中性的：`model`、`reasoningEffort`、`messages`、`system`、`tools`、`temperature`、`maxTokens`、`stop`，以及用于取消的 `signal` 和标明用途的 `purpose`（`'compaction'` 或 `'session-title'`）。

响应侧同理。`StreamChunk` 是一组与厂商 SSE 格式无关的增量事件：`block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish`。`types.ts` 的模块注释说明了分工：只有适配器负责把厂商的原始消息翻译成这套词汇，翻译完之后，会话日志、UI 渲染、压缩逻辑看到的永远是同一种结构，不需要为每个厂商写一套平行逻辑。`ContentBlockMap`、`FinishReasonMap` 这些接口被设计成可以用 TypeScript 声明合并扩展的字典，新增一种内容块类型，只需合并一个新 key，不必改动每个消费联合类型的地方。

这套设计的检验标准很朴素：只有一个适配器时，无法判断接口是否足够通用。`llm-pi-ai` 的存在，就是"同一套接口能不能装下风格完全不同的第二个实现"的证明。

## LlmCallConfig 与请求头

一次对话里跨请求保持不变、又影响缓存复用的那几个字段，被单独抽成 `LlmCallConfig`：`provider`、`model`、`reasoningEffort`、`temperature`、`maxTokens`、`stop`，每个字段与 `GenerateOptions` 的同名字段一一对应。注释里最关键的一句是：循环是从记录在日志里的请求头去构造请求，而不是在每次调用时接受这些参数。`packages/core/session` 里的 `EpochHeader` 就是把它包了一层：

```typescript
export interface EpochHeader {
  config: LlmCallConfig
  adapterDefaults?: LlmCallConfigAdapterDefaults
}
```

`adapterDefaults` 标记的是"这个值不是用户显式指定的，而是适配器解析出来的默认值"，比如用户没给 `reasoningEffort`，适配器按模型的默认策略填了 `high`。`agent-loop` 里的 `requestProposal` 会在向插件征询"下一次请求要不要换配置"之前，把带这个标记的字段剥掉。否则切换模型之后，上一个模型的隐式默认会被当成用户锁定的值继续沿用。配置是否发生实质变化，用 `callConfigEquals` 逐字段比较，只有真的变了才追加新的请求头快照。这是"模型可见的一切必须能从日志重建"这条工程规则的一处具体落地：任何影响请求的配置，事后都查得到。

## llm-deepseek：一次连接是怎么组装的

`llm-deepseek` 在 0.1.7 里拆过文件：`index.ts` 只留下一行模块注释（注册带实时配置和请求级凭证的 DeepSeek Messages 适配器），配置词汇表和解析逻辑搬到了同目录的 `config.ts`。`Config` 接口里没有任何字段直接是密钥，只有一个引用名 `apiKeyEnv`，默认是 `DEEPSEEK_API_KEY`。其余字段包括 `baseURL`（缺省时回落到受信环境层的 `$DEEPSEEK_BASE_URL`，再到公共 API）、`thinking`、`reasoningEffort`（取值 `off`、`low`、`high`、`max`，缺省解析为 `high`）、`maxTokens`、`defaultContextWindow`、`models`（模型目录）、`streamIdleTimeoutMs`、`retryPolicy`，以及图片和文件上传的一组限额。所有字段都声明为 `Volatile<...>`，即 Cordis 的"活配置引用"，可以热更新。

解析分两步。`resolveAdapterOptions` 把配置和启动环境合成一份 `ResolvedDeepSeekOptions`，过程中对协议、`baseURL`、各类限额逐字段校验，不合法直接抛错，不会静默忽略。而密钥的真实值要到每次请求即将发出时，才由 `resolveApiKey` 去取：

```typescript
const credentials = ctx.get('credentials')
if (credentials !== undefined) {
  const hit = await credentials.resolve(ref)
  if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-deepseek', ref)
} else {
  const ambient = launchEnvironmentOf(ctx).get(ref)
  if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, 'llm-deepseek', ref)
}
throw new LlmError(`llm-deepseek: no API key for provider route "${PROVIDER}"; ...`, 'MISSING_CREDENTIAL')
```

正常安装下 `dsh-base` 会挂载 `credentials-local`，走它的完整优先级；只有在一个极简 Profile 里整个 Seam 都没有时，才退化成直接读进程环境。没有任何 Key 时，请求以 `MISSING_CREDENTIAL` 失败，而不是在插件加载时失败。每次请求重新解析，意味着在 Web UI 的 Models 页面改一次 Key，下一次对话立刻生效，不用重启。

## 非敏感偏好：settings

`baseURL`、`thinking`、默认 `reasoningEffort`、模型目录这类偏好走另一条路。0.1.7 里 settings 的实现换过一版：以前插件用 `installSettingsSection()` 把 schema 注册成独立命名空间，现在插件把字段声明为 volatile（`schemastery` 的 `.volatile()`），Settings 服务直接按 entry id 暴露这些字段，Web UI 表单读写它们，写回的位置是当前 Profile 的 Cordis 补丁，而不是独立命名空间。`llm-deepseek` 自带设置页面，所以通过 `settings.configure({ auto: false }, ...)` 关掉了自动生成表单，并监听 Loader 的 `loader/volatile-update` 事件来刷新注册。

`packages/settings/settings` 的 README 规定了分层语义：Reset 恢复到 Profile 覆盖层之下的值（含 schema 默认值）；Home 补丁和命令行覆盖层优先级更高，一次表单写入如果会被它们覆盖，会被直接拒绝。这条"值是多少"的链路，与凭证"密钥内容是什么"的优先级链条是两套独立机制。

## llm-pi-ai：另一种拓扑

`llm-deepseek` 是一个插件对应一个 provider 路由；`llm-pi-ai` 则是一个插件实例管理一整个 `providers` 字典。模块注释里的示例把两种写法放在一起：

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openai:                       # catalog route：除凭证外都继承 pi-ai 的目录
        apiKeyEnv: OPENAI_API_KEY
      acme-gateway:                 # 手写 route：pi-ai 里没有这个 key
        apiKeyEnv: ACME_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.acme.example/v1
        models:
          - id: acme-large
            contextWindow: 65536
```

前者的端点、协议、模型目录都来自 pi-ai 自己的知识；后者需要手工补全端点与模型清单，示例里还有 `displayName` 与 `compat.thinkingFormat` 等字段（此处省略）。两种风格最终都通过 `ctx.llm.registerAdapter()` 注册路由，没有绕开接口另起一套逻辑，这正是接口足够通用的证据。

## 三层配置入口

实际配置模型的入口有三层，从低到高：Bundle 自带的默认层（`dsh-base`、`dsh-web-app` 的 `cordis.patch.yml` 里 `llm-deepseek` 那一行的 `config`，例如把模型目录限定为公司批准的几个）；用户设置，即 Web UI 的 Models 页面写入的覆盖，持久化进当前 Profile 的补丁；凭证，只负责 `apiKeyEnv` 引用背后的真实密钥。具体一次对话用什么，记在会话自己的 `EpochHeader` 里，由 `agent-loop` 在 turn 边界读取和比较，这套状态机属于第 04 章。

## 容易踩的地方

改了模型设置没生效时，注意有些"注册时捕获的事实"不会被自动重新解析。比如 `retryPolicy` 是在注册路由时读入的，配置变更后要通过 `registration.replace([PROVIDER], ...)` 重新注册才能生效，`ctx.on('loader/volatile-update', ensureRegistrationFacts)` 监听器做的就是这件事。另一个常见误解是把密钥直接写进 `apiKeyEnv`：它永远是环境变量名，不是值。给 `llm-pi-ai` 声明的路由不生效，则先查路由名是否冲突、`models` 里的字段是否合乎 schema（`id` 非空，`contextWindow` 为正整数），装配阶段的校验失败会直接抛错。

## 小结

1. 核心循环只认 `provider` 字符串路由和一套中性的 `GenerateOptions` 与 `StreamChunk`，厂商差异由适配器吸收；`llm-deepseek` 与 `llm-pi-ai` 用两种不同拓扑验证了接口的通用性。
2. 每次对话的 provider、模型、推理强度记录在 `EpochHeader`，适配器填的默认值被单独标记，配置变化才追加快照，保证事后可追踪。
3. 密钥每次请求时经 `credentials` 解析，偏好经 `settings` 落进 Profile 补丁，两条路径互相独立。

更详细的源码走读见 `DeepSeek-Harness/01-快速上手/04-Provider与模型配置.md`。
