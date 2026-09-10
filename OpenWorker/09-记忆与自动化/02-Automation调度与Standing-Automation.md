# Automation 调度与 Standing Automation:一个定时任务的完整生命周期

> README"What it can do"一节把这个能力概括成一句话:"Run on a schedule - automations for recurring work: a morning brief, a weekly report, a standing watch over a channel. Runs land in the app with full transcripts."——每次提到"standing automation",指的都不是一次性脚本,而是一个持久化的实体:它有自己的 id、自己的会话线程、自己的工作目录,每次触发都是这个实体名下的一次全新的 Run。`coworker/automation/` 四个文件——`models.py`/`scheduler.py`/`store.py`/`tools.py`——各自负责这个生命周期里的一段:数据结构、后台轮询、`croniter` 驱动的时间计算、模型创建任务的入口。这一篇按"创建 → 计算下一次触发 → 调度器发现到期 → 真正跑起来 → 落地成可继续对话的记录"这条时间线,把四个文件串起来读。

## 学习目标

- 看懂 `ScheduledTask`/`TaskRun` 两个数据类怎么把"任务定义"和"每一次执行"分开建模。
- 理解模型怎么通过 `create_scheduled_task` 工具把用户的自然语言时间描述("每天晚上 7 点 10 分")自己转换成 5 段式 cron 表达式,以及这个转换为什么不是系统代码做的。
- 理解 `croniter` 在 `compute_next_run` 里具体做了什么,以及本地时区("local")和具名 IANA 时区在 DST(夏令时)边界上的处理差异。
- 理解 `Scheduler._loop` 的轮询策略——"run-once-catch-up"(补跑错过的)和"skip-on-overlap"(不重叠执行)——以及为什么"先推进 `next_run` 再执行"能保证语义正确。
- 完整看一遍 `_run_scheduled_task` 怎么把一次触发变成一个独立的、可持续对话的会话,呼应 README 里"Runs land in the app with full transcripts"这句话。
- 理解"标准审批授权"(`always_allowed_tools`)这套机制怎么让一个自动化任务在被批准过一次之后,后续运行不必每次都为同一个目标重新问一遍。

## 背景与设计动机

`models.py` 开头的模块 docstring 只有一句话,但信息密度很高:

```python
"""Automation data model — a scheduled task is its own persistent entity (see
docs/AUTOMATION-SCHEDULING.md). Each fire is a fresh Run of the task's instructions, recorded
in the task's own thread + working folder.
"""
```

"a scheduled task is its own persistent entity"——这决定了整套数据模型的形状:`ScheduledTask` 不是挂在某次对话下面的一个附属品,而是一个独立的、有自己生命周期的对象;它触发的每一次执行(`TaskRun`)又是这个任务名下一条独立的历史记录,而不是覆盖上一次的执行结果。这种"任务实体 + 执行历史"的两层建模,决定了后面能自然地支持"看这个自动化过去 30 次跑得怎么样""某一次跑失败了,点进去看那次的完整对话"这些产品能力。

## 核心机制详解

### 数据模型:`Schedule` / `ScheduledTask` / `TaskRun`

一个任务的时间触发规则由 `Schedule` 描述,它只有两种 `kind`:`"cron"` 和 `"once"`:

```python
@dataclass
class Schedule:
    kind: str  # "cron" | "once"
    cron: Optional[str] = None
    fire_at: Optional[str] = None  # ISO datetime for one-time
    timezone: str = (
        "local"  # 'local' = the machine's clock (a local-first tool default)
    )
```

`timezone` 默认值是字符串 `"local"` 而不是某个具体的 IANA 名字——这是"本地优先"工具的一个自然选择:大多数用户想要的是"这台机器的当地时间几点几分",而不是先弄清楚自己在哪个时区。`Schedule.human()` 会把 cron 表达式尽量翻译成人话("Every day at ~7:10 PM"、"Every Monday at ~9:00 AM"),翻译不了的非平凡 cron(带范围或步长的)就原样显示。

`ScheduledTask` 是任务本体,字段列表本身就是这个实体所有维度的清单:

```python
@dataclass
class ScheduledTask:
    title: str
    instructions: str
    schedule: Schedule
    workspace: str
    origin_surface: str = "cowork"  # where it was launched from (a reference)
    origin_session_id: str = ""
    agent: str = "cowork"
    id: str = field(default_factory=lambda: "task-" + uuid.uuid4().hex[:10])
    task_session_id: str = ""  # the task's OWN thread (set to f"__task__{id}")
    model: Optional[str] = None
    notify_on_completion: bool = True
    notify_target: Optional[str] = None  # extra messaging target ("telegram:123")
    always_allowed_tools: list[str] = field(default_factory=list)
    always_allowed_commands: list[str] = field(default_factory=list)
    enabled: bool = True
    ...
    next_run: Optional[float] = None  # epoch seconds; computed by the store
    last_run: Optional[float] = None
    last_status: Optional[str] = None
    run_count: int = 0
    max_runs: Optional[int] = None
    seen_runs_at: float = 0.0
```

几个字段值得单独说明:

- **`instructions`**:模型每次执行时拿到的原始指令文本,和"什么时候执行"完全解耦——时间信息只活在 `schedule` 里。后面会看到 `create_scheduled_task` 的工具描述专门强调这一点。
- **`workspace`**:任务绑定的工作目录。它和 `origin_session_id`(发起这个自动化的那次对话)一起,决定了"这个自动化产出的文件放在哪、原始对话能不能看到这些产出"。
- **`task_session_id`**:任务自己拥有的一条会话线程,固定格式是 `f"__task__{id}"`(在 `__post_init__` 里兜底生成)——这条线程和下面 `TaskRun.session_id` 的 `__run__{run_id}` 格式是两个不同层级的东西:前者是任务本身的"元"会话,后者是每一次具体执行的会话。
- **`always_allowed_tools`**:标准范围授权列表,下一节详细展开。

`TaskRun` 则是每一次触发的执行记录:

```python
@dataclass
class TaskRun:
    task_id: str
    run_id: str = field(default_factory=lambda: "run-" + uuid.uuid4().hex[:10])
    started_at: float = field(default_factory=_now)
    finished_at: Optional[float] = None
    status: str = "running"  # running | ok | error | skipped
    result_text: Optional[str] = None
    artifacts: list[str] = field(default_factory=list)
    error: Optional[str] = None
    trigger: str = "schedule"  # schedule | manual | catchup
    session_id: str = ""  # the run's own conversation thread — persisted + continuable

    def __post_init__(self) -> None:
        if not self.session_id:
            self.session_id = f"__run__{self.run_id}"
```

`trigger` 字段记录这次执行是怎么被触发的——`schedule`(正常到点)、`manual`(用户点了"立即运行")、还是 `catchup`(服务器重启后补跑错过的那一次)。`session_id` 的自动生成规则(`__run__{run_id}`)是本篇后半段"每次运行都是一个可继续对话的完整会话"这条主线的入口。

### 模型怎么创建一个自动化:自己把自然语言换算成 cron

`tools.py` 的模块 docstring 一句话点出了这个工具的核心设计:

```python
"""Agent-facing scheduling tools (Cowork + MyHelper).

`create_scheduled_task` is gated (`requires_approval`) so it surfaces a confirm card before a
standing automation is created (approve-at-creation). The agent converts natural language
("7:10pm everyday") into a cron string itself. Tools are origin-bound: a created task records
the launching session and runs in its workspace, so the origin conversation can read the
results (the artifacts are real files in that folder).
"""
```

"The agent converts natural language into a cron string itself"——这不是系统代码里藏着一个 NLP 时间解析器,而是直接把这件事交给模型自己做。`create_scheduled_task` 的工具 schema 描述把这个期望写得很明确:

```python
"description": (
    "Create a scheduled automation that re-runs `instructions` on a schedule. Convert "
    "the user's natural-language timing into a cron expression yourself (e.g. "
    "'every day at 7:10pm' → '10 19 * * *'), or pass a one-time `fire_at` ISO datetime. "
    "The user confirms before it is created."
),
```

`instructions` 字段的描述则专门提醒模型不要把时间信息重复写进指令文本里:

```python
"instructions": {
    "description": (
        "What to do on each run, written as a direct command to execute "
        "immediately (e.g. 'Prepare a market analysis report covering …'). Do "
        "NOT restate the schedule or timing here — timing belongs in cron/"
        "fire_at; this text is handed verbatim to the agent every run."
    ),
},
```

这条约束背后是一个真实的坑:如果 `instructions` 里写着"每天晚上 7 点 10 分生成一份简报",而这段文本会被原样喂给每一次触发的执行——那个被触发的 agent 看到"每天……"这种措辞,很容易误以为自己的任务是"去创建一个定时安排",而不是"现在立刻执行一次"。后面讲调度器执行细节时会看到,系统专门在开场白里做了一次显式澄清来堵住这个陷阱。

工具函数本身对输入做的校验很轻量——只检查 cron 语法合法性和"至少给了 cron 或 fire_at 其中一个":

```python
def create_scheduled_task(
    title, instructions, cron=None, fire_at=None, timezone="local", permissions=None
):
    from croniter import croniter

    if not cron and not fire_at:
        return {
            "error": "provide a cron (recurring) or a fire_at ISO datetime (one-time)"
        }
    if cron and not croniter.is_valid(cron):
        return {"error": f"invalid cron expression: {cron}"}
    schedule = Schedule(
        kind="once" if (fire_at and not cron) else "cron",
        cron=cron,
        fire_at=fire_at,
        timezone=timezone or "local",
    )
    workspace = origin.get("workspace") or default_workspace
    grants = grant_entries(permissions)
    task = ScheduledTask(
        title=title,
        instructions=instructions,
        schedule=schedule,
        workspace=workspace,
        origin_surface=origin.get("surface", "cowork"),
        origin_session_id=origin.get("session_id", ""),
        agent=origin.get("agent", "cowork"),
        always_allowed_tools=grants,
    )
    store.save(task)
    ...
```

`workspace` 默认取发起会话的工作目录(`origin.get("workspace")`)——这就是 docstring 里"tools are origin-bound"的具体体现:自动化产出的文件天然落在发起它的那次对话所在的文件夹里,原始对话可以直接看到这些产物,不需要额外的传递机制。而这个工具在 `_gated` 包装里被标记为 `requires_approval=True`(`risk_level="medium"`):创建一个"以后会反复自主运行"的任务,天然应该在真正落地前给用户一张确认卡片——这是"批准发生在创建时"(approve-at-creation)的具体实现,和运行时权限门槛是两回事。

`permissions` 参数则是标准范围授权提议的入口,下面单独展开。

### 标准范围授权:被批准过的自动化不必每次都问

`models.py` 里专门有一段注释解释这套机制存在的原因:

```python
# -- standing scoped approvals (UX-DECISIONS §25) --------------------------------
# An `always_allowed_tools` entry is either a bare tool name (legacy, allows the tool
# against any argument) or "tool target" — one space, tool names never contain spaces —
# binding the allowance to one exact target (channel address, recipient, …). Rules live
# on the task record so revocation is per-automation and deletion takes them along.
```

一条授权规则的格式是 `"tool target"`(工具名和目标之间一个空格,因为工具名本身不含空格),或者只有工具名的旧式写法(不绑定具体目标)。`grant_entries` 函数负责把创建时模型提议的 `permissions` 列表过滤成真正能落地的授权:

```python
def grant_entries(permissions: Any) -> list[str]:
    """... Only `access: "write"` items become grants; the tool must declare a target
    argument (which excludes exec/destructive tools by construction) and the target
    must be non-empty. Reads are disclosure-only — rendered on the consent card,
    never stored. Anything else is dropped, fail-closed."""
    ...
    for item in permissions or []:
        if str(item.get("access", "")).lower() != "write":
            continue
        tool = str(item.get("tool", "")).strip()
        target = str(item.get("target", "")).strip()
        if not tool or not target or target_arg_for(tool) is None:
            continue
        entry = rule_entry(tool, target)
        ...
```

只有 `access: "write"` 的条目才可能变成一条标准授权,而且工具必须声明一个"目标参数"(`target_arg_for(tool)` 非空)——这个约束天然排除了执行命令、删除文件这类没有单一目标的高风险工具,只有像"发消息给某个频道/收件人"这种能精确绑定目标的写操作才可能被预先放行。`access: "read"` 的条目只用于在创建时的确认卡片上展示"这个自动化会读取什么",从不落库存储成授权。

这套机制在实际运行时怎么生效?`server/manager.py` 里的 `_seed_task_permissions` 把任务记录上的授权应用到引擎的权限系统:

```python
def _seed_task_permissions(self, engine: TurnEngine, task) -> None:
    """Apply a task's standing allowances to an engine: target-bound rules feed the
    permission engine's matcher (connector tools included — the target binding is the
    safety); name-only legacy entries keep their session-allowlist behavior."""
    engine.permissions.task_rules = task.standing_rules()
    for tool in task.name_allowed_tools():
        engine.permissions.allow_tool_for_session(tool)
```

每次为这个任务构建引擎(不管是定时触发,还是用户在 GUI 里手动点"立即运行"重建),这批标准授权都会被重新种进去——授权规则活在任务记录上,而不是活在某一次运行的临时状态里,这也是为什么"撤销一条授权"或者"删除整个任务"能干净利落地把授权一并带走。

### `croniter` 与下一次触发时间:本地时区和 DST

`store.py` 里的 `compute_next_run` 是"下一次什么时候触发"这个问题的唯一权威答案来源,一次性任务和周期性任务走两条分支:

```python
def compute_next_run(
    task: ScheduledTask, *, after: Optional[float] = None
) -> Optional[float]:
    sched = task.schedule
    now = after if after is not None else _epoch_now()
    if sched.kind == "once":
        if not sched.fire_at:
            return None
        dt = datetime.fromisoformat(sched.fire_at)
        tz = _tz(sched.timezone)
        if dt.tzinfo is None and tz is not None:
            dt = dt.replace(tzinfo=tz)
        ts = dt.timestamp()
        return ts if (task.run_count == 0 and ts > now) else None
    # cron
    from croniter import croniter

    if not sched.cron or not croniter.is_valid(sched.cron):
        return None
    if task.max_runs is not None and task.run_count >= task.max_runs:
        return None
    tz = _tz(sched.timezone)
    base = datetime.fromtimestamp(now) if tz is None else datetime.fromtimestamp(now, tz=tz)
    return croniter(sched.cron, base).get_next(datetime).timestamp()
```

一次性任务(`kind == "once"`)的判定条件是 `task.run_count == 0 and ts > now`——已经跑过一次(`run_count >= 1`)或者触发时间已经过去,就返回 `None`,这个任务自然"到期作废",不需要额外的清理逻辑。周期性任务(`kind == "cron"`)则直接把 cron 表达式和一个"基准时间"交给 `croniter`,由它算出下一个匹配时间点。`max_runs` 达到上限时同样直接返回 `None`。

`_tz` 函数的实现和注释解释了本地时区(`"local"`)和具名 IANA 时区在处理夏令时(DST)时的本质区别:

```python
def _tz(name: str):
    """Resolve a schedule timezone to a DST-aware tzinfo, or None for the machine's local
    zone. None (not a fixed-offset tzinfo) is deliberate: naive datetimes let .timestamp()/
    the C library apply local DST at the fire date. A frozen `datetime.now().astimezone()`
    offset baked in whatever offset was in effect at compute time and misfired across a DST
    boundary. An unknown IANA name falls back to local (None) rather than raising."""
    if not name or name.lower() == "local":
        return None
    try:
        return ZoneInfo(name)
    except Exception:
        return None
```

这里的关键教训是:如果为了图省事,在计算时就把"当前时区偏移量"冻结成一个固定值(比如调用一次 `datetime.now().astimezone()` 拿到偏移量再复用),那么一旦触发时间跨越了夏令时切换的边界,这个偏移量就是错的,任务会在错误的钟点被触发。正确做法是保留一个"naive"(不带时区信息)的 `datetime`,让 `.timestamp()` 在真正需要转换的那一刻,由 C 库按"触发发生的那个具体日期"去查表决定该用哪个偏移——这正是 `_tz` 对 `"local"` 返回 `None` 而不是某个固定偏移量对象的原因。对于一个具名的 IANA 时区(比如 `"America/New_York"`),`ZoneInfo` 本身就是 DST-aware 的,直接用就行;解析失败(比如时区名字打错了)则退回本地时区而不是抛异常——保证一个拼写错误不会让整个任务失效。

### 调度器主循环:补跑、防重叠、先推进后执行

`scheduler.py` 的模块 docstring 一句话概括了两条并存的策略:

```python
"""... Policy (agreed): **run-once-catch-up** for runs missed while down (due tasks fire
once on startup, then resume), and **skip-on-overlap** (don't stack a run if the previous
is still going). The actual execution is injected as `runner(task, trigger) -> TaskRun`
so this stays independent of the engine/manager.
"""
```

`Scheduler._loop` 的实现体现了这两条策略:

```python
async def _loop(self) -> None:
    try:
        await self._tick(trigger="catchup")
    except Exception:
        logger.exception("scheduler catch-up failed")
    while True:
        await asyncio.sleep(self.tick_seconds)
        try:
            await self._tick(trigger="schedule")
        except Exception:
            logger.exception("scheduler tick failed")
```

启动时先跑一轮 `trigger="catchup"`——服务器如果之前关闭了一段时间,这一轮会把关机期间已经到期但没跑的任务立刻补跑一次(而不是丢弃,也不是按错过的次数连续补跑很多次——一次性把它们标记为到期,补跑一次即可,后续的 `next_run` 由 `compute_next_run` 正常往前推)。之后按 `tick_seconds`(默认 30 秒)周期性检查。

`_tick` 里对每个到期任务的处理方式值得细读:

```python
async def _tick(self, *, trigger: str) -> None:
    for task in self.store.due():
        if not self._claim(task.id):
            continue
        spawned = asyncio.create_task(self._run_claimed(task, trigger=trigger))
        self._spawned.add(spawned)
        spawned.add_done_callback(self._spawned.discard)
    ...

def _claim(self, task_id: str) -> bool:
    if task_id in self._running_ids:  # skip-on-overlap
        logger.info("skipping %s — previous run still going", task_id)
        return False
    self._running_ids.add(task_id)
    return True
```

**"spawn 而不是 await"**是这里的关键设计:一个自动化的执行过程中可能会命中一个需要人工审批的操作而挂起(下一篇会讲这条挂起路径怎么走进 Inbox),一个被卡住的自动化绝不能拖住整条调度器循环、拖住其他到期任务的执行、也拖住 self-wake 的恢复轮询(`extra_tick`,同样在下一篇展开)。而防重叠的"claim"必须在 `spawn` **之前**完成——注释解释了原因:`due()` 拿到的这批任务快照会随时间变旧,如果一个正在执行的任务提前跑完、而这批快照里恰好还有它的重复项等着被 spawn,那么如果 claim 检查发生在 spawn 内部,此时旧的运行早已经把守卫清掉了,新的重复 spawn 就会真的把这个任务跑两遍。

而"先推进 `next_run` 再执行"这条顺序在 `TaskStore.save` 里体现:

```python
def save(self, task: ScheduledTask) -> ScheduledTask:
    task.updated_at = _epoch_now()
    task.next_run = compute_next_run(task) if task.enabled else None
    ...
```

`_run_claimed` 跑完一次执行之后会重新 `fetch` 任务、更新 `run_count`/`last_run`/`last_status`,再调用 `store.save(fresh)`——这次 `save` 触发的 `compute_next_run` 是基于**已经递增过的 `run_count`**去算下一次时间,保证即使某次执行本身耗时很长,也不会因为执行慢而让下一次触发的计算基准出错(参考同类项目里 cron 调度"先推进时间戳、再执行"的通用原则)。

### 一次触发怎么变成一个可继续对话的会话

`server/manager.py` 里的 `_run_scheduled_task` 是把"到期"这个信号转换成一次真实执行的地方,这里能直接呼应 README 那句"Runs land in the app with full transcripts":

```python
async def _run_scheduled_task(self, task, trigger: str) -> TaskRun:
    run = TaskRun(task_id=task.id, trigger=trigger)  # __post_init__ sets run.session_id
    self.task_store.add_run(run)  # mark "running"
    ...
    engine = self._build_task_engine(task, session_id=run.session_id)
    self._engines[run.session_id] = engine
    opening = (
        f"⏰ Scheduled run — {task.title}\n\n"
        "This automation is due now: carry out the task below immediately and produce the "
        "result. The schedule already exists — do not create or modify any scheduled tasks.\n\n"
        f"{task.instructions}"
    )
    try:
        async for _event in engine.run(opening):
            pass
        run.result_text = _last_assistant_text(engine.messages)
        run.artifacts = _recent_files(task.workspace, since=run.started_at)
        run.status = "ok"
        if task.notify_on_completion:
            await self._notify_task_done(task, run)
    except Exception as exc:
        run.status, run.error = "error", str(exc)
    finally:
        run.finished_at = _epoch()
        self.save(run.session_id, engine)
        self._engines[run.session_id] = engine
        self.task_store.add_run(run)
    return run
```

几个关键动作串起了完整闭环:

1. **每次触发都是一次真实、独立的会话**——`run.session_id`(`__run__{run_id}`)不是一个虚拟标识,而是一个真正被构建、真正跑完整个工具调用循环、最后被 `self.save(...)` 落盘的引擎会话。这正是注释里那句话的含义:"Each run is a real, persisted conversation thread: it runs the instructions under its own session id, then saves the transcript. The user can reopen that session and ask a follow-up — the scheduled agent is no longer fire-and-forget."——用户可以重新打开这次运行对应的会话,针对这次的结果继续追问,而不是只拿到一段孤立的输出文本。
2. **开场白显式区分"已到期"和"要不要再排一次"**——注释解释了为什么要这么写:`instructions` 里经常会复述一遍时间描述("每天……"),如果不做这层澄清,执行时的 agent 很容易把任务理解成"我需要去创建/修改一个定时安排",而不是"立刻把这件事做一遍"。开场白直接告诉它"排期已经存在,不要创建或修改任何定时任务"。
3. **`_build_task_engine` 里刻意不给执行中的引擎挂调度工具**(`task_store=None`):

```python
# No scheduling tools inside a scheduled run: the executing agent's job is to DO the
# task, and instructions that mention timing ("every day at 5:32pm…") otherwise tempt
# it to create another automation instead of running this one.
task_store=None,
```

这是对同一个风险(指令文本里的时间措辞诱导模型去创建新任务)的第二道防线——开场白是"软"提醒,而这里是"硬"隔断:即使模型没理会开场白的措辞,它此刻的工具列表里根本就没有 `create_scheduled_task` 这个选项。

4. **产出物是真实文件,而不是只存在于对话文本里**——`_recent_files` 扫描任务工作目录里"这次运行期间被修改过的文件"作为 `run.artifacts`;`result_text` 取的是这次会话里最后一条助手消息。两者共同构成一次运行的"交付物"记录。

5. **完成通知**——`notify_on_completion` 默认打开,`_notify_task_done` 先向任何正在看这个会话的前端广播一条 `task_done` 事件,如果任务还配置了 `notify_target`(比如一个 Telegram chat id),还会额外通过对应平台的发送器把结果摘要推送出去。

## 常见问题/易踩坑

- **`instructions` 字段不应该复述时间信息**:工具 schema 明确要求把时间只放在 `cron`/`fire_at` 里,`instructions` 是"每次执行时原样喂给 agent 的指令文本"——写成"每天 7 点做 X"很容易让执行阶段的 agent 误判自己的任务是排期而不是执行,系统靠"开场白澄清 + 不挂调度工具"两道防线兜底,但源头上把指令写清楚仍然更可靠。
- **`always_allowed_tools` 只对声明了目标参数的写操作生效**:执行命令、删除类的高风险工具天然被排除在标准授权范围之外,创建时的 `permissions` 列表里这类条目会被 `grant_entries` 静默丢弃。
- **一次性任务的"到期作废"逻辑依赖 `run_count == 0`**:如果一个一次性任务因为某种原因 `run_count` 被提前推进过,`compute_next_run` 会认为它已经跑过,不会再触发——这不是 bug,是设计上"一次性任务只认第一次触发"的直接后果。
- **本地时区(`"local"`)不是一个固定偏移量**:代码特意用 naive datetime 而不是提前算好的偏移量对象,为的是让 DST 边界能被正确处理;如果自己扩展这块逻辑时手滑冻结了一个偏移量,大概率会在夏令时切换那几天踩坑。

## 小结

一个 standing automation 的完整生命周期是:模型把用户的自然语言时间描述自己转换成 5 段式 cron(或者一个一次性 `fire_at`),经用户确认后落成一条独立的 `ScheduledTask` 记录;`TaskStore.save` 借助 `croniter` 算出 `next_run`,妥善处理本地时区和 DST 边界;`Scheduler` 每 30 秒轮询一次到期任务,用"先 claim 再 spawn"避免重复执行,用"先推进时间戳再执行"保证"最多执行一次"的语义;真正触发时,`_run_scheduled_task` 把这次执行包装成一个独立的、可持久化、可继续对话的会话,产出真实文件、推送完成通知,并且刻意不给执行中的 agent 挂调度工具以防止它误把"执行"当成"再排一次期"。下一篇会把镜头切到这套机制运行时真正会撞见的边界情况——当一次自动化执行需要人工批准时会发生什么、`selfwake.py` 这个名字到底是不是"唤醒新会话"的意思、以及"无人值守"这个执行模式和第 04 章讲过的审批链是怎么接上的。
