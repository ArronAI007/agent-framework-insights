# Provenance 与 Audit 审计追踪

> README 对第三层治理的描述是:"Every tool call is recorded with its approval provenance — auto-approved, user-approved, or denied, with the reviewer's reasoning attached — and persisted with the conversation"。读到这句话时很容易顺着字面意思去找一个叫 `provenance.py` 的模块,以为它就是"审批出处"的记录者——但读完源码后必须诚实地纠正这个假设:`coworker/provenance.py` 实际记录的是另一件事(agent 本次会话自己创建或下载过哪些文件),真正实现"谁批准的、reviewer 给出的理由是什么"这套记录契约的,是 `coworker/engine.py` 里的 `_approval_origins` 机制,加上 `coworker/audit.py` 的持久化存储。本篇把这两条容易被混淆的线索分开讲清楚,再讲 `inbox.py`/`inbox_routing.py` 如何让无人值守场景下的审批请求"进收件箱、等人来答"。

## 学习目标

- 弄清楚 `coworker/provenance.py` 真正的职责边界——它是"agent 本次创建了哪些文件"的记录者,服务于 reviewer 和人工审批卡的上下文展示,而不是"审批出处"的记录者。
- 找到 README"auto-approved / user-approved / denied,附带 reviewer 理由"这套记录契约在代码里的真实落点:`engine.py` 的 `_approval_origins` 字典 + `_audit()` 调用。
- 理解 `coworker/audit.py` 的 `AuditStore` 表结构、字段含义,以及它如何对参数做脱敏处理。
- 理解 `coworker/inbox.py`/`inbox_routing.py` 如何让审批请求"进收件箱、从任意界面回答、有且仅有一次生效"。

## 背景与设计动机

在动手写这一篇之前,先把一个容易踩的坑摆在明处:仓库里确实存在一个名为 `coworker/provenance.py` 的文件,但它的模块 docstring 一开始就说明了自己要解决的问题:

```python
# coworker/provenance.py:1-14(节选)
"""What the agent itself created this session — and the one fact that follows (OPE-114 §1).

The reviewer is never shown file contents, so `python scripts/setup.py` cannot be judged
from its text: the effect lives inside a file neither the reviewer nor the human at the
card is shown. But the engine knows something neither of them does — whether it wrote or
downloaded that file moments ago. This module keeps that record and renders it as one line
of fixed-vocabulary fact.

Deliberately NOT here: reading file contents, analysing what a script does, or tracing
values out of untrusted text (the general taint tracking of OPE-114 is a separate, larger
design). ...
"""
```

这段话讲的是完全另一件事:reviewer(以及审批卡上的人类)看不到文件内容,所以一条 `python scripts/setup.py` 命令光看文本没法判断它到底做了什么——但引擎自己知道一件 reviewer 和人类都不知道的事:这个文件是不是**这次会话里 agent 自己刚写的或刚下载的**。这一模块只负责把这一个事实渲染成一行固定措辞的话(比如"`setup.py` was downloaded by the agent 2 steps ago"),供 reviewer 判断和人工审批卡展示——它跟"这次调用是被谁批准的"完全无关。真正记录"批准出处"的逻辑,分布在 `engine.py` 和 `audit.py` 里,下面分别展开。

## 核心机制详解

### `provenance.py` 真正做什么:文件溯源,不是审批溯源

`SessionFiles` 类是这个模块的核心,它按"路径 → 何时创建、以什么方式创建"记录状态:

```python
# coworker/provenance.py:223-257(节选)
class SessionFiles:
    """Per-session record of what the agent created. Runtime-only, like the engine's other
    reviewer state: a restart starts clean rather than inheriting stale provenance."""

    def __init__(self, workspace_root: Path) -> None:
        self.root = Path(workspace_root)
        self._files: dict[str, Origin] = {}

    def record(
        self, tool_name: str, arguments: dict[str, Any], result: Any, *, step: int
    ) -> None:
        """Note what a SUCCESSFUL call created. Callers must not record failed calls: a
        write that raised left nothing on disk to run."""
        paths, origin = created_paths(tool_name, arguments, result)
        for path in paths:
            self._files[resolve(path, self.root)] = Origin(step=step, kind=origin)

    def match(
        self, tool_name: str, arguments: dict[str, Any], *, step: int
    ) -> Optional[Match]:
        """The most recently created path this call names, or None."""
        ...
```

它区分两种起源——`WRITTEN`(通过 `write_file`/`apply_patch` 这类内置写工具产生)和 `DOWNLOADED`(通过 `curl -O`、`github_clone` 这类"拉取外部内容"的调用产生),并且只在 `run_shell` 场景下解析命令行文本里可能涉及的路径(`command_paths()`)。这个区分很关键,因为它直接决定了 `engine.py` 里的处理方式不同:

```python
# coworker/engine.py:1135-1155(节选)
# OPE-114 §1: running something the agent DOWNLOADED this session is the classic
# fetch-then-execute chain, and there is no quiet legitimate version of it — so it
# goes to a person, over both the reviewer and any command allowlist that would
# otherwise wave it through ... Agent-WRITTEN files are not
# floored — "write this script and run it" is ordinary work — they travel as a fact
# for the reviewer to weigh instead.
provenance_note = self._provenance(tool_call)
if self._downloaded_target(tool_call) is not None and (
    decision.needs_user or allowed
):
    allowed = False
    reason = f"this file was downloaded by the agent this session — {provenance_note}"
    decision = replace(decision, allowed=False, reason=reason, needs_user=True, human_only=True)
```

"这次会话里下载的文件被拿去执行"这个模式(经典的 fetch-then-execute 攻击链)被单独提出来当作一条硬性红线——即使权限引擎本来判断放行、即使 reviewer 本来会判断放行,只要目标是"刚下载的文件",一律翻转成需要人工确认且 `human_only=True`。而"agent 自己写的脚本被拿去执行"则被认为是正常工作流程("write this script and run it" is ordinary work),不会被强制拦下,只是作为一条事实(`provenance_note`)传给 reviewer 去权衡。这是 `provenance.py` 存在的全部意义——它是"下载后执行"这道专门红线,以及给 reviewer 提供额外上下文这两件事的支撑模块,和"审批是谁给的"不是一回事。

### 真正的"审批出处":`engine.py` 的 `_approval_origins`

README 说的"每次工具调用都带着它的审批出处被记录下来——自动批准、用户批准,还是被拒绝,并附带 reviewer 的理由",这套契约的真实实现是 `TurnEngine._authorize()` 里贯穿全程维护的 `self._approval_origins` 字典。这个字典在调用的不同阶段被写入不同的"出处"标签:

- **`bypass` 模式全权放行**:

```python
# coworker/engine.py:1166-1169
# (c) Bypass mode ran a consequential call no other rule allowed: annotate it.
# "full access" is the exact reason string of permissions.py's bypass branch.
if allowed and decision.reason == "full access":
    self._approval_origins[tool_call.id] = {"origin": "bypass"}
```

- **MCP 信任规则放行**(区分是用户自己设的信任规则,还是服务器自带的 `requires_approval: false` 标志):

```python
# coworker/engine.py:1178-1187(节选)
if allowed and decision.reason.startswith("trusted MCP tool"):
    origin = (
        "trusted_rule" if "user trust rule" in decision.reason else "trusted_server"
    )
    self._approval_origins[tool_call.id] = {"origin": origin}
```

- **reviewer 放行,附带理由**:

```python
# coworker/engine.py:1230-1236(节选)
if verdict.verdict == "allow":
    allowed = True
    self._reviewer_denials = 0
    self._approval_origins[tool_call.id] = {
        "origin": "reviewer", "note": verdict.reason
    }
```

- **人工点击放行或拒绝**(`grant` 字段记录了具体是哪一种批准方式——一次性、常驻工具、常驻命令、常驻域名、只读会话授权、durable trust、还是本次运行内的临时授权):

```python
# coworker/engine.py:1359-1410(节选)
if outcome is ApprovalOutcome.DENY:
    ...
    self._approval_origins[tool_call.id] = {
        "origin": "user", "grant": "deny", **({"note": unsure_note} if unsure_note else {}),
    }
    ...
else:
    ...
    self._approval_origins[tool_call.id] = {
        "origin": "user", "grant": outcome.value, **({"note": unsure_note} if unsure_note else {}),
    }
```

这个字典最终被渲染进 `_display` 字段,附着在会话记录的工具调用消息上(`engine.py:1416-1422`),这是"审批出处"最终展示给用户、以及被持久化进对话记录的地方——README 说的"persisted with the conversation"正是指这一步:审批出处和对话历史存在一起,而不是单独一份日志。

### 落盘的一半:`AuditStore`

`_approval_origins` 是内存里的、附着在单次调用上的即时记录,真正跨会话、跨重启、可查询的持久化落在 `coworker/audit.py` 的 `AuditStore`。它的模块 docstring 只有一句话——"Durable local audit log for connector/tool actions"——但表结构说明了它记录的粒度:

```python
# coworker/audit.py:32-54(节选)
self._conn.execute("""
    CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
        session_id TEXT,
        agent TEXT,
        workspace TEXT,
        connector TEXT,
        tool TEXT,
        stage TEXT,
        status TEXT,
        approval TEXT,
        args TEXT,
        result_preview TEXT,
        reason TEXT,
        resource TEXT,
        call_id TEXT,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cache_read INTEGER DEFAULT 0,
        cache_write INTEGER DEFAULT 0
    )
    """)
```

`stage` 字段是理解这张表的关键——同一次工具调用在生命周期的不同阶段会写入多条记录,`engine.py` 里能看到的 `stage` 取值包括 `auto_allowed`(允许列表/常驻规则/信任规则放行)、`approval_requested`(卡片弹出)、`reviewer_verdict`(reviewer 给出裁决,`status` 就是 `allow`/`deny`/`unsure`,`reason` 就是它的理由)、`reviewer_shadow`(影子评测,不影响决策)、`approval_resolved`(人工点击的最终结果,`approval` 字段存的正是 `ApprovalOutcome` 的取值——`once`/`always_tool`/`always_command`/…/`deny`)、`finished`(调用真正执行完的结果)。`call_id` 字段把同一次工具调用在不同阶段产生的多条记录串联起来——比如一条 `reviewer_verdict` 记录和随后可能出现的 `approval_resolved` 记录,靠 `call_id` 关联成"reviewer 怎么判断的"和"人最终怎么判断的"这一组可对比的数据,这也是第 11 章 reviewer 评测方法论要用到的原始数据结构。

`AuditStore.append()` 在落盘前会对参数做脱敏处理:

```python
# coworker/audit.py:192-206
def _sanitize_args(tool: str, args: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(args, dict):
        return {}
    out: dict[str, Any] = {}
    for key, value in args.items():
        lk = str(key).lower()
        if any(s in lk for s in _SECRET_KEYS):
            out[key] = "[redacted]"
        elif tool == "browser_type" and lk == "text":
            out[key] = "[redacted input]"
        elif any(b == lk or lk.endswith("_" + b) for b in _BODY_KEYS):
            out[key] = "[redacted body]"
        else:
            out[key] = _summarize(value)
    return out
```

字段名包含 `token`/`secret`/`password`/`api_key` 等关键词的一律替换成 `[redacted]`,浏览器输入文本和邮件/消息正文类字段也各自有专门的脱敏占位符——审计记录要"回答谁做的、为什么",但不能把凭据和敏感正文原样存进这张明文可查询的表里,这是"可追溯"和"最小化暴露面"之间的一处具体权衡。

`reviewer_stats()` 方法则是把 `reviewer_verdict`(真正生效的裁决)和 `reviewer_shadow`(影子评测)分桶统计——`live` 和 `shadow` 两个桶各自独立计数,这也印证了上一篇讲的"影子评测不影响任何决策"这条设计在存储层的体现:两类记录物理上共享一张表,但从不被混在一起统计。

### `audit_autonomy_change`:治理姿态本身的变化也要留痕

除了单次工具调用的审批记录,`coworker/server/manager.py` 里还有一处专门记录"治理姿态整体变化"的审计:

```python
# coworker/server/manager.py:4347-4383(节选)
def audit_autonomy_change(
    self, session_id: str, kind: str, before: Any, after: Any
) -> None:
    """Record a change to how much the agent may do unsupervised — the permission mode,
    or the attended/unattended toggle. Without this, "who turned on auto mode, and when"
    is unanswerable from the audit store, which is at odds with the per-call trail the
    rest of the engine keeps. Raising autonomy is flagged so it can be filtered."""
```

这条记录回答的是比"这一次工具调用怎么被批准的"更高一层的问题:"谁在什么时候把这个会话切到了更高的自主权模式"——`order` 字典把 `discuss`(0)到 `auto`/`bypass-approvals`(4)按自主权高低排了序,只要新模式的序号高于旧模式,或者 `unattended` 从关到开,这次变化就会被标记为"raised",方便审计时单独筛出"权限被放宽"的事件。这条记录同样落在同一张 `audit_events` 表里,`stage` 是 `mode_changed` 或 `unattended_changed`。

### `inbox.py` / `inbox_routing.py`:无人值守时,审批请求进收件箱

README 最后一句"Unattended runs never self-approve: their asks park in an inbox until a human answers"对应的正是 `coworker/inbox.py`。它的模块 docstring 讲清楚了这个"跨会话人类关注队列"的定位:

```python
# coworker/inbox.py:1-12(节选)
"""The Inbox — the canonical, cross-session human-attention queue.

While a user works in one session (or is away with a session running Unattended), the Inbox
holds what other agents need from them: an **approval**, a **question**, or a **notification**.
...

Item state machine (the anti-race contract): each item is ``pending → resolved``, resolved
**once**, idempotent + first-responder-wins — so answering from any surface (in-app, Slack, the
composer after resuming) is safe. ``inbox_approver`` turns a permission request into an item and
suspends the agent until that item is resolved.
"""
```

`InboxStore.resolve()` 就是这条"只生效一次"契约的实现:

```python
# coworker/inbox.py:334-348
def resolve(self, item_id: str, resolution: str) -> bool:
    """Resolve an item exactly once. First responder wins; later attempts are no-ops
    (return False). Fires any awaiting agent (the suspended inbox_approver)."""
    with self._lock:
        item = self._items.get(item_id)
        if item is None or item.state == STATE_RESOLVED:
            return False
        item.state = STATE_RESOLVED
        item.resolution = resolution
        item.resolved_at = _now()
        self._save()
    waiter = self._waiters.get(item_id)
    if waiter is not None:
        waiter.set()
    return True
```

第一个到达的回答生效,之后任何对同一个 `item_id` 的解析请求都直接返回 `False`——这解决的是一个真实的竞态场景:同一个审批请求可能同时出现在桌面应用、Slack 消息、以及用户恢复会话后的输入框里,三处任何一处都可以回答,但不能出现"先在 Slack 点了拒绝,过一会儿又在桌面应用点了批准"这种互相覆盖的情况。`inbox_approver()` 把一个权限请求包装成收件箱条目并挂起 agent,直到条目被解析:

```python
# coworker/inbox.py:387-407(节选)
def inbox_approver(store: InboxStore, session_id: str, *, inbox: str = "default"):
    async def approve(request: "PermissionRequest") -> "ApprovalOutcome":
        item = store.add_approval(
            session_id, title=f"Run `{request.tool_name}`?", body=request.reason or "", inbox=inbox,
        )
        resolution = await store.wait(item.id)
        if resolution == "always":
            return ApprovalOutcome.ALWAYS_TOOL
        if resolution == "allow":
            return ApprovalOutcome.ONCE
        return ApprovalOutcome.DENY
    return approve
```

而路由到哪个收件箱、是否要镜像到 Slack/Telegram 频道,是 `inbox_routing.py` 的职责——每个会话按"会话自己的覆盖设置 > 所属 persona 的默认设置 > 全局默认收件箱"这个优先级解析(`InboxRouting.route_for()`),一个绑定了外部频道的收件箱条目会在投递文本里嵌入形如 `[ow:<id>]` 的令牌(`inbox_routing.py:109-117`),后续从该频道收到的回复只要能提取出这个令牌(以及一个简单的"批准/拒绝"意图词——`_reply_intent()` 只看回复消息的**第一个词或表情**,避免"I cannot approve this yet"这类否定句被子串匹配误判成批准),就能通过 `resolve_from_reply()` 关联回原始条目并解析它。

`inbox.py` 里另一处细节值得一提:`add()` 方法接受的 `tool_call_id` 用来保证"幂等":

```python
# coworker/inbox.py:142-147(节选)
# Idempotent by (session_id, tool_call_id): a durable resume re-raises the same prompt, and
# must reuse the existing (possibly already-resolved) item rather than re-prompt.
if tool_call_id:
    existing = self.for_tool_call(session_id, tool_call_id)
    if existing is not None:
        return existing
```

一次进程重启后的"持久化恢复"可能会重新走到同一个待批准的工具调用,这时不应该重新弹出一张新的审批卡,而是找回原来那一张(可能已经被回答过)——这条幂等保证让"无人值守 + 进程可能重启"这个组合场景不会产生重复的审批请求。

`unattended.py` 值得单独澄清一句它**不**做什么:

```python
# coworker/unattended.py:1-6(节选)
"""Unattended mode — a per-session toggle for *where the human is reached*.

It does **not** change the autonomy ceiling (the permission mode does). When a session is
unattended, anything that would prompt inline (approval / question) is routed to the Inbox and
the agent suspends until answered; the composer is disabled.
"""
```

"unattended" 只决定审批请求投递到哪里(内联在当前对话框 vs. 收件箱),不决定这次调用需不需要审批、以及审批的宽松程度——这两件事完全是 `permissions.py` 的 `mode` 字段管的。这条区分解释了为什么第 3 篇讲的 `_reviewer_active()` 要求 `is_attended()` 必须为真:一个无人值守的会话即使处于 `AUTO_APPROVE` 模式,它的审批请求也不会去咨询 reviewer,而是直接进收件箱——"unattended runs never self-approve"这句话在代码里的落点,正是 `_reviewer_active()` 那一条 `and self.is_attended()` 判断。

## 常见问题/易踩坑

- **不要把 `coworker/provenance.py` 当成"审批溯源"的实现来找**——它记录的是"这个文件是不是 agent 本次会话自己写的/下载的",服务于 fetch-then-execute 红线和 reviewer 的上下文展示;真正的审批出处记录分布在 `engine.py` 的 `_approval_origins` 与 `audit.py` 的 `audit_events` 表里,两者字面上都不叫"provenance",阅读源码时容易被模块名误导。
- **`_display` 字段和 `AuditStore` 里的记录是两份不同粒度的存储**——前者是附着在单条会话消息上、随对话记录一起持久化的展示层数据(README"persisted with the conversation"说的就是它);后者是独立的 SQLite 表,支持跨会话查询、按 `session_id`/`connector`/`tool` 过滤。两者内容有重叠但不是同一份数据,不要假设改一处另一处会同步。
- **Inbox 条目的"解决一次"语义是无条件的**——即使一个条目被解决后又收到另一个来源的回复,`resolve()` 直接返回 `False`,不会抛异常也不会覆盖已有结果;排查"为什么我在 Slack 点的按钮没反应"这类问题时,第一步应该确认条目是否已经在别的界面被回答过。

## 小结与下一篇

README 承诺的"每次调用都带着审批出处被记录"这句话,真正落地在两个地方:`engine.py` 的 `_approval_origins` 在单次调用的生命周期里实时打上 `bypass`/`reviewer`/`trusted_rule`/`user` 等标签并附上理由,最终随对话记录一起持久化;`audit.py` 的 `AuditStore` 则是一张独立的、可跨会话查询的 SQLite 表,用 `stage` 字段把同一次调用在放行/审批请求/reviewer 裁决/最终结果这几个阶段的记录串起来,并对参数做了脱敏处理。真正叫 `provenance` 的模块管的是完全不同的一件事——文件溯源,支撑的是"下载后执行"这条硬性红线。`inbox.py`/`inbox_routing.py` 则解决了"人不在场时,审批请求该去哪里等谁来回答"这个问题,靠"解决一次、任意界面回答"的状态机保证无人值守场景下不会出现审批被静默跳过或被互相覆盖的情况。下一篇是本章的收束篇,会回到"自主权阶梯"这条线索本身——`coworker/overrides.py` 里"一次性批准 → 常驻规则 → 配置白名单"这条晋升路径具体是怎么一步步实现的,以及每一步"显式、可见、可撤销"的承诺分别对应哪段代码。
