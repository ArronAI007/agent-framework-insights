# 模型目录 Catalog 与能力矩阵

> 先纠正一个望文生义的直觉:`coworker/catalog.py` 并不是模型目录。读完它的 docstring 和实现会发现,这是一份**工具/能力目录**——`file_tools`/`git_tools`/`shell_tools` 这些内置能力按 id 注册的清单,供 persona 的 `tools:` 字段引用,和模型选型没有任何关系。真正扮演"模型目录"角色的,是这一篇要讲的另外两个文件:`matrix.py` 里那份被反复强调"故意做小"的精选模型清单,以及 `capabilities.py` 里一套按厂商/模型名前缀做能力推断的启发式规则。`matrix.py` 这个文件名也容易让人联想成一张"模型 x 能力"的二维交叉表,但它实际的数据结构就是一个 `{完整模型 id: ModelEntry}` 的扁平字典——名字暗示的"矩阵",和实现落地的"清单",是两回事。

## 学习目标

- 弄清 `coworker/catalog.py` 真正管理的是什么(工具能力目录),从而理解"模型目录"这个角色在这个仓库里实际由谁承担。
- 读懂 `matrix.py` 里 `MATRIX` 字典的真实结构与它"故意做小、不可用户编辑"的设计取舍,以及它和 README"a curated model list marks what we've verified for tool-calling work"这句话的对应关系。
- 理解 `capabilities.py::capabilities_for()` 的两级查询逻辑——精选模型直接查表,自定义模型退回到按前缀匹配的保守启发式——以及这套机制如何支撑"原生 PDF 支持""是否支持并行工具调用"这类差异化判断。
- 确认 Provider 层与 `aisuite` 上游库的真实关系:`providers/` 目录下完全没有引用 `aisuite`,`aisuite` 只服务于工具目录(`catalog.py`)而非模型访问层。

## 背景与设计动机

第一篇提到 `ModelCapabilities` 是一个跨 Provider 共享的数据结构,用来支撑"优雅降级"——模型不支持原生 PDF 就退回本地文本提取,不支持并行工具调用就退回串行执行。但这份能力声明数据本身存在哪里、怎么查询,第一篇没有展开。这一篇要回答的问题正是:当引擎需要知道"这个模型支不支持视觉输入"时,答案从哪里来?

答案分两层:一层是**精选清单**(`matrix.py`),只覆盖 OpenWorker 团队实际验证过的、当前主推的模型,连带一个人类可读的展示名和上下文窗口大小;另一层是**启发式兜底**(`capabilities.py`),覆盖用户自己粘贴进来的、清单之外的任意模型字符串,靠模型名/厂商前缀做保守推断。这两层合起来才是"模型目录"这个概念在 OpenWorker 里的真实实现——而不是 `catalog.py` 这个名字看起来最像的那个文件。

## 核心机制详解

### 先说清楚:`catalog.py` 管的是工具,不是模型

`coworker/catalog.py` 开头的 docstring 写得很明确:

```python
# coworker/catalog.py
"""Vetted tool catalog — the stable ``id → capability`` layer a persona references.

A *capability* bundles a group of tools (the existing ``tools/`` factories) behind a stable
id, plus what session context it needs (``requires``) and the risk classes it can produce
(``risk``, used by the Phase 2 install-consent screen). ``expand(ids, context)`` turns a
persona's ``tools:`` list into concrete callables, skipping capabilities whose context
prerequisites aren't met ...
"""
```

它注册的是 `code_files`/`files`/`git`/`search`/`shell`/`todo` 这几个**工具能力**id,每个 id 对应一个 `build(context)` 工厂函数,产出一组具体的可调用工具(比如 `_shell` 对应 `shell_tools(context.executor)`)。`expand(ids, context)` 把一个 persona 声明的 `tools:` id 列表,在给定的会话上下文里展开成真正可用的工具函数列表,跳过那些上下文前提不满足的能力(比如没有 `executor` 就没有 `shell`)。这整套机制服务的是"一个 persona 能用哪些工具",和"这次对话该用哪个模型、这个模型有什么能力"是完全不同的两个问题域——只是恰好都叫"catalog"、都是"id → capability"的登记表模式,读起来容易被名字带偏。

顺带确认一个容易被搭配联想到一起的点:`catalog.py` 顶部 `import aisuite as ai`,用来复用 `aisuite` 的 `toolkits.files()`/`toolkits.git()` 这些工具实现——但这是**工具目录**对 `aisuite` 的依赖,和模型 Provider 层完全无关。对 `coworker/providers/` 目录整体搜索 `aisuite` 关键字,没有任何一处引用:

```bash
$ grep -rn "aisuite" coworker/providers/
# (no output)
```

`pyproject.toml` 里"aisuite (toolkits/tracing)"这条注释描述的能力——工具集(toolkits)和调用链追踪(tracing)——落地在 `catalog.py` 和别的地方(比如上一章提到的 `server/manager.py` 用 `ai.tool()` 动态包装闭包函数),但 Provider 层从消息转换、流式解析到能力声明,是完全独立于 `aisuite` 自己写的一套实现。这个边界值得记住:**模型访问层是自研的,`aisuite` 只服务于工具执行这一侧**。

### `matrix.py`:一份故意做小的精选清单,不是一张交叉表

`matrix.py` 的模块 docstring 开门见山地定义了它的角色:

```python
# coworker/providers/matrix.py
"""The curated model matrix — the only models we actively suggest, label, and vouch for.

Keyed by the FULL routed id, exactly as the ProviderRouter receives it — including reseller
"ugly names" like ``together:zai-org/GLM-5.2`` ... Each entry carries the UI display label
and the model's capabilities, making this the single source of truth the capability probe
and the GUI's pickers read from.

Deliberately SMALL (owner call, 2026-07-04): current-generation, agent-capable (tool-calling)
models only. It is not user-editable — users can still add any custom model string, which
falls back to the conservative heuristics in ``capabilities.py`` at their own risk of
degraded results.
"""
```

数据结构本身非常朴素——一个 `dict[str, ModelEntry]`,key 是 `ProviderRouter` 会收到的**完整路由 id**(带 `provider:` 前缀,包括转售平台那些丑陋的原始模型命名空间):

```python
# coworker/providers/matrix.py
@dataclass(frozen=True)
class ModelEntry:
    label: str  # UI display name, e.g. "GLM-5.2 · via Together"
    caps: ModelCapabilities = _AGENTIC
    context_window: Optional[int] = None

MATRIX: dict[str, ModelEntry] = {
    "gpt-5.6-sol": ModelEntry("GPT-5.6 Sol · OpenAI", _AGENTIC_VISION, 400_000),
    "anthropic:claude-fable-5": ModelEntry("Claude Fable 5 · Anthropic", _AGENTIC_VISION, 1_000_000),
    "gemini:gemini-3.6-flash": ModelEntry("Gemini 3.6 Flash · Google", _AGENTIC_VISION, 1_048_576),
    "together:zai-org/GLM-5.2": ModelEntry("GLM-5.2 · via Together", _AGENTIC, 128_000),
    "bedrock:claude/anthropic.claude-sonnet-4-6-v1:0": ModelEntry(
        "Claude Sonnet 4.6 · AWS Bedrock", _AGENTIC_VISION, 200_000
    ),
    ...
}
```

这就是"矩阵"这个文件名和实际实现之间的落差:它不是一张"模型 x 能力"的二维表格,而是一份**扁平的、以完整 id 为键的字典**,每一项自带三件东西——UI 展示名(`label`)、能力标志(`caps`,复用第一篇的 `ModelCapabilities`)、上下文窗口大小(`context_window`)。README 里"A curated model list marks what we've verified for tool-calling work"这句话,对应的实现依据正是这份清单——docstring 明确写着"current-generation, agent-capable (tool-calling) models only",而且这份清单**不允许用户编辑**,用户添加自定义模型字符串会绕过它、直接落到 `capabilities.py` 的启发式规则(风险自负)。

清单里每一条都标注了验证日期和取值依据的注释,比如 Bedrock 的一个条目:

```python
# coworker/providers/matrix.py
# Live-verified on Converse 2026-07-26 (complete/stream/tool round trip); asked for
# two tool calls it emits them one at a time, so parallel stays off.
"bedrock:other/nvidia.nemotron-super-3-120b": ModelEntry(
    "Nemotron Super 3 120B · AWS Bedrock",
    ModelCapabilities(tools=True, vision=False, parallel_tool_calls=False, streaming=True),
),
```

这类注释说明每一行 `ModelEntry` 背后都是一次**真实跑通**的验证,而不是照抄厂商宣传页的规格——`parallel_tool_calls=False` 这个具体取值来自"实测发现该模型一次只吐一个工具调用"这个观察,而不是文档推断。`context_window` 字段同理:注释里写着"Entries where the vendor spec wasn't re-checked stay `None` — the meter simply hides rather than showing a made-up denominator",宁可让 GUI 的上下文占用进度条直接隐藏,也不用一个没有核实过的数字去猜。

`matrix.py` 对外只暴露三个纯函数,分别喂给 GUI 的不同界面:

```python
# coworker/providers/matrix.py
def entry_for(model: str) -> ModelEntry | None: ...
def model_labels() -> dict[str, str]: ...          # 完整 id → 展示名,喂给所有模型选择器
def model_context_windows() -> dict[str, int]: ...  # 完整 id → 上下文窗口,喂给填充进度条
def models_for_provider(provider: str) -> list[str]: ...  # 某个 provider 下清单收录的裸 id
```

`models_for_provider()` 是设置页"推荐模型"下拉列表的数据来源——它保证 GUI 里能选到的模型建议,和 `matrix.py` 清单里实际登记的完全一致,不会出现"推荐了一个清单里根本没有能力声明的模型"这种不一致。

### `capabilities.py`:精选清单查不到,就退回按前缀猜

```python
# coworker/providers/capabilities.py
def capabilities_for(model: str) -> ModelCapabilities:
    # Curated models answer from the matrix (exact full-id match — including reseller ids
    # like `together:zai-org/GLM-5.2`, whose names defeat the prefix heuristics below).
    # Custom user-added models fall through to the heuristics, at their own risk.
    from .matrix import entry_for
    entry = entry_for(model)
    if entry is not None:
        return entry.caps

    provider = model.split(":", 1)[0].lower() if ":" in model else ""
    name = model.split(":", 1)[-1].lower()
    ...
```

第一步永远是精确匹配 `matrix.py` 的完整 id——这一点很重要,因为像 `together:zai-org/GLM-5.2` 这种转售平台的模型命名空间,是没办法靠"模型名前缀"猜出能力的(`GLM-5.2` 这个名字本身在别的厂商语境下未必对应同一套能力)。只有清单里没有的自定义模型,才会走到下面这段按厂商/模型名前缀分层的保守规则:

```python
# coworker/providers/capabilities.py
if provider == "ollama":
    _vision_patterns = ("-vl", "vision", "llava", "bakllava", "cogvlm", "minicpm-v")
    has_vision = any(p in name for p in _vision_patterns)
    return ModelCapabilities(tools=True, vision=has_vision, parallel_tool_calls=False, streaming=True)

if provider in ("bedrock", "vertex"):
    if name.startswith(("claude/", "gemini/")):
        return ModelCapabilities(tools=True, vision=True, pdf=True, parallel_tool_calls=True, streaming=True)
    return ModelCapabilities(tools=True, vision=False, parallel_tool_calls=False, streaming=True)

if provider in ("anthropic", "gemini"):
    return ModelCapabilities(tools=True, vision=True, pdf=True, parallel_tool_calls=True, streaming=True)

if name.startswith(("gpt-5", "gpt-4")):
    return ModelCapabilities(tools=True, vision=True, pdf=True, parallel_tool_calls=True, streaming=True)

if name.startswith(("o1", "o3", "o4")):
    return ModelCapabilities(tools=True, vision=False, parallel_tool_calls=False, streaming=True)

if name.startswith(("deepseek", "glm", "kimi", "minimax", "qwen", "grok", "mistral", "magistral")):
    return ModelCapabilities(tools=True, vision=False, parallel_tool_calls=True, streaming=True)

return ModelCapabilities(tools=True, vision=False, parallel_tool_calls=False, streaming=True)
```

这段规则的排列顺序本身就是一种设计:先处理需要"家族段"细分的云托管场景(Bedrock/Vertex 的 `claude/`、`gemini/` 段落决定是否继承原生能力),再处理原生三家(Anthropic/Gemini 直接给满血能力,包含 PDF 原生支持——对应 `matrix.py` 里 `_AGENTIC_VISION` 注释提到的"the native three (OpenAI, Anthropic, Gemini) all take PDFs directly"),再按 OpenAI 自己的模型代际分组(GPT-4/5 系给视觉+PDF,`o1`/`o3`/`o4` 推理模型保守到不给视觉、不给并行工具调用),最后是一整批 OpenAI 兼容厂商的兜底规则(给工具调用和并行调用,但不给视觉——因为这些厂商的旗舰文本模型是主推对象,视觉变体没有被验证过,宁可保守）。任何不匹配以上任何一条规则的模型字符串,最终落到函数末尾一个**最保守的默认值**——有工具、没视觉、不支持并行工具调用。

这套"精确匹配优先,前缀规则兜底"的两级结构,呼应了 `matrix.py` docstring 里的那句"at their own risk of degraded results"——用户永远可以粘贴一个精选清单之外的模型字符串进来,系统不会拒绝,但拿到的能力声明是一套故意偏保守的猜测,而不是清单里那种"实测验证过"的确定性数据。

### 能力矩阵如何支撑差异化的降级判断

`ModelCapabilities` 里 `pdf: bool` 这个字段是"能力驱动降级"最直接的例子。第一篇提过,原生三家(OpenAI/Anthropic/Gemini)之外的模型普遍没有内联文件的协议支持——`matrix.py` 里 `_AGENTIC` 与 `_AGENTIC_VISION` 两个预设 `ModelCapabilities` 常量的注释直接点出了这一点:

```python
# coworker/providers/matrix.py
_AGENTIC = ModelCapabilities(tools=True, vision=False, parallel_tool_calls=True, streaming=True)
# The native three (OpenAI, Anthropic, Gemini) all take PDFs directly; every
# OpenAI-compatible vendor and reseller in the matrix does not (their chat APIs have
# no inline file part — checked 2026-07-17), so those fall back via pdf_support.py.
_AGENTIC_VISION = ModelCapabilities(tools=True, vision=True, pdf=True, parallel_tool_calls=True, streaming=True)
```

上层代码(引擎在组装一次请求、决定要不要把一个 PDF 附件塞进消息里之前)只需要调用 `provider.capabilities(model).pdf` 这一个布尔值,不需要关心"这个模型属于哪个协议家族、这个协议家族支不支持内联文件"这些细节——这些细节已经在 `matrix.py`/`capabilities.py` 这一层被判断并压缩成一个标志位。`parallel_tool_calls` 同理:`o1`/`o3`/`o4` 这类推理模型、以及不少 Bedrock 上的 `other/` 家族模型都被标记为 `False`,上层的 agent 循环据此决定是"一次性发出多个工具调用"还是"退回一次只发一个、串行执行"。

这正是第一篇提到的"优雅降级"的完整闭环:`ProviderClient.capabilities()` 定义了查询接口,`matrix.py` + `capabilities.py` 提供了这份声明数据的两级来源(精选清单优先、启发式兜底),`ModelCapabilities` 的具体字段(`pdf`/`vision`/`parallel_tool_calls`/`streaming`)则是上层各处降级逻辑实际读取的开关。

## 常见问题/易踩坑

- **`coworker/catalog.py` 是不是模型目录?** 不是。它是工具/能力目录(`file_tools`/`git_tools`/`shell_tools` 这些内置能力的 id 注册表),供 persona 声明"这个角色能用哪些工具"。真正承担"模型目录"角色的是 `matrix.py`(精选清单)加 `capabilities.py`(启发式兜底),这两个文件才是本章真正要读的"目录"。
- **`matrix.py` 是不是一张"模型 x 能力"的交叉表?** 不是,名字容易误导。它的数据结构是一个以完整路由 id 为键的扁平字典,每一项打包展示名、能力标志、上下文窗口三样东西,更接近一份"精选花名册"而不是数学意义上的矩阵。
- **Provider 层复用了多少 `aisuite`?** 几乎为零——对 `coworker/providers/` 目录搜索 `aisuite` 没有任何匹配。`aisuite` 服务于工具执行这一侧(`catalog.py` 的 `ai.toolkits.files()`/`ai.toolkits.git()`,以及 `server/manager.py` 里动态包装的 `ai.tool()`),模型访问层是完全独立自研的。
- **用户能不能编辑 `matrix.py` 里的清单?** 不能,它是代码里硬编码的常量,不是配置文件。用户可以自由输入清单之外的任意模型字符串,但这样做会绕开精选数据,落到 `capabilities.py` 的保守启发式规则上。

## 小结

"模型目录"这个概念在 OpenWorker 里不是一个单独的文件,而是 `matrix.py`(故意做小、经过实测验证的精选清单)和 `capabilities.py`(覆盖清单之外任意模型的保守启发式)两层配合的结果——`coworker/catalog.py` 这个名字最像"目录"的文件,实际管的是完全无关的工具能力注册。`ModelCapabilities` 里 `pdf`/`vision`/`parallel_tool_calls` 这些字段,让上层代码只需要查一个布尔值就能决定要不要做本地降级,而不需要在各处散落"这家厂商支不支持某个特性"的判断逻辑。`aisuite` 这个上游依赖也和模型访问层没有交集,它服务的是工具执行,不是模型选型。

到这里,"引擎怎么统一调用不同厂商的模型""具体协议差异怎么被吸收""模型的能力声明从哪里来"这条主线就讲完了。下一章会转向另一条完全不同的线——工具、Skills、MCP,以及它们怎么被装配进一次对话的工具链里。
