# Subagent 委派与 MCP 开放接口

> `coworker/tools/subagent.py` 这个文件名会让人以为它实现了某种通用的"子代理任务委派"框架,和上一篇的 Team/Board 机制配合工作。读完代码后需要如实纠正这个预期:这个文件里唯一的产出是一个叫 `explore` 的只读研究工具——一次性地、在当前这个模型调用里,把"翻多少文件才能回答一个宽泛问题"这件事外包给一个拥有独立上下文窗口、但活不过这一次工具调用的子引擎。它与 Team/Board 之间**没有任何代码层面的连接**:`explore` 不认识 `TeamStore`,也不会在看板上留下任何痕迹;`propose_team` 拉起的 worker 是持久化的、有自己的 session id、会被指派看板条目的独立会话。OpenWorker 里事实上存在两条完全独立的"委派"路径,本篇先把这条差异讲清楚,再看 `teams/mcp_server.py` 如何把上一篇的整块 Board 暴露成一个任何外部 harness 都能接入的 stdio MCP server——这是 OpenWorker 在"团队协作要不要只服务于自己"这个问题上给出的最开放的答案。

## 学习目标

- 弄清 `tools/subagent.py` 里 `explore` 工具的真实工作机制:它如何构建一个只读的子 `TurnEngine`、为什么强制跑在 `Mode.PLAN` 下、为什么子引擎的工具注册表里没有 `explore` 自己。
- 能够准确说明:`explore` 子代理和 Team/Board 的"lead 指挥 worker"委派,是 OpenWorker 里两条彼此独立、互不知情的委派路径——不是同一套机制的两种用法,并说清两者在生命周期、上下文隔离方式、可见性三个维度上的具体差异。
- 理解 `teams/mcp_server.py` 如何把 `BoardDialect`(上一篇讲过的"board 存放在哪里"抽象)包装成一个 `FastMCP` stdio server,以及这个设计解决的核心问题:让 Board/Journal 从"OpenWorker 内部私有机制"变成一个任何外部编码 agent 都能通过标准 MCP 协议接入的开放能力。
- 理解 `ocw board mcp` 这行命令背后完整的组装链路:`cli.py` 解析 backing(远程/本地/发现本机 server)→ 拿到一个 dialect → `mcp_server.build()` 注册按角色裁剪的工具集 → `serve()` 用 stdio 跑起来。

## 背景与设计动机

一个 agent 在处理宽泛问题("这个仓库里重试逻辑是怎么处理的?")时,如果自己去翻几十个文件,会把主会话的上下文窗口消耗在大量中间产物(文件内容、grep 结果)上,而最终有用的只是一个结论。这是几乎所有长上下文 agent 系统都会遇到的问题,`tools/subagent.py` 给出的答案很直接:把这类"广度优先的只读研究"整体外包给一个用完即弃的子引擎,只把它的最终报告带回来。

这与 Team/Board 要解决的问题完全是两个维度。Team/Board 面对的是"一份工作需要拆解成多个条目,分给多个专门角色,状态要能长期追踪,过程要能审计"——重点是持久化的分工与责任归属。`explore` 面对的是"当前这一步思考需要查阅比较多的上下文,但结论本身很简单"——重点是上下文隔离与即时性。二者的实现完全不共享代码路径是这两个问题本质不同的自然结果,而不是工程上的疏漏或者尚待统一的技术债。本篇会如实指出这一点,而不是把两者叙述成"统一子代理框架"的两种外观。

第二个设计压力来自"Board 该不该只是 OpenWorker 自己会用的东西"。上一篇讲到 `dialect.py` 已经把"board 存放在哪里"抽成了协议无关的客户端接口,`teams/mcp_server.py` 是这层抽象派上用场的地方:如果一个团队想用另一款编码 agent(而不是 OpenWorker 自己的 session)作为 worker 去认领看板条目,唯一现实的做法是让 Board 讲一种那款 agent already 认识的协议——Model Context Protocol 正是这样一种事实标准。把 Board/Journal 包装成一个标准 MCP server,意味着任何支持 MCP 客户端配置的 harness,不需要理解 OpenWorker 内部的任何实现细节,只需要按 MCP 协议连接、拿到一组工具,就能加入同一块看板工作。

## 核心机制详解

### `explore`:一次性、只读、独立上下文的研究子代理

`build_explorer_engine()` 组装了一个和主会话完全隔离的子 `TurnEngine`:

```python
# coworker/tools/subagent.py:42-76(节选)
def build_explorer_engine(*, workspace, provider, model, model_settings=None,
                           max_iterations=_CHILD_MAX_ITERATIONS) -> TurnEngine:
    """A child engine with the Code agent's read-only tools and a fresh context."""
    ws = str(Path(workspace).resolve())
    registry = ToolRegistry()
    replaced = {"search_files", "read_file", "read_file_lines"}
    registry.register_all([t for t in ai.toolkits.files(root=ws) if getattr(t, "__name__", "") not in replaced])
    registry.register_all(file_tools(ws))
    registry.register_all(ai.toolkits.git(root=ws))
    registry.register_all(git_tools(ws))
    registry.register_all(search_tools(ws))
    permissions = PermissionEngine(workspace_root=Path(ws), mode=Mode.PLAN)
    return TurnEngine(
        provider=provider, registry=registry, permissions=permissions,
        model=model, instructions=EXPLORER_INSTRUCTIONS,
        max_iterations=max_iterations, model_settings=model_settings,
    )
```

三个细节决定了这个子引擎"只能读、不能写、活不长":

1. **工具集是只读切片**:注册进来的只有文件读取/列目录、`git_status`/`git_diff`/`git_log`、`grep`——没有任何写文件或执行 shell 的工具。这是白名单式的隔离,而不是靠权限层拦截可能存在的写工具。
2. **`Mode.PLAN` 是双重保险**:即便某个读工具的实现出于疏忽具备了副作用,`PermissionEngine(mode=Mode.PLAN)` 会在权限层硬性拦截任何写/shell 操作——docstring 里说得很直接:"the PermissionEngine hard-blocks writes/shell no matter what the child decides",而且因为 plan 模式下的操作不需要审批往返,`explore` 调用可以被判定为低风险,从而允许一次助手轮次里多个 `explore` 并行执行。
3. **`max_iterations=10` 且禁止递归**:模块 docstring 明确写道"No recursion: the child registry has no `explore` tool"——子引擎的工具注册表里根本没有注册 `explore` 自己,一个探索子代理不能再派生出下一层探索子代理,委派链条被硬性限制在一层。

`explorer_tools()` 里的 `explore()` 函数是暴露给主会话模型的入口,调用之后发生的事情本质上是"起一个完整的 turn 循环,只取它的最终文本":

```python
# coworker/tools/subagent.py:106-126(节选)
async def _run() -> tuple[str, str]:
    report, status = "", "unknown"
    async for event in engine.run(task):
        if event.type == EventType.ASSISTANT_MESSAGE and event.data.get("text"):
            report = event.data["text"]
        elif event.type == EventType.TURN_END:
            status = event.data.get("status", "unknown")
        elif event.type == EventType.ERROR:
            return report, f"error: {event.data.get('error', '')}"
    return report, status

report, status = asyncio.run(_run())
if not report:
    return {"error": f"explorer produced no report (status: {status})"}
result: dict[str, Any] = {"report": report}
if status != "completed":
    result["note"] = f"explorer stopped early ({status}); the report may be partial"
return result
```

主会话拿到的只是一个 `{"report": "..."}` 字典——子引擎运行过程中产生的每一次文件读取、每一次 grep 调用的原始输出,全部留在子引擎自己的、随这次工具调用结束就被丢弃的上下文里,永远不会计入主会话的 token 消耗。这正是 `explore` 存在的全部意义:用一次完整但廉价的子会话,换取主会话上下文的清爽。

`code_agent()`(见第一篇)的系统提示词里明确指导模型何时该用 `explore`:"For broad questions spanning many files ... delegate to `explore` ... For a single known file, just read it yourself"——这是一条效率上的建议,不是权限上的强制:模型完全可以自己读文件而不经过 `explore`,`explore` 只是在"要翻很多文件才能回答"这类场景下更划算的选择。

### 两条独立的委派路径:`explore` 与 Team/Board 的对照

把 `explore` 和上一篇的 Team/Board 机制放在一起对照,能看清 OpenWorker 里"委派"这个词其实覆盖了两种性质完全不同的机制:

| 维度 | `explore`(`tools/subagent.py`) | Team/Board(`teams/*`) |
|---|---|---|
| 触发方式 | 主会话模型直接调用一个普通工具 `explore(task)` | Lead 调用 `propose_team` 走审批,批准后**预先创建**worker 会话;之后通过 `assign`/`claim` 把看板条目交给某个 worker |
| 生命周期 | 一次工具调用内起止,`asyncio.run()` 跑完就销毁,不持久化 | Worker 会话是持久化状态(`TeamWorker` 落在 `TeamRegistry` 磁盘文件里),可以跨多轮、跨多次唤醒存活 |
| 上下文关系 | 子引擎拥有全新、独立、用后即焚的上下文窗口,只有最终报告字符串回流 | Lead 和 worker 是两个完全独立的会话/进程,彼此的"上下文"从一开始就不共享,靠看板事件和 Journal 案卷做异步的信息传递,而不是"调用返回值" |
| 可见性 | 对其他 agent、对用户都不可见——`explore` 的存在只在触发它的那次工具调用里体现 | 每一次指派、认领、状态迁移都是一条落在哈希链日志里的事件,lead 的 `subscribed_events()`、user 的看板视图都能看到 |
| 权限模型 | 恒定只读(`Mode.PLAN`),没有 Actor/Role 的概念 | 每个动作都绑定一个 `Actor`(id + role),`TeamStore` 按角色裁剪权限(worker 不能把 item 移到 done、不能 assign) |
| 能否再派生下一层 | 禁止(子引擎的工具表里没有 `explore`) | 可以——一个 worker persona 如果自己也具备 `team: lead` 之外的能力,理论上可以在另一块看板上继续拆解,但这已经是另一块独立的 space,而不是"嵌套子代理" |

需要特别强调:这不是"同一套子代理机制的两种参数配置",而是**两套在代码层面完全不相交的实现**。`tools/subagent.py` 从未 import 过 `teams/` 目录下的任何模块,`teams/store.py`/`teams/model.py` 也从未引用 `TurnEngine` 或 `explore`。如果要在这两者之间画一条概念上的分界线:`explore` 是"一次调用内部的上下文管理技巧",Team/Board 是"跨会话、跨时间的责任与状态追踪系统"。把二者混为一谈,会导致误判——比如以为一个 `explore` 调用也会像 worker 一样在看板上留下可审计的记录,或者以为给一个 worker 分配任务也能像 `explore` 一样"零延迟、零审批"地立刻拿到结果。

### `teams/mcp_server.py`:把 Board 包装成一个标准 MCP server

`build()` 函数是这个设计的核心,它接收一个上一篇讲过的 `BoardDialect`(已经绑定好身份的客户端)和一个 `space`,组装出一个 `FastMCP` 实例:

```python
# coworker/teams/mcp_server.py:20-38(节选)
def build(dialect, *, space: str):
    from mcp.server.fastmcp import FastMCP
    who = dialect.whoami()
    role = who.get("role", "worker")
    mcp = FastMCP(
        "team-board",
        instructions=(
            f"A shared team work board (you are '{who.get('actor')}', role {role})"
            " plus the team journal. Items carry acceptance criteria — what gets"
            " verified before they can be done. Typical worker loop: board_list →"
            " board_claim an open item → board_move to in_progress → work,"
            " journal_append findings as you go → board_move to review with a"
            " hand-off comment and refs. Never mark items done — done is the"
            " verdict after review."
        ),
    )
```

这段 `instructions` 直接写给接入的外部 agent 看——它不知道 OpenWorker 内部的任何实现细节,只需要照着这段自然语言指导去调用工具,就能表现得像一个合格的 team worker。这正是"薄适配层"这个定位的字面体现:模块 docstring 说得很直接——"identity and authority never live here: the dialect is already bound to one actor ..., and every write is judged by the store/server — this file is a thin adapter, safe to hand to any harness"。所有的权限判断早已经在 `dialect`(进而在 `TeamStore`/`JournalStore`)里完成,`mcp_server.py` 唯一做的事是把 dialect 的方法签名翻译成 MCP 工具签名,并把异常统一包装成 `{"error": ...}` 结构:

```python
# coworker/teams/mcp_server.py:40-44
def _safe(func, *args, **kwargs) -> Any:
    try:
        return func(*args, **kwargs)
    except (BoardError, ValueError) as error:
        return {"error": str(error)}
```

工具集会按角色裁剪——`board_assign`/`board_link`/`board_policy` 这三个动词只在 `role in ("lead", "user")` 时才被注册进 server:

```python
# coworker/teams/mcp_server.py:135-146(节选)
if role in ("lead", "user"):
    @mcp.tool()
    def board_assign(item: int, assignee: str) -> Any:
        """Assign a work item to a worker (or to yourself to reserve it)."""
        return _safe(dialect.assign, space, item, assignee)
    ...
```

也就是说,一个以 worker 身份接入的外部 agent,连 `board_assign` 这个工具本身都不会出现在它能看到的工具列表里——这是"授权在协议层可见"的一种体现:权限不只是调用后被拒绝,而是从工具枚举阶段就按角色收窄了可见范围。`board_list`/`board_show`/`board_create`/`board_claim`/`board_move`/`board_comment`/`board_attach`/`board_pending`/`board_consume`/`journal_append`/`journal_read`/`journal_cases` 这组工具则对所有角色开放,构成了上一篇提到的 `WORKER_VERBS` 在 MCP 协议层的镜像。

`serve()` 是最后一步,把组装好的 server 跑在 stdio 传输上:

```python
# coworker/teams/mcp_server.py:210-211
def serve(dialect, *, space: str) -> None:
    build(dialect, space=space).run("stdio")
```

stdio 是当前几乎所有 MCP 客户端(包括各类编码 agent 的 MCP 配置)都默认支持的传输方式,选择它而不是要求一个网络端口,进一步降低了外部 harness 接入的门槛——它们的 MCP 配置只需要指向一条可执行命令,不需要额外的网络配置。

### `ocw board mcp`:从命令行到一个可被外部接入的进程

`teams/cli.py` 里的 `_cmd_mcp()` 是这条链路真正被触发的地方:

```python
# coworker/teams/cli.py:443-446
def _cmd_mcp(args) -> int:
    from .mcp_server import serve
    serve(_dialect(args), space=_space(args))
    return 0
```

它复用了和其他 `ocw board` 子命令完全相同的 `_dialect(args)` 解析逻辑——这正是 `dialect.py` 这层抽象真正发挥价值的地方:`ocw board mcp` 不需要知道自己连的是本地 SQLite 还是远程 server,只需要拿到一个已经绑定好身份的 dialect,剩下的事情和 `ocw board list`/`ocw board move` 完全一样。`cli.py` 顶部的 backing 解析优先级说明了这条命令实际会怎么被使用:

```python
# coworker/teams/cli.py:1-18(节选,docstring)
"""`ocw` — the board and journal from any shell, for any harness.
...
Backing resolution, in order:
1. `--url` + `--token` (or OCW_BOARD_URL / OCW_BOARD_TOKEN) — a remote board.
2. `--db DIR` — direct SQLite in that state dir (headless; you are the only writer).
3. A running local server, discovered via its sidecar token files ...
4. Direct SQLite on the default state dir (nothing else is running).

`ocw board mcp` serves the same surface as an MCP server on stdio — the way to
hand a board to an external coding agent: point the agent's MCP config at
`ocw board mcp --url … --token … --space …` and ask it to claim a work item.
"""
```

落到实际操作上,一个团队想让另一款编码 agent(不是 OpenWorker 自己的 session)加入某块看板当 worker,完整链路是:先用 `ocw board token mint --actor <name> --role worker` 在服务这块看板的机器上签发一个 worker 身份的 token(对应上一篇讲过的 `BoardTokens`);把这个 token 和 board 的 URL 写进那款外部 agent 的 MCP 配置,让它以 `ocw board mcp --url ... --token ... --space ...` 的方式启动一个 MCP server 子进程;外部 agent 连接上后,看到的工具集、能执行的动作,完全由它 token 绑定的 `role`(这里是 `worker`)在 `TeamStore`/`JournalStore` 里被允许的范围决定——和一个原生的 OpenWorker worker persona 受到的权限约束完全一致。

这就是"Board 不只是 OpenWorker 内部私有机制"这句话的具体含义:一块看板的权威副本可以完全托管在 OpenWorker 这一侧(不管是本机直连的 SQLite,还是跑成一个可以被远程连接的 sidecar server),但**参与协作的 agent 不需要是 OpenWorker**。只要外部系统能起一个 MCP 客户端、能拿到一个 token,它就能像一个合法的 team worker 一样认领条目、迁移状态、往 Journal 里写调查发现——这条能力边界完全由 dialect 绑定的 `Actor` 角色决定,而不取决于连接进来的是谁写的代码。

## 常见问题/易踩坑

- **把 `explore` 和 Team/Board 的委派当成同一套机制**:如前所述,二者代码不相交、生命周期不同、可见性不同——`explore` 的执行过程对外完全不可见,Team/Board 的每一步都是可审计的事件。
- **假设一个持有 worker token 的外部 agent 能做 lead 才能做的事**:`mcp_server.py` 在工具枚举阶段就按角色裁掉了 `board_assign`/`board_link`/`board_policy`,即便外部 agent 尝试直接拼一个等价的请求,`TeamStore` 的 `_require()` 也会在数据层再次拒绝。
- **忽略 `--url`/`--db` 二选一背后的并发约束**:`dialect.py` 明确警告过,只要有 server 在跑,其它写入者就必须走 `RemoteDialect`,直接对同一个 SQLite 文件发起第二个写入进程会破坏哈希链的"读头再写"假设——这也是为什么 `ocw` 的 backing 解析会优先探测本机是否已有 server 在跑,而不是无脑走 `--db`。

## 小结

`tools/subagent.py` 里的 `explore` 和 `teams/` 目录下的 Team/Board 机制,是 OpenWorker 里两条各自独立、服务于不同问题的委派路径:前者是一次性的、只读的、上下文隔离技巧,后者是持久化的、可审计的、跨会话协作系统,不应该被叙述成同一套框架的两种形态。而 `teams/mcp_server.py` 把上一篇讲过的 `BoardDialect` 包装成一个标准的 stdio MCP server,配合 `ocw board mcp` 这行命令,让 Board/Journal 从"OpenWorker 内部的团队协作机制"变成一个任何支持 MCP 的外部 harness 都能接入、且权限边界与内置 worker 完全一致的开放能力——这是这一章里最能体现"多智能体协作"不局限于单一框架内部的设计。到这里,persona 如何定义一个专家、Team/Board/Journal 如何承载协作、委派与开放接口如何划清边界,这一章的三条主线就讲完了。下一章会转向记忆系统和自动化调度——看 OpenWorker 如何让一个专家 coworker 在没有人盯着的时候,依然记得该记的事、在该醒来的时候自己醒来。
