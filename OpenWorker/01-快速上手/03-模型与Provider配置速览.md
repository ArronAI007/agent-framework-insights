# 模型与 Provider 配置速览

> README 说"a curated model list marks what we've verified for tool-calling work",听起来像是一句市场话术,但仓库里真的有一个文件把这句话变成了可核查的代码事实——`coworker/providers/matrix.py` 的模块级 docstring 第一句就是"The curated model matrix — the only models we actively suggest, label, and vouch for."。"curated"不是修辞,而是一个被显式命名、显式维护、带着验证日期注释的数据结构。

## 学习目标

- 记住 README "Bring your own model"一节列出的全部受支持模型厂商,以及"任意模型字符串都能加、但风险自担"这条边界。
- 理解"curated model list"对应的真实实现——`coworker/providers/matrix.py` 里的 `MATRIX` 字典——它"故意做小"（deliberately SMALL）背后的取舍。
- 看懂 `docs/config.example.toml` 里 `model` 字段的配置方式,以及它和全局/工作区两级配置文件的关系。
- 理解 README "Privacy"一节强调的"本地优先、OAuth 握手才经过云端"这条隐私边界具体划在哪里。
- 明确知道：Provider 抽象层（`ProviderClient`/`ProviderRouter`）的源码级实现是第 05 篇的内容,这一篇只建立"模型可以随便换,但换的时候有一层验证"的第一手直觉。

## 背景与设计动机

"不锁定任何一个模型厂商"是一句几乎所有 Agent 框架都会讲的话,但真正做到"随时切换"至少要解决两个问题：第一,不同厂商的 API 形状千差万别,总得有一层统一接口；第二,即便接口统一了,不同模型对"工具调用"（tool-calling）这件事的支持程度天差地别——有的模型能可靠地并行调用多个工具,有的模型连基本的 tool schema 都解析不稳定,如果用户随手填一个模型字符串就被当作"和其他模型一样能用",出问题的时候用户根本不知道是模型本身能力不够,还是系统哪里配错了。

OpenWorker 的应对方式是把这两个问题分开处理：接口统一这一层交给 aisuite（第 05 篇会展开）,而"这个模型到底靠不靠谱"这一层,则维护一份显式的、体积克制的"验证过的模型清单"，清单之外的模型依然可以用，但明确告诉用户这是在使用未经验证的路径。README 的措辞是：

> A curated model list marks what we've verified for tool-calling work. Adding any model string works at your own risk.

这句话把责任边界划得很清楚："curated"的部分是平台做过验证的,"any model string"的部分则是用户自担风险的自由。这一篇要建立的第一手认知,就是这条边界在源码里长什么样。

## 核心机制详解

### Bring your own model：受支持的厂商清单

README 用一句加粗的横向列表列出了开箱即用支持的模型厂商：

```text
# README.md
Model access is yours: pick a provider, paste your key, switch anytime. Supported
out of the box:

**OpenAI · Anthropic · Google Gemini · BytePlus Ark · Volcengine Ark Agent Plan ·
Inkling (Thinking Machines) · GLM (Z.ai) · DeepSeek · Kimi (Moonshot) · Qwen ·
MiniMax · Mistral · Grok (xAI)** - plus open-weight models via **Together** and
**Fireworks**, and fully local models via **Ollama**.
```

这份清单可以分成三类：

1. **原生 API 厂商**——OpenAI、Anthropic、Google Gemini 三家,后面会看到它们在 provider 层是"native"实现,直接对接各自的官方 API 形状（Messages API、GenAI API 等）。
2. **OpenAI 兼容/自有 API 的厂商**——BytePlus Ark、Volcengine Ark Agent Plan、Inkling、GLM、DeepSeek、Kimi、Qwen、MiniMax、Mistral、Grok 这一长串,多数是通过兼容 OpenAI Chat Completions 形状的接口接入。
3. **开放权重模型的"渠道"**——Together、Fireworks 这类 reseller,不是模型本身的厂商,而是托管多家开放权重模型的平台；以及 Ollama,代表完全本地运行、不经过任何云端 API 的路径。

"pick a provider, paste your key, switch anytime"这句话对应的是用户侧的真实体验：换模型不需要重启应用或者改配置文件结构,只是换一下 provider 和对应的 key。

### curated model list：`matrix.py` 里的真实实现

README 提到的"curated model list"，在源码里对应 `coworker/providers/matrix.py`。这个文件的 docstring 把"curated"这件事讲得非常直白：

```python
# coworker/providers/matrix.py
"""The curated model matrix — the only models we actively suggest, label, and vouch for.

Keyed by the FULL routed id, exactly as the ProviderRouter receives it — including
reseller "ugly names" like ``together:zai-org/GLM-5.2`` (bare ids route to the OpenAI
default). Each entry carries the UI display label and the model's capabilities, making
this the single source of truth the capability probe and the GUI's pickers read from.

Deliberately SMALL (owner call, 2026-07-04): current-generation, agent-capable
(tool-calling) models only. It is not user-editable — users can still add any custom
model string, which falls back to the conservative heuristics in ``capabilities.py``
at their own risk of degraded results. Ids verified against vendor/reseller catalogs
on 2026-07-04; refresh the reseller rows when catalogs rotate (they rename on every
model generation).
"""
```

几个关键信息点：

- 这份清单是**故意做小**的（"Deliberately SMALL"）,只收录"当前一代、具备 agent 能力（工具调用）"的模型,而不是把所有能接进来的模型字符串都塞进去。
- 它**不能被用户编辑**（"not user-editable"）——用户依然可以填任意自定义模型字符串,但这条路径会退回到 `capabilities.py` 里更保守的启发式判断,后果是"at their own risk of degraded results"。
- 每一条记录都带着"验证过的日期"（"Ids verified against vendor/reseller catalogs on 2026-07-04"）,并且明确提示 reseller（Together/Fireworks 这类平台）的模型命名会随着上游目录轮换而改变,需要定期刷新。

清单里每一条记录长什么样,可以直接看 `MATRIX` 字典的开头几行：

```python
# coworker/providers/matrix.py
MATRIX: dict[str, ModelEntry] = {
    # -- first-party ------------------------------------------------------------
    # GPT-5.6 (2026-07-09): number = generation, Sol/Terra/Luna = capability tiers.
    # Bare "gpt-5.6" aliases to Sol server-side; we list the explicit tier ids only.
    # Rolling out — accounts without access get a friendly error (providers/errors.py).
    "gpt-5.6-sol": ModelEntry("GPT-5.6 Sol · OpenAI", _AGENTIC_VISION, 400_000),
    "gpt-5.6-terra": ModelEntry("GPT-5.6 Terra · OpenAI", _AGENTIC_VISION, 400_000),
    "gpt-5.6-luna": ModelEntry("GPT-5.6 Luna · OpenAI", _AGENTIC_VISION, 400_000),
    "gpt-5.5": ModelEntry("GPT-5.5 · OpenAI", _AGENTIC_VISION, 400_000),
    ...
```

每一条 `ModelEntry` 携带三样信息：UI 展示名（比如"GPT-5.6 Sol · OpenAI"）、能力标记（`ModelCapabilities`,是否支持工具调用、视觉输入、并行工具调用、流式输出）、以及上下文窗口大小（喂给 GUI 的"上下文占用进度条"用）。`context_window` 字段的注释解释了为什么有的条目是 `None`：

```python
# coworker/providers/matrix.py
# Max context length in tokens (prompt side), for the GUI's context-fill meter.
# None = not verified against the vendor spec yet; the meter simply hides.
```

也就是说,如果厂商文档还没有被核实过,系统宁可让"上下文进度条"这个 UI 元素直接隐藏,也不会显示一个编造出来的数字。这和"deliberately SMALL""not user-editable"是同一种保守取舍：宁可少展示,也不展示未经验证的信息。

清单外的模型走哪条路径,`coworker/providers/capabilities.py` 的注释说得很清楚：

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
    ...
```

命中 `MATRIX` 的模型直接拿到验证过的能力描述；命不中的,才会走后面针对 Ollama、Bedrock/Vertex 等场景的前缀名启发式判断——这正是"curated 与自定义"两条路径在代码里的分岔点。

这里要特别澄清一个容易混淆的地方：仓库里还有一个 `coworker/catalog.py`,名字看起来也叫"catalog",但它维护的是**工具能力目录**（`Capability`，比如"code_files"、"shell"、"git"这些 persona 可以引用的工具组合）,不是模型清单。它的 docstring 同样强调了"platform-owned and closed"（"third parties get breadth from us adding vetted capabilities here and from MCP, never by adding entries"）——这是同一种"官方维护一份封闭清单、外部扩展走专门的通道（MCP）"的治理哲学,在工具目录和模型目录这两个不同的地方分别落地。这两份"目录"服务于不同的领域，本篇只是提前指出这个平行关系，`catalog.py` 里工具能力的具体展开留给第 06 篇。

### `config.example.toml` 里的 `model` 字段

`docs/config.example.toml` 给出了配置文件的完整样例,`model` 是第一个字段：

```toml
# docs/config.example.toml
# coworker config — copy to one of:
#   ~/.config/coworker/config.toml          (global)
#   <your-project>/.coworker/config.toml    (per-workspace, overrides global)
#
# All keys are optional; unset keys fall back to built-in defaults.

model = "gpt-5.5"            # default model id (override per session in the UI/CLI)
mode = "interactive"         # plan | interactive | auto | custom
```

这个 `model` 字段只是**默认值**——注释写明了"override per session in the UI/CLI",也就是说配置文件里填的模型只是没有额外指定时的兜底选择,真正每一次会话用哪个模型,完全可以在 UI 或者命令行里当场切换。对照 `coworker/config.py` 里 `Config` 数据类的定义,可以看到实际代码里的默认值和示例文件不完全一致：

```python
# coworker/config.py
@dataclass
class Config:
    model: str = "gpt-5.6-sol"
    mode: str = "interactive"
    max_iterations: int = 150
    ...
```

`config.example.toml` 示例里写的是 `"gpt-5.5"`,而 `config.py` 里代码真正的内置默认值是 `"gpt-5.6-sol"`——这提醒我们示例配置文件是一份"教学用途"的样板,不完全等同于代码里当前生效的出厂默认值,真正决定行为的还是 `Config` 类里的字段定义。配置的加载顺序是"内置默认值 < 全局配置 < 工作区配置"三层覆盖（`config.py` 模块 docstring里写明），`model` 属于可以在工作区配置里覆盖的字段,不属于"全局专属"的敏感字段（这类字段留到第 04 篇讲 `allowed_commands`/`auto_allow` 时展开）。

### Privacy：本地优先，OAuth 是唯一的云端环节

README "Privacy"一节的表述是理解 Provider 配置这件事"安全边界"的关键背景：

> OpenWorker is local-first. Everything lives on your machine: the agent loop, your conversations, connector tokens, and model keys - all in the app's local secret store. The only cloud piece is a small service that brokers OAuth handshakes for connectors. You can always use the App without signing-in - use the connectors via manually-created credentials/API-keys.

翻译成配置层面的直觉：无论你选择哪一家模型厂商,填入的 API key 都存放在应用本地的密钥存储里,不经过 OpenWorker 自己的服务端中转；agent 的推理循环、对话记录同样留在本机。"The only cloud piece"——唯一涉及云端的部分——是给 connectors（比如 Slack、GitHub 这类第三方集成）代理 OAuth 授权握手的一个小型服务,而且这一层也是可以绕开的：README 明确说"You can always use the App without signing-in - use the connectors via manually-created credentials/API-keys",也就是说即便不登录 OpenWorker 账号,依然可以通过手动创建的凭据/API key 去用这些连接器。这条边界解释了为什么"选模型、填 key"这件事本身不涉及任何登录或者云端账号——模型访问是彻头彻尾的"你自己的 key、你自己的账号"。

## 常见问题/易踩坑

- **以为清单外的模型完全不能用**：不成立。`capabilities.py` 的逻辑说明自定义模型字符串依然可以用,只是拿不到 `MATRIX` 里验证过的能力标签,退回保守的启发式判断,行为可能"降级"（比如误判是否支持并行工具调用）。
- **拿 `config.example.toml` 里的默认值当作代码的真实默认值**：不完全准确。示例文件里的 `model = "gpt-5.5"` 只是教学样板,`coworker/config.py` 里 `Config` 类的实际默认值是 `"gpt-5.6-sol"`,两者出现差异时以代码为准。
- **把 `catalog.py` 当成模型清单的实现**：不是。`catalog.py` 管的是工具能力目录（file/git/shell 等 `Capability`）,"curated model list"对应的真实实现是 `providers/matrix.py`,两者是并行的、服务不同领域的"官方封闭清单"设计。

## 小结

这一篇建立的是"选模型"这件事的第一手直觉：README 列出的厂商清单覆盖了原生 API、OpenAI 兼容厂商、开放权重 reseller 和本地 Ollama 四类接入方式；"curated model list"不是一句空话,而是 `providers/matrix.py` 里一份故意做小、不可由用户编辑、带验证日期的 `MATRIX` 字典,清单外的模型依然可用但会退化到保守的能力判断；配置文件里 `model` 字段只是可被会话覆盖的默认值；而所有这一切都建立在"本地优先、只有 connector 的 OAuth 握手才碰云端"这条隐私边界之上。Provider 抽象层具体怎么把这些异构的厂商 API 统一成同一套调用接口——`ProviderClient`、`ProviderRouter`、以及 aisuite 在其中扮演的角色——是第 05 篇要深挖的内容。下一篇《权限模式与治理速览》会回到 README"Governed by design"一节,看看模型选好之后,它被允许做哪些事、哪些事永远需要人类点头。
