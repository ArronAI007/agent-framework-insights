# MCP 集成

> README 里"What it can do"一节有这么一句:"Any tool reachable over [MCP](https://modelcontextprotocol.io/) plugs in too, with per-tool control." 前半句好验证——`coworker/mcp/` 目录确实实现了一个完整的 MCP client。后半句"per-tool control"值得较真:是笼统地"整台服务器一起开关",还是真能精确到某一个具体工具?答案分散在三个文件里——`mcp/config.py` 的 `include_tools`/`exclude_tools`,`mcp/tools.py` 给每个远端工具生成的独立可调用对象与独立 `ToolMetadata`,以及 `coworker/risk.py`/`coworker/permissions.py` 里那条"MCP 工具的风险等级被焊死为 EXTERNAL,但审批卡片可以按精确工具名单独信任"的规则。本篇把这条链路从"怎么连上一个 MCP 服务器"一路读到"怎么让某一个具体的远端工具不再每次都问"。

## 学习目标

- 读懂 `MCPManager` 的连接生命周期——为什么每个服务器各自跑在自己的 asyncio task 里,以及这个设计如何服务于"同步的 `ToolRegistry.execute()` 要调用异步的 MCP session"这个跨界问题。
- 理解 `MCPServerDef` 的配置来源——global/workspace 两级 `mcpServers` JSON,以及"未受信任的工作区不读取其 MCP 配置"这条与仓库信任门槛绑定的规则。
- 理解一个远端 MCP 工具是怎么被包装成本地 `ToolRegistry` 认识的同步可调用对象的,包括命名规则、schema 转换、以及执行时怎么跨线程调回异步事件循环。
- 用代码验证"per-tool control"这句话——服务器级的 `include_tools`/`exclude_tools`过滤,以及精确到单个工具名的"始终允许"信任规则,分别落在哪一层。
- 简单了解 MCP OAuth 授权流程的角色分工,以及它和 Connectors 一章 OAuth 的关系。

## 背景与设计动机

MCP(Model Context Protocol)的核心承诺是"一个工具服务器,任意客户端都能接进来"。对 OpenWorker 这样一个把"用你已经在用的工具"当作卖点的产品来说,MCP 是把这个承诺兑现成本地能力最直接的路径——不需要为每一个第三方系统单独写连接器,只要对方暴露一个 MCP 服务器(本地进程或远程 HTTP 服务),就能把它的工具接进同一个工具调用循环。

但"接进来"不等于"无条件信任"。一个第三方 MCP 服务器暴露的工具,OpenWorker 完全不知道它内部到底做了什么——一个叫 `read_file` 的远端工具背后完全可能是一次写操作。`coworker/risk.py` 里专门有一段注释讲这件事:MCP 工具的效果是"陌生人的自述",不能从名字或分类推断真实的读写性质,所以风控上直接把所有 MCP 工具焊死在 `EXTERNAL` 这个最高风险等级,不允许任何配置把它降级。这个"先假设不可信,再一层层给例外"的思路贯穿了本篇要读的三个模块。

## 核心机制详解

### `MCPManager`:一个服务器一个任务的连接生命周期

`mcp/client.py` 的模块 docstring 交代了一个不寻常的实现选择:"Async-native (no `nest_asyncio`, no second event loop): each server runs in a dedicated asyncio task that opens the transport + `ClientSession`, keeps them alive until shutdown, then closes them in the *same* task — required because the SDK's transports use anyio cancel scopes that must be entered and exited on one task."

```python
# coworker/mcp/client.py(节选)
async def ensure(self, server: MCPServerDef, *, interactive: bool = False) -> _Conn:
    async with self._lock:
        existing = self._conns.get(server.name)
        if existing is not None:
            return existing
        ready: asyncio.Future = asyncio.get_running_loop().create_future()
        self._tasks[server.name] = asyncio.create_task(
            self._serve(server, ready, interactive=interactive)
        )
        conn = await ready  # propagates connection errors
        self._conns[server.name] = conn
        return conn
```

`ensure()` 是懒连接的入口——第一次有人要用某个服务器的工具时才真正建立连接,建过一次就缓存在 `self._conns` 里。真正干活的 `_serve()` 才是关键:它在自己的 task 里用 `AsyncExitStack` 依次进入 transport(stdio 或 streamable-HTTP)和 `ClientSession` 两层异步上下文管理器,`initialize()` 握手、`list_tools()` 拿到工具列表,把结果通过 `ready` 这个 future 交回给等待它的 `ensure()` 调用方,然后一直挂起在 `await conn.shutdown.wait()` 上,直到外部调用 `aclose()` 或 `verify()` 触发关闭——关闭时的退出动作(`AsyncExitStack.__aexit__`)必须在**同一个** task 里执行,因为底层的 anyio cancel scope 有"谁开谁关"的硬性要求。这就是为什么 `MCPManager` 不能简单地"在需要时开一个连接、调用完就扔",而是要为每个服务器维护一个长期存活的专职 task。

工具调用要解决另一个方向的跨界问题——`ToolRegistry.execute()` 是同步接口(引擎通过 `asyncio.to_thread` 在工作线程里跑它),但 MCP 的 `call_tool()` 是协程。`mcp/tools.py` 里的桥接方式是:

```python
# coworker/mcp/tools.py(节选)
def _invoke(_remote: str = remote, **kwargs: Any) -> Any:
    future = asyncio.run_coroutine_threadsafe(call_async(_remote, kwargs), loop)
    return future.result(timeout)
```

`run_coroutine_threadsafe` 把协程调度回持有事件循环的那个线程执行,工作线程里的同步调用方只需要阻塞等待 `future.result()`。这是"同步工具接口 + 异步底层实现"这类混合系统里一个经典且必要的桥接手法。

`MCPManager` 里还有一个专门为"手动测试连接"设计的方法 `verify()`,模块注释解释了它存在的原因——"`ensure` returns a cached connection untouched, which made Test-on-Live a silent no-op that could not detect a dead server (owner-hit 2026-08-21)"。也就是说,如果用户在 UI 上点"测试连接",而 `ensure()` 只是把缓存的旧连接原样返回,即使这个连接早就死了,测试也会"假装"成功。`verify()` 会对已缓存的连接做一次真实的 `list_tools()` 往返,失败就整个拆掉重连,把"点了测试按钮却什么都没测到"这个真实踩过的坑堵上。

### `MCPServerDef`:配置从哪里来,谁能定义可执行的服务器

`mcp/config.py` 里 `MCPServerDef` 是解析后的服务器定义,`load_mcp_servers()` 决定这些定义从哪些文件、按什么顺序合并:

```python
# coworker/mcp/config.py(节选)
def _config_paths(workspace, *, workspace_trusted: bool) -> list[Path]:
    """Workspace MCP is executable provenance (stdio spawn), so an untrusted repo's
    `.coworker/mcp.json` is never read — cloning alone must not be enough to define
    processes that run at session open.
    """
    paths = [global_mcp_path()]
    if workspace and workspace_trusted:
        paths.append(Path(workspace).expanduser() / ".coworker" / "mcp.json")
    return paths
```

工作区级的 `.coworker/mcp.json` 只有在这个工作区被判定为"受信任"之后才会被读取——原因写得很直接:一个 stdio 类型的 MCP 服务器定义本质上是"启动这个命令、传这些参数、带这些环境变量",这和仓库里的 `allowed_commands` 是同一个信任等级的问题。仅仅把一个仓库 clone 到本地,不应该足以让它在你打开这个工作区的那一刻就悄悄定义一个会被启动的进程。合并规则是"global 先合并、workspace 后合并、但 global 赢":

```python
# coworker/mcp/config.py(节选)
merged: dict[str, dict[str, Any]] = {}
for path in _config_paths(workspace, workspace_trusted=workspace_trusted):
    for name, raw in (_read(path).get("mcpServers") or {}).items():
        if isinstance(raw, dict):
            merged.setdefault(name, raw)  # global first → global wins on clash
```

`setdefault` 意味着先出现的名字生效——global 路径排在前面,所以即使一个受信任的工作区在自己的 `mcp.json` 里重新定义了一个和用户全局配置同名的服务器,用户自己全局配置的那份仍然生效。这是"用户自己的选择优先于任何仓库内容"这条原则在 MCP 配置里的具体体现。

`MCPServerDef` 本身的字段里已经能看到"per-tool control"的第一层证据:

```python
# coworker/mcp/config.py
@dataclass
class MCPServerDef:
    name: str
    transport: str  # "stdio" | "http"
    ...
    include_tools: Optional[list[str]] = None
    exclude_tools: Optional[list[str]] = None
    requires_approval: bool = True
    auth: Optional[str] = None
```

`include_tools`/`exclude_tools` 是配置文件层面就能做的过滤——一个 MCP 服务器可能暴露几十个工具,用户完全可以只放行其中几个(白名单),或者放行全部但排除某几个特别敏感的(黑名单)。这个过滤发生在服务器定义这一层,不需要用户逐个点开 UI 里的开关。

### 一个远端工具怎么变成本地工具:命名、schema、执行

`mcp/tools.py` 的 `tool_name()` 决定了一个远端工具在本地 `ToolRegistry` 里叫什么:

```python
# coworker/mcp/tools.py
def tool_name(server: str, tool: str) -> str:
    """`mcp__<server>__<tool>`, sanitized to OpenAI's `[A-Za-z0-9_-]{1,64}` rule."""
    base = f"mcp__{_NAME_OK.sub('_', server)}__{_NAME_OK.sub('_', tool)}"
    if len(base) > _MAX_NAME:
        base = base[:_MAX_NAME]
    return base
```

`mcp__<server>__<tool>` 这个双下划线命名规则和 Claude Code 暴露 MCP 工具的命名方式一致——两个连字符/下划线之外的字符全部替换成下划线,超长直接截断到 OpenAI 函数名的 64 字符限制。这个命名不只是好看,它同时是 `coworker/risk.py` 里"给任何以 `mcp__` 开头、又没带 metadata 的裸名字兜底判定为 EXTERNAL"这条防线的判断依据之一(下面细讲)。

`build_callables()` 把一个服务器过滤后的工具列表,逐个包装成注册表能吃的同步可调用对象:

```python
# coworker/mcp/tools.py(节选)
def build_callables(server, mcp_tools, call_async, loop, *, timeout=120.0):
    callables = []
    for mcp_tool in _filtered(mcp_tools, server):
        name = tool_name(server.name, mcp_tool.name)
        remote = mcp_tool.name

        def _invoke(_remote: str = remote, **kwargs: Any) -> Any:
            future = asyncio.run_coroutine_threadsafe(call_async(_remote, kwargs), loop)
            return future.result(timeout)

        _invoke.__name__ = name
        _invoke.__aisuite_tool_metadata__ = ai.ToolMetadata(
            name=name, category="mcp", risk_level="medium",
            capabilities=[server.name], requires_approval=server.requires_approval,
        )
        _invoke.__coworker_schema__ = _openai_schema(name, mcp_tool)
        _invoke.__coworker_mcp_destination__ = {
            "transport": server.transport, "host": _server_host(server),
        }
        callables.append(_invoke)
    return callables
```

对照上一篇讲的 `ToolRegistry` 协议——每个远端工具最终落地成一个普通函数,挂着 `__aisuite_tool_metadata__` 和 `__coworker_schema__` 两个属性,和一个内置工具在注册表眼里没有任何区别。`_openai_schema()` 直接把 MCP 工具自带的 `inputSchema` 原样透传成 OpenAI 格式的 `parameters`,不做二次推导——因为 MCP 协议本身已经要求每个工具自带标准 JSON Schema,没有必要像内置工具那样再从函数签名反推一次。`__coworker_mcp_destination__` 这个字段专门服务于审批卡片:它记录这次调用最终会打到哪个主机(HTTP 服务器解析出 `hostname`)或者说明这是本地 stdio 进程——而且明确注明数据来源是"服务器 DEF(用户自己配置的),不是服务器自称的任何信息",避免一个恶意 MCP 服务器通过自我描述伪造"这次调用很安全"的假象。

`_filtered()` 是 `include_tools`/`exclude_tools` 真正生效的地方:

```python
# coworker/mcp/tools.py
def _filtered(mcp_tools, server):
    out = mcp_tools
    if server.include_tools is not None:
        allow = set(server.include_tools)
        out = [t for t in out if t.name in allow]
    if server.exclude_tools:
        block = set(server.exclude_tools)
        out = [t for t in out if t.name not in block]
    return out
```

被过滤掉的工具连 `ToolRegistry` 的注册这一步都不会走到——模型从一开始就看不到它们存在,而不是"看得到但调用会被拒绝"。这是 per-tool control 的第一层:配置阶段的静态过滤。

### 风险焊死与"信任某一个具体工具":per-tool control 的第二层

即使一个 MCP 工具通过了 `include_tools`/`exclude_tools` 的过滤、成功注册进了会话,它的风险等级也不是由 `requires_approval` 这个配置项直接决定的。`coworker/risk.py` 里的 `_mcp_floor()` 讲得很清楚:

```python
# coworker/risk.py(节选)
def _mcp_floor(tool_name: str, metadata: Any) -> Optional[RiskClass]:
    """The floor for third-party MCP tools (OPE-136): EXTERNAL, always.
    ... Before this floor, `requires_approval: false` in mcp.json reclassified a whole
    server's tools to READ, which skipped not just the approval card but the Discuss-mode
    denial, the Auto-approve reviewer, and the audit trail in one step. The flag now only
    ever waives the *card* (see permissions.evaluate's trusted-MCP branch); the class is
    welded on.
    """
    if getattr(metadata, "category", "") == "mcp":
        return RiskClass.EXTERNAL
    if metadata is None and tool_name.startswith("mcp__"):
        return RiskClass.EXTERNAL
    return None
```

这段注释交代了一次真实的设计反复:早期版本里,`mcp.json` 里的 `requires_approval: false` 会把整台服务器的所有工具重新归类成 `RiskClass.READ`——这一步会连带跳过 Discuss 模式的只读拒绝、Auto-Approve 模式下的自动审阅、以及审计留痕,一次配置改动同时关掉了三层保护。现在的规则是:MCP 工具的风险等级被"焊死"在 `EXTERNAL`,`requires_approval` 这个配置项**只**能影响是否弹出审批卡片(`permissions.evaluate` 里的"trusted-MCP branch"),不能再改变这个工具在权限体系里的分类。

`classify()` 的合并逻辑进一步保证了这个焊死是硬约束,而不是又一层可覆盖的默认值:

```python
# coworker/risk.py(节选)
def classify(tool_name, metadata=None, overrides=None) -> RiskClass:
    base = _BASE.get(tool_name) or _catalog_floor(tool_name) or _mcp_floor(tool_name, metadata)
    if overrides is not None:
        ov = overrides(tool_name)
        if ov is not None:
            if base is None or _STRICTNESS[ov] >= _STRICTNESS[base]:
                return ov
            # A loosening override on a floored tool is ignored: fall through to the base.
    if base is not None:
        return base
    ...
```

用户级的风险覆写(`RiskOverrideStore`)只能**收紧**一个已有 floor 的工具,不能放松——`_STRICTNESS[ov] >= _STRICTNESS[base]` 这个判断直接拒绝了任何试图把一个 MCP 工具的风险等级往下调的覆写。真正能实现"这一个具体工具以后不用每次都问我"的机制,是另一条完全独立的路径——`coworker/permissions.py` 里的"trusted-MCP branch":

```python
# coworker/permissions.py(节选)
if (
    getattr(metadata, "category", "") == "mcp"
    and self.mode is not Mode.AUTO_APPROVE
):
    if self.trust_overrides is not None and self.trust_overrides(tool_name):
        return Decision(True, "trusted MCP tool (user trust rule)")
    if not bool(getattr(metadata, "requires_approval", True)):
        return Decision(True, "trusted MCP tool (server marked don't-ask)")
```

`self.trust_overrides(tool_name)` 精确到*这一个*工具名(比如 `mcp__github__create_issue`),来源是 `coworker/overrides.py` 里的 `RiskOverrideStore`——用户在审批卡片上点过一次"始终允许这个工具"之后,这条规则会被持久化写进 `risk_overrides.json`,以后同名工具再被调用就直接放行审批*卡片*(风险分类依然是 EXTERNAL,依然会出现在审计记录里,只是不再弹窗打断)。这正是 README"per-tool control"这句话最终落地的地方——过滤发生在配置层(整台服务器的工具子集),信任发生在单个工具名的粒度上,两层叠加,风险分类本身却始终焊死不动。

### MCP 场景下的 OAuth:一句话带过

`mcp/oauth.py` 处理的是远程 HTTP 类型 MCP 服务器需要浏览器登录授权的情形——完整实现 OAuth 2.1 + PKCE + Dynamic Client Registration,令牌存进 `SecretStore`(`mcp-oauth:<server>` 这个 profile,和明文的 `mcp.json` 配置文件分开),回调走本地 sidecar 的一个 loopback 端点。它和 Connectors 一章要讲的 OAuth 走的是两条独立的授权路径——MCP 这边靠 DCR 动态注册客户端,不需要任何预先在 broker 上登记的 client id/secret,因此完全在本地闭环;Connectors 走的是托管的 OAuth broker,这里不重复展开。

## 常见问题/易踩坑

**Q:`mcp.json` 里把某个服务器的 `requires_approval` 设成 `false`,是不是就等于把它的所有工具都当成安全的只读操作?**

不是,而且这正是 `risk.py` 那段长注释想澄清的误解。`requires_approval: false` 只影响"要不要弹审批卡片"这一件事,工具的风险分类始终是 `EXTERNAL`——Discuss(只读讨论)模式下依然会被拒绝,Auto-Approve 模式下依然要经过 reviewer 判断(这条信任规则被显式排除在 `Mode.AUTO_APPROVE` 之外),每一次调用依然会被计入审计记录。真正能做到"跳过卡片"的是两条路径之一:服务器级配置的 `requires_approval: false`,或者用户在卡片上对某个具体工具点过"始终允许"。

**Q:一个 MCP 服务器暴露的工具名和某个内置工具重名会怎样?**

不会冲突——`tool_name()` 生成的名字总是带 `mcp__<server>__` 前缀,和内置工具(比如 `run_shell`、`grep`)不在同一个命名空间里。真正需要留意的是同一个服务器换了一批不同的远端工具名时,`ToolRegistry` 里旧的注册项会随着会话重建自然消失,不存在"残留的僵尸工具"问题——工具列表是每次构建引擎时从当前 `list_tools()` 结果现造的。

## 小结

OpenWorker 的 MCP 集成分三层:`MCPManager` 用"一个服务器一个专职 asyncio task"解决连接的异步生命周期管理,并通过 `run_coroutine_threadsafe` 桥接同步的工具执行接口;`mcp/config.py` 决定服务器定义从哪些文件、按什么信任规则合并,`include_tools`/`exclude_tools` 提供配置阶段的静态工具过滤;`mcp/tools.py` 把每个远端工具包装成和内置工具外观完全一致的本地可调用对象。"per-tool control"这句话不是一句空话——它体现在两处具体机制里:服务器配置里的白名单/黑名单决定了哪些远端工具能进入这个会话,而 `risk_overrides.json` 里按精确工具名记录的信任规则决定了哪些已经进入会话的工具可以不再每次都弹审批卡片,同时风险分类本身作为一条不可绕过的底线始终焊死在 `EXTERNAL`。工具、Skills、MCP 这三条内容扩展面各自解决"给模型什么"的问题,但一次任务真正启动时,这些内容里哪些会被实际装配进这个会话——由谁的 persona、谁的配置、谁的连接状态共同决定——是另一个问题。下一篇转向 `coworker/toolchain.py` 和 `coworker/catalog.py`,看这条装配链路具体是怎么工作的,再补上 web 搜索/抓取这一类工具的实现细节。
