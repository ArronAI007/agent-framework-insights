# 上下文压缩 Compaction

> `coworker/compaction.py` 的模块 docstring 把自己的定位讲得很清楚："this module is pure functions + one dataclass; the engine owns *when* (its run loop) and *with what* (its provider/model)"——压缩本身不知道什么时候该触发、也不知道用哪个模型去做摘要,这两件事都由 `TurnEngine` 决定,`compaction.py` 只负责在被调用时,把"该压缩哪一段、怎么压、压完变成什么样"这几个问题回答清楚。这一篇要拆开的是：触发阈值怎么算、边界怎么选、摘要怎么生成、失败了怎么办,以及压缩状态最终怎么落到 `SessionRecord.compaction` 字段里,在下次加载时原样恢复。

## 学习目标

- 理解压缩的触发信号——`_last_context_tokens`（provider 真实上报的 usage）或 `estimate_tokens()`（chars/4 的粗估兜底)——以及 `should_compact()` 的阈值算法：`min(threshold_pct × context_window, cap_tokens)`,为什么连百万上下文窗口的模型也会在 25 万 token 时被压缩。
- 通读 `pick_boundary()`,理解压缩边界为什么优先选在"用户消息"处、只有单轮工具循环本身就超预算时才退化到"助手消息（迭代)"边界,并且绝不能落在一条 `tool` 消息上。
- 理解压缩产物的两个来源——LLM 生成的结构化摘要（`summarize_span`）和代码直接从工具调用记录里抽取的"机械状态块"（`extract_working_state`/`extract_user_messages`）——为什么后者被设计成完全不依赖模型。
- 理解压缩失败之后的兜底路径：两次尝试 → 有人值守时询问 Retry/Trim → 否则直接退化成不调用模型的 `trim_state()`;以及"主动压缩"（每次迭代前的阈值检查)和"被动压缩"（provider 直接报出上下文超限之后的兜底重试)两条路径如何在 `TurnEngine._loop()` 里共存。
- 理解压缩只改变"发给模型看的视图",`self.messages` 这份canonical 历史从未被压缩逻辑修改过一个字节。

## 背景与设计动机

一个会话如果长期运行,token 消耗迟早会撞上模型的上下文窗口——但"到了阈值就自动摘要"这句话如果直接照抄,会在真实系统里踩到几个坑：

- **token 计数从来不是精确的。** 有的 provider 每次响应都会上报真实的 usage,有的完全不报;`openworker` 支持六种 provider（OpenAI、Anthropic、Gemini、Bedrock、Vertex、Codex),彼此上报口径还不完全一致。如果压缩判断完全依赖一个可能不存在或者偏差很大的估算值,总会有"本地觉得还没到阈值,provider 却已经拒绝了这次请求"的情况——这就要求除了"提前预测"之外,还必须有一条"provider 已经明确报错之后立刻补救"的被动路径。
- **摘要本身是一次可能失败的模型调用。** 摘要请求本身也会超时、也可能返回空内容,如果压缩失败没有兜底,会话就会卡在一个不断重试同一个失败操作的死循环里,而无人值守的自动化场景（scheduled task、self-wake)根本没有人能来处理一次"要不要重试"的提示。
- **压缩不能把正在进行的工作切断。** 一次很长的工具调用循环（比如一次安全扫描连续跑了三十次 shell 命令)如果被压缩边界从中间切开,provider 会因为看到一个不成对的 `tool_use`/`tool_result` 直接拒绝请求;而"最近的对话"永远是模型继续干活最需要的部分,压缩必须保证足够的"最近历史"完整保留,而不是简单按消息条数一刀切。

`openworker` 的答案是：把压缩拆成"判断该不该压"（阈值 + 每次迭代前检查)、"选择压哪一段"（边界选择,保证语义完整)、"怎么压"（LLM 摘要 + 代码机械抽取双轨并行)、"压不动怎么办"（重试 → 询问 → 免摘要兜底)四层独立的问题,每一层单独可测,`compaction.py` 里不出现任何 `asyncio`,不依赖任何提供方 SDK。

## 核心机制详解

### 触发信号与阈值：每次迭代前都会检查一次

```python
# coworker/engine.py
def _compaction_due(self) -> bool:
    cfg = self._compaction_config()
    if cfg.get("enabled") is False:
        return False
    signal = self._last_context_tokens or _compaction.estimate_tokens(self._outbound_messages())
    return _compaction.should_compact(
        signal, cfg.get("context_window"),
        threshold_pct=float(cfg["threshold_pct"]), cap_tokens=int(cfg["cap_tokens"]),
    )
```

```python
# coworker/compaction.py
DEFAULT_THRESHOLD_PCT = 0.8
DEFAULT_CAP_TOKENS = 250_000

def trigger_tokens(context_window, *, threshold_pct=DEFAULT_THRESHOLD_PCT, cap_tokens=DEFAULT_CAP_TOKENS) -> int:
    window = context_window or DEFAULT_CONTEXT_WINDOW
    return min(int(threshold_pct * window), int(cap_tokens))

def should_compact(signal, context_window, *, threshold_pct=DEFAULT_THRESHOLD_PCT, cap_tokens=DEFAULT_CAP_TOKENS) -> bool:
    return signal >= trigger_tokens(context_window, threshold_pct=threshold_pct, cap_tokens=cap_tokens)
```

信号优先取 `self._last_context_tokens`——上一轮模型响应里 provider 真实上报的"这次请求占用了多少上下文窗口"（`TokenUsage.context_tokens`,即 `input + cache_read + cache_write`);只有从没拿到过真实 usage 时才退化到 `estimate_tokens()` 的字符数除以 4 的粗估。阈值是 `threshold_pct × context_window` 和 `cap_tokens` 里取较小值——`DEFAULT_CAP_TOKENS = 250_000` 这个硬顶的存在,是为了让"上下文窗口标称一百万 token"的模型也在 25 万 token 左右就被压缩,注释里的理由是"quality and latency degrade well before the nominal limit"——标称窗口大小和"这个窗口用满了效果还好"完全是两回事。

关键的是这个检查发生的位置——`TurnEngine._loop()` 的**每一次迭代开始**,而不是只在用户发起新一轮对话时：

```python
# coworker/engine.py
async def _loop(self) -> AsyncIterator[Event]:
    while True:
        ...
        notice = None
        if self._compaction_due():
            yield Event(EventType.COMPACTING, {})
            notice = await self._compact_now()
        ...
```

也就是说,哪怕是同一个用户输入触发的第五次工具调用循环,只要历史涨到阈值,压缩也会插进来——注释里特意点出"Deliberately no 'wrap up' warning to the model"：不会在压缩前给模型一个"要收尾了"的提示,压缩对模型来说是静默发生的;而 `COMPACTING` 事件在真正调用摘要模型之前就先 `yield` 出去,是为了让界面能展示"正在压缩"这样的过渡态,而不是让用户对着一个卡住几秒的界面发呆。

### pick_boundary()：边界优先选在用户消息，绝不落在 tool 消息上

```python
# coworker/compaction.py
def pick_boundary(messages, *, keep_tokens: int) -> Optional[int]:
    start = 1 if messages and messages[0].get("role") == "system" else 0
    users, assistants = _turn_starts(messages, start=start)

    def _fit(candidates):
        for i in candidates:  # earliest-first: keep as much verbatim as fits
            if estimate_tokens(messages[i:]) <= keep_tokens:
                return i
        return None

    boundary = _fit(users)
    if boundary is None and users:
        inside = [i for i in assistants if i > users[-1]]
        boundary = _fit(inside)
        if boundary is None:
            boundary = inside[-1] if inside else users[-1]
    if boundary is None:
        boundary = _fit(assistants) or (assistants[-1] if assistants else None)
    if boundary is None or boundary <= start:
        return None
    return boundary
```

`keep_tokens` 是"边界之后必须原样保留、发给模型看的最新那段历史"的 token 预算,在 `_compact_now()` 里算出来：

```python
# coworker/engine.py
KEEP_RECENT_FRACTION = 0.25  # compaction.py
keep = int(_compaction.KEEP_RECENT_FRACTION * _compaction.trigger_tokens(window, threshold_pct=pct, cap_tokens=cap))
```

也就是触发阈值的 25%——**这是一个 token 预算,不是一个"保留最近 N 轮对话"的轮次数**,注释解释了原因："one huge tool loop shouldn't starve the working set"——如果按轮次数保留,一次动辄几十条工具调用消息的巨型循环会挤占掉本该保留的窗口;按 token 预算保留,不管这段历史是三轮对话还是三十次工具调用,只要装得下就整段保留。

`pick_boundary()` 的选择顺序体现了对"合法性"的执着：优先在**用户消息**处切（`users` 列表,从最早的候选开始试),因为一个用户消息天然是一轮新对话的起点,不会切断任何进行中的工具调用配对;只有当"最新这一轮用户消息本身"单独展开就已经超出预算(比如一次巨型工具调用循环),才退化到**助手消息（每次模型响应,即一次迭代)**边界——这仍然合法,因为一条新的助手消息前面不会有孤立的 `tool_calls` 尾巴。这个函数从头到尾都没有出现"在任意位置切一刀"的选项——不合法的边界从设计上就不存在于候选集合里。

### 摘要与机械抽取：LLM 负责叙事，代码负责事实

压缩产物由两条完全独立的流水线拼成。第一条是 LLM 摘要,`SUMMARY_SYSTEM_PROMPT` 要求模型按固定的八个小节输出（意图与约束、关键决策及理由、产出的文件、错误与修复、**全部用户消息的时间线**、待办事项、当前进度、下一步),并且明确要求"Do NOT carry full file contents as truth"——摘要只需要记住"读过/改过某个文件"这件事,不需要背下文件内容,"过时的文件记忆比没有记忆更糟"。

第二条是完全不经过模型的机械抽取:

```python
# coworker/compaction.py
def extract_working_state(span: list[dict[str, Any]]) -> str:
    """The mechanical block appended to the summary by CODE, from the span's
    tool-call records: files written, recent commands (+ exit status), artifacts, tools used."""
    for name, args, result in _iter_tool_calls(span):
        ...
        if path and any(h in lowered for h in _WRITE_HINTS):
            files.append(str(path))
        if lowered == "run_shell" and args.get("command"):
            status = _result_status(result)
            commands.append(f"{line}" + (f"  [{status}]" if status else ""))
```

```python
def extract_user_messages(span, *, clip=_USER_MESSAGE_CLIP) -> list[str]:
    """Every user message in the span, chronological, trimmed of pasted bulk. Preserved
    mechanically — the summarizer is also asked to list them, but user words are the
    ground truth of intent and must not depend on an LLM remembering to include them."""
```

这两个函数直接遍历被压缩的消息片段,用字符串匹配（`_WRITE_HINTS = ("write", "edit", "append", "save", "create", "patch")` 这类命名启发式)抠出"写过哪些文件""跑过哪些 shell 命令及其退出码""产出过哪些 artifact"——这部分信息**零幻觉风险**,因为它根本不经过模型生成,只是对工具调用记录的结构化重排。用户消息列表同理：docstring 直接写明"user words are the ground truth of intent and must not depend on an LLM remembering to include them"——虽然摘要提示词里也要求模型列出所有用户消息,但真正进入压缩产物的用户消息列表来自代码抽取,不依赖模型是否老实照做。

用户消息列表还有一个容易被忽略的上限控制：

```python
_USER_MESSAGES_MAX = 40

def _cap_user_messages(messages, *, prior_dropped, limit=_USER_MESSAGES_MAX):
    if len(messages) <= limit:
        return messages, prior_dropped
    return messages[-limit:], prior_dropped + (len(messages) - limit)
```

如果不设上限,一个长会话反复压缩几十次之后,这份"逐字保留的用户消息列表"会自己膨胀成占用大量 token 的负担,变相抵消了压缩省下来的空间——所以只保留最新的 40 条,更早的计入 `user_messages_dropped` 累计丢弃计数,在压缩块里显式告知模型"还有 N 条更早的用户消息被省略了,它们的意图已经体现在上面的摘要里"。

### 重复压缩：前一次的摘要作为新一轮的第零条消息

```python
# coworker/compaction.py
def build_state(messages, *, provider, model, keep_tokens, prior=None) -> Optional[CompactionState]:
    boundary = pick_boundary(messages, keep_tokens=keep_tokens)
    if boundary is None or (prior is not None and boundary <= prior.boundary_index):
        return None
    span_start = prior.boundary_index if prior is not None else 0
    span = messages[span_start:boundary]
    summary = summarize_span(provider, model, span, prior_summary=prior.summary_text if prior is not None else "")
```

第二次压缩发生时,`span` 只覆盖"上一次压缩边界"到"这一次新算出的边界"之间的消息——而不是从头再摘要一遍整个历史,`prior.summary_text` 作为 `summarizer_messages()` 里的"[previous compaction summary — fold its still-relevant content into the new summary]"前缀,让模型把旧摘要和新增内容一起折叠成一份新摘要。`boundary <= prior.boundary_index` 这行判断保证了边界严格单调前进——不会出现"压缩了个寂寞"的空转。

### 失败与兜底：两次重试 → 有人值守才问 → 否则直接免摘要

```python
# coworker/engine.py
async def _compact_now(self, *, force: bool = False) -> Optional[str]:
    ...
    for _attempt in range(2):  # first try + the unconditional single retry
        try:
            state = await asyncio.to_thread(_build)
            failed = False
            break
        except Exception:
            failed = True
    if failed and self.question_asker is not None and self.is_attended and self.is_attended():
        while True:
            answer = await self._interruptible(
                self.question_asker({"question": "...", "options": ["Retry", "Trim oldest 10%"], ...}),
                interrupted=None,
            )
            if not answer or answer.get("answer") != "Retry":
                break
            try:
                state = await asyncio.to_thread(_build)
                failed = False
                break
            except Exception:
                continue
    if state is not None:
        self.compaction_state = state
        return "Context compacted — earlier turns were summarized"
    if failed or force:
        trimmed = _compaction.trim_state(self.messages, prior=self.compaction_state)
        if trimmed is not None:
            self.compaction_state = trimmed
            return "Context trimmed — oldest turns dropped (summary unavailable)"
    return None
```

失败处理分三层：先无条件重试一次（`range(2)`);如果还失败,只有当 `question_asker` 存在**并且** `is_attended()` 返回真（即这是一个当前有人盯着的交互式会话,不是无人值守的自动化任务)才会弹出询问,让用户选择"再重试一次"还是"直接砍掉最老的 10%";任何情况下,只要最终还是拿不到一份带摘要的 `CompactionState`,就退化到 `trim_state()`——完全不调用模型、按固定比例（`_TRIM_FRACTION = 0.10`)把最老的一段历史推过边界,压缩块里放一句"没有摘要,需要重新读取文件/重新跑命令"的说明,外加机械抽取的工作状态和用户消息列表（这两项是"免费的",不依赖 LLM)。**无人值守的场景永远不会卡在一次询问上**——这是自动化任务不能被内部记账工作阻塞这条原则在压缩机制上的体现。

### 被动兜底：provider 直接报错之后的即时补救

主动检查依赖的是估算,估算天然可能失准。当一次原始的 400 错误真的从 provider 那边冒出来,`_loop()` 的异常处理分支会识别它并触发一次强制压缩:

```python
# coworker/engine.py
except Exception as exc:  # provider failure
    if _compaction.is_context_overflow(exc) and not self._cancel.is_set():
        yield Event(EventType.COMPACTING, {})
        notice = await self._compact_now(force=True)
        if notice:
            self._append_notice("compacted", notice)
            yield Event(EventType.COMPACTED, {"text": notice})
            continue
```

```python
# coworker/compaction.py
_OVERFLOW_MARKERS = (
    "context_length_exceeded", "maximum context length", "context window",
    "prompt is too long", "input is too long", "too many tokens", ...
)

def is_context_overflow(exc: BaseException) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in _OVERFLOW_MARKERS)
```

`is_context_overflow()` 用一组覆盖不同 provider 措辞的关键词字符串匹配去识别"这是不是一次上下文超限报错"——这条路径只在主动检查失手时才会被触发,`force=True` 会跳过 `_compaction_due()` 的阈值判断直接执行压缩,压缩成功后 `continue` 让 `_loop()` 用刚刚缩小的历史重新走一遍这一轮迭代。这正是"主动预测 + 被动兜底"两条腿走路的完整闭环——前者基于估算,后者基于 provider 已经给出的确定性事实。

### apply_to_outbound()：只改视图，从不改历史

```python
# coworker/compaction.py
def apply_to_outbound(messages, state) -> list[dict[str, Any]]:
    if state is None:
        return messages
    boundary = state.boundary_index
    if boundary <= 0 or boundary >= len(messages):
        return messages
    head = []
    if messages and messages[0].get("role") == "system":
        head.append(messages[0])
    head.append({"role": "user", "content": compacted_block(state)})
    return head + messages[boundary:]
```

这个函数只在 `TurnEngine._outbound_messages()`——也就是喂给 provider 的唯一入口——里被调用,`self.messages` 这份 canonical 历史从头到尾没有被压缩逻辑修改过一个字节。这意味着：界面上展示给用户看的完整对话记录永远保持原样,压缩只影响"接下来发给模型的这份请求里,老历史被替换成了摘要"。`CompactionState` 最终通过 `.as_dict()` 序列化进 `SessionRecord.compaction` 字段（上一篇读到的 dataclass 字段),`server/manager.py` 在构建引擎、恢复历史时用 `CompactionState.from_dict(record.compaction)` 把它还原到新建的 `TurnEngine` 实例上——这就是为什么一个会话重启进程之后,压缩视图不会丢失,也不需要重新压缩一遍。

## 常见问题/易踩坑

- **`_compaction_due()` 每次迭代都检查,不是只在新用户输入到来时检查**——一个包含大量工具调用的巨型任务,压缩可能在同一个用户输入的循环内部就被触发好几次。
- **`keep_tokens` 是 token 预算而不是轮次数**——不要假设"最近 N 轮对话"一定会被完整保留,如果最近的工作本身就是一次超大的工具调用循环,`pick_boundary()` 会退化到"迭代边界",只保留最近一次模型响应之后的部分。
- **无人值守的会话永远不会因为压缩失败而卡住**——`is_attended()` 为假或 `question_asker` 未提供时,失败直接走 `trim_state()` 兜底,绝不会挂起等待一个不存在的人来回答。
- **`trim_state()` 产出的压缩块没有真正的摘要**,只有机械抽取的文件/命令/用户消息列表 + 一句提示模型"需要重新读取"的说明——这是刻意的诚实,而不是缺陷:没有摘要就不该假装有摘要。

## 小结

压缩的触发判断（阈值 + 每次迭代前检查)、边界选择（优先用户消息边界,保证语义完整)、内容生成（LLM 摘要 + 代码机械抽取双轨并行)、失败兜底（重试 → 值守场景下询问 → 免摘要 trim)分别是四个独立可测的问题,`compaction.py` 里的纯函数只回答"怎么压",`TurnEngine._loop()` 负责"什么时候压"和"压不下去了怎么办",而 `apply_to_outbound()` 保证这一切只影响发给模型的视图,从不触碰持久化的对话历史。压缩状态本身也和上一篇的 `SessionRecord.compaction` 字段一起完成了跨进程重启的持久化闭环。

下一篇要顺着 `Event`/`EventType` 这条线,看这一整套循环——从文本增量、工具调用开始/结束,到刚刚看到的 `COMPACTING`/`COMPACTED`——是怎么经过 `server/app.py`/`server/manager.py` 转发给 `surfaces/gui`,变成用户在界面上看到的打字机效果和实时状态展示的。
