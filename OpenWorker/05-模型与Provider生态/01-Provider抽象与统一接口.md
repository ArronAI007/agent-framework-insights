# Provider 抽象与统一接口

> `coworker/providers/` 用一个只有两个抽象方法的基类 `ProviderClient`,把 OpenAI、Anthropic、Gemini、Bedrock、Vertex、Codex 订阅这些形状迥异的模型接口,收敛成引擎唯一认识的一种调用方式。真正值得琢磨的是它的取舍:内部消息表示选的是 OpenAI Chat Completions 的形状而不是任何"中立"格式,错误处理没有做成一张跨厂商的分类表而是只解决了一个具体的用户体验问题,Provider 的路由也不是靠猜模型名,而是靠一个显式的 `provider:` 前缀外加一份用户自己配置的档案。这三处"没有做成教科书式抽象"的地方,恰恰是读懂这一层设计意图的钥匙。

## 学习目标

- 读懂 `ProviderClient` 这个抽象基类的最小契约:`complete()`/`capabilities()` 两个必须实现的方法,以及 `stream()` 的默认降级实现如何让"不支持流式"的接入方式免费获得一个能用的行为。
- 理解 `AssistantTurn`/`TokenUsage`/`ModelCapabilities` 这几个跨 Provider 共享的数据结构,尤其是 `extras` 这个"厂商私有边车(sidecar)"字段的契约——它是如何在一次对话中支持中途切换 Provider 的。
- 看懂 `ProviderRouter` 如何用模型字符串的 `provider:` 前缀做路由、懒加载并缓存具体客户端,以及它和 `registry.py` 里 `ProviderDescriptor` 的分工。
- 弄清 `providers/errors.py` 实际解决的问题范围——它不是一张跨厂商的错误分类表,而是一个专门翻译"账号没权限/额度不够"这两类失败的小工具,以及真正的重试逻辑分散在哪里。

## 背景与设计动机

OpenWorker 的引擎(`coworker/engine.py`)要能在一次会话里自由切换模型:今天用 Claude Fable 5,明天换成本地 Ollama 跑的 Qwen,后天又想省钱换到某个 OpenAI 兼容网关。如果 `engine.py` 里到处写 `if provider == "anthropic": ... elif ...`,新增一个厂商就要动核心循环。`coworker/providers/base.py` 的模块级 docstring把这件事说得很直白:

> "The runtime never imports a provider SDK directly — it talks to a `ProviderClient`."

这是整套抽象的出发点。但 OpenWorker 面对的复杂度和很多同类项目不完全一样:它不只是要抹平"消息格式""工具调用格式""流式协议"这几个维度的差异,还要在同一个抽象下装下三种性质完全不同的鉴权方式——API Key 直连、云账号内的 IAM/ADC、以及复用 ChatGPT 订阅的 OAuth——并且要在用户的 Provider 之间**保留跨轮对话的连续性**(比如 Gemini 的 thought signature、OpenAI Responses 的加密推理内容,必须原样回放,不能因为格式统一就被抹掉)。下一篇会看到,这些差异细节几乎全部被压进具体 Provider 实现内部;这一篇先把"引擎面对的到底是什么"讲清楚。

## 核心机制详解

### `ProviderClient`:两个抽象方法,一个免费的降级实现

```python
# coworker/providers/base.py
class ProviderClient(ABC):
    """Single-shot, provider-agnostic completion interface.

    Deliberately blocking (the turn engine wraps it in `asyncio.to_thread`) and
    deliberately without a `max_turns` loop — the runtime owns the agent loop.
    """

    @abstractmethod
    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        **settings: Any,
    ) -> AssistantTurn:
        """Return one assistant turn for the given messages/tools."""

    @abstractmethod
    def capabilities(self, model: str) -> ModelCapabilities:
        """Return capability flags for the given model."""

    def stream(self, *, model, messages, tools=None, **settings):
        """Yield StreamChunks. Default: no token streaming — one final chunk with the
        full turn. Providers that support streaming (OpenAIProvider) override this."""
        yield StreamChunk(
            turn=self.complete(model=model, messages=messages, tools=tools, **settings)
        )
```

契约刻意做得很窄:一次调用只产出**一个** `AssistantTurn`(文本 + 工具调用 + 结束原因),没有 `max_turns` 或者内建的多轮循环——docstring 里写得很明确,agent loop 是引擎自己的事,Provider 只负责"帮我把这一轮请求发出去、把结果解析回来"。`stream()` 不是抽象方法,而是一个**默认实现**:直接调用 `complete()`,把整段结果包成唯一一个 `StreamChunk`。这意味着任何一个只实现了 `complete()`/`capabilities()` 的最简 Provider 都能直接工作在流式接口之下——只是体验上没有逐字符输出。这是一处很实用的"能力最小化实现":新增一个 Provider 时,先把 `complete()` 写对,`stream()` 可以晚一点再优化,而不是必须一次性啃下 SSE 解析才能接入。

### 跨 Provider 共享的数据结构:`AssistantTurn` 与 `extras` 边车

```python
# coworker/providers/base.py
@dataclass
class AssistantTurn:
    text: Optional[str] = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: Optional[str] = None
    raw: Any = field(default=None, repr=False, compare=False)
    # The model's thinking text (DeepSeek reasoning_content, Gemini thought summaries, …).
    # Display-only: persisted on the assistant message as the `reasoning` sidecar and shown
    # in the GUI, but stripped before every provider call — never replayed as context.
    reasoning: Optional[str] = None
    # Provider-private sidecars to persist on the canonical assistant message
    # (underscore-prefixed keys, e.g. `_gemini` thought signatures). Contract: the
    # owning provider consumes its own key when converting history; every other
    # provider must strip or ignore foreign underscore keys before its wire call.
    extras: dict[str, Any] = field(default_factory=dict)
    usage: Optional[TokenUsage] = None
```

`extras` 是整个统一层里最耐人寻味的一个字段。Gemini 3 的 `thought_signature`、OpenAI Responses 的加密推理内容(`encrypted_content`)、Anthropic 的 `thinking`/`redacted_thinking` 块,都必须**原样回放**才能让模型在下一轮工具调用里保持推理连续性——但这些东西是各家协议私有的,没有办法统一成一种中立格式。`base.py` 的解法不是强行统一,而是承认"统一不了"并给出一个显式契约:每个 Provider 把自己的私有数据写进 `extras` 里以下划线开头的键(`_gemini`、`_openai`、`_anthropic`),只有"发行"这个键的 Provider 在把历史转换成自己的请求格式时才会读它,其他 Provider 一律忽略或剥离。

这个契约在 `openai_provider.py` 里能直接看到消费端:

```python
# coworker/providers/openai_provider.py
def _strip_foreign_sidecars(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop provider-private message sidecars (underscore-prefixed keys, e.g. `_gemini`
    thought signatures — see providers/base.py): they belong to other providers, and the
    OpenAI wire (and its compat servers) rejects unknown message fields."""
    return [
        (
            {k: v for k, v in m.items() if not k.startswith("_")}
            if any(k.startswith("_") for k in m)
            else m
        )
        for m in messages
    ]
```

这就是"一次会话中途切换模型厂商"这个功能背后的真正机制:历史消息里可能同时躺着 `_gemini`、`_openai`、`_anthropic` 三种边车,只有当前生效的 Provider 会去认领属于自己的那个键,其余的原样丢弃——而不是报错或者污染下游请求。

另外值得注意的是,`AssistantTurn` 里的规范消息形态是**OpenAI Chat Completions 的形状**(`role`/`content`/`tool_calls`),而不是任何厂商中立的格式,也不是 Anthropic 的形状。`anthropic_provider.py` 的模块 docstring 说得很直接:"the runtime's canonical message format is OpenAI-shaped ... so this module is mostly a pair of pure converters"。也就是说,Anthropic、Gemini、Bedrock 都要向 OpenAI 的消息形状"倒着转换",而不是相反。这和它复用 OpenAI SDK(`openai_provider.py`)覆盖十几家厂商的事实是一致的选择——既然大多数第三方厂商本来就是抄 OpenAI 的协议,把内部形状锚定在 OpenAI 上,能让"倒转"这件事只集中在原生的 Anthropic/Gemini/Bedrock 几个适配器里发生,而不需要每加一个 OpenAI 兼容供应商就多写一次转换代码。

`ModelCapabilities` 同样是一个跨 Provider 共享的小契约:

```python
# coworker/providers/base.py
@dataclass(frozen=True)
class ModelCapabilities:
    """What a given model/provider can do; used for graceful degradation."""
    tools: bool = True
    vision: bool = False
    pdf: bool = False
    parallel_tool_calls: bool = True
    streaming: bool = True
```

它的作用是"优雅降级"——比如一个模型没有原生 PDF 支持,上层就会退回到本地的文本提取或转图片(`pdf_support.py`),而不是直接报错。第三篇会详细展开这份能力是怎么被声明和查询的。

### `ProviderRouter`:靠前缀路由,不靠猜模型名

```python
# coworker/providers/router.py
class ProviderRouter(ProviderClient):
    def _provider_name(self, model: str) -> str:
        """The provider for a model: the `prefix` of `prefix:rest` if it's a known provider,
        else the default."""
        if ":" in model:
            prefix = model.split(":", 1)[0]
            if get_descriptor(prefix) is not None:
                return prefix
        return self._default

    def _client_for(self, model: str) -> ProviderClient:
        name = self._provider_name(model)
        with self._lock:
            client = self._clients.get(name)
            if client is None:
                profile = self._secrets.get(f"provider:{name}") or {} if self._secrets else {}
                client = build_provider_client(name, profile, self._secrets)
                self._clients[name] = client
            return client
```

`ProviderRouter` 本身也实现了 `ProviderClient`——它是 `SessionManager` 交给引擎的**唯一**一个 Provider 实例,`complete()`/`stream()` 每次调用时才根据模型字符串的前缀(比如 `ollama:llama3.3`、`bedrock:claude/anthropic.claude-sonnet-4-6-v1:0`)决定该转发给哪个具体客户端。`get_descriptor(prefix)` 会去查 `registry.py` 里登记的 Provider 名字表,只有前缀精确匹配一个已知 Provider 才会被当成路由前缀——这个判断很重要,因为像 `qwen2.5-coder:32b` 这种模型名本身也带冒号(版本标签,不是前缀),`_bare()` 里做的是同样的判断,以免把版本号误当成 Provider 前缀截掉。

客户端是**懒加载并缓存**的:第一次遇到某个 Provider 前缀,才会从 `SecretStore` 读取 `provider:<name>` 这份用户配置档案,调用 `build_provider_client()` 实例化,然后缓存住。`invalidate()` 用于配置变更(用户在设置里换了 Key、改了 Ollama 地址)后清空缓存,让下一次调用重新构建——这样正在运行的引擎实例不需要重建就能感知到新配置。

这里有一处值得对照的架构选择:`ProviderRouter` 的路由**不是**靠嗅探模型名/密钥前缀/base_url 关键词去猜该用哪种协议(那是 `registry.py::detect_provider()` 做的事,而且只用于新手引导时"粘贴一个 key,猜你想连哪家"这个场景,下一节细讲),而是靠模型字符串里显式写出来的 `provider:` 前缀,这个前缀又对应用户在设置里选中并保存的一份 `ProviderDescriptor` 配置档案。换句话说,"这次请求该用哪个 Provider"这件事在 OpenWorker 里从来不是运行时猜出来的,而是配置时就已经确定、只是编码进了模型字符串里而已。

### `registry.py` 与 `ProviderRouter` 的分工

`registry.py` 里的 `ProviderDescriptor` 和 `ProviderField` 是两个更偏"配置与 UI"的数据结构(下一篇会展开每个具体 Provider 的 `build()` 工厂函数),这里先看它和路由器的接口:

```python
# coworker/providers/registry.py
def build_provider_client(name: str, profile: dict[str, Any], secrets: Any) -> ProviderClient:
    """Build a `ProviderClient` for `name` from its stored profile. Unknown → OpenAI default."""
    descriptor = _BY_NAME.get(name) or _BY_NAME["openai"]
    return descriptor.build(profile or {}, secrets)
```

`ProviderRouter` 只依赖这一个函数(以及 `get_descriptor()` 判断前缀是否是已知 Provider),它不关心具体某个 Provider 需要几个配置字段、认证方式是 API Key 还是 OAuth——这些细节全部封装在 `ProviderDescriptor.build` 这个工厂闭包里。这是一处清晰的关注点分离:`router.py` 只管"路由 + 缓存 + 转发",`registry.py` 只管"给定一份配置,造出一个能用的客户端"。

### `providers/errors.py`:一个窄范围的翻译器,不是错误分类表

读到 `providers/errors.py` 时容易先入为主地以为这是一张"限流/认证失败/服务端错误"的统一分类表——但读完代码会发现,它实际只做一件很具体的事:

```python
# coworker/providers/errors.py
"""Friendly translation of model access + quota failures. ...
Matching is on the error BODY text (error codes/types), not just HTTP status — a 404 also
means "wrong base_url" and a 429 also means "slow down", and neither of those should be
dressed up as an access problem.
"""

_NO_ACCESS = (
    "model_not_found",
    "does not exist or you do not have access",
    "does not have access to model",
    "permission_error",
    "permission denied",
)
_NO_QUOTA = (
    "insufficient_quota",
    "exceeded your current quota",
    "credit balance is too low",
    "billing hard limit",
)

def friendly_model_error(model: str, exc: Exception) -> Optional[str]:
    """One actionable sentence for "your account can't use this model" failures, or None."""
    ...
```

它只匹配两类失败——"账号没有这个模型的访问权限"和"账号额度/信用不够"——把厂商各自晦涩的错误体翻译成一句用户能看懂、能行动的话;其余情况一律返回 `None`,让调用方原样展示原始异常。`coworker/engine.py` 里唯一的调用点印证了这一点:

```python
# coworker/engine.py
except Exception as exc:  # provider failure
    ...
    friendly = friendly_model_error(self.model, exc)
    payload = {"error": friendly or str(exc), "error_type": type(exc).__name__}
    ...
```

也就是说,`errors.py` 解决的是一个具体的**产品体验问题**——新模型灰度发布、账号欠费这类高频出现且原始错误信息很难看懂的失败——而不是一层通用的"限流该怎么重试、认证失败该怎么提示"的跨 Provider 错误分类基础设施。真正的重试逻辑其实分散在别处,而且每处都不一样:

- `openai_provider.py`/`openai_responses.py` 里各自有一个 `_param_fix_retry()`,专门处理"服务端拒绝了某个具体参数"(比如 `max_tokens` 该叫 `max_completion_tokens`、`reasoning_effort` 不该和工具调用同时出现)这一类 400 错误,靠字符串匹配错误信息里点名的参数名,精确地只修那一个参数,最多重试三次。
- `codex_provider.py` 里对 401 做"刷新令牌后重试一次",对 429 直接翻译成订阅额度用尽的提示(这部分下一篇细讲)。
- `coworker/engine.py` 里还有一层专门识别"上下文溢出"异常(`_compaction.is_context_overflow(exc)`)、触发强制压缩后重试的逻辑,和模型访问/额度错误完全是另一条路径。

这种"不集中、按失败类型各自就近处理"的做法,和 `ProviderClient` 契约本身的态度是一致的:统一层只统一了"调用形状",没有假装能统一"失败的语义"——不同厂商、不同失败原因需要的修复动作差异太大,勉强塞进一张通用分类表反而会丢失每种失败真正需要的上下文。

## 常见问题/易踩坑

- **`ProviderRouter` 是不是也做协议探测?** 不是。协议探测(靠密钥前缀/模型名猜厂商)只存在于 `registry.py::detect_provider()`,而且只服务于新手引导 UI 的"贴一个 key,自动选中对应的 Provider 表单"这个场景。运行时路由完全靠模型字符串里显式的 `provider:` 前缀,不做任何猜测。
- **为什么内部消息格式是 OpenAI 形状,而不是设计一种真正中立的格式?** 因为绝大多数第三方厂商本身就是在抄 OpenAI 的协议(Chat Completions),把内部形状锚定在 OpenAI 上可以让"格式转换"这件事只在原生的 Anthropic/Gemini/Bedrock 几个适配器里发生一次,不需要为每个新增的兼容供应商都写一遍双向转换。
- **`extras` 里的下划线字段会不会互相污染?** 不会,前提是每个 Provider 都遵守"只读自己发行的键、忽略/剥离别人的键"这条契约——`openai_provider.py` 的 `_strip_foreign_sidecars()` 就是这条契约在消费端的落地。
- **`providers/errors.py` 能覆盖所有失败场景吗?** 不能,也没打算覆盖。它只翻译"没权限"和"没额度"这两类高频且原始信息很难懂的错误;其余异常原样透出,各 Provider 自己的重试逻辑(参数修复、令牌刷新、上下文压缩触发)分别处理各自的失败模式。

## 小结

`ProviderClient` 把统一层的契约压缩到最小:一个 `complete()`、一个 `capabilities()`,`stream()` 有免费的降级实现。真正跨 Provider 共享的,是 `AssistantTurn`/`TokenUsage`/`ModelCapabilities` 这几个数据结构,尤其是 `extras` 这个"厂商私有边车"字段,用一个显式契约而不是强行统一,解决了"内部推理状态没法跨协议中立化,但又要支持中途切换 Provider"这个真实难题。路由靠的是模型字符串里的 `provider:` 前缀加上用户配置好的档案,而不是运行时猜测;错误处理也没有做成一张大而全的分类表,只解决了"账号权限/额度"这个高频体验问题,其余失败模式分散在各 Provider 和引擎自己的重试逻辑里就近处理。

这些"统一了什么、又刻意没有统一什么"的边界,下一篇会在具体的 Provider 实现里看到更多细节:Anthropic 的扩展思考和拒答降级、OpenAI 新旧两套协议为什么并存、Gemini 与 Vertex 的关系、Bedrock 怎么用惰性导入把 `boto3` 变成可选依赖、以及 Codex 订阅认证这一整套 OAuth 流程。
