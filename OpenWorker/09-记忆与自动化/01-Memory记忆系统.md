# Memory 记忆系统:模型主动写入而非系统自动提炼

> `coworker/memory/` 只有四个文件、不到 400 行代码,却把"记忆"这件事切得很干净:`base.py` 定义存储无关的统一接口和注入渲染逻辑,`sqlite_store.py` 是当前唯一的落地实现,`settings.py` 管一个和记忆表完全分离的开关与用户规则,`tools.py` 则是模型触达记忆的**唯一**入口——没有会话结束后自动跑一次侧路模型调用去"提炼"记忆这回事。这一篇就把这四个文件拆开,重点回答一个问题:OpenWorker 的记忆到底是谁在维护?答案和"系统在后台悄悄帮你自动提炼"这类设计完全不同。

## 学习目标

- 看懂 `MemoryStore` 这个抽象基类怎么把"记忆要不要落 SQLite、以后要不要换 Postgres"这件事和上层逻辑解耦。
- 理解 `INDEX_THRESHOLD_CHARS`/`INDEX_FULL_NEWEST` 驱动的"全量注入 vs 索引模式"切换,以及为什么这个切换对模型是"看得见但自动发生"的。
- 弄清楚 `Scope.GLOBAL`/`WORKSPACE`/`SESSION` 三种作用域里,`SESSION` 为什么在代码里被明确标注为"dead scope"。
- 理解 `remember`/`memory_update`/`memory_forget`/`memory_read` 四个工具怎么构成模型读写记忆的完整闭环,以及这条闭环和 GUI 记忆页面之间是什么关系。
- 弄清楚 `user_rules`(用户在 Settings 里写的规则)为什么被设计成模型永远不能触碰的字段,以及它和"学来的记忆"冲突时谁说了算。
- 简要理解为什么选 SQLite 而不是一堆散落的 Markdown 文件。

## 背景与设计动机

`coworker/memory/base.py` 开篇的模块 docstring 把记忆的定位说得很直接:

```python
"""Persistent memory — adapter interface + scopes.

Memory is the long-lived layer above transient conversation state: durable facts,
preferences, task notes, summaries. Scopes: global (user-wide), workspace (per project),
session. Backends are adapters (`SQLiteMemoryStore` now, `PostgresMemoryStore` later).
"""
```

两个关键词奠定了整篇的分析基调:**adapter**(存储后端可替换)和**scopes**(记忆按作用域分层,而不是一锅混装)。`MemoryStore` 是一个纯抽象类,`add`/`get`/`list`/`update`/`delete`/`delete_all` 六个方法构成了整套接口;当前唯一的实现是 `SQLiteMemoryStore`,但接口本身对存储介质一无所知——这就是为什么注释里已经预留了"`PostgresMemoryStore` later"这句话:换存储引擎不需要动上层任何一行调用记忆的代码。

更值得注意的是"谁来写记忆"这件事上的设计取向。翻遍 `coworker/` 全部代码,搜索 `memory_extract`、`auto_extract`、`extract_memor` 这类关键词,一个匹配都找不到——OpenWorker 里不存在"每轮对话结束后自动发起一次侧路模型调用,判断这轮有没有值得记住的事实"这种机制。记忆完全靠两条路径产生:模型在对话里主动调用 `remember`/`memory_update` 工具,或者用户在 GUI 的记忆页面里手动增删。这不是遗漏,而是一种明确的设计立场——记忆的取舍权交给对话当下的模型判断和用户的显式操作,而不是外包给一个额外的、模型看不见决策过程的自动化流程。

## 核心机制详解

### `MemoryItem` 与三种作用域:`SESSION` 是一个"死掉"的作用域

`base.py` 里的 `Scope` 是一个三值枚举:

```python
class Scope(str, Enum):
    GLOBAL = "global"
    WORKSPACE = "workspace"
    SESSION = "session"
```

`MemoryItem` 数据类携带 `scope`/`content`/`key`/`summary`/`workspace`/`session_id`/`created_at` 几个字段,其中 `workspace` 和 `session_id` 分别对应 `WORKSPACE` 和 `SESSION` 两种作用域该往哪张"表格"里归档。但在 `tools.py` 的 `remember` 工具里,`SESSION` 这个取值被显式挡了下来:

```python
chosen = Scope(scope) if scope in _SCOPES else Scope.WORKSPACE
if chosen is Scope.SESSION:  # dead scope (spec §3): never save to it
    chosen = Scope.WORKSPACE
```

注释直接写明"dead scope"——`SESSION` 在数据模型层面仍然存在(`MemoryStore.list` 依然接受 `session_id` 过滤参数),但产品规范(spec §3)已经决定不再往这个作用域写入新记忆,任何试图存成 `session` 作用域的请求都会被静默降级成 `workspace`。这是一个值得记住的读码经验:类型系统或数据模型里"看起来还在用"的字段,不代表业务逻辑真的还在使用它——需要往下游追一层才能确认。真正对模型开放的只有两档:`global`(跨项目、关于用户本人的事实)和 `workspace`(只对当前项目有效)。

### 全量注入与索引模式的自动切换

记忆最终要被塞进 system prompt,`base.py` 里的 `render_memory_block` 是这条链路的出口:

```python
INDEX_THRESHOLD_CHARS = 8_000
INDEX_FULL_NEWEST = 10

def render_memory_block(
    items: list[MemoryItem], *, threshold_chars: int = INDEX_THRESHOLD_CHARS
) -> str:
    """The injected memories block. Full mode while it's affordable; automatically and
    invisibly flips to index mode when the full rendering exceeds the threshold
    (MEMORY-SPEC §7). Evaluated once per engine build — a session is always in exactly
    one mode for its whole life."""
    full = format_memories(items)
    if len(full) <= threshold_chars:
        return full
    return format_memory_index(items)
```

`8_000` 字符这个阈值不是拍脑袋定的,代码注释给了一个具体的量级换算:一条典型记忆 20-40 个 token,这意味着这个阈值大约要攒到 50-100 条记忆才会触发;而这个数字本身还要照顾"最弱的那个支持配置"——一个只有 8k 上下文窗口的本地模型,是它给这条上限定了调子。

一旦超过阈值,`format_memory_index` 接管渲染:最新的 `INDEX_FULL_NEWEST=10` 条记忆仍然全文展示("最近的事实往往更相关"这一假设,softens 了两步检索的成本),其余的记忆只显示一行摘要:

```python
def _index_line(item: MemoryItem) -> str:
    """One-line rendering: the saved summary, or a truncated first line for rows
    written before summaries existed (no data migration)."""
    text = (item.summary or "").strip()
    if not text:
        text = item.content.strip().splitlines()[0] if item.content.strip() else ""
        if len(text) > 80:
            text = text[:77] + "..."
    return f"- [#{item.id}] {text}"
```

值得注意的降级细节:如果一条记忆是在 `summary` 字段还不存在的年代写入的(数据库做过 schema 演进但没有跑数据迁移),渲染层会退化成截断正文首行——这是一种"读时兼容"而不是"写时迁移"的策略,后面讲 SQLite 存储时还会再碰到一次同样的思路。摘要模式还会在最后附一句固定提示:

```python
_INDEX_NOTE = (
    "(Some memories above show only a one-line summary. Call memory_read with the "
    "[#id]s before acting on anything a summary hints at.)"
)
```

这句提示把"目前只看到了缩略版"这件事明确告诉模型,并指名要用哪个工具去补全细节——`memory_read`(下面会讲)正是为这个场景准备的。注释里还有一句容易忽略但很关键的话:"Evaluated once per engine build — a session is always in exactly one mode for its whole life"——全量/索引模式的判定只在引擎构建时算一次,不会在同一个会话进行中途因为记忆数量涨过阈值而突然切换渲染方式,避免了模型在一次对话里看到两种不一致的记忆呈现形态。

### 用户规则:模型永远不能碰的一份文本

`settings.py` 管理的不是记忆条目本身,而是一个和记忆表完全独立的开关与文本域。`MemorySettingsStore.enabled` 控制"记忆功能整体开关",docstring 说得很清楚:

> off 意味着构建引擎时不带任何记忆工具、不注入记忆 block、不给任何记忆相关指引;已有的记忆继续保留但处于失活状态;这个值在构建时读取,已经在跑的会话按它启动时的模式跑到底,不会中途变卦。

另一个字段 `user_rules` 才是本节的重点——它是用户在 Settings 界面里手写的一段标准规则文本,长度上限 `MAX_USER_RULES_CHARS = 20_000`。这个上限的注释解释了为什么要卡一个具体数字:

```python
# User Rules is a bounded settings field, not a document store: big enough for any
# real rule list, small enough that a paste-accident (or a hostile client) can't
# bloat every future system prompt.
```

它既要装得下任何真实的规则清单,又要小到不会因为一次误粘贴(或者一个恶意客户端)把之后每一次的 system prompt 都撑爆。而这个字段最关键的约束写在模块 docstring 里:

> **The agent never writes, edits, or deletes this** — no tool touches it; the only writer is the Settings UI via the manager.

`tools.py` 里注册的四个记忆工具确实没有一个能碰 `user_rules`——`memory_tools` 函数只接受一个 `MemoryStore` 实例,`user_rules` 走的是完全独立的 `MemorySettingsStore`,物理上就不在同一套读写通道里。渲染时 `format_user_rules` 把这段文本包装成一句明确的优先级声明:

```python
return (
    "User rules (written by the user in Settings; always follow these — on any "
    f"conflict they outrank learned memories):\n{text}"
)
```

"人写的规则"和"模型学来的记忆"之间的优先级在这里被写死:前者永远赢。这是一种朴素但有效的信任分层——用户显式写下的偏好,不应该被模型自己攒的、可能已经过时或者判断有误的记忆条目覆盖掉。

### SQLite 存储:为什么不是一堆 Markdown 文件

`SQLiteMemoryStore` 是当前唯一的落地实现,表结构很简单:

```python
self._conn.execute("""
    CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        key TEXT,
        content TEXT NOT NULL,
        summary TEXT,
        workspace TEXT,
        session_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
    """)
```

选 SQLite 而不是像有的同类项目那样一条记忆一个 Markdown 文件,原因从代码里能看出两点:一是 `list()` 需要按 `scope`/`workspace`/`session_id` 做组合过滤(这正是本篇要讲的三种作用域的查询需求),关系表 + `WHERE` 拼接比逐个打开文件解析 frontmatter 更直接;二是这个 store 要在多线程环境下被安全共享——构造函数里的注释说明了原因:

```python
# check_same_thread=False: the server runs the WS handler on a different thread
# than the store was created on; a lock serializes access.
self._lock = threading.RLock()
self._conn = sqlite3.connect(self.path, check_same_thread=False)
```

WebSocket 请求处理线程和 store 创建时所在的线程不是同一个,`check_same_thread=False` 配合一把 `RLock` 把并发访问序列化掉,这是比"每次读写都开关文件、自己维护文件锁"更省心的并发方案。

一个值得单独拎出来的细节是"读时兼容而非写时迁移"的 schema 演进方式:

```python
cols = {
    row["name"]
    for row in self._conn.execute("PRAGMA table_info(memories)").fetchall()
}
if "summary" not in cols:
    self._conn.execute("ALTER TABLE memories ADD COLUMN summary TEXT")
```

`summary` 字段是后加的能力,老数据库启动时会自动跑一次 `ALTER TABLE` 补齐这一列,但已有的旧记录不会被回填一份摘要——它们的 `summary` 就是 `NULL`,渲染层(上一节看到的 `_index_line`)自己负责在缺摘要时退化成截断首行。这和前面记忆索引模式里"没数据迁移就靠渲染时兜底"是同一种工程哲学的两次应用。

另一个有意思的方法是 `rekey_workspace`:

```python
def rekey_workspace(self, old: str, new: str) -> int:
    """Re-key workspace-scoped memories from one project key to another — the
    twentieth-pass one-time path→git migration. Rows are independent, so a
    collision with existing rows under `new` is just a union. Returns the
    number of rows moved."""
```

这背后对应的是 `coworker/projects.py` 里 `resolve_memory_key` 的身份解析梯队:"显式绑定 > git 仓库身份 > 文件路径"。项目最初用工作目录的绝对路径作为 `workspace` 的 key,后来发现同一个 git 仓库换个 checkout 路径(比如换机器、换克隆目录)记忆就跟丢了,于是改成优先用 git 身份作为 key;`resolve_memory_key` 在检测到某个工作区还在用旧的路径 key 时,会顺手调用一次 `rekey_workspace` 把这批记忆挪到新 key 下——这是一次性、幂等的迁移(挪过一次之后,旧 path key 下已经没有行可挪,再调用就是空操作),读代码时能看出这是"识别到方案本身要演进"之后打的一个补丁,而不是原始设计的一部分。

### 记忆工具:模型触达记忆的唯一入口

`tools.py` 暴露的四个工具——`remember`、`memory_read`、`memory_update`、`memory_forget`——共同构成模型对记忆读写的完整闭环,没有任何旁路。`remember` 的工具描述本身就在教模型怎么用这套系统:

```python
def remember(content: str, summary: str = "", scope: str = "workspace") -> dict:
    """Save a durable memory (a fact or preference) to recall in future sessions.
    Check the known-memories list first: if one already covers this, use
    memory_update instead of saving a near-duplicate.
    ...
    """
```

"先检查已知记忆列表,已经有覆盖的话用 `memory_update` 而不是存一条近似重复的记忆"——这条指引把"去重"这件事完全交给了模型的判断,代码本身没有做任何语义相似度比对或者签名去重(这一点和某些同类项目里用内容哈希做自动去重的思路不同)。

`memory_read` 是索引模式的另一半:

```python
def memory_read(memory_ids: list[int]) -> dict:
    """Read the full content of memories by id (use when the known-memories list
    shows only a one-line summary and you need the details before acting).
    """
```

它"始终注册,在全量模式下无害"——即使这一轮记忆没有触发索引模式,这个工具依然挂在工具列表里,模型调用它也不会出错,只是通常用不上。

`memory_update`/`memory_forget` 分别对应修正和退休一条记忆,两者都带一个"保存前通知"的回调机制:

```python
def _announce(item: MemoryItem, previous: Optional[str]) -> None:
    """Surface the write to the user (§5.1). Best-effort: the notice is never worth
    failing a write that already succeeded."""
    if on_saved is None:
        return
    try:
        on_saved(item, previous)
    except Exception:
        pass
```

`on_saved` 由上层(`server/manager.py`)注入,用来在界面上渲染"我会记住这件事——…[撤销]"这样的行内提示;`memory_update` 特意把**旧文本**(`previous`)一并传给回调,这样用户点"撤销"时才能把内容还原回去——docstring 里提到这是修过的一个 bug(2026-07-28 的一次 owner-hit):记忆更新原本是不带这条通知的,而"先检查是否已有覆盖、用 update 而不是新建"这条规则意味着很多保存实际上是以 update 的形式发生的,过去这类保存对用户是不可见的。

最后,四个写工具都共享同一道活开关检查:

```python
def _saving_off() -> bool:
    return saving_enabled is not None and not saving_enabled()
```

`saving_enabled` 是一个**存活**的回调(不是构建引擎时读一次的快照),docstring 专门强调这一点是为了修另一个双向 bug(同样是 2026-07-28 那次):关掉开关之后正在跑的会话本该停止保存却继续保存,重新打开开关之后正在跑的会话本该恢复保存却继续拒绝——工具的注册本身是固定的(写工具永远挂在列表里),真正决定"这次调用生不生效"的判断被推迟到每一次实际调用发生的那一刻。`memory_read` 则完全不受这个开关影响——docstring 的原话是"off = stop learning, not amnesia"(关闭是停止学习新东西,不是失忆),已经存在的记忆在开关关闭期间依然可以被模型读取和引用,只是不能再新增或修改。

## 常见问题/易踩坑

- **不要以为记忆会"自动"生长**:没有任何机制会在对话结束后自动跑一次侧路模型调用去提炼记忆(这一点和某些同类项目的"记忆自动提炼服务"不同),一切记忆都来自模型主动调用 `remember`/`memory_update`,或者用户在 GUI 记忆页面手动操作。
- **`SESSION` 作用域已经是历史包袱**:数据模型和查询接口还留着这个选项,但 `remember` 工具会把它静默降级成 `WORKSPACE`,不要被"看起来还有三个作用域"误导。
- **`user_rules` 和 `remember` 写的记忆完全是两套通道**:前者只有 Settings UI 能改,任何工具调用都摸不到它;判断"这条冲突信息该信哪个"时,规则永远赢。
- **全量/索引模式在一次会话生命周期内不会切换**:如果调试时发现记忆数量刚好在阈值附近,不要以为同一个会话里前后两次渲染结果会不一致——判定只在引擎构建时算一次。

## 小结

OpenWorker 的记忆系统把"存储抽象""是否要记""记什么样"这三件事切得很清楚:`MemoryStore` 提供一套与后端无关的接口,当前用 SQLite 落地,选它主要是因为需要按作用域组合查询、又要在多线程 server 里安全共享;`Scope` 三值里 `SESSION` 已经名存实亡;记忆的取舍完全交给模型通过 `remember`/`memory_update`/`memory_forget` 显式操作,或者用户在 GUI 里手动编辑,没有任何自动提炼的旁路;渲染时会在全量与索引两种模式之间按渲染后字符数自动切换,兼顾小上下文模型的可用性;而用户在 Settings 里写下的规则被物理隔离在另一套存储里,任何工具都无法触碰,并且在语义上被声明为对学来的记忆拥有最终否决权。下一篇转向另一条完全不同的持久化线索——`coworker/automation/` 里的"常驻自动化":一个定时任务从被创建、到 `croniter` 算出下一次触发时间、再到调度器真正把它跑起来,完整生命周期是什么样的。
