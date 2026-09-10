# Teams、Board 与 Journal:多智能体协作的底层账本

> `coworker/teams/` 目录没有一个叫"协调器"或"编排引擎"的核心类,取而代之的是一份非常朴素的设计:所有的团队协作事实——谁创建了一个任务、谁把它移到了"进行中"、谁在上面留了言、谁把它指派给了谁——被写成一条条不可篡改的事件,追加进一个按"空间(space)"分区的哈希链日志里。看板(Board)不是一张数据库表,而是这条日志的一份投影(projection);Journal(案卷)是另一条独立的、按调查案例(case)分区的日志,专门装看板之外还需要长期留存的证据与决策。`teams/model.py` 定义了这套系统的状态机和角色权限,`teams/store.py` 是事件日志与看板投影的实现,`teams/journal.py` 是案卷系统,`teams/dialect.py` 回答"这个 board 到底存在哪儿",`teams/tokens.py`、`teams/attachments.py` 是配套的身份与附件基础设施,`teams/tools.py`/`teams/mcp_server.py`/`teams/cli.py` 是三张把同一套账本暴露出去的"脸"。本篇把这套账本从数据模型讲到落地机制。

## 学习目标

- 理解 Team/Board 的核心设计信条:"board 不是数据库,是事件日志的投影"——`TeamStore` 如何用同一次 SQLite 事务同时追加事件、折叠投影、维护哈希链,以及 `verify_chain()`/`rebuild()` 这对"防篡改证明 + 灾难恢复"组合拳。
- 弄清工作项(item)状态机 `ItemState` 的合法迁移边(`EDGES`)、worker 能做什么(`WORKER_TARGETS`)、以及"谁能把 item 标记为 done"这条硬性权限约束背后的设计意图——builder 永远不能给自己的工作打分。
- 理解 Journal 案卷系统与 Board 日志"共享记录形状、分离生命周期"的设计:为什么案卷要独立于看板存在,以及"访问权随指派流转"(access rides assignment)这一条访问控制规则的具体实现。
- 弄清 `dialect.py` 的真实作用——它是"board 存放在哪里"的抽象层(本地 SQLite 直连 vs. 远程 HTTP),不是团队成员之间的通信协议或语言约定;以及 `tokens.py` 里的"token"是绑定身份角色的认证凭证,不是配额/速率限制。
- 理解 `ocw board`/`ocw journal` 这组 CLI 命令族、`teams/tools.py` 里注册进模型会话的 in-process 工具、以及第三篇要讲的 MCP server,三者如何共用同一套 verb(动词)接口。

## 背景与设计动机

多智能体协作系统天然会遇到一个记录问题:多个 agent(以及人类用户)并发地对同一份工作状态做出判断和修改,这些修改必须是可追溯的、可审计的、并且不能被静默篡改。`teams/store.py` 顶部的设计说明把这一诉求归纳成一句话:board 事件和聊天消息是"one attributed, timestamped, immutable record shape in one space-scoped log"——一种归属明确、带时间戳、不可变的记录形状,存在一条按空间分区的日志里,"一条写入路径便于审计,一个注入面便于防御,多个只读视图供不同用途使用"。

这个设计选择直接排除了"看板是一张可变数据库表"的朴素实现:如果 `team_items` 表可以被任意 UPDATE,那么"谁在什么时候把某个 item 从 review 打回 in_progress"这类历史事实就会随着最新一次更新而丢失。`store.py` 的做法是:`team_events` 表只增不减,`team_items`/`team_links` 等投影表是这条日志"叠加"出来的当前状态视图,任何一次状态变更都先写事件、再在同一个事务里更新投影——`rebuild()` 可以随时清空投影,重放整条日志,得到完全相同的结果,这就是"投影可以随时从日志重新推导"这句设计承诺的字面实现。

Journal(案卷)被从 Board 中拆分出来,是另一层同样重要的设计判断。`journal.py` 顶部注释直接给出了理由:一块看板是团队作用域的产物,团队解散、看板归档,看板本身的生命周期可以结束;但一次调查(比如一次安全评估)可能横跨两块看板,也可能在没有看板的情况下独立存在(比如 Ops 场景下人工记录的案例)。如果案卷和看板共用一张日志表,就无法让案卷的生命周期独立于看板存在。于是案卷有自己的 SQLite 表、自己的哈希链、自己的访问授权表(`journal_grants`)——它和 Board 共享"归属+时间戳+可追加+可标记 taint"这套记录纪律,但物理上是两个独立的存储。

第三个设计压力来自"这套机制要不要只服务于 OpenWorker 自己的内置 agent"。`dialect.py` 的存在正是为了回答"否"——`teams/mcp_server.py`、`teams/cli.py` 的存在则是这个"否"字的具体落地(留给第三篇细讲),本篇先把这套底层账本的数据模型和读写规则讲透。

## 核心机制详解

### 状态机与角色权限:`model.py`

`ItemState` 定义了一个工作项的六种状态,`EDGES` 是这张状态机唯一合法的迁移表:

```python
# coworker/teams/model.py:16-42(节选)
class ItemState(str, Enum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"
    REVIEW = "review"
    DONE = "done"
    CANCELED = "canceled"

EDGES: dict[ItemState, set[ItemState]] = {
    ItemState.OPEN: {ItemState.IN_PROGRESS, ItemState.CANCELED},
    ItemState.IN_PROGRESS: {ItemState.BLOCKED, ItemState.REVIEW, ItemState.CANCELED},
    ItemState.BLOCKED: {ItemState.IN_PROGRESS, ItemState.CANCELED},
    ItemState.REVIEW: {ItemState.DONE, ItemState.IN_PROGRESS, ItemState.CANCELED},
    ItemState.DONE: set(),
    ItemState.CANCELED: {ItemState.OPEN},
}

WORKER_TARGETS = {ItemState.IN_PROGRESS, ItemState.BLOCKED, ItemState.REVIEW}
```

值得注意的是这张状态机里**没有"草稿/待批准"状态**——`model.py` 的注释解释了这是一个明确的设计决定(2026-08-16):一份工作计划的提议活在对话里(通过下一篇会提到的 `propose_work_items` 审批流程),看板本身永远只装"已经被接受的工作"——item 一创建出来就是 `open`。真正的控制点不是"这个 item 该不该存在"的批准,而是**指派**:`ASSIGNMENT` 是一种可授予、可撤销的权限,只有被指派了工作的 worker 才谈得上"开始干活"。`WORKER_TARGETS` 把 worker 能主动把自己的 item 移向的目标限定为 `in_progress`/`blocked`/`review` 三种——`done` 不在其中,这不是遗漏,而是 `store.py` 里 `_check_transition_authority()` 显式拦截的硬性规则:

```python
# coworker/teams/store.py:1046-1065(节选)
if target == ItemState.DONE and actor.role == Role.WORKER:
    raise AuthorityError(
        "workers finish by moving to review — done is the verdict after"
        " verification"
    )
if actor.role == Role.WORKER:
    if item["assignee"] != actor.id:
        raise AuthorityError(f"worker {actor.id} is not assigned item #{item['id']}")
    if target not in WORKER_TARGETS:
        raise AuthorityError(...)
```

"builder 永远不能给自己的工作打分"——这条规则在 `swe-lead`/`devsecops-lead` 的系统提示词里被反复强调("verified by the test worker", "a fixer never grades its own fix"),但真正兜底的不是提示词层面的自觉,而是这里的代码级权限检查:即便一个 worker 被越权提示词诱导去尝试把自己的 item 标记为 `done`,`transition()` 也会在状态机校验之外再触发一次 `AuthorityError`。

`Actor` 这个 frozen dataclass 是所有权限判断的输入:

```python
# coworker/teams/model.py:52-61
@dataclass(frozen=True)
class Actor:
    id: str
    role: Role
    persona: str = ""
    model: str = ""
    session_id: str = ""
```

`role` 只有 `USER`/`LEAD`/`WORKER`/`SYSTEM` 四种取值,每一个对 `TeamStore` 的写调用都要传入一个 `Actor`,`_require()` 方法在每个 verb 入口做一次角色白名单校验(比如 `assign` 只允许 `{USER, LEAD}`),`_check_transition_authority()` 再在状态迁移这个特殊 verb 上做一次更细的二次校验。两层校验都在数据层,而不是在提示词层——这是整个 teams 系统权限模型的核心特征:提示词负责告诉 agent "你应该怎么做",store 负责保证"你不能做超出你角色的事"。

### 事件日志与投影:`TeamStore` 如何让 board "可重放"

`append_event()` 是所有写操作的唯一入口,`_append_locked()` 展示了"一次写入,两件事同时发生"的核心机制:

```python
# coworker/teams/store.py:227-277(节选)
prev = self._head_hash(space)
record = {..., "prev_hash": prev}
record["hash"] = _hash(record)
cursor = self._conn.execute("INSERT INTO team_events (...) VALUES (...)", (...))
seq = cursor.lastrowid
self._apply(space, seq, record["ts"], kind, actor.id, item_id, payload)
self._conn.execute(
    "INSERT INTO team_meta (space, head_hash, watermark) VALUES (?, ?, ?)"
    " ON CONFLICT(space) DO UPDATE SET head_hash = ?, watermark = ?",
    (...),
)
self._conn.commit()
```

每条事件记录携带 `prev_hash`(上一条事件的哈希)和自己的 `hash`(由 `_HASHED_FIELDS` 里列出的字段计算而来),`team_meta` 表额外保存每个 space 当前的 `head_hash` 作为"锚点"。`_apply()` 把事件"叠加"进 `team_items`/`team_links` 等投影表,和事件本身的 INSERT 在同一次数据库连接、同一次 `commit()` 里完成——这保证了"事件已写入"和"投影已更新"永远同步,不存在事件写进去了但投影没跟上的中间态。

`verify_chain()` 是这条哈希链的完整性校验器:

```python
# coworker/teams/store.py:419-441(节选)
prev = GENESIS
for row in rows:
    record = {key: row[key] for key in _HASHED_FIELDS}
    if row["prev_hash"] != prev:
        raise ChainError(f"event {row['seq']}: chain linkage broken")
    if _hash(record) != row["hash"]:
        raise ChainError(f"event {row['seq']}: content does not match hash")
    prev = row["hash"]
if rows and prev != self._head_hash(space):
    raise ChainError("log ends before the recorded head — tail deleted")
```

最后一个检查特别值得注意:仅仅校验链条内部的哈希衔接,无法发现"日志尾部被整体截断"这种攻击——一条被砍掉后半段的日志,剩下的部分内部链接依然完全合法。`team_meta` 里独立保存的 `head_hash` 就是用来堵住这个漏洞的:如果重放到的最后一条记录的哈希对不上 `team_meta` 里记的锚点,说明日志尾巴被删过。文档注释把这种能力定性为"tamper-evidence, not tamper-proofing"——这套机制能让篡改被发现,而不是从物理上阻止篡改(SQLite 文件本身没有防篡改能力),这是一个诚实的边界声明,不是缺陷。

`rebuild()` 则是这套投影体系的"灾难恢复"路径:清空一个 space 的投影表,重新按顺序回放事件日志,重新调用 `_apply()`。注释明确说这不是热路径——正常写入靠 `append_event()` 增量维护投影,`rebuild()` 只在"投影实现有 bug 需要修复重跑"或者"缓存损坏"这类场景下使用。这与前面提到的"board 是日志的投影"这句设计信条完全对应:投影随时可以从日志重新推导出来,只是平时没必要每次都重新推导一遍。

### 指派与投递:feed 而不是 mailbox

`teams/store.py` 明确禁用了"邮箱(mailbox)"这个概念:

```python
# coworker/teams/store.py:322-330(节选)
# The per-agent durable feed is a PROJECTION over the one log, never a second
# write path — and INTEREST FOLLOWS THE ASSIGNMENT RELATION (owner ruling
# 2026-08-17): a worker is subscribed to events on its slice (items assigned
# to it or filed by it — subscription ≡ visibility, one boundary), ...
# "Mailbox" is banned as a concept.
```

`feed_for()` 是每个 agent 拉取"我该关心的未读事件"的实现,它没有独立的投递表,而是对同一条事件日志按"这个 actor 的兴趣范围(slice)"过滤:

```python
# coworker/teams/store.py:332-356(节选)
def feed_for(self, space: str, actor_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
    key = f"feed:{actor_id}:{space}"
    events = self.events(space, since_seq=self._cursor(key), limit=limit)
    slice_ids = self._worker_slice(space, actor_id)
    out = []
    for event in events:
        if event["actor"] == actor_id:
            continue
        payload = event.get("payload") or {}
        if event["kind"] == ITEM_ASSIGNED and actor_id in (payload.get("assignee"), payload.get("previous")):
            out.append(event); continue
        if event.get("item_id") in slice_ids:
            out.append(event)
    return out
```

"兴趣跟随指派关系"——一个 worker 的 slice 是它被指派的 item、它自己创建的 item,以及和这些 item 直接关联(parent/blocks)的 item(`_worker_slice()`)。一个事件只有落在这个范围内,或者是一条把它指派进来/移出去的 `ITEM_ASSIGNED` 事件,才会出现在它的 feed 里。"已消费"靠一个游标(`team_cursors` 表)标记,而不是删除记录——`consume_feed()` 只是推进游标,原始事件永远留在日志里,这意味着一次崩溃发生在"读到但没确认消费"之间,下次拉取会重新看到这批事件("durable-until-consumed")。

Lead 的订阅走一条独立但结构相同的路径——`subscribed_events()` 只关心"需要决策的事件类"(worker 把 item 移到 `review`/`blocked`,或者提交了一次自助认领),日常评论和 Journal 追加从不触发唤醒。这条设计与几篇 persona manifest 里反复出现的"Routine status is already on the board — never ask a worker how's it going"是同一个理念的两面:lead 不需要主动去问进度,因为进度变化本身会通过订阅事件主动推给它。

### 认领(claim)与并发:谁来仲裁竞态

`claim()` 是工作项从"开放认领池"进入某个 worker 名下的入口,注释直接点出了它要解决的并发问题:

```python
# coworker/teams/store.py:797-803(节选)
"""Self-assign an open, unassigned item. Nobody stamps a claim — the store
arbitrates: the open+unassigned check runs under the write lock, so when two
workers race for the same item, exactly one wins and the other gets a clean
error. A claim is a normal assignment event attributed to the claimer —
visible in the lead's subscription feed and revocable like any assignment."""
```

两个 worker 同时认领同一个 item 时,"谁先谁后"完全由 `self._lock`(一个可重入锁)包裹的临界区决定——`item["assignee"]` 的检查和 `append_event()` 写入 `ITEM_ASSIGNED` 事件在同一个锁范围内完成,第二个到达的调用会看到 `assignee` 已经非空,拿到一个干净的 `BoardError`,不会出现两个 worker 都"认领成功"的脏状态。`policy()`/`set_policy()` 控制这条认领通道的开关——`open`(默认,任何 worker 可以自助认领开放的未指派 item)或 `lead-only`(认领关闭,只能由 lead/user 显式 `assign`)。这个策略是"设置",不是"历史"——`team_settings` 表直接存当前值,不经过事件日志,`store.py` 的类比很直接:和游标(cursor)一样,这是基础设施状态,不是需要被日志叙述的领域事实。

### Journal:案卷的生命周期与"访问权随指派流转"

`journal.py` 的核心访问控制规则是 `_check_access()`——除了 `Role.USER` 永远放行外,其他角色必须在 `journal_grants` 表里有一条授权记录才能读写一个案卷:

```python
# coworker/teams/journal.py:381-390
def _check_access(self, actor: Actor, case: str) -> None:
    if actor.role == Role.USER:
        return
    row = self._conn.execute(
        "SELECT 1 FROM journal_grants WHERE case_id = ? AND principal = ? LIMIT 1",
        (case, actor.id),
    ).fetchone()
    if row is None:
        raise AuthorityError(f"{actor.id} has no grant on case '{case}'")
```

授权有三个来源(`source` 字段区分):`creator`(第一个往案卷里写东西的人自动获得授权)、`assignment`(看板上的一次指派,如果这个 item 挂着一个 `case_id`,会自动同步授权给新的被指派人)、`grant`(用户或 lead 的显式跨团队共享)。`sync_assignment()` 是"访问权随指派流转"这条规则的具体实现,由 `store.py` 的 `assign()`/`claim()` 在指派发生时回调:

```python
# coworker/teams/journal.py:329-353(节选)
def sync_assignment(self, case, *, space, item_id, assignee, previous=""):
    if previous:
        self._conn.execute(
            "DELETE FROM journal_grants WHERE case_id = ? AND principal = ?"
            " AND source = 'assignment' AND space = ? AND item_id = ?",
            (case, previous, space, item_id),
        )
    self._grant_locked(case, assignee, source="assignment", space=space, item_id=item_id)
```

被撤走指派的上一个 assignee 只会失去"这一个 item 带来的"授权——如果它还持有同一个案卷下其他 item 的授权,或者拥有显式 `grant`,访问权不受影响。这是一条精确到"来源"的撤销规则,而不是粗暴地"撤销这个人对整个案卷的访问"。

案卷与看板的哈希链设计几乎和 `TeamStore` 完全对称(`verify_chain()`、`GENESIS` 锚点、`prev_hash`/`hash` 字段),这印证了模块开头"共享记录形状、分离生命周期"的说法——两套存储复用同一个 `_hash()`/`_canonical()` 工具函数(`journal.py` 直接从 `store.py` import),只是各自的哈希链按 `case_id` 而不是 `space` 分区。

### 附件与身份:内容寻址存储、认证令牌

`attachments.py` 的 `AttachmentStore` 用内容寻址(sha256 文件名)解决三个问题:同一张截图重复上传只存一份、引用永远不会指向被修改过的字节、以后换成对象存储时引用格式不需要变。写入前 `_validate()` 会检查文件扩展名与文件头部"魔数(magic bytes)"是否吻合——一个伪装成 `.png` 但内容其实不是 PNG 的文件会被拒绝,而不是被改名接受。

`tokens.py` 里的 `BoardTokens` 容易被名字带偏联想成"配额/速率限制令牌",但读代码后可以确认它做的是完全不同的事:它是外部客户端接入 board 时的**身份认证凭证**。

```python
# coworker/teams/tokens.py:34-51(节选)
def mint(self, actor: str, role: str = "worker", *, label: str = "") -> str:
    """Create a token for one actor identity; returns the plaintext ONCE."""
    token = _TOKEN_PREFIX + secrets.token_urlsafe(32)
    entries[_digest(token)] = {"actor": actor, "role": role, "label": label, ...}
    self._save(entries)
    return token
```

模块开头的设计说明写得很直接:一个 token 在服务端绑定一个 actor 和一个 role——外部客户端(另一个 agent CLI、第二台机器上的 `ocw`)出示 token,服务端据此解析出"你是谁、什么角色",客户端本身从不自称身份,而是靠 token **证明**身份;一个 worker 角色的 token 不可能自称是 lead。存储上只保存 token 的 sha256 摘要,明文只在 `mint()` 时返回一次——注册表文件本身泄露也不会泄露可用凭证。拿到身份和角色之后,真正的权限判断仍然落在 `TeamStore`/`JournalStore` 的 `_require()`/`_check_access()` 上——token 只解决"你是谁",从不越权替代"你能做什么"的裁决。

### `dialect.py`:board 存放在哪里,而不是"团队怎么说话"

`dialect.py` 这个文件名容易让人联想到"团队成员之间通信用什么协议/方言",但模块开头的说明纠正了这个联想:dialect 回答的是"一块看板的权威副本(board of record)存放在哪里,从一个客户端的视角看"这个问题,而不是智能体之间怎么交流。

```python
# coworker/teams/dialect.py:1-27(节选,docstring)
"""The BoardDialect seam — where "a board" stops meaning "our SQLite file".

A dialect is where the board of record LIVES, seen from a client's chair:
- LocalDialect: this machine's TeamStore/JournalStore, direct SQLite. ...
- RemoteDialect: one wire protocol (the `/v1/board` HTTP API) to a board served
  elsewhere — the running OpenWorker sidecar on this machine, a teammate's
  machine, or a hosted board service later. ...

External trackers (Jira/Linear) are deliberately NOT dialects: ... They join as
MIRRORS instead — one more subscriber with a cursor over the append-only event
log, replaying events outward.
"""
```

`BoardDialect` 是一个 `Protocol`,声明了 `whoami`/`list_items`/`create_item`/`transition`/`claim`/`journal_append` 等一整套 verb;`LocalDialect` 直接持有一个 `TeamStore`/`JournalStore` 实例和一个绑定好的 `Actor`,每个方法只是薄薄一层参数转发:

```python
# coworker/teams/dialect.py:176-187(节选)
def transition(self, space, item_id, to, *, comment="", refs=None):
    return self.store.transition(space, self.actor, item_id, to, comment=comment, refs=refs)
```

`RemoteDialect` 实现同一套 Protocol,但底层换成对 `/v1/board` HTTP API 的调用,身份靠构造时传入的 Bearer token(即 `BoardTokens.mint()` 签发的凭证)携带:

```python
# coworker/teams/dialect.py:304-319(节选)
"""The `/v1/board` HTTP client. `base_url` is an OpenWorker sidecar or a hosted
board service; the Bearer token carries identity — the server resolves it to an
actor+role, so this client never states who it is, it proves it."""
```

两个实现类共用同一份 Protocol 意味着调用方(下一篇要讲的 MCP server、CLI)完全不需要关心自己连的是本机 SQLite 还是远程 HTTP——这正是"dialect"这个名字的准确含义:同一套语义(board 的 verb 集合),不同的"方言变体"取决于 board 存放在哪里。模块注释里还专门解释了为什么 Jira/Linear 这类外部 tracker 不会成为第三种 dialect:把一个前 LLM 时代的 tracker 硬套成"权威副本"意味着要把 board 自己的状态机和投递游标削足适履地映射到对方的 API 上;更合理的定位是把外部 tracker 当作一个"镜像(mirror)"订阅者——像其他订阅者一样持有一个游标,把事件日志向外重放,board 自身继续是唯一的事实源。

模块末尾还有一条容易被忽略但很关键的并发安全说明:哈希链的"读头部再写入"是在进程内加锁完成的,这意味着**两个进程绝不能直接对同一个 SQLite 文件写入**——只要有一个 server 在跑,其他客户端就必须走 `RemoteDialect`;`LocalDialect` 只适用于"这个进程是唯一写入者"的无头(headless)场景。这条规则是 `ocw` CLI 下一篇要讲的"backing 解析优先级"的直接依据。

## 常见问题/易踩坑

- **把 `dialect.py` 理解成"消息协议"**:如前所述,它是"board 存在哪里"的客户端抽象,团队成员之间不存在独立的"聊天协议"层——事件日志本身就是所有协作事实(包括未来的 chat 消息类型)的唯一记录形状。
- **误以为 `tokens.py` 管的是用量配额**:它管的是身份与角色绑定,是认证(authentication)而不是限流或计费。
- **假设看板状态可以被直接改写**:`team_items` 表看似是一张普通表,但唯一合法的写入路径是通过 `append_event()` 触发的 `_apply()` 折叠——直接对这张表做 SQL UPDATE 会让哈希链和投影失去同步,`verify_chain()` 之后也无法证明历史没有被篡改。
- **两个进程直连同一个 board 数据库文件**:`dialect.py` 明确警告过这一点——只要有 server 在跑,其他写入者必须走 `RemoteDialect`,否则哈希链的"读头再写"假设会被破坏。

## 小结

Team/Board 的地基是一条按 space 分区、哈希链保护的追加事件日志,看板本身只是这条日志折叠出来的一份投影,可以随时通过 `rebuild()` 重新推导;`ItemState` 的状态机和 `_check_transition_authority()` 一起,把"worker 不能给自己的工作判定 done"这类协作纪律做成了代码级的硬约束,而不只是提示词层面的道德劝说。Journal 是另一条独立的、案卷(case)维度的日志,专门收纳跨看板、跨团队存活的调查证据,"访问权随指派流转"让协作团队的知识边界自动跟随任务分配移动。`dialect.py` 把"board 存放在哪里"抽成一层协议无关的客户端接口,为 board 从"一个进程里的 SQLite 文件"变成"可以被外部系统接入的服务"打下了地基——这也是下一篇要讲的 `ocw` CLI 和 `team-board` MCP server 能够存在的前提:它们都只是这套 verb 接口的两张不同的脸。下一篇会看 `tools/subagent.py` 里模型自己触发的 `explore` 子代理和这套 Team/Board 机制到底是不是同一条委派路径,再深入 `teams/mcp_server.py` 如何把这块看板整个暴露成一个外部 harness 可以直接接入的 stdio MCP server。
