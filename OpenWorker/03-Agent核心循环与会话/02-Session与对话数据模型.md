# Session 与对话数据模型

> `coworker/sessions.py` 只有 46 行,定义了一个 `SessionRecord` dataclass;真正的会话存储逻辑在 `coworker/conversations.py` 的 `ConversationStore` 里——SQLite 存元数据,每个会话的消息则各自追加写入一个独立的 `.jsonl` 文件。这一篇要讲清楚：一个 Session 到底装的是什么、它和"一次任务"是什么关系、消息历史用什么姿势落盘和恢复,以及 `coworker/session_facts.py` 里的"会话事实"——先说结论：它不是一份会随对话内容持续更新的摘要,而是一份在会话开始那一刻冻结的、后续永不改变的"已知世界"快照,外加一条只增不改的"外部内容摄入"审计流水。这两者的区别,决定了它和第三篇要讲的压缩机制之间没有直接依赖关系。

## 学习目标

- 理解 `SessionRecord`（`coworker/sessions.py`）里每个字段代表什么,以及"一个 Session"和"一次用户输入触发的一轮循环（turn）"“一次自动化任务(task)"之间的关系。
- 弄清楚 `ConversationStore` 的存储布局——SQLite 索引 + 每会话一个 append-only `.jsonl` 文件——以及为什么"只追加新消息、不重写全量历史"是默认路径,`len(record.messages) < existing` 触发的原子重写只是一个不常见的兜底分支。
- 通读 `_repair_tool_pairing()`,理解为什么一次被中断的工具调用会在磁盘上留下 `tool_call` 和 `tool_result` 错位的历史,以及这个自愈算法如何区分"待恢复的挂起调用"和"真正损坏的历史"。
- 理解 `session_facts.py` 里 `KnownWorld`（冻结快照）与 `Ingestion`（摄入流水）的真实语义,纠正"它是持续更新的任务摘要"这类望文生义的猜测。

## 背景与设计动机

一个 Session 在 `openworker` 里是长期存在的东西——用户可能在周一开一个会话讨论一个功能,周三回来接着聊,中间这个会话可能被进程重启打断过很多次(桌面 App 更新、机器休眠又唤醒、服务器进程被杀掉重启)。这就带来几个朴素做法容易翻车的地方：

- **历史不能全量重写。** 如果每一轮对话都要把整个消息列表重新序列化写一遍磁盘,历史越长这个操作越慢,而且如果写到一半进程崩溃,整个历史文件就可能损坏。
- **中断点必须能安全恢复。** 一次工具调用如果在"模型请求了工具、还没等到结果"这个中间态被打断（进程重启、用户点了 Stop）,消息历史里会留下一个孤立的 `tool_calls` 块——如果轻率地在下次加载时把它当成"损坏数据"清掉,恢复逻辑就没有对象可以恢复了;但如果不做任何清理,一次真正意外损坏的历史（比如追加写到一半磁盘满了)也会被原样交给 provider,后者会直接拒绝这个请求。
- **"已经发生过的事实"和"当前对话内容的摘要"是两件事,不能混着存。** 会话开始时的工作区路径、git remote 这些"背景事实"在整个会话生命周期里几乎不会变,而对话内容本身会随着压缩不断被改写——把这两者放在同一个数据结构里维护,会让"这份状态到底谁负责更新"变得含混。

`openworker` 的做法是：`SessionRecord` 只装不涉及"如何编排一次循环"的纯元数据（工作区、模型、模式、标题、附加根目录、审批授权记录……),真正的消息历史交给一个append-only 的 `.jsonl` 文件,并且在每次加载时跑一遍幂等的自愈修复;至于"会话开始时的既有事实",则完全独立于对话内容,用一个 `frozen=True` 的数据结构在会话构建那一刻定格,此后再也不碰。

## 核心机制详解

### SessionRecord：一份纯元数据快照

```python
# coworker/sessions.py
@dataclass
class SessionRecord:
    session_id: str
    workspace: str
    model: str
    mode: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    title: Optional[str] = None
    agent: str = "code"
    message_count: int = 0
    updated_at: Optional[str] = None
    extra_roots: list[dict[str, Any]] = field(default_factory=list)
    grants: dict[str, Any] = field(default_factory=dict)
    pinned: bool = False
    archived: bool = False
    origin: Optional[str] = None
    origin_label: Optional[str] = None
    compaction: dict[str, Any] = field(default_factory=dict)
    bindings: dict[str, Any] = field(default_factory=dict)
    team: dict[str, Any] = field(default_factory=dict)
```

这个 dataclass 的每个字段都对应一件"这个会话作为一个长期存在的容器需要记住"的事情,而不是"这一轮对话产生了什么"。`workspace`/`model`/`mode` 是这个会话绑定的运行环境;`extra_roots` 是会话运行过程中额外授权的目录（第一篇提到的 `RootDir` 列表,持久化的只是主工作区之外的部分——主 workspace 每次构建引擎时会重新确定);`grants` 是"永久允许"这类审批授权,字段注释直接点明了动机——"session-scoped by design, but the session outlives the process, so they must too"（会话本该是进程内的授权范围,但 Session 本身比进程活得更久,所以授权也必须落盘,不然每次重启都要重新审批一遍);`compaction` 是第三篇要讲的压缩状态序列化;`origin`/`origin_label` 记录这个会话是不是由自动化（Slack 提及、定时任务、self-wake）派生出来的。

这里能看出 **Session 和"任务"不是一回事**：`origin` 字段说明一个 Session 可以由某次任务触发而诞生,但 Session 本身作为一个持续存在的对话容器,生命周期是"从创建到被删除",而不是"从任务开始到任务结束"。`team` 字段进一步说明这一点——一个 Session 可以在运行过程中被纳入一个多 Agent 团队（`team = {"role": "worker", "actor": ..., "lead_session": ...}`),这是发生在 Session 已经存在之后的事,与它最初因为什么任务被创建没有必然关系。而"一轮用户输入触发的模型-工具循环"则是上一篇讲的 `TurnEngine.run()` 的粒度——一个 Session 在其生命周期里会经历成百上千次这样的 `run()` 调用。

### ConversationStore：SQLite 索引 + 每会话一个 append-only 文件

```python
# coworker/conversations.py
"""Layout under a base dir (default `~/.config/coworker/`):
  coworker.db                  SQLite index: sessions(id → project, title, n_msgs), workspaces, memory
  conversations/<id>.jsonl     append-only message log, one file per conversation

Writes append only the new messages each turn (no rewriting history)."""
```

`save()` 的核心分支就是这句话的具体实现：

```python
# coworker/conversations.py
def save(self, record: SessionRecord, touch: bool = True) -> None:
    sid = record.session_id
    with self._lock:
        existing = self._count(sid)
        if len(record.messages) > existing:
            self._append(sid, record.messages[existing:])
        elif len(record.messages) < existing:  # rare; not append-only
            path = self._file(sid)
            tmp = path.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                for m in record.messages:
                    f.write(json.dumps(m) + "\n")
            tmp.replace(path)
        ...
```

正常路径（`len(record.messages) > existing`)只把**新增的那一段尾巴**追加写入,不接触已经落盘的部分——这也是为什么整个模块的文件头注释敢说"append only"。真正会重写整个文件的分支只在消息数量反而变少时触发（这种情况很少见,注释直接标注"rare"),而且即便如此也不是直接 `open(path, "w")` 截断原文件,而是先完整写一份到 `.tmp`,再用 `tmp.replace(path)` 做原子替换——这与 `subscriptions.ChannelBuffer._save` 用的是同一套模式,目的是避免"写到一半进程崩溃,文件被截断成半份"这种情况。SQLite 那边则只存元数据（workspace、model、mode、标题、`n_msgs` 计数、grants/compaction/team 的 JSON 序列化),`messages` 列在迁移完成后固定写 `NULL`——消息内容的唯一真源是 `.jsonl` 文件。

### 会话 id 是一道明确的路径穿越防线

```python
# coworker/conversations.py
_SAFE_SESSION_ID = re.compile(r"\A[A-Za-z0-9_-]{1,128}\Z")

def _file(self, sid: str) -> Path:
    if not is_safe_session_id(sid):
        raise ValueError(f"unsafe session id: {sid!r}")
    path = (self.conv_dir / f"{sid}.jsonl").resolve()
    if path.parent != self.conv_dir.resolve():
        raise ValueError(f"unsafe session id: {sid!r}")
    return path
```

注释直接点明了攻击面："Session ids arrive from client-controlled surfaces (the `/ws/session/{id}` route, REST paths)"——一个客户端传入的 id 如果不做校验,`../../evil` 这种值就能让 `_file()` 拼出 `conv_dir` 之外的路径,写坏任意文件。这里做了两层校验：先用正则限定字符集（只允许 `[A-Za-z0-9_-]`,天然排除了 `/`、`\`、`.`),再在拿到 `resolve()` 之后的绝对路径时二次确认它的父目录确实还在 `conv_dir` 里——双保险,而不是只信任正则。

### _repair_tool_pairing()：把中断留下的历史修回合法状态

这是本篇最值得细看的机制。一次工具调用在助手消息里以 `tool_calls` 字段出现,对应的结果必须以 `role: "tool"` 消息紧跟其后——这是几乎所有 provider（Anthropic、OpenAI）共同的硬性约束。但 append-only 写入 + 进程可能在任意时刻被打断,天然会破坏这个约束：如果一次工具调用还没执行完、用户又发了一条新消息,磁盘上就会出现"assistant(tool_calls) → user → tool(result)"这种顺序——provider 看到这种历史会直接 400。

```python
# coworker/conversations.py
@staticmethod
def _repair_tool_pairing(messages: list[dict]) -> list[dict]:
    pending_calls: dict[str, int] = {}   # call_id → assistant 消息的下标
    for i, m in enumerate(messages):
        if m.get("role") == "assistant" and m.get("tool_calls"):
            for tc in m["tool_calls"]:
                if tc.get("id"):
                    pending_calls[tc["id"]] = i
    if not pending_calls:
        return messages

    found_results: dict[str, int] = {}   # call_id → 找到的 tool 结果下标（只取第一个）
    for i, m in enumerate(messages):
        if m.get("role") == "tool":
            cid = m.get("tool_call_id")
            if cid in pending_calls and cid not in found_results:
                found_results[cid] = i

    last_msg_idx = len(messages) - 1
    trailing_calls = {
        cid for cid, idx in pending_calls.items() if idx == last_msg_idx
    }
```

算法先做两趟扫描,分别记下每个 `tool_call_id` 是在哪条助手消息里发起的、又是在哪条 `tool` 消息里被回应的（只认第一个匹配,重复的结果不算)。关键的第三步是识别 `trailing_calls`——如果发起调用的那条助手消息本身就是整个历史的最后一条消息,说明这次调用**还没被处理完,引擎重启后会去恢复它**,不是残缺数据。只有当一个调用「不是」trailing、又找不到对应结果时,才会判定为需要修复;修复时要么把散落在后面的真实结果挪回调用紧后面,要么（结果彻底丢失时)合成一条占位的 `tool` 消息：

```python
repaired.append({
    "role": "tool",
    "tool_call_id": call_id,
    "content": '{"error": "tool result was lost during an interrupted turn"}',
})
```

这个"trailing 调用不合成占位"的判断,直接对应上一篇 `TurnEngine.resume()` 里的 `_unanswered_trailing_tool_calls()`——`resume()` 依赖的正是"历史尾部残留的未回应工具调用"这个信号,去恢复一次被打断的轮次。如果 `_repair_tool_pairing()` 把这些 trailing 调用也合成了占位结果,`resume()` 就永远找不到需要恢复的调用了——两处代码对"什么时候该恢复、什么时候该判定为损坏"的边界判断必须完全一致,这也是为什么这段逻辑的注释反复强调"idempotent"（幂等)——一份格式良好的历史经过这个函数必须原样不变。

`load()` 每次读取都会跑一遍这个修复:

```python
# coworker/conversations.py
def load(self, session_id: str) -> Optional[SessionRecord]:
    ...
    messages = self._repair_tool_pairing(messages)
    return SessionRecord(..., messages=messages, ...)
```

也就是说,只要引擎构建时通过 `ConversationStore.load()` 加载历史,这层自愈就自动生效——上层完全不需要关心磁盘上是否留下过中断的痕迹。

### session_facts.py：冻结的"已知世界",不是持续更新的摘要

`session_facts.py` 的模块 docstring 开门见山地把两件事分开陈述：

```python
# coworker/session_facts.py
"""Session facts — what was already familiar when the session began, and what arrived
from outside since.

Both are deterministic: no model is involved in producing either. **In v1 neither
changes a decision.**"""
```

第一部分是 `KnownWorld`——冻结快照：

```python
@dataclass(frozen=True)
class KnownWorld:
    roots: tuple[tuple[str, bool], ...] = ()
    remotes: tuple[tuple[str, str], ...] = ()
    hosts: tuple[str, ...] = ()
    captured_at: float = 0.0
```

`frozen=True` 不是随手加的装饰——docstring 里的类注释直接解释了原因："compared against the *live* state, an agent that runs `git remote add backup https://attacker.net/r.git` would make its own destination look familiar. Compared against a snapshot taken before it acted, it cannot."——如果"已知世界"是一份可以被更新的活状态,那么一个被提示词注入攻击的模型完全可以自己往 git remote 里加一条记录,再让后续判断把这条记录当作"用户本来就熟悉的东西"。冻结,恰恰是让这份基线**不可能被会话本身在运行过程中污染**的手段。`capture()` 只在 `build_engine()` 构造引擎那一刻调用一次:

```python
# coworker/agent.py
engine.session_facts = session_facts.SessionFacts(
    world=session_facts.capture(roots=root_list, allowed_domains=config.allowed_domains, workspace=ws)
)
```

第二部分是 `Ingestion`——只增不改的摄入流水,跟"已知世界"完全独立地增长：

```python
# coworker/session_facts.py
@dataclass
class SessionFacts:
    world: KnownWorld = field(default_factory=KnownWorld)
    turn: int = 0
    ingestions: list[Ingestion] = field(default_factory=list)

    def begin_turn(self) -> None:
        self.turn += 1

    def note(self, tool: str, arguments: dict[str, Any] | None) -> Ingestion:
        record = Ingestion(self.turn, tool, ingestion_source(arguments))
        self.ingestions.append(record)
        return record
```

`begin_turn()` 由 `TurnEngine.run()` 在每次用户输入到来时调用一次（上一篇读到过);`note()` 则由 `TurnEngine._note_ingestion()` 在一次工具调用成功返回、且这个工具的 `metadata.category` 属于 `{"web", "connector", "mcp"}`（即"结果可能携带外部世界内容"的工具类别)时调用。`Ingestion` 记录的只有"第几轮、哪个工具、内容大致来自哪个域名"三样事实,`docstring` 特别强调"never the content itself"——它记的是"这一步确实从外部拉取过内容"这个事实本身,而不是内容是什么,也不判断这次拉取是不是可疑。docstring 里还有一句很诚实的免责声明："Its absence is not proof of a clean session. Local reads are excluded, so a poisoned file already in the workspace produces no record at all."——这份流水本来就不追求完备,只追求"有记录的部分绝对真实"。

**这正是为什么 session_facts 和第三篇的压缩机制没有直接关系**：压缩处理的是"对话内容随时间增长"的问题,针对的是 `self.messages`;而 session_facts 处理的是"这个会话一开始站在什么已知背景上、后来又从外部世界摄入过什么"的治理问题,`KnownWorld` 从不更新、`ingestions` 只增不改也不会被摘要——两者是完全独立的数据结构,分别服务不同的下游消费者（`KnownWorld.render()` 被 `Reviewer` 用作审阅提示词的前缀,详见第 04 章;`ingestions` 目前只写入审计日志,v1 里"nothing consumes this"）。也正因为如此,`SessionRecord`（上面读到的 46 行 dataclass)里根本没有 `session_facts` 字段——它不需要跨进程重启保留,每次 `build_engine()` 都会用当时的工作区状态重新 `capture()` 一份新的冻结快照,这本身也是设计的一部分：一个新进程理应对"当前工作区看起来是什么样"重新做一次判断,而不是复用一份可能已经过时的旧快照。

## 常见问题/易踩坑

- **不要把 `grants`/`compaction`/`team`/`bindings` 这几个字段和普通消息保存混为一谈。** `conversations.py` 里 `set_team()`/`set_bindings()`/`set_extra_roots()` 都特意绕开常规的 `save()` 路径,直接对单个列做 `UPDATE`——注释解释了原因：`save()` 的 upsert 语句从不包含 `team` 列,如果按常规每轮保存的逻辑重建整条记录,会把 worker 会话和 lead 会话的团队关系意外抹掉。
- **`_repair_tool_pairing()` 和 `resume()` 对"trailing 调用"的判断必须保持一致**——这不是两处独立的代码,而是同一个不变量的两个消费端。修改其中一处对"什么算挂起、什么算损坏"的定义,另一处必须同步。
- **`session_facts` 不是压缩摘要,也不会随对话内容变化。** 如果需要"当前对话讲到哪了"这种活的、会更新的摘要,应该看第三篇的 `CompactionState`,而不是这里的 `KnownWorld`。

## 小结

`SessionRecord` 只装元数据,消息历史交给独立的 append-only `.jsonl` 文件,`ConversationStore.save()` 默认只追加新尾巴,只有消息数量倒退这种罕见情况才触发原子重写;`load()` 每次都会跑一遍 `_repair_tool_pairing()`,把中断可能留下的"工具调用/结果错位"自愈成合法历史,同时小心翼翼地不去动挂起中、尚待 `resume()` 恢复的 trailing 调用。`session_facts.py` 里的"已知世界"是一份在会话构建那一刻冻结、此后绝不更新的快照,配合一条只增不改的外部摄入流水——它和对话内容的压缩摘要是两套完全独立的机制。下一篇要讲的正是"对话内容随时间增长"这个真正会被摘要、被改写的问题：`compaction.py` 怎么决定该不该压缩、压缩哪一段、压缩失败了怎么办。
