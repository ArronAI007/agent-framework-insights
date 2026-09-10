# Permissions 与 Risk 风险评估

> 上一篇建立了模式和配置层面的心智模型,本篇要打开 `PermissionEngine.evaluate()` 这一个方法——一次工具调用从"模型发起请求"到"被判定为允许 / 需要审批 / 直接拒绝",中间到底经过了哪些检查点、这些检查点的先后顺序为什么是这样安排的。`risk.py` 负责回答"这个工具本质上有多危险",`permissions.py` 负责回答"在当前模式和当前配置下,这次调用该怎么处理"——README 里"没有任何模式能降低硬性红线"这句承诺,最终要落实成代码里一个具体的、优先级高于一切模式判断的检查顺序。

## 学习目标

- 理解 `risk.py` 里 `RiskClass` 五个取值的语义,以及 `classify()` 如何把一个工具调用归到某个风险类别。
- 完整走一遍 `PermissionEngine.evaluate()` 的决策链,搞清楚自我保护红线、只读模式、路径作用域、常驻授权红线、允许列表这几个检查点的先后顺序及其理由。
- 理解"硬性红线在任何模式下都不能被降低"这句话在代码里具体是怎么保证的——答案不是一个单独的开关,而是几处检查被刻意排在模式判断之前。
- 理解风险覆盖(`RiskOverrides`)"只能收紧、不能放松"这条规则,以及它对 MCP 工具和连接器目录工具的特殊处理。

## 背景与设计动机

一次工具调用能不能自动执行,理论上取决于两个独立的问题:这个工具**本质上**有多危险(风险分类),以及**当前**的模式/配置允不允许它自动跑(权限决策)。OpenWorker 把这两个问题拆成了两个模块——`risk.py` 和 `permissions.py`——`risk.py` 的模块 docstring 讲得很清楚:

```python
# coworker/risk.py:1-10
"""Risk classes for tools — the intrinsic side-effect category that drives permission
gating (and, later in Phase 2, unattended Inbox routing).

This replaces the hardcoded ``WRITE_TOOLS`` / ``SHELL_TOOL`` name sets the permission engine
used to carry inline: risk is now a declared property a single ``classify`` reads.

A tool's *effective* risk = an optional user-local override (Phase 2) ?? the base
classification here. Built-in vetted tools are classified by name; anything else falls back
to its aisuite metadata (``requires_approval`` → external) or is treated as read.
"""
```

"risk 是工具的内在属性,permission 是运行时的决策"——这条分工解释了为什么 `PermissionEngine.evaluate()` 的第一步永远是调用 `classify()`,而不是直接检查 mode。

## 核心机制详解

### `RiskClass`:五个风险类别

```python
# coworker/risk.py:18-24
class RiskClass(str, Enum):
    READ = "read"  # no side effects — always allowed
    EGRESS = "egress"  # reaches the network — the request itself can carry data off-machine
    WRITE_LOCAL = "write_local"  # mutates the workspace — path-scoped + mode-gated
    EXEC = "exec"  # runs commands — mode-gated
    EXTERNAL = "external"  # side effects off the machine — the unattended Inbox hook
```

内置工具的风险由名字直接决定(`WRITE_TOOLS`、`SHELL_TOOL`、`EGRESS_TOOLS` 这几张表,`risk.py:27-54`),没有命中这些表的工具走两条兜底路径:连接器目录工具有自己的"地板"(`_catalog_floor`),第三方 MCP 工具也有自己的"地板"(`_mcp_floor`),两者都在下面详细讲。`classify()` 的完整优先级:

```python
# coworker/risk.py:117-142
def classify(
    tool_name: str, metadata: Any = None, overrides: Optional[RiskOverrides] = None
) -> RiskClass:
    """Effective risk of a tool call. A user override may *relax* a metadata tool (the
    intended use — quieting an over-cautious plug-in), but may only ever **tighten** a
    built-in write/exec/egress tool, a connector-catalog write, or a third-party MCP tool
    (OPE-136), never loosen one. ...
    """
    base = (
        _BASE.get(tool_name)
        or _catalog_floor(tool_name)
        or _mcp_floor(tool_name, metadata)
    )
    if overrides is not None:
        ov = overrides(tool_name)
        if ov is not None:
            if base is None or _STRICTNESS[ov] >= _STRICTNESS[base]:
                return ov
            # A loosening override on a floored tool is ignored: fall through to the base.
    if base is not None:
        return base
    if bool(getattr(metadata, "requires_approval", False)):
        return RiskClass.EXTERNAL
    return RiskClass.READ
```

`_STRICTNESS` 表(`risk.py:64-70`)给每个风险类别打了一个"严格程度"分数(`EXEC`/`WRITE_LOCAL` 并列最高分 3),`overrides` 只有在**分数不降低**时才会被采纳——这条规则本身就是"用户可以让一个过度谨慎的插件安静下来,但不能把一个内置的写/执行/出网工具悄悄降级成只读"的精确实现,后面第五篇讲 `overrides.py` 时会展开这条规则背后的完整设计。

### MCP 工具的"焊死"地板

`_mcp_floor` 是一处专门为第三方 MCP 工具设的地板,值得单独摘出来读:

```python
# coworker/risk.py:90-114(节选)
def _mcp_floor(tool_name: str, metadata: Any) -> Optional[RiskClass]:
    """The floor for third-party MCP tools (OPE-136): EXTERNAL, always.

    An MCP tool's effects are a stranger's claim — we cannot tell its reads from a write
    wearing a read's name — so no config value may drop one into the never-checked READ
    tier. Before this floor, `requires_approval: false` in mcp.json reclassified a whole
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

这段注释交代了一次真实的回退:早期版本里 `mcp.json` 的 `requires_approval: false` 会把整台服务器的工具重新归类成 `READ`,一步之内同时关掉了审批卡、`Discuss` 模式的只读拒绝、Auto-Approve 的 reviewer,以及审计记录——四道防线因为一个标志位同时失效。现在这个标志位被降级成只能"免掉审批卡本身"(见下一篇 `overrides.py` 里的信任规则),风险类别本身"焊死"在 `EXTERNAL`,任何配置都无法把它降下去。这是"风险分类"和"审批决策"必须分成两层的直接理由:如果两者混在一起,一个本意"少问一次"的标志位就可能连带关掉审计和只读模式的保护。

### `PermissionEngine.evaluate()`:完整决策链

`evaluate()` 是整个治理系统的心脏,按代码里出现的先后顺序,决策链条是这样的:

1. **自我保护红线**(`permissions.py:363-370`)——如果调用是写或执行类,先检查它是否触碰了 `protected_paths()` 列出的文件(`config.toml`、`risk_overrides.json`、`workspace_trust.json`、`unattended.json`、`coworker.db`、`secrets.json`、`inbox_routing.json`)。命中就直接拒绝,`needs_user=False`——甚至不给"请人工确认"的选项,因为这类文件"治理系统自身的配置"一旦被修改,后续所有判断都不可信了。
2. **只读模式拒绝**(`permissions.py:372-376`)——`DISCUSS`/`PLAN` 模式下,任何有副作用的调用直接拒绝。
3. **写操作的路径作用域检查**(`permissions.py:378-399`)——每一个写工具的目标路径都必须解析到某个可写的根目录下;如果路径压根解析不出来(比如一个未知的写工具),直接失败关闭(`human_only=True`),绝不放过一个"作用域不明"的写操作。
4. **常驻授权红线**(`permissions.py:401-411`)——`PERSISTENT_AUTHORITY_TOOLS`(`save_skill`、`create_scheduled_task`、`update_scheduled_task`、`delete_scheduled_task`)一律要求人工批准,且 `human_only=True`。
5. **非消费性调用直接放行**(`permissions.py:413-415`)——纯读操作(`RiskClass.READ`)不需要经过下面任何一层。
6. **项目内延迟执行文件**(`permissions.py:417-425`)——即使前面都通过了,如果目标是 `.git/hooks/`、`.github/workflows/` 这类"现在写入、以后自动触发"的文件,依然要求人工批准。
7. **`BYPASS_APPROVALS` 全权放行**(`permissions.py:427-429`)——走到这里才轮到"全权模式"生效。
8. **各类允许列表**(`permissions.py:431-515`)——命令前缀白名单、会话授权、域名白名单、MCP 信任规则、任务级常驻规则、`custom` 模式的 `auto_allow`。
9. **兜底:请求人工批准**(`permissions.py:517-518`)。

把这九步的**顺序**画出来,能直接看到"硬性红线永远优先于模式判断"这句话是怎么落地的——第 1、4、6 步全部排在第 7 步(`BYPASS_APPROVALS` 全权模式)**之前**,这不是巧合,而是刻意的代码组织方式。`evaluate()` 里第 401 行那条注释把这个意图写得非常直白:

```python
# coworker/permissions.py:401-404(节选)
# Authority outliving the session reaches a person, over the reviewer and over
# every allowlist below (OPE-117). Placed ahead of the non-consequential return on
# purpose: these tools are consequential today, but a metadata slip must not be
# able to switch the floor off. Read-only modes still hard-deny above this.
```

"哪怕某个工具未来的风险元数据被误标成了低风险,这条红线也不会因此失效"——这是一种防御性的代码组织哲学:红线不依赖某个可能出错的中间判断结果,而是直接写死在决策链的前排。

### 自我保护红线的具体实现:`_touches_protected`

第一步的自我保护红线值得展开看,因为它同时覆盖了"写文件"和"shell 命令"两种不同的检测方式:

```python
# coworker/permissions.py:590-622(节选)
def _touches_protected(
    self, tool_name: str, arguments: dict[str, Any], is_shell: bool
) -> Optional[str]:
    """The protected settings path this call would modify, or None.

    For writes we resolve the real target. For shell we can only inspect the command
    text — parser depth, so it stops accidents and casual attempts, not a determined
    adversary (that needs the OS sandbox). Cheap and worth having regardless.
    ...
    """
    targets = [str(p) for p in protected_paths()]
    if is_shell:
        command = str(arguments.get("command", ""))
        if not command:
            return None
        lowered = command.replace("\\", "/").lower()
        for target in targets:
            if target.replace("\\", "/").lower() in lowered:
                return target
        return None
    paths, located = write_paths(tool_name, arguments)
    if not located:
        return None  # unlocatable writes are already failed closed by the caller
    resolved = {str(self._candidate(p)) for p in paths}
    for target in targets:
        if str(Path(target).resolve()) in resolved:
            return target
    return None
```

docstring 里"stops accidents and casual attempts, not a determined adversary (that needs the OS sandbox)"这句自我评估非常诚实:对 shell 命令的检测只是文本层面的字符串匹配,防不住一个真正处心积虑的对抗性输入(那需要操作系统级的沙箱),但对"合作模式下的误操作"——比如模型不小心在一条批量清理命令里带上了配置文件路径——完全够用。这条自我评估的措辞和 Hermes-Agent 系列 `SECURITY.md` 里"审批门是启发式、不是边界"的说法遥相呼应:OpenWorker 同样清楚地知道自己这道检测的能力边界在哪里,而不是把它包装成一个"绝对安全"的承诺。

### 风险覆盖(`RiskOverrides`)只能收紧,不能放松

`classify()` 里那句"A user override may *relax* a metadata tool... but may only ever **tighten** a built-in write/exec/egress tool"值得单独强调,因为它是"用户能自定义什么、不能自定义什么"这条边界的精确定义:

- 一个通过 aisuite 元数据接入的第三方插件工具,如果被默认标记得"过度谨慎"(比如一个纯读操作被标成 `requires_approval: True`),用户可以用覆盖规则把它降级——这是"quieting an over-cautious plug-in"的合法用途。
- 但一个**内置**的写/执行/出网工具,或者连接器目录工具、MCP 工具,覆盖规则**只能升级它的风险等级**,不能降级——`_STRICTNESS[ov] >= _STRICTNESS[base]` 这个比较式就是这条规则的全部实现:新等级的严格分数必须不低于原等级,否则覆盖被直接忽略,退回基础分类。

这条"只紧不松"的规则和 `_mcp_floor`"焊死在 EXTERNAL"是同一种设计意图的两种实现方式:前者是通用规则,后者是专门为最容易被滥用的 MCP 工具加的一道额外保险——即便"只紧不松"的比较逻辑本身出了 bug,MCP 工具的基础分类也不会低于 `EXTERNAL`。

## 常见问题/易踩坑

- **不要把"风险分类"和"是否需要审批"混为一谈**——`RiskClass.READ` 直接跳过整条决策链,但 `RiskClass.EXTERNAL`/`WRITE_LOCAL`/`EXEC`/`EGRESS` 都还要继续走后面模式、路径作用域、允许列表的判断,风险类别只是"是否需要关注"的第一道筛选,不是最终结论。
- **`allowed_commands` 前缀白名单的匹配对象是"解析后的参数列表",不是原始字符串**——`_command_allowed()` 用 `shlex.split` 解析命令、逐段比较前缀,`git status` 能覆盖 `git status -s`,但覆盖不了 `git statusfoo` 这种字符串层面"看起来像前缀"实则是另一个词的情况。这个细节在 `_is_prefix_eligible()`(`permissions.py:56-70`)以及 `_OPAQUE_CONSTRUCTS`(反引号、`$()`、`>`、`<` 等)、`_ARG_EXECUTORS`(`xargs`、`sudo`、`docker` 等"会执行参数里另一个程序"的命令)、`_DANGEROUS_FLAGS`(`find -exec`、`-delete` 等)几张表里体现得很完整——一条前缀规则只能担保它匹配到的那几个词,后面跟着的内容如果可能引入未经审查的执行路径,整条命令就不再是前缀可担保的。
- **写路径解析不出来时,行为是"失败关闭"而不是"跳过检查"**——`write_paths()` 返回的 `located=False` 会让整个调用直接进入需要人工批准且 `human_only=True` 的分支,这个设计是为了让"引入一个新的写工具但没有更新路径解析逻辑"这种疏漏,后果是多问一次人,而不是悄悄放过一次越界写入。

## 小结与下一篇

`risk.py` 回答"这个工具本质上有多危险",`permissions.py` 的 `evaluate()` 回答"当前这次调用该怎么处理"——两者分工清晰,但更重要的是 `evaluate()` 内部检查点的**顺序**:自我保护红线、只读模式拒绝、路径作用域、常驻授权红线、项目内延迟执行文件,这五道检查全部排在"全权模式"和"各类允许列表"之前,这正是 README"没有任何模式——包括全权自动批准——能降低这些红线"这句承诺在代码层面的真实实现。风险覆盖规则"只能收紧、不能放松",以及 MCP 工具被焊死在 `EXTERNAL` 等级,是同一种保守设计哲学在不同粒度上的体现。下一篇转向 `AUTO_APPROVE` 模式下真正承担"放行常规操作"职责的角色——`coworker/reviewer.py` 里的审查模型,它的输入输出契约是什么,以及"连续拒绝会触发熔断、把控制权交还给人类"这条规则的具体实现。
