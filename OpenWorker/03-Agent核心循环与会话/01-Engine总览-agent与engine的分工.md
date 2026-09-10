# Engine 总览：agent 与 engine 的分工

> `openworker` 的后端叫 `coworker/`，但真正跑循环的类却叫 `TurnEngine`，定义在 `coworker/engine.py` 里——文件头的docstring直接写明"the owned agent loop"。而 `coworker/agent.py` 这个名字看起来最像"Agent 本体"的文件，读进去才发现它只有一个函数 `build_engine()`：把一个静态的 `Agent`（persona 描述，定义在 `coworker/agents/base.py`）、一份工作区配置、一堆连接器和权限设置，组装成一个可以运行的 `TurnEngine` 实例。这一篇要讲清楚：`Agent` 是什么、`build_engine()` 做了什么、`TurnEngine` 又是怎么把"模型 → 工具 → 模型"这条链路跑起来的，以及 README 里反复强调的"built on aisuite"，具体复用了 aisuite 的哪一部分——答案可能比你想象的更小。

## 学习目标

- 弄清楚 `Agent`（`coworker/agents/base.py`）、`build_engine()`（`coworker/agent.py`）、`TurnEngine`（`coworker/engine.py`）三者的分工：谁是持久化的"人设模板"，谁是"一次性组装脚本"，谁是真正持有会话状态、跨多轮运行的引擎实例。
- 通读 `TurnEngine._loop()` 的真实实现，搞清楚一次用户输入如何变成一次完整的"组装请求 → 流式调模型 → 识别工具调用 → 授权 → 执行 → 写回结果 → 判断继续/终止"循环。
- 理解工具调用的"先审批、后执行"两阶段设计,以及"低风险并发、高风险串行"的执行策略是怎么落地的。
- 用 `grep` 验证的事实说话：aisuite 在 `engine.py`/`agent.py` 里完全没有被直接引用,它真正被复用的地方是 `coworker/tools/registry.py` 和一大批具体工具文件里的 schema 生成能力,循环本身是 OpenWorker 自己写的。

## 背景与设计动机

`openworker` 不是单一角色的工具——一个安装了这个 App 的用户,可能同时开着一个写代码的 Code 会话、一个跑安全扫描的 Security 会话、一个处理 Slack 消息的 Cowork 会话。这些角色的系统提示词、可用工具、是否需要工作区、要不要接入连接器都完全不同,但它们驱动模型对话、执行工具、等待审批这套底层机制应该是同一套——不然每加一个新角色就要重新写一遍循环,维护成本会失控。

`openworker` 的解法是把"这个角色是什么"和"循环怎么跑"彻底分成两个不会互相污染的层次：`Agent` 是一份**冷的、无状态的描述**（叫什么名字、系统提示词写什么、需不需要工作区、要不要开连接器),`TurnEngine` 是**热的、有状态的运行时**（持有完整消息历史、压缩状态、审批记录、reviewer 实例)。中间还夹了一层——`build_engine()`——专门负责把"这次要跑哪个 Agent、在哪个工作区、当前的权限模式是什么"这些一次性决定，翻译成 `TurnEngine` 构造函数要的那一堆参数。这一层存在的意义是让 `TurnEngine` 的构造函数不需要知道"记忆功能"“技能菜单”"连接器授权"这些属于上层产品逻辑的概念——它只管接收一个已经组装好的工具注册表、权限引擎和系统提示词字符串。

## 核心机制详解

### Agent：一份不持有任何运行时状态的 persona 描述

```python
# coworker/agents/base.py
@dataclass
class Agent:
    name: str
    title: str
    system_prompt: str
    tool_factory: Optional[Callable[[AgentContext], list]] = None
    requires_folder: bool = False
    subagents: bool = False
    scheduling: bool = False
    messaging: bool = False
    connectors: bool | tuple[str, ...] = False
    team: Optional[str] = None

    def build_tools(self, context: AgentContext) -> list:
        return list(self.tool_factory(context)) if self.tool_factory else []
```

这个类的文件头注释写得很直白："An agent owns its system prompt + base toolset + whether it needs a workspace."——`Agent` 只是一个 dataclass,没有一个字段是运行时才产生的（没有消息列表、没有 provider、没有权限引擎)。它的字段全部是"这个角色天生是什么样"的静态事实：`requires_folder` 决定这个角色能不能在没有工作区的情况下启动,`subagents`/`scheduling`/`messaging`/`connectors`/`team` 这几个 trait 字段的注释直接说明它们是为了取代"过去用 agent 名字做 if/else 分支"的老写法——即用声明式字段替代分散在 `build_engine`/manager 各处的 `if agent.name == "cowork"` 判断。`build_tools()` 是这个类唯一的方法,而且只是一层薄薄的转发：把 `tool_factory` 这个可选的回调函数,用当前的 `AgentContext`（工作区路径、shell executor、todo 列表、根目录列表）调用一遍。

一个 `Agent` 实例可以被复用来构造无数个会话——它自己永远不会被写入任何消息或状态,这正是它能安全地作为"模板"存在的原因。

### build_engine()：把 persona + 会话配置翻译成一个 TurnEngine 实例

```python
# coworker/agent.py（节选，删去大量连接器/技能/记忆装配细节）
def build_engine(
    *, agent: Agent, workspace=None, model="gpt-5.6-sol", mode=Mode.INTERACTIVE,
    approver=None, provider=None, memory_store=None, secrets=None, ...
) -> TurnEngine:
    ws = Path(workspace).expanduser().resolve() if workspace else None
    if agent.requires_folder and ws is None:
        raise ValueError(f"agent '{agent.name}' requires a workspace")

    executor = LocalExecutor(cwd=ws) if ws is not None else None
    context = AgentContext(workspace=ws, executor=executor, todo=TodoList(), roots=root_list or None)

    registry = ToolRegistry()
    registry.register_all(agent.build_tools(context))
    if agent.connectors:
        enabled_connectors, enabled_tools = _enabled_connector_tools(secrets)
        registry.register_all(make_integration_tools(secrets, enabled_connectors=..., enabled_tools=...))
    if memory_store is not None:
        registry.register_all(memory_tools(memory_store, ...))
        instructions = f"{instructions}\n\n{_MEMORY_GUIDANCE}"

    permissions = PermissionEngine(workspace_root=ws or ..., mode=mode, ...)

    engine = TurnEngine(
        provider=provider, registry=registry, permissions=permissions, model=model,
        instructions=instructions, approver=approver, context_provider=context_provider, ...,
    )
    engine.session_facts = session_facts.SessionFacts(world=session_facts.capture(...))
    if live_on or shadow_on:
        engine.reviewer = Reviewer(provider=provider, model=model, known_world=engine.session_facts.world.render())
    return engine
```

这个函数干的事情本质上是一次"物料清单展开"：621 行里绝大部分篇幅都在按条件往一个 `ToolRegistry` 里 `register_all()`——基础工具、连接器工具、记忆工具、技能加载工具、调度工具、探索子代理工具——每一段 `if` 判断的依据都来自 `Agent` 的某个 trait 字段或者调用方传入的可选参数（`memory_store`、`task_store`、`subscription_store` 是否为 `None`)。同一份工作还包括拼装系统提示词字符串（叙事引导 `_NARRATION_GUIDANCE`、首次问候引导 `_FIRST_CONTACT_GUIDANCE`、工作区里的 `AGENTS.md` 约定、用户的记忆列表)、构造一个每轮都会被重新调用的 `context_provider()` 闭包（把"当前是不是 plan mode"“实时的目录列表”“技能菜单是否有变化"这些**必须逐轮重新判断**的动态信息,拼成一段 `<system-context>` 文本)。

值得注意的是最后几行：`engine.session_facts = ...`、`engine.reviewer = ...`——这些字段在 `TurnEngine.__init__` 里已经被声明为 `None`,并且构造函数的注释明确写了"set post-construction by the surface/manager so the constructor footprint stays put"。也就是说 `TurnEngine` 自己完全不知道 session_facts、reviewer 这些概念从哪来,`build_engine()` 只是在engine造好之后,像挂配件一样把这些能力挂上去。这是一种刻意的解耦：`TurnEngine` 的构造函数签名不需要随着"这个版本加了审阅者功能"“这个版本加了 session facts"而不断膨胀。

`build_engine()` 只在**会话建立/恢复时调用一次**（`server/manager.py` 里可以看到它在 `get_engine()`/`_build_engine()` 这类路径上被调用),之后同一个 `TurnEngine` 实例会在这个会话的整个生命周期里被反复 `run()`——这就是本篇要讲的下一层。

### TurnEngine：持有会话全部状态的心脏

```python
# coworker/engine.py
class TurnEngine:
    def __init__(self, *, provider, registry, permissions, model, instructions=None, ...):
        self.provider = provider
        self.registry = registry
        self.permissions = permissions
        self.messages: list[dict[str, Any]] = list(messages or [])
        self.compaction_state: Optional[_compaction.CompactionState] = None
        self.session_facts: Optional[session_facts.SessionFacts] = None
        self.reviewer: Optional[Any] = None
        self._reviewer_denials = 0
        self._steering: list[tuple[str, Optional[dict[str, Any]]]] = []
        ...
```

对比 `Agent` 的"零状态",`TurnEngine` 反过来是纯状态容器：`self.messages` 是这个会话从第一条消息到现在的完整历史（下一篇会讲它怎么落盘),`self.compaction_state` 记着上一次压缩压到了哪个边界（第三篇细讲),`self._reviewer_denials`/`self._standing_notes`/`self._agent_files` 这些字段全部是"这个会话跑到现在积累出来的、影响下一步判断的上下文"。`TurnEngine` 不知道"Agent"这个概念的存在——它的构造函数只接收已经具体化的 `provider`、`registry`、`permissions`、`instructions` 字符串,完全不关心这些东西是从哪个 persona 装配出来的。这正是"壳与心脏"分工的关键：`build_engine()`（连同它所在的 `agent.py`)是知道"persona"这个概念的**唯一**地方,`TurnEngine` 只知道"消息、工具、权限、模型"这几个通用概念。

### run() → _loop()：一次用户输入的完整生命周期

```python
# coworker/engine.py
async def run(self, user_input, *, source=None, display=None):
    message = {"role": "user", "content": user_input, "ts": time.time()}
    self.messages.append(message)
    self._cancel.clear()
    if self.session_facts is not None:
        self.session_facts.begin_turn()
    self._reviewer_denials = 0
    self.permissions.clear_run_allowances()
    yield Event(EventType.TURN_START, data)
    try:
        async for event in self._loop():
            yield event
    finally:
        self.permissions.clear_run_allowances()
```

`run()` 本身很薄：追加用户消息、重置"这一轮"该清空的计数器（reviewer 连续拒绝计数、临时授权表),然后把控制权完全交给 `_loop()`。真正的循环体是：

```python
# coworker/engine.py（节选，保留骨架）
async def _loop(self) -> AsyncIterator[Event]:
    iterations = 0
    while True:
        if iterations >= self.max_iterations:
            yield Event(EventType.TURN_END, {"status": "max_iterations_exceeded", ...})
            return
        iterations += 1

        if self._compaction_due():
            yield Event(EventType.COMPACTING, {})
            notice = await self._compact_now()
        ...

        turn: Optional[AssistantTurn] = None
        async for chunk in self._astream():
            if chunk.text_delta:
                yield Event(EventType.ASSISTANT_DELTA, {"text": chunk.text_delta})
            if chunk.turn is not None:
                turn = chunk.turn
        ...
        self.messages.append(_assistant_message(turn, model=self.model))
        yield Event(EventType.ASSISTANT_MESSAGE, payload)

        if not turn.tool_calls:
            if self._steering:
                self._inject_steering()
                continue
            yield Event(EventType.TURN_END, {"status": "completed", ...})
            return

        async for event in self._handle_tool_calls(turn.tool_calls):
            yield event
        yield Event(EventType.ITERATION_END, {"iteration": iterations})
        if self._steering:
            self._inject_steering()
```

这一段和 OpenHarness 的 `run_query()` 骨架长得神似——都是单层 `while` 循环,每一轮依次做压缩检查、流式请求、工具识别与执行。但有两处细节是 `openworker` 自己的设计：

第一,循环终止条件里多了一条**"未完成但排队了新消息"**的分支：如果模型这一轮没有再要求工具（`turn.tool_calls` 为空),但 `self._steering` 队列里还有待注入的消息,循环不会直接结束,而是把排队消息追加成新的 `user` 消息后 `continue`——这就是"用户中途插话"在这个引擎里的真实落地方式,由 `queue_steering()` 写入、`_inject_steering()` 消费,不是靠打断当前请求,而是让当前轮次先自然收尾,再把新指令接上去。

第二,`_compaction_due()` 的检查点在**每一次迭代开始时**,不是只在用户发起新一轮对话时——哪怕是同一个用户输入触发的第 5 次工具调用循环,只要历史涨到阈值,压缩也会插进来。第三篇会展开这一点。

### 工具调用：先集中授权，再按风险分流执行

```python
# coworker/engine.py
async def _handle_tool_calls(self, tool_calls: list[ToolCall]) -> AsyncIterator[Event]:
    await self._preconsult_reviewer(tool_calls)
    cleared: list[ToolCall] = []
    for tool_call in tool_calls:
        ...
        allowed = False
        async for item in self._authorize(tool_call):
            if isinstance(item, Event):
                yield item
            else:
                allowed = item
        if allowed:
            cleared.append(tool_call)

    concurrent = [tc for tc in cleared if self._parallel_safe(tc)] if len(cleared) > 1 else []
    serial = [tc for tc in cleared if tc not in concurrent]

    if concurrent:
        outcomes = await asyncio.gather(
            *[asyncio.to_thread(self._execute_sync, tc) for tc in concurrent]
        )
        for tool_call, (result, status) in zip(concurrent, outcomes):
            yield self._record_result(tool_call, result, status)

    for tool_call in serial:
        result, status = await asyncio.to_thread(self._execute_sync, tool_call)
        yield self._record_result(tool_call, result, status)
```

这里的分工原则写在 `_parallel_safe()` 里：

```python
def _parallel_safe(self, tool_call: ToolCall) -> bool:
    spec = self.registry.get(tool_call.name)
    metadata = spec.metadata if spec else None
    return getattr(metadata, "risk_level", "") == "low" and not getattr(metadata, "requires_approval", False)
```

只有元数据显式标注为 `risk_level == "low"` 且不需要审批的工具（读文件、搜索、只读的 git 查询)才会被丢进 `asyncio.gather` 并发执行;写操作、shell 命令,以及任何没有标注元数据的工具,一律进入 `serial` 列表按调用顺序逐个 `await`。这不是性能优化的副产品,而是一条安全边界——并发执行的前提是"这些调用互不影响、可以乱序完成",而写操作天然不满足这个假设。授权阶段（`_authorize`/`_preconsult_reviewer`,涉及权限引擎、reviewer、`readonly.py` 的只读命令分类器)本身是第 04 章治理系统的主题,这一篇只需要知道:**先把这一批工具调用集中送去审批，拿到 `cleared` 列表之后才决定谁并发、谁串行**——审批阶段永远是顺序的（因为审批卡片要一张一张地展示给人),执行阶段才谈得上并发。

### aisuite 到底复用了什么：不是循环，是工具 schema 生成

README 里说"OpenWorker's engine is built on aisuite",但对 `coworker/engine.py` 和 `coworker/agent.py` 分别执行 `grep -n "aisuite"` 会发现——**零命中**。真正大量 `import aisuite` 的地方是 `coworker/tools/registry.py` 和几十个具体工具文件（`tools/files.py`、`tools/search.py`、`tools/git.py`、`tools/ask.py`、`tools/shell.py`、`tools/todo.py` 等):

```python
# coworker/tools/registry.py
"""Schema generation is reused from aisuite (`Tools`) so we don't reimplement
docstring/type-hint → JSON-schema extraction."""
from aisuite.utils.tools import Tools

def _schema_for(func: Callable[..., Any]) -> dict[str, Any]:
    """Generate one OpenAI-format tool schema via aisuite's schema generator."""
    return Tools([func]).tools(format="openai")[0]
```

也就是说,aisuite 在这个项目里被复用的能力是**把一个 Python 函数的签名/类型标注/docstring 自动转换成 OpenAI 格式的 tool schema**,以及 `ToolMetadata`/`tool` 这些装饰器/元数据类型（`tools/git.py` 的注释甚至直白地写"aisuite's git toolkit gives `git_status`/`git_diff`; this adds history"——说明 openworker 一开始借用过 aisuite 自带的工具实现,后来又在其之上补充了自己的版本)。而"模型 → 工具 → 模型"这条多轮循环本身,`coworker/providers/base.py` 里的抽象基类写得非常明确：

```python
# coworker/providers/base.py
class ProviderClient(ABC):
    """Single-shot, provider-agnostic completion interface.
    Deliberately blocking (the turn engine wraps it in `asyncio.to_thread`) and
    deliberately without a `max_turns` loop — the runtime owns the agent loop.
    """
```

"deliberately without a `max_turns` loop — the runtime owns the agent loop"这句注释是整个第一篇最重要的一条事实：`openworker` 特意没有采用 aisuite 自带的 agents 层多轮循环,而是自己写了一套 provider 适配层（`anthropic_provider.py`/`openai_provider.py`/`gemini_provider.py`/`bedrock_provider.py`/`vertex_provider.py`/`codex_provider.py`,每个都只实现"一次性"的 `complete`/`stream`)加上 `TurnEngine` 这一整套编排、审批、压缩、reviewer 逻辑。README 说"built on aisuite"没有说错,只是这个"built on"更准确的含义是"借用了 aisuite 里省事的边角能力（schema 生成、部分工具实现),循环、治理、会话这些真正体现产品判断的部分完全自研"。

## 小结

`Agent` 是一份不持有状态的 persona 模板,`build_engine()` 是把它和一次具体会话的配置（工作区、权限模式、connector 授权、记忆存储)翻译成一个 `TurnEngine` 实例的组装脚本——只在会话建立时跑一次;`TurnEngine` 才是真正持有消息历史、压缩状态、审批记录、跨越无数次 `run()` 调用存活的心脏,它的 `_loop()` 用单层 `while` 循环把"压缩检查 → 流式调模型 → 工具授权 → 按风险分流执行 → 写回结果"串起来,并且用 `_steering` 队列而不是打断当前请求的方式支持"任务过程中插话"。aisuite 在这条链路里扮演的角色远比 README 字面意思要小——它只提供了工具 schema 生成这类基础设施,循环、治理、会话管理全部是 `openworker` 自己的代码。

这一篇还留了一个尾巴没展开：`self.messages` 这份贯穿会话生命周期的消息列表,到底是怎么落盘、怎么在进程重启后恢复、又是怎么应对"一次中断的工具调用把 tool_call 和 tool_result 拆散"这种脏数据的——这是下一篇 `02-Session与对话数据模型.md` 要讲的内容。
