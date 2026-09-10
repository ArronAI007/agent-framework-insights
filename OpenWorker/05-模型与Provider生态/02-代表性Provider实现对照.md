# 代表性 Provider 实现对照

> README 的"Bring your own model"一节列出了十几个厂商名字,但 `coworker/providers/` 目录下只有 15 个文件。这不是巧合,而是这一层设计里最值得注意的一点:大部分厂商名字背后根本没有专属的实现类——GLM、DeepSeek、Kimi、MiniMax、Qwen、xAI、Mistral、Meta,再加上 Together/Fireworks/OpenRouter 三家转售平台和本地的 Ollama,十几个名字全部复用同一个 `OpenAIProvider`(Chat Completions)类,区别只是 base_url 和 api_key 从哪个配置槽位读。真正需要独立协议适配的,只有 Anthropic、Gemini 两个原生实现,以及 OpenAI 自己因为一次协议分裂而多出来的第二套客户端,再加上云托管场景(Bedrock/Vertex)和订阅复用场景(Codex)这两类要在"认证方式"上做文章的特例。

## 学习目标

- 分清"一个 Provider 实现文件覆盖多个厂商"(OpenAI 兼容协议)和"一家一个原生实现"(协议差异大到必须单独适配)这两类,并能把 README 里列出的每个厂商对号入座。
- 读懂 `AnthropicProvider` 里两套并存的扩展思考(extended thinking)配置、以及 Fable/Mythos 模型的拒答自动降级机制。
- 理解 OpenAI 为什么在这个仓库里有两个 Provider 类(`OpenAIProvider` 与 `OpenAIResponsesProvider`),分别覆盖 Chat Completions 和 Responses 两套协议,以及路由层怎么决定用哪一个。
- 看懂 `VertexProvider`/`BedrockProvider` 这两个"家族分发器"如何用组合(而不是重新实现)复用 `AnthropicProvider`/`GeminiProvider`/`OpenAIProvider`,以及 `bedrock` 依赖为什么要做成惰性导入的可选安装项。
- 读懂 `CodexProvider` 如何靠继承 `OpenAIResponsesProvider`,只替换"怎么拿到一个能用的 Bearer token"这一件事,就把 ChatGPT 订阅复用接了进来。

## 背景与设计动机

README 里"Bring your own model"这一节把厂商列成一串平铺的名字:

> OpenAI · Anthropic · Google Gemini · BytePlus Ark · Volcengine Ark Agent Plan · Inkling (Thinking Machines) · GLM (Z.ai) · DeepSeek · Kimi (Moonshot) · Qwen · MiniMax · Mistral · Grok (xAI) · 以及通过 Together 和 Fireworks 的开放权重模型,通过 Ollama 的本地模型。

如果按"一个厂商一个实现类"的直觉去数,`coworker/providers/` 目录下应该有十几个文件——但实际只有 15 个 `.py` 文件,其中还包含 `base.py`/`registry.py`/`router.py`/`errors.py`/`capabilities.py`/`matrix.py` 这些不对应任何具体厂商的基础设施文件。答案在 `registry.py` 里已经埋好了:大部分厂商走的是**同一条 OpenAI 兼容协议**,真正需要协议级适配的只是少数几家。这一篇把"哪些厂商共享同一个类""哪些厂商必须单独写"这条边界画清楚,再深入每个原生实现各自要解决的具体问题。

## 核心机制详解

### 一个类覆盖十几个厂商:OpenAI 兼容协议阵营

`registry.py` 里的 `_compat()` 辅助函数是这条阵营的入口:

```python
# coworker/providers/registry.py
def _openai_compat(vendor: str, default_base_url: str, env_key: Optional[str] = None):
    """Builder factory for vendors reached through their OpenAI-compatible API (Z AI, DeepSeek,
    Kimi, MiniMax, Qwen, xAI, Mistral). The key is resolved from the vendor's OWN profile (or its
    env var) — deliberately NOT from the OpenAI env/SecretStore fallback, so a configured OpenAI
    key is never silently sent to a different vendor's endpoint.
    """
    def build(profile: dict[str, Any], secrets: Any) -> ProviderClient:
        base_url = ((profile or {}).get("base_url") or "").strip() or default_base_url
        api_key = ((profile or {}).get("api_key") or "").strip() or (
            os.environ.get(env_key, "").strip() if env_key else ""
        )
        if not api_key:
            raise RuntimeError(f"No {vendor} API key configured — add it in Settings ▸ Models.")
        return OpenAIProvider(api_key=api_key, base_url=base_url)
    return build
```

`_compat("zai", "Z AI (GLM)", base_url="https://api.z.ai/api/paas/v4", ...)` 这样的调用,给 GLM、DeepSeek、Kimi、MiniMax、Qwen、xAI(Grok)、Mistral、Meta(Muse Spark)各自登记了一个 `ProviderDescriptor`,但它们的 `build()` 工厂全部指向同一个 `OpenAIProvider(api_key=..., base_url=...)`——**没有一行厂商专属的转换代码**。README 里列出的这八九家厂商,底层其实是同一个类的八九份不同配置实例。转售平台 Together、Fireworks、OpenRouter 走的是同一条路,区别只是它们的模型 id 是"reseller 命名空间"形式的丑名字(比如 `together:zai-org/GLM-5.2`),这些丑名字在 `matrix.py` 里被单独登记(下一篇细讲)。本地的 Ollama 也复用同一个类,只是塞进一个占位符 API Key(`_build_ollama`),因为 Ollama 的 OpenAI 兼容端点根本不校验这个字段。

`registry.py` 的模块 docstring 里有一句注释解释了为什么密钥解析要"按厂商各自隔离"而不是统一走一个 OpenAI 兜底:一个配置好的 OpenAI Key 绝不能被静默地发到另一个厂商的端点去——每个兼容厂商的 Key 只能从它自己的配置槽位或者自己的环境变量里读,读不到就直接报一个点名该厂商的错误,而不是"借用"别家的凭据。

BytePlus Ark 和 Volcengine Ark Agent Plan 是这条阵营里一个稍微特殊的分支——它们实现的不是 Chat Completions,而是 OpenAI 的 **Responses** 协议,所以走的是 `_openai_responses_compat()` / `_responses_compat()`,底层是 `OpenAIResponsesProvider` 而不是 `OpenAIProvider`。`registry.py` 里专门留了一条注释解释为什么这两家被登记成两个完全独立的 Provider 身份,而不是合并成一个"Ark"条目:

```python
# coworker/providers/registry.py
# Ark has two intentionally separate provider identities. BytePlus pay-as-you-go and
# Volcengine Ark Agent Plan use different regions, endpoints, credentials, and model catalogs;
# combining them would let one provider profile route a model to the wrong service.
```

### 需要原生实现的两家:Anthropic 与 Gemini

Anthropic 和 Gemini 的协议形状和 OpenAI 差异大到没法复用——工具结果的表达方式、系统提示词的位置、流式事件的粒度都不同——所以各自有一个从零写的转换层(上一篇已经看过 `anthropic_provider.py::convert_messages`/`convert_tools` 的核心转换逻辑,这里补两处它们各自要解决的"协议专属"难题)。

**Anthropic 的扩展思考(extended thinking)是模型代际相关的**,`anthropic_provider.py` 里维护了一份前缀表来区分两种完全不同的请求形状:

```python
# coworker/providers/anthropic_provider.py
# - Pre-4.6 models (Haiku 4.5, Sonnet 4.5, Opus 4.5 and older): thinking needs
#   {"type": "enabled", "budget_tokens": N}.
# - 4.6+ and the Claude 5 family: budget_tokens is deprecated/REMOVED (hard 400 on 4.7+) —
#   use {"type": "adaptive"}. display: "summarized" is required to get trace text on 4.7+.
_BUDGET_THINKING_PREFIXES = (
    "claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5",
    "claude-opus-4-1", "claude-opus-4-0", "claude-sonnet-4-0", "claude-3", "claude-2",
)

def _uses_budget_thinking(model: str) -> bool:
    return model.startswith(_BUDGET_THINKING_PREFIXES)
```

同一个 Provider 类要同时兼容"旧代际必须显式给思考预算"和"新代际预算参数直接 400、只能用自适应模式"两种协议行为,靠的就是按模型名前缀分派——这类"协议随模型代际漂移"的知识,和上一篇提到的"厂商专属知识封死在适配器内部"是同一个设计原则。

Anthropic 还有一处更特殊的处理:Fable/Mythos 系列模型内建了安全分类器,可能对"擦边但无害"的请求直接拒答(HTTP 200,但 `stop_reason` 是 `"refusal"`)。`_request_kwargs()` 对这类模型自动带上一个 beta 参数,让服务端在拒答时**自动**降级到 Opus 4.8 重新生成一次:

```python
# coworker/providers/anthropic_provider.py
_FALLBACK_BETA = "server-side-fallback-2026-06-01"
_FALLBACK_MODEL = "claude-opus-4-8"

def _needs_refusal_fallback(model: str) -> bool:
    return model.startswith(("claude-fable", "claude-mythos"))
```

而如果拒答一路"扛"到了降级模型依然被拒,`_raise_on_refusal()` 会把它转换成一个普通的 `RuntimeError`,让引擎当作可重试的错误呈现给用户,而不是让对话悄无声息地卡在一段空文本上。

**Gemini 的原生实现要解决的是完全不同的一类问题**:函数调用在 Gemini 的协议里没有 id,必须靠一个 `id → name` 的映射把工具结果对应回正确的函数调用(`convert_messages` 里的 `call_names` 字典);而 Gemini 3 的"思考签名"(`thought_signature`)必须原样回传,否则多轮工具调用会中断——这正是上一篇提到的 `_gemini` 边车字段的来源。另外 Gemini 的工具参数 schema 是 OpenAPI 3.0 的子集,`_sanitize_schema()` 要递归剥掉 `additionalProperties`、`$schema` 这类它不认识的 JSON Schema 关键字,还要把 JSON Schema 的联合类型(`["string", "number"]`)转换成 Gemini 认识的 `anyOf` 形状——docstring 里点名了这是被 MCP 工具的 schema 实际"炸"出来的兼容性坑,不是纸上谈兵的假设。

### OpenAI 自己也有两套协议并存

OpenAI 是这套体系里比较特殊的一个厂商——它自己名下就有两个 Provider 类,`openai_provider.py::OpenAIProvider`(Chat Completions)和 `openai_responses.py::OpenAIResponsesProvider`(Responses API)。原因写在两个文件的 docstring 里:

```python
# coworker/providers/openai_provider.py
"""OpenAI Chat Completions provider — the compat workhorse.
... Native OpenAI models (the `openai` provider with no custom endpoint) route to
`openai_responses.OpenAIResponsesProvider` instead — Chat Completions rejects function
tools combined with reasoning on GPT-5.6+, so reasoning + tools needs `/v1/responses`.
"""
```

GPT-5.6 这一代模型,只要工具和"非 none 的推理强度"同时出现在 Chat Completions 请求里就会被拒绝,必须换成 Responses API 才能同时要工具调用和真正的推理强度。`registry.py::_build_openai()` 就是这个分流点:

```python
# coworker/providers/registry.py
def _build_openai(profile: dict[str, Any], secrets: Any) -> ProviderClient:
    base_url = ((profile or {}).get("base_url") or "").strip() or None
    if base_url:
        return OpenAIProvider(secrets=secrets, base_url=base_url)
    return OpenAIResponsesProvider(secrets=secrets)
```

没有自定义端点(用户直接用官方 OpenAI)就走 Responses API,拿到完整的推理 + 工具能力;一旦用户填了自定义端点(Azure OpenAI 的 `/openai/v1`、自建的 vLLM、以及前面提到的一整批"OpenAI 兼容"厂商),就退回 Chat Completions——因为这些端点普遍只实现了 Chat Completions,没有实现 Responses 协议。`OpenAIProvider` 自己也针对这种情况做了兜底:只要工具和 `gpt-5.6` 系模型同时出现,就强行把 `reasoning_effort` 钉死为 `"none"`(`_pin_reasoning_effort`),防止某个转发到 GPT-5.6 的自定义端点因为同样的限制被拒;`_param_fix_retry()` 还准备了针对"服务端说不支持某个参数"的一次性修复重试,专门应付各家兼容服务器在 `max_tokens`/`reasoning_effort`/`stream_options` 上参差不齐的实现差异。

`OpenAIProvider` 里还有一段专门为本地弱模型准备的"救援"逻辑:一些通过 Ollama 跑的模型(尤其是 Qwen 系)不会把工具调用放进结构化的 `tool_calls` 字段,而是直接把调用写成文本——`<tool_call>{...}</tool_call>`、裸的 `{"name","arguments"}` 对象,或者 Qwen/Hermes 特有的 `<function=NAME><parameter=KEY>VAL</parameter></function>` XML 形式。`_salvage_tool_calls_from_text()` 按这几种已知形状依次尝试解析,只有真正解析出结构化调用时才生效,否则原样当成普通文本——这不是理论设计,而是本地弱模型在生产环境里真实暴露出来的兼容性负担,只有走 Chat Completions 协议的厂商才会遇到(Responses API 和原生 Anthropic/Gemini 不需要这层救援)。

### `VertexProvider`/`BedrockProvider`:组合复用而非重新实现

Vertex 和 Bedrock 是两个"云托管账号"场景——模型跑在用户自己的 GCP/AWS 账号里,但很多模型本身还是 Claude 或 Gemini,只是换了一层云厂商的传输和认证。两个 Provider 类都采用了同一种设计:**按模型 id 里的"家族段"分发,复用已有的原生 Provider 类,而不是重新实现一遍协议转换**。

```python
# coworker/providers/vertex_provider.py
"""Routed ids look like `vertex:<family>/<model id>` ...
- `gemini/…`     → the native `GeminiProvider` over `genai.Client(vertexai=True)`.
- `claude/…`     → the native `AnthropicProvider` over the SDK's `AnthropicVertex` client.
- `openweight/…` → `OpenAIProvider` against Vertex's OpenAI-compatible MaaS endpoint.
"""
```

```python
# coworker/providers/vertex_provider.py
def _family_client(self, family: str) -> ProviderClient:
    ...
    if family == "gemini":
        sdk = genai.Client(vertexai=True, project=self._project, location=self._location,
                            credentials=self._explicit_credentials())
        client = GeminiProvider(client=sdk)
    else:
        sdk = AnthropicVertex(project_id=self._project, region=self._location,
                               credentials=self._explicit_credentials())
        client = AnthropicProvider(client=sdk)
    ...
```

`GeminiProvider`/`AnthropicProvider` 本身就支持"注入一个自定义 SDK client"这个构造参数(上一篇 `AnthropicProvider.__init__` 里的 `client: Any = None` 就是为测试和这种复用场景准备的),`VertexProvider` 只是换了一个认证方式不同、`base_url` 不同的 SDK client 塞进去,消息转换、流式解析这些真正复杂的逻辑完整复用,一行都不用重写。第三种家族 `openweight`(跑在 Vertex 的 Model-as-a-Service 端点上的开放权重模型,比如 Llama、Qwen)则复用 `OpenAIProvider`,因为 MaaS 端点本身就是 OpenAI 兼容协议,只是认证换成了一个每小时过期、需要主动刷新的 Google bearer token——`_openweight_client()` 里能看到token 过期检测和 SDK client 重建的逻辑。

`BedrockProvider` 是同一个模式的另一份实例:

```python
# coworker/providers/bedrock_provider.py
"""Routed ids look like `bedrock:<family>/<bedrock model id>` ...
- `claude/…`  → the native `AnthropicProvider` over the SDK's `AnthropicBedrock` client,
  so Claude-on-Bedrock gets everything direct Anthropic gets (thinking, refusal handling).
- `other/…`   → the Converse API (`bedrock-runtime.converse/converse_stream`), Bedrock's
  unified wire format across Llama, Nova, Mistral, Cohere, DeepSeek, …
"""
```

`claude/` 家族复用 `AnthropicProvider`(换成 `AnthropicBedrock` SDK client),因此拿到和直连 Anthropic 完全一样的扩展思考、拒答降级能力;`other/` 家族(Llama、Nova、Mistral 等等)则是仓库里唯一一处**真正独立实现**的转换层——`_BedrockConverseClient`——因为 AWS 的 Converse API 是它自己发明的统一格式(`toolUse`/`toolResult`/`reasoningContent` 这些字段名和 Anthropic、OpenAI 都不一样),既不是 Anthropic 的形状也不是 OpenAI 的形状,没有任何已有转换器可以直接复用。

这里能看到 `Bedrock`/`Vertex` 和上一篇讲过的"OpenHarness `CopilotClient` 用组合复用 `OpenAICompatibleClient`"是同一类设计手法在这个项目里的对应版本:协议相同的部分坚决复用,协议独有的部分(这里是 Converse API)才值得单独写一份转换层。

### `bedrock` 依赖的惰性导入:让 `boto3` 变成可选项

`pyproject.toml` 里 `bedrock` 是一个独立的可选依赖组:

```toml
# pyproject.toml
[project.optional-dependencies]
...
# AWS Bedrock provider (lazy-imported; desktop builds bundle it, pip users opt in).
bedrock = ["boto3>=1.34"]
```

`bedrock_provider.py` 里对应的做法是**把 `import boto3` 推迟到真正需要用到 Bedrock 的那一刻**,而不是放在模块顶部:

```python
# coworker/providers/bedrock_provider.py
def _ensure_client(self) -> Any:
    if self._client is None:
        try:
            import boto3
        except ImportError as exc:
            raise RuntimeError(
                "AWS Bedrock support needs the boto3 package — "
                "install with `pip install 'openworker[bedrock]'`."
            ) from exc
        ...
```

这样一来,一个从 pip 安装、只想用 OpenAI/Anthropic 的用户,完全不需要装 `boto3` 这个体积不小、只服务于一小部分用户的依赖;只有当用户真的选中 Bedrock 作为 Provider、第一次触发 `_ensure_client()` 时,才会尝试导入,导入失败也有一句指向具体安装命令的清晰报错,而不是一个裸的 `ModuleNotFoundError`。docstring 里的"desktop builds bundle it, pip users opt in"说明桌面客户端(打包了完整依赖)和 `pip install` 直接使用的场景被区别对待——桌面壳不在乎体积,追求开箱即用;`pip` 安装场景则把这个不常用的依赖做成显式的可选项。

### `CodexProvider`:靠继承复用整套 Responses 转换,只换认证

ChatGPT 订阅复用(`openai-codex` Provider)是认证维度最特殊的一个场景——它完全不是 API Key,而是浏览器 OAuth 登录换来的令牌。但协议这一侧,ChatGPT 的订阅后端说的还是和 `/v1/responses`同源的 Responses 协议,所以 `CodexProvider` 直接**继承** `OpenAIResponsesProvider`,而不是另起一个类:

```python
# coworker/providers/codex_provider.py
class CodexProvider(OpenAIResponsesProvider):
    def __init__(self, client=None, *, secrets=None, default_model="gpt-5.2-codex", ...):
        super().__init__(client=client, default_model=default_model,
                          base_url=CODEX_BASE_URL, reasoning_summary=reasoning_summary)
        self._store = CodexTokenStore(secrets)
        self._session_id = str(uuid.uuid4())
        ...

    def _ensure_client(self) -> Any:
        if self._injected:
            return self._client
        token, account = self._store.access_token()
        if self._client is None or token != self._client_token:
            self._client = OpenAI(api_key=token, base_url=CODEX_BASE_URL,
                                   default_headers=backend_headers(account, self._session_id))
            self._client_token = token
        return self._client
```

消息转换、流式解析、`_openai` 边车这些全部继承自父类,`CodexProvider` 只重写了三处:`_ensure_client()`(用 `CodexTokenStore` 换来的短生命周期 Bearer token 构造 SDK client,令牌轮换了就重建)、`_request_kwargs()`(去掉这个后端不接受的采样参数,把 `reasoning_effort` 接到父类不支持的位置)、`_create()`(捕获 401 后强制刷新令牌重试一次,429 直接翻译成"订阅额度用尽"的提示)。

认证细节全部封在 `codex_auth.py` 里:标准的 OAuth 2.0 + PKCE 授权码流程,固定回调端口(`1455`,因为这是订阅客户端 id 在服务端注册好的重定向地址,不能自己选),令牌落地在和其他 Provider 完全一样的 `SecretStore` `provider:openai-codex` 档案里,账号 id 靠**不做签名校验地解码** JWT 里的一个自定义 claim 得到(信任边界很清楚:后端才是真正验证签名的一方,本地只是拿这个 id 做路由用):

```python
# coworker/providers/codex_auth.py
def _jwt_claims(token: str) -> dict[str, Any]:
    """Decode a JWT payload WITHOUT verification — we only read routing claims
    (`exp`, the account object); the backend is the one verifying signatures."""
```

这套认证机制和 API Key/云 IAM 最大的不同,是令牌会过期、需要**主动刷新**——`CodexTokenStore.access_token()` 在返回令牌前会检查 JWT 的 `exp`,提前一段安全余量(`REFRESH_MARGIN_SECONDS`)就主动刷新,而不是等服务端真的拒绝了才补救;刷新令牌本身被拒绝(比如用户在别处登出了)会清空本地档案,让 Provider 读到一个"干净的未登录状态",而不是陷入无限重试的死循环。

## 常见问题/易踩坑

- **README 里的每个厂商都有一个专属类吗?** 没有。GLM、DeepSeek、Kimi、MiniMax、Qwen、xAI、Mistral、Meta,再加上 Together/Fireworks/OpenRouter 和 Ollama,全部共享 `OpenAIProvider`;Ark 系(BytePlus/Volcengine)共享 `OpenAIResponsesProvider`。只有 Anthropic、Gemini 是真正独立的协议实现,Bedrock/Vertex/Codex 则是"复用 + 认证/传输层特殊处理"的组合体。
- **为什么 OpenAI 官方模型和"OpenAI 兼容"厂商用的不是同一个类?** 因为 GPT-5.6 这代模型在 Chat Completions 上不允许工具调用和真正的推理强度同时出现,官方模型走 Responses API(`OpenAIResponsesProvider`)绕开这个限制;但大多数第三方兼容端点只实现了 Chat Completions,所以自定义端点场景必须留在 `OpenAIProvider`。
- **`VertexProvider`/`BedrockProvider` 里的 `claude/`、`gemini/`、`other/` 家族分发是不是简单的字符串匹配?** 是,但背后的意义不是"图省事",而是"能复用原生转换逻辑就绝不重写一份"——Converse API 是 Bedrock 的例外,因为它是 AWS 自己发明的统一格式,没有已有的转换器可以复用。
- **为什么 `boto3` 要惰性导入而不是直接列为核心依赖?** 因为它只服务于选择 Bedrock 的一小部分用户,`pip install` 场景要避免强加一个大多数人用不到的依赖;桌面客户端打包时则会带上,不受这个约束。

## 小结

十几个厂商名字背后,真正的协议实现只有三类:大多数厂商共享同一个 `OpenAIProvider`/`OpenAIResponsesProvider`,只换 base_url 和密钥槽位;Anthropic、Gemini 因为协议差异太大而各自独立实现;Bedrock、Vertex、Codex 则是在认证和传输层面各自特殊,但只要底层模型还是 Claude/Gemini/OpenAI,就坚持复用已有的原生转换逻辑,只有 AWS 自创的 Converse API 才值得单独写一份适配器。下一篇转向这些具体实现之上的另一层——`matrix.py` 到底登记了什么、`capabilities.py` 怎么做能力降级判断、以及 `catalog.py` 这个名字容易让人误会的文件,实际管的是不是模型。
