# Overrides:常驻规则与 Allowlist 晋升机制

> README 把第二层治理描述成一条阶梯:"One-off approvals can graduate into standing rules, then into config allowlists - each step explicit, visible, and revocable"。前四篇分别讲清楚了模式总览、决策链、reviewer、审计追踪,本篇要把"阶梯"本身的三级台阶拼完整:第一级是只活在当前会话内存里的一次性/会话级授权,第二级是写进 `coworker/overrides.py` 的 `RiskOverrideStore`、跨会话持久化的"信任规则",第三级是需要用户手工编辑 `config.toml` 的命令/工具白名单。除此之外还有一条专门服务定时自动化的平行阶梯——任务级常驻规则。本篇也是全章的收束篇,最后会回顾这五篇文章讲的治理系统整体解决了什么问题。

## 学习目标

- 把"一次性批准 → 常驻规则 → 配置白名单"这三级台阶,分别对应到 `ApprovalOutcome` 枚举、`PermissionEngine` 的会话状态、以及 `RiskOverrideStore` 的持久化文件。
- 理解 `overrides.py` 里"风险覆盖规则"和"信任规则"是两种不同的杠杆——前者改变工具的风险等级,后者只免除审批卡本身,而 MCP 工具只能用后者。
- 理解服务端如何对"用户点了哪个按钮"做二次校验(`_grant_offered`/`approval_outcome`),防止一次 API 调用伪造出一个 UI 从未提供过的授权范围。
- 理解自动化任务专属的"任务级常驻规则"(§25)与会话级授权阶梯是两条并行但目标不同的晋升路径。

## 背景与设计动机

`coworker/overrides.py` 的模块 docstring 一句话点出了这个模块要解决的两个问题:

```python
# coworker/overrides.py:1-15(节选)
"""User-local risk overrides — relax (or tighten) a tool's risk class — and, since
OPE-136, per-tool TRUST rules.

``rules`` relax or tighten a third-party (plugin) tool's risk class by glob; the most
specific rule wins. MCP tools cannot be reclassified (the floor in ``risk.classify``);
their sanctioned lever is a ``trust`` rule instead: *waive the approval card for this
tool* — nothing else. A trusted tool stays EXTERNAL: read-only modes still deny it, the
Auto-approve reviewer still judges it, and the audit trail still records it. ...

**Inviolable rule: this store is user-local and is NEVER written by a persona/package.** ...
"""
```

一个模块、两种规则:`rules`(风险覆盖)能改变一个第三方插件工具"本质上有多危险"这个判断本身;`trust`(信任规则)完全不碰风险等级,只是"以后别再为这一个工具弹审批卡了"——第二篇讲过,MCP 工具的风险等级被 `_mcp_floor` 焊死在 `EXTERNAL`,任何规则都无法把它降下来,所以 MCP 工具唯一能用的杠杆就是信任规则:哪怕免除了审批卡,只读模式依然会拒绝它、reviewer 依然会审查它(如果处于非 `AUTO_APPROVE` 的其他模式)、审计轨迹依然会记录它。这正是"晋升不等于失去所有约束"的具体体现。

## 核心机制详解

### 第一级台阶:只活在内存里的会话/单次授权

最低一级的"批准"完全不落盘,`PermissionEngine` 用几个内存里的集合分别装它们:

```python
# coworker/permissions.py:285-300(节选,PermissionEngine 字段)
session_allow_tools: set[str] = field(default_factory=set)
session_allow_commands: set[str] = field(default_factory=set)
run_allow_tools: set[str] = field(default_factory=set)
allowed_domains: list[str] = field(default_factory=list)
session_allow_domains: set[str] = field(default_factory=set)
session_readonly: bool = False
```

对应用户在审批卡上能点出的几种"一次性/会话级"选项,在 `ApprovalOutcome` 枚举里能找到完整清单:

```python
# coworker/engine.py:43-58
class ApprovalOutcome(str, Enum):
    ONCE = "once"
    ALWAYS_TOOL = "always_tool"
    ALWAYS_COMMAND = "always_command"
    ALWAYS_DOMAIN = "always_domain"
    READONLY_SESSION = "readonly_session"
    ALWAYS_TRUST = "always_trust"
    THIS_RUN = "this_run"
    DENY = "deny"
```

其中 `THIS_RUN`("Allow for this request")是这一级台阶里生命周期最短的一种——它只覆盖"当前这一次运行"(一次用户消息触发的完整多轮工具调用),`PermissionEngine.clear_run_allowances()` 会在每次运行结束或被中断时清空它:

```python
# coworker/permissions.py:527-531
def clear_run_allowances(self) -> None:
    """The run boundary IS the grant's expiry: the engine calls this when a run
    finishes or is interrupted, so "Allow for this request" never outlives the
    answer the user was watching."""
    self.run_allow_tools.clear()
```

"运行边界本身就是这份授权的到期时间"——这句注释解释了为什么它比 `ALWAYS_TOOL`(会话级,活到整个会话结束)更短命:它是专门为一次性任务里"这个工具会在同一轮里被反复调用好几次(分页、重试)"这种场景设计的,不需要、也不应该活过用户正在看着的这一次回答。

而 `session_readonly` 这一档("Allow read-only commands for this session")则代表了一种更粗粒度的信任:相信一个专门的分类器(`coworker/readonly.py`)能判断一条 shell 命令是不是只读——但 `permissions.py` 里紧跟着的注释提醒了这份信任的边界:

```python
# coworker/permissions.py:453-464(节选)
if honor_session_grants and self.session_readonly and command:
    from .readonly import is_readonly_command, read_targets

    # The classifier vets what a command DOES; the roots vet what it READS
    # (OPE-130). Without the second half, a grant the user reads as "stop
    # asking about my project files" also covers ~/.aws/credentials, another
    # repo's history, and OpenWorker's own secrets file — none of which the
    # self-protection floor catches, since that guards writes, not reads.
    if is_readonly_command(command) and all(
        self._under_root(t) for t in read_targets(command)
    ):
        return Decision(True, "read-only command (session grant)")
```

"分类器只负责判断命令**做了什么**,读取目标是否越界还要单独检查"——这是一处很典型的"两个各自独立、缺一不可"的检查叠加:自我保护红线只守写操作,如果只读授权不额外检查读取目标,一句"帮我看看这个项目里有什么文件"式的宽泛授权,理论上也能顺带读到 `~/.aws/credentials` 或者 OpenWorker 自己的 `secrets.json`。

### 第二级台阶:跨会话持久化的信任规则

第一级台阶的所有授权都会在会话结束、进程重启后清零。想让某个规则活过今天这一次对话,就要晋升到 `RiskOverrideStore` 持久化的信任规则——`ApprovalOutcome.ALWAYS_TRUST` 就是这一级台阶专属的选项,`engine.py` 里处理它的分支只有一行,但背后接的是磁盘上的一份 JSON 文件:

```python
# coworker/engine.py:1390-1393(节选)
elif outcome is ApprovalOutcome.ALWAYS_TRUST:
    # Durable per-tool trust (OPE-136 §4): lands in the user-local
    # override store, so tomorrow's sessions stay quiet too.
    self.permissions.grant_trust_for_tool(tool_call.name)
```

`grant_trust_for_tool()` 调用的是 `agent.py` 构建引擎时注入的 `grant_trust` 回调——最终落到 `RiskOverrideStore.set_trust()`:

```python
# coworker/overrides.py:144-151
def set_trust(self, pattern: str) -> None:
    """Mint a trust rule (the approval card's "Always allow this tool" writes an
    EXACT name — a button grants precisely what its card showed, nothing wider)."""
    if not pattern:
        return
    if pattern not in self._trust:
        self._trust.append(pattern)
        self.save()
```

这里有一处细节值得留意:注释强调"按钮写入的是精确的工具名,不是更宽的通配符"——用户在审批卡上点击的是"总是允许**这一个**工具",而不是"总是允许所有匹配某种模式的工具",尽管 `_trust` 列表底层用的是 `fnmatchcase` 做匹配,支持手工编辑文件时写入通配符,但通过 UI 产生的信任规则永远是精确名称,不会因为一次点击就意外扩大到一整类工具。

`RiskOverrideStore` 落盘的文件路径是 `state_dir() / "risk_overrides.json"`——回头看第二篇讲过的 `protected_paths()` 清单,这份文件本身就在受保护路径之列:agent 自己**不能**通过写文件或 shell 命令去修改它。也就是说,"常驻信任规则"这一级台阶的晋升,只能通过用户在审批卡上真实点击"总是允许"来触发,agent 没有任何代码路径能绕过人类直接给自己写一条常驻规则——这正是模块 docstring 里"this store is user-local and is NEVER written by a persona/package"这条不可侵犯规则的存储层保障。

"每一步都可撤销"这条承诺也在这个模块里有对应实现:

```python
# coworker/overrides.py:153-157
def revoke_trust(self, pattern: str) -> None:
    before = len(self._trust)
    self._trust = [p for p in self._trust if p != pattern]
    if len(self._trust) != before:
        self.save()
```

`trust_patterns()` 把当前所有信任规则列出来供 UI 展示(比如工具详情页的"撤销"按钮),这条晋升路径的"可见"也不是一句空话——用户随时能看到自己曾经授予过哪些常驻信任,并且逐条撤回。

风险覆盖规则(`_rules`)那一半走的是另一套匹配逻辑——按模式的"具体程度"决胜:

```python
# coworker/overrides.py:34-38, 125-133
def _specificity(pattern: str) -> int:
    """More literal (non-wildcard) characters = more specific; an exact pattern beats any glob."""
    literal = sum(1 for c in pattern if c not in "*?[]")
    exact = 0 if any(c in pattern for c in "*?[") else 1000
    return literal + exact

def resolve(self, tool_name: str) -> Optional[RiskClass]:
    best: Optional[RiskClass] = None
    best_score = -1
    for r in self._rules:
        if fnmatchcase(tool_name, r.pattern):
            score = _specificity(r.pattern)
            if score > best_score:
                best, best_score = r.risk, score
    return best
```

一条精确匹配的规则(没有任何通配符)天然比一条 glob 规则分数高出一大截(`exact` 直接加 1000 分),这保证了"给某一类工具定一条宽松规则,又给其中一个特定工具定一条更严格的例外"这种叠加是可预期的:更具体的规则总是赢。而 `set_rule()`(`overrides.py:109-123`)在写入前会重复一遍 `_load()` 里对"MCP 工具规则不得降到 `READ`/`EGRESS`"的拒绝检查——防止一条规则在这次会话里生效、下次加载时又被悄悄丢弃,那种"时灵时不灵"的规则比直接拒绝写入更危险。

### 第三级台阶:需要手工编辑的配置白名单

第一篇已经讲过 `config.toml` 里 `allowed_commands`/`auto_allow` 两个字段的基本用法,这里要补的是它们在"晋升阶梯"里的位置:这是唯一一级**不经过任何 UI 点击**、必须由用户手工编辑配置文件(或者未来由某个专门的"从历史中提炼规则"的工具辅助生成)才能到达的台阶。它比 `RiskOverrideStore` 的信任规则更"重"——信任规则只是免除审批卡、不改变风险等级,而 `allowed_commands` 命中即直接放行(`Decision(True, "command on allowlist")`),`auto_allow` 在 `custom` 模式下同样直接放行,两者都不会被 `AUTO_APPROVE` 模式的 reviewer 拦下来复核(`permissions.py` 里 `_command_allowed()` 判断成功时直接返回,不经过 reviewer 判断分支)。这也是为什么第一篇要专门强调 `_GLOBAL_ONLY_FIELDS` 那道限制——这两个字段是三级台阶里权限最重的一级,所以被限定成"只能来自用户全局配置,一个仓库自己声明不算数,除非用户先显式信任这个仓库路径"。

### 服务端不信任按钮本身:`_grant_offered` 与 `approval_outcome` 的二次校验

一条容易被忽略但很重要的防线是:客户端 UI 上"能看到哪些晋升选项"和服务端"愿意接受哪些晋升请求"是两条独立的判断,后者不信任前者。`coworker/server/manager.py` 里的 `_grant_offered()` 就是这层校验:

```python
# coworker/server/manager.py:126-171(节选)
def _grant_offered(outcome, request) -> bool:
    """Whether a persistent grant is legitimately offered for this tool — the server-side
    mirror of what the approval card actually renders (`ApprovalCard.tsx`).
    ...
    """
    ...
    if outcome is ApprovalOutcome.ALWAYS_TOOL:
        if risk in (RiskClass.EXEC, RiskClass.EXTERNAL):
            return False
        if risk is RiskClass.EGRESS and args.get("url"):
            return False
        if getattr(metadata, "category", "") == "connector":
            return False
        return name != "save_skill"
    return True
```

`ALWAYS_TOOL`(工具级、参数无关的"总是允许")被明确排除在 shell 工具、任何离开本机的连接器/MCP 工具、带 URL 的出网工具、以及 `save_skill` 之外——原因在同一段注释里写得很清楚:shell 工具应该用范围更窄的"常驻命令"授权,出网工具应该用"常驻域名"授权,`save_skill` 的每一次技能提案都值得单独审视,这些工具"总是允许"这个粒度本身就太粗,不该被批准。

真正决定这条校验是否被执行的,是 `manager.py` 的 `approval_outcome()` 方法——它是所有来自任意界面(应用内点击、Slack 按钮、直接调用 REST API)的解析结果统一要经过的一道关卡:

```python
# coworker/server/manager.py:4300-4312(节选)
def approval_outcome(self, resolution: str, request, session_id: str):
    """Map an approval resolution (from any surface) to an ApprovalOutcome...

    Server-side validated, not trusted from the caller: a grant that no UI offers for
    this tool is downgraded to a one-time approval rather than honoured. The GUI already
    hides the broad "always allow" for run_shell / connectors / save_skill, and Slack
    mirrors only ever render approve/deny — but `POST /v1/inbox/{id}/resolve` takes a raw
    string, so without this check any local API caller could mint a session-wide
    any-argument shell grant. Same philosophy as mint_task_rule: validate here, don't
    trust the card.
    """
```

这段注释点出了真实的攻击面:`POST /v1/inbox/{id}/resolve` 这个接口接受一个原始字符串作为 `resolution`,如果没有这层校验,任何能调用这个本地 API 的调用方都可以直接构造出一个 UI 从来没有提供过的"给 shell 工具的、不限参数的会话级授权"。`approval_outcome()` 的兜底策略不是拒绝整次请求,而是把不被允许的晋升**降级成一次性批准**(`_grant_offered` 返回 `False` 时调用 `_audit_grant_refused()` 留痕,再返回 `ApprovalOutcome.ONCE`)——这是"宁可少批一点,也不要让一个不该存在的授权悄悄落地"这条一贯原则的又一次体现。

### 一条平行的阶梯:面向自动化任务的常驻规则(§25)

除了会话内的三级台阶,仓库里还有一套专门服务定时自动化任务的常驻规则机制——`PermissionEngine.task_rules` 字段:

```python
# coworker/permissions.py:304-307(节选)
# Task-scoped standing rules (§25): {tool: {allowed targets}}, seeded from the owning
# ScheduledTask's target-shaped entries. Kept by reference and re-read every check, so a
# rule minted mid-run ("Allow every time") applies to the run's next call too.
task_rules: dict[str, set[str]] = field(default_factory=dict)
```

这套规则的粒度比前面讲的"工具级"信任规则更窄——它绑定的是"工具 + 具体目标"这一对组合,`standing_rule_candidate()`(`permissions.py:260-278`)限定了只有"外部风险(`RiskClass.EXTERNAL`)且声明了目标参数"的调用才有资格拥有一条标靶式的常驻规则,shell/写本地文件这类调用永远没有资格——注释里说得很直白:"external-risk only (never exec/write-local — shell asks forever)"。这条设计针对的正是自动化场景的真实痛点:一个每天早上发晨报的任务,可能需要反复调用"发消息到某个固定频道"这一个工具,但把"这个工具永远不用问"和"这个工具只对这一个固定频道永远不用问"相比,后者的授权范围要精确得多。

一次任务运行中,用户在审批卡上点击"Allow every time"会调用 `manager.py` 的 `mint_task_rule()`:

```python
# coworker/server/manager.py:4265-4298(节选)
def mint_task_rule(
    self, session_id: str, tool_name: str, arguments: Any, metadata: Any = None
) -> bool:
    """Persist a standing rule a human minted via "Allow every time" on a run's
    approval card (§25's retrofit path). Server-side validation, not trust in the
    card: the session must be an automation run and the call must be rule-eligible
    (external risk, declared target argument, non-empty target). Also applies the
    rule to the live engine so the run's next call auto-allows."""
    task = self.task_store.task_for_run_session(session_id)
    if task is None:
        return False
    target = standing_rule_candidate(tool_name, arguments or {}, metadata)
    if not target or not task.add_rule(tool_name, target):
        return False
    self.task_store.save(task)
    engine = self._engines.get(session_id)
    if engine is not None:
        engine.permissions.task_rules.setdefault(tool_name, set()).add(target)
    ...
```

这里同样贯彻了"服务端二次校验、不信任调用方"的原则——`task_store.task_for_run_session(session_id)` 先确认这确实是一次自动化任务的运行会话,再确认这个调用本身是否"够资格"拥有标靶规则,最后才把规则写进任务本身的持久化存储、同时应用到当前正在运行的引擎实例,让"本次运行的下一次调用"立刻生效,不用等到任务的下一次调度。这次晋升同样会被记进审计轨迹:

```python
# coworker/server/manager.py:4285-4295(节选)
self.audit_store.append({
    "session_id": session_id, "tool": tool_name, "arguments": arguments or {},
    "stage": "standing_rule_minted", "status": "granted",
    "reason": f"allow every time: {tool_name} → {target} (task {task.id})",
})
```

而对于无人值守的自动化任务本身怎么处理审批,`manager.py` 的 `_scheduled_approver()` 给出了一条"优雅降级"的默认行为:

```python
# coworker/server/manager.py:4414-4444(节选)
def _scheduled_approver(self, task, session_id: str):
    from ..engine import ApprovalOutcome
    from ..permissions import WRITE_TOOLS

    name_allowed = task.name_allowed_tools()

    async def approver(request):
        # Unattended: auto-allow the deliverable writes (path-scoped to the task
        # workspace) + tools the task allows BY NAME (legacy entries). Target-bound
        # rules never reach here — the permission engine matched them already.
        if request.tool_name in WRITE_TOOLS or request.tool_name in name_allowed:
            return ApprovalOutcome.ONCE
        # Anything else parks in the Inbox and suspends the run (§25 graceful
        # degradation — an ungranted automation still works, it just asks). ...
        item = self.inbox.add_approval(...)
        ...
        resolution = await self.inbox.wait(item.id)
        return self.approval_outcome(resolution, request, session_id)

    return approver
```

一个自动化任务默认只对"往自己工作区里写交付物"和任务本身预先按名字授权的工具自动放行,除此之外的任何调用一律走 Inbox——"一个没有被充分授权的自动化任务依然能运行,只是会停下来问"("an ungranted automation still works, it just asks"),这正是 README"unattended runs never self-approve"这句话在自动化任务场景下的具体行为:自动化不会因为遇到一个没被授权的操作就悄悄放行,也不会因此彻底失败,而是把这次请求交给 Inbox,等人来回答。

## 常见问题/易踩坑

- **"常驻信任规则"和"风险覆盖规则"是两种不同强度的杠杆,不要混用**——信任规则只免除审批卡,风险等级、只读模式的拒绝、reviewer 的审查、审计记录全部照常;风险覆盖规则则是真的改变了工具的风险分类本身,但它对内置写/执行/出网工具、连接器目录工具、MCP 工具"只能收紧不能放松"(第二篇讲过的 `_STRICTNESS` 比较),真正能被放松的只有第三方插件工具里被判断得"过度谨慎"的那一小类。
- **配置白名单是唯一一级不需要人在关键时刻点一次按钮就能生效的授权**,这也是它被限定为"只能来自用户全局配置、仓库自己声明的白名单需要显式工作区信任"的原因——把它和会话内的三级授权放在同一条阶梯上理解时,始终要记得它的生效门槛和撤销方式(直接编辑文件)都不一样。
- **任务级常驻规则和会话级的"常驻信任规则"服务的是完全不同的场景**——前者绑定"工具+具体目标"这个更窄的粒度,专门为自动化任务设计,只对声明了目标参数的外部风险调用开放;后者是"整个工具都不用再问了",服务的是交互式会话里反复使用同一个工具的场景,两者不能互相替代。

## 小结:三层治理合起来解决了什么问题

五篇文章讲到这里,可以退一步看这套治理系统整体在解决什么矛盾:一个真正有用的桌面 agent,必须能够代表用户去写文件、跑命令、发消息、连外部服务——这些能力天然伴随着风险;但用户又不可能对每一个动作都亲自确认,那样"agent 帮你干活"这件事本身就不成立。OpenWorker 的答案不是在"完全信任"和"事事确认"之间选一个折中点,而是把这道光谱拆成了三层各自独立生效的机制:**硬性红线**保证了不管自主权被放到多松,总有一组操作(自我保护文件、常驻授权工具、项目内延迟执行文件)永远绕不开人;**自主权阶梯**让"信任是一步步挣来的"这件事变得显式、可见、可撤销——一次性授权、跨会话的信任规则、需要手工编辑的配置白名单,每升一级都意味着更少的打扰,但也意味着更大范围的默许,而 reviewer 在这条阶梯的顶端提供了一个"不确定就问人"的缓冲层,并且用连续拒绝熔断保证它自己也不会变成一个失控的自动放行器;**审计轨迹**则保证前两层无论怎么运作,"谁做的、为什么"这个问题永远有答案可查——这也是为什么 reviewer 的裁决被反复强调"是判断,不是保证":真正兜底这套系统可信度的,是绕不开的红线和查得到的记录,而不是任何一次模型给出的裁决本身。

下一章会转向驱动这套引擎的另一条主线——模型与 Provider 生态:OpenWorker 如何在不锁定任何一家模型厂商的前提下,让 `aisuite` 之上的这一层适配代码同时支撑 OpenAI、Anthropic、Google Gemini,以及本地运行的 Ollama。
