# Skills 机制与内置技能包

> `coworker/skills/base.py` 的模块 docstring 只有两句话:"Anthropic SKILL.md format with progressive disclosure. ... Progressive disclosure: at session start only the catalog (name + description) is injected into the agent's context; the full body is loaded on demand via the `load_skill` tool." 这句话是不是真的,可以在代码里逐字核对——本篇会把 `SkillLoader`、`context_provider()` 里的 `skill_catalog_text()`、以及 `load_skill` 工具本身的实现摆在一起看,验证"目录常驻、正文按需"这个假设。更值得深挖的是 OpenWorker 特有的一层:一个 persona(比如内置的 Security Coworker)可以自带一批只属于它自己的技能——`coworker/personas/builtin/security/skills/` 下的 `secret-scan`、`security-fix-pr`、`semgrep-review` 就是三个真实存在、会被 `security` persona 的 manifest 通过 `skills:` 字段点名引用的技能包。

## 学习目标

- 读懂 `Skill` 数据类和 `SkillLoader` 的发现/解析逻辑——YAML frontmatter 里 `name`/`description`/`allowed-tools` 三个字段各自的作用,以及一个没有严格 frontmatter 的技能会怎样降级处理。
- 用代码验证渐进式加载:系统提示词/`context_provider()` 里到底注入了什么内容,`skill.instructions`(技能正文)要等到什么时候才真正进入模型的上下文。
- 理解 `SkillStore` 的作用域设计——global 与 project 两级"文件夹即真相"、Settings 级禁用与 session 级静音这两层独立的开关、以及 `effective_skills()` 的"任一关闭即关闭"合并规则。
- 理解 persona 如何携带自己专属的技能目录(OPE-58),以及 manifest 里的 `skills:` 字段如何把这批技能限定在对应的 persona 会话里——用 `security` persona 的三个真实技能文件验证整条链路。
- 认识 `save_skill` 这个反向通道:一个 worker 在对话中打磨出一份好用的技能后,可以把它提议存回用户的技能库。

## 背景与设计动机

把"领域知识"塞进固定的系统提示词,会随着知识点变多而线性膨胀上下文预算,而且大多数技能在大多数会话里根本用不上。OpenWorker 选择直接复用 Anthropic 公开的 `SKILL.md` 格式——YAML frontmatter(至少 `name`/`description`)加一段 markdown 正文——而不是自造一套技能描述语言。`coworker/skills/base.py` 里的 `SkillLoader` 实现了"发现 + 解析"这一半,`coworker/skills/store.py` 里的 `SkillStore` 实现了另一半——"增删改查 + 作用域 + 启用状态",两者的分工很清楚:`SkillLoader` 只关心"这个目录里有哪些技能、内容是什么",`SkillStore` 关心"这个技能该不该出现在这个用户/这个会话面前"。

OpenWorker 的技能来源比单纯的 global/project 两级更丰富一层:一个 persona bundle 自己的目录树里可以带一个 `skills/` 子目录,这批技能只在这个 persona 的会话里可见,由 manifest 的 `skills:` 字段做二次收窄。`security` persona 是目前仓库里能看到的最完整的例子——它的三个技能(`secret-scan`/`security-fix-pr`/`semgrep-review`)不是通用技能,而是这一个身份专属的工作流程。

## 核心机制详解

### `Skill` 与 `SkillLoader`:从 `SKILL.md` 到内存对象

```python
# coworker/skills/base.py
@dataclass
class Skill:
    name: str
    description: str
    instructions: str = ""  # full body — loaded on demand
    path: Optional[str] = None
    allowed_tools: list[str] = field(default_factory=list)
```

`instructions` 字段存的是整份 `SKILL.md` 的正文——注意它在加载阶段就已经被读进了内存(`SkillLoader._discover()` 对每个技能目录都会解析出完整的 `Skill` 对象)。这意味着"按需加载"不是指"正文延迟到磁盘 I/O 发生",而是指"正文延迟到进入模型的上下文窗口"——这个区别马上会在 `context_provider()` 里看到。`allowed_tools` 字段被解析(来自 frontmatter 的 `allowed-tools`/`allowed_tools` 键),但在目前的代码里,搜索整个仓库找不到任何地方真正读取并强制执行这个字段——它现在更像是一个已经预留、尚未接进权限系统的字段,和 `coworker/automation/models.py` 里那个名字很像但完全不同的 `always_allowed_tools`(调度任务的风险白名单)不要混为一谈。

解析逻辑写在 `_parse_skill`:

```python
# coworker/skills/base.py(节选)
def _parse_skill(md: Path) -> Skill:
    text = md.read_text(encoding="utf-8")
    name, description, allowed, body = md.parent.name, "", [], text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            frontmatter = text[3:end]
            body = text[end + 4 :].lstrip("\n")
            for line in frontmatter.splitlines():
                if ":" not in line:
                    continue
                key, value = line.split(":", 1)
                key, value = key.strip().lower(), value.strip()
                if key == "name" and value:
                    name = value
                elif key == "description":
                    description = value
                elif key in ("allowed-tools", "allowed_tools"):
                    allowed = [t.strip() for t in value.split(",") if t.strip()]
    return Skill(name=name, description=description, instructions=body.strip(), path=str(md.parent), allowed_tools=allowed)
```

这个解析器逐行拆 `key: value`,不依赖专门的 YAML 库——好处是一份没有严格 YAML 语法、只是"看起来像 frontmatter"的文件也能被容忍地解析;代价是遇到多行值(比如带冒号的自然语言描述)会比较脆弱。`name` 的默认值是 `md.parent.name`——也就是技能所在的目录名,即使 frontmatter 完全没写 `name:`,一个技能也总能有名字。

`SkillLoader` 的发现逻辑很直接:

```python
# coworker/skills/base.py(节选)
def _discover(self, directory: Path) -> None:
    if not directory.is_dir():
        return
    for sub in sorted(directory.iterdir()):
        md = sub / "SKILL.md"
        if md.is_file():
            skill = _parse_skill(md)
            self._skills[skill.name] = skill
```

传入的多个目录按顺序 `_discover`,后面的目录里同名技能会覆盖前面的——这是理解"persona 的 skills 目录放在 loader 目录列表哪个位置"这件事为什么重要的关键(下面会看到 `coworker/agent.py` 里的具体顺序)。`rescan()` 方法很关键:一个技能如果是在这个引擎构建*之后*才创建/安装的,第一次 `load_skill(name)` 会先尝试查缓存,查不到就整体 `rescan()` 再查一次——这保证了"新建技能立刻可用",不需要重启会话。

### 验证渐进式加载:目录进系统提示词,正文进工具结果

`base.py` 里另一半是 `skill_catalog_text()` 和 `skill_tools()`:

```python
# coworker/skills/base.py(节选)
def skill_catalog_text(loader: SkillLoader, allowed: Optional[set[str]] = None) -> str:
    catalog = [c for c in loader.catalog() if allowed is None or c["name"] in allowed]
    if not catalog:
        return ""
    lines = [f"- {c['name']}: {c['description']}" for c in catalog]
    return (
        "Available skills — call load_skill(name) to load one's full instructions when "
        "it's relevant to the task:\n" + "\n".join(lines)
    )
```

这个函数只拼了 `name` 和 `description` 两个字段,`Skill.instructions` 完全没有出现在这段文本里。这段文本在 `coworker/agent.py` 的 `context_provider()` 里每一轮对话都会重新生成一次并追加到最新一条用户消息后面:

```python
# coworker/agent.py(节选,context_provider 内)
skill_loader.rescan()
allowed = skill_filter() if callable(skill_filter) else skill_filter
skills_ctx = skill_catalog_text(skill_loader, allowed=allowed)
if skills_ctx:
    parts.append(skills_ctx)
```

`context_provider()` 不是系统提示词组装阶段的一次性调用,而是**每一轮**都会重新执行——这意味着技能菜单是"活的":一个技能在会话中途被安装、被 Settings 禁用、被会话静音,都会在下一条消息生效,不需要开新会话。真正把正文读出来的地方只有一处:

```python
# coworker/skills/base.py(节选)
def load_skill(name: str) -> dict:
    skill = loader.get(name)
    if skill is None:
        loader.rescan()
        skill = loader.get(name)
    gate = _allowed_now()
    if skill is None or (gate is not None and name not in gate):
        available = sorted(n for n in loader.names() if gate is None or n in gate)
        return {"error": f"unknown skill: {name}", "available": available}
    return {"name": skill.name, "instructions": skill.instructions, "resources_path": skill.path}
```

只有模型主动发起一次 `load_skill(name=...)` 调用,`skill.instructions`(整份 `SKILL.md` 正文)才会作为这次工具调用的结果进入消息历史,进而在下一轮请求里真正计入模型的上下文窗口。至此,"按需加载"这四个字在代码层面的落地路径完整对上了:**加载阶段(会话构建时)正文已经读进内存,但系统提示词/每轮上下文只拼接名字和一句话描述;正文真正的上下文成本要等模型主动调用 `load_skill` 那一刻才发生。**

这里还有一个不那么显眼但很讲究的细节——技能被"退订"之后的补救:

```python
# coworker/agent.py(节选,context_provider 内)
eng = _engine_box[0] if _engine_box else None
if eng is not None:
    available = set(skill_loader.names()) if allowed is None else set(allowed)
    for name in sorted(_loaded_skill_names(eng.messages) - available):
        parts.append(
            f'Note: the skill "{name}" has been disabled by the user — stop '
            "following its instructions from here on."
        )
```

一份技能的正文一旦通过 `load_skill` 进入过对话历史,就已经在持续影响模型的行为——即使之后这个技能被禁用或删除,历史里已经读过的指令是"读不撤回"的。所以每一轮都会重新计算"哪些技能曾经被成功加载过、但现在已经不在可用列表里",给模型一条显式的"停止遵循"提醒。`_loaded_skill_names()` 的实现是扫描消息历史里所有 `load_skill` 的 tool_call 及其结果,只有结果里带 `"instructions"` 字符串的才算真正加载成功。

### `SkillStore`:作用域、启用状态与上传流程

`store.py` 里的 `SkillStore` 是"文件夹即真相"的具体实现——global 技能住在 `state_dir()/skills`,project 技能住在 `<workspace>/.coworker/skills`,没有数据库,一切操作都是目录 + `SKILL.md` 操作。这个设计带来一个直接好处:project 技能可以随仓库一起被 git 提交,团队成员 clone 下来就能共享。

启用/禁用状态却刻意**不**存在技能目录内部:

```python
# coworker/skills/store.py(模块 docstring)
"""Disable state is deliberately NOT a marker inside the skill folder: project folders
travel with the repo and one user's disable must not be committed to teammates. It lives
in the personal ``state_dir()/skills-settings.json`` instead."""
```

如果禁用状态写进了 `SKILL.md` 或同目录的某个标记文件,一个用户在自己机器上把某个 project 技能关掉,这个"关闭"动作就会被下一次 `git commit` 意外带给所有队友——这是典型的"个人偏好 vs 共享内容"分离设计,和很多项目把 `.gitignore` 之外的个人配置放进独立的、不纳入版本控制的文件是同一个原则。

技能的启用状态实际上分两层,由 `effective_skills()` 合并:

```python
# coworker/skills/store.py
def effective_skills(*, names: set[str], disabled: set[str], session_overrides: dict[str, bool]) -> set[str]:
    """... any-off-wins. A Settings disable removes the skill everywhere — a session override
    can NOT resurrect it. Absent any opinion, a skill is on."""
    out: set[str] = set()
    for name in names:
        if name in disabled:
            continue
        if not session_overrides.get(name, True):
            continue
        out.add(name)
    return out
```

第一层是 Settings 里的全局禁用(`SkillStore.disabled_names()`,存在 `skills-settings.json`),第二层是单个会话里的临时静音(`SessionSkillStore`,`{session_id: {skill_name: bool}}`)。规则是"任一关闭即关闭"——一个被 Settings 全局禁用的技能,任何会话级的开关都无法把它救回来;而会话静音只影响这一个会话,不写回全局状态。这个双层结构对应两种截然不同的使用场景:用户在 Settings 里永久关掉一个不想要的技能,和用户在这一次具体对话里临时不想让某个技能掺和进来。

上传流程走"暂存 → 预览 → 确认"三段式:`stage_upload()` 接受一个 `.zip`(文件夹技能)或一份裸 `SKILL.md`,解析出预览信息(名字、描述、正文、附带文件列表)但**不**立即安装,只是落到 `state_dir()/skills-staged/<token>` 下;用户看过预览之后调用 `confirm_upload(token, scope=...)` 才真正移动进对应作用域目录。这个设计的好处是用户在真正把一个陌生的 `.zip` 技能包"激活"之前,总有一次确认自己看到的正是即将被安装的内容的机会——`stage_upload` 里还专门过滤了 macOS `Compress` 命令产生的 `__MACOSX/` 影子条目和 `.DS_Store`,这是又一个"来自真实使用场景"的细节。

### persona 携带的技能:以 `security` 为例

`coworker/personas/builtin/security/manifest.md` 的 frontmatter 里有这么一行:

```yaml
skills: [semgrep-review, secret-scan, security-fix-pr]
```

这三个名字对应的正是 `coworker/personas/builtin/security/skills/` 目录下三个真实存在的子目录,每个目录里各有一份 `SKILL.md`。以 `secret-scan/SKILL.md` 为例,它的 frontmatter 很简单:

```yaml
# coworker/personas/builtin/security/skills/secret-scan/SKILL.md
---
name: secret-scan
description: Hunt committed secrets with gitleaks and drive safe rotation
---
```

正文是一套五步流程:检查 `gitleaks` 是否存在(缺失就调用上一篇讲过的 `request_tool`,而不是悄悄跳过)、同时扫描工作区和 git 历史(因为"删掉的密钥仍然活在每一次 clone 里")、逐条 triage 真假、按"先轮换、再清理代码、再防复发"的顺序处理每一个真实密钥、最后交付一份命中列表。`security-fix-pr` 和 `semgrep-review` 走的是类似的结构——每一份 `SKILL.md` 都是一套具体、带编号步骤的操作规程,而不是泛泛的"你要注意安全"这种提示词式的话术。

这批 persona 专属技能是怎么进入一个会话的可用列表的?线索在 `coworker/server/manager.py` 的 `persona_skill_scope`:

```python
# coworker/server/manager.py(节选)
d = Path(manifest.source).parent / "skills"
if not d.is_dir():
    return None, None
allow = {s for s in manifest.skills if s} or None
return d, allow
```

`manifest.source` 是这个 persona manifest 文件本身的路径(比如 `.../security/manifest.md`),它的父目录再拼上 `skills` 就是 `.../security/skills/`——persona bundle 目录结构本身决定了技能从哪里找,manifest 里的 `skills:` 列表(`allow`)则是一层白名单过滤,即使这个目录下将来多出一份没被 manifest 点名的 `SKILL.md`,它也不会自动出现在这个 persona 的会话里。`effective_skill_names()` 把这批 persona 技能和 global/project 技能合并进同一个候选集合,再交给同一个 `effective_skills()` 做 Settings 禁用与会话静音的过滤:

```python
# coworker/server/manager.py(节选)
loader = SkillLoader(dirs)  # global_dir + project_dir
names = set(loader.names())
persona_dir, allow = self.persona_skill_scope(self._persona_of(session_id, agent))
if persona_dir is not None:
    persona_names = set(SkillLoader([persona_dir]).names())
    if allow is not None:
        persona_names &= allow
    names |= persona_names
return effective_skills(names=names, disabled=self.skill_store.disabled_names(), session_overrides=...)
```

而在真正构建引擎、注册 `load_skill` 工具的 `coworker/agent.py` 里,persona 的技能目录是通过 `extra_skill_dirs` 参数传进 `SkillLoader` 的构造函数,并且刻意放在列表*最前面*:

```python
# coworker/agent.py(节选)
# Persona dirs come FIRST so a user's global/workspace copy of the same name shadows
# the bundle's (later dirs overwrite earlier in the loader).
skill_loader = SkillLoader([Path(d) for d in (extra_skill_dirs or [])] + _skill_dirs(ws))
```

结合前面 `_discover()` "后注册覆盖先注册"的规则,这意味着:如果用户自己在 global 或 project 作用域里创建了一个和 persona 内置技能同名的技能,用户自己的版本会覆盖 persona bundle 自带的版本——这是一种"用户的定制永远比预置内容优先级更高"的就近覆盖语义,和很多配置系统的层叠规则是同一个思路。

### `save_skill`:worker 自己写技能的反向通道

到目前为止讲的都是"技能怎么被读取和使用",`store.py` 末尾的 `save_skill_tool()` 是反方向的通道——一个 worker 在对话里帮用户打磨出一份有用的操作流程后,可以提议把它存成正式技能:

```python
# coworker/skills/store.py(节选,schema 的 description)
"description": (
    "Propose adding a finished skill to the user's skills. The user reviews the "
    "name, description, full instructions, and any bundled files on an approval "
    "card before anything is saved; once they approve, the skill is usable in "
    "every conversation."
),
```

这个工具的 `requires_approval=True`——每一次调用都会走标准审批卡片,而卡片展示的正是这次调用的**参数本身**(名字、描述、完整指令正文、要打包的文件列表),这是"审批卡片即评审界面"这个设计模式的又一个例子(上一篇讲 `run_shell` 的 `description` 参数时也见过类似思路)。工具实现里有一处专门的自愈处理:

```python
# coworker/skills/store.py(节选)
if base.lower() == "skill.md":
    # The instructions argument BECOMES SKILL.md; models routinely draft one in
    # the workspace and bundle it. Skip silently — erroring here cost the user a
    # second approval round for a self-healing retry (live drive 2026-07-27).
    continue
```

模型经常会先在工作区里手写一份 `SKILL.md` 草稿,再把它当作"要打包的文件"传给 `save_skill`——但 `instructions` 参数本身就会变成最终的 `SKILL.md`,重复打包一份没有意义。早期实现会对此报错,逼用户走一次"失败 → 模型自愈重试 → 再审批一次"的额外回合;现在的实现选择静默跳过这份重复文件,注释里连具体日期(2026-07-27)都记录了下来——这是从真实使用中反推出的一处体验修正。另外,被打包的文件只能来自这个会话已有的目录(`allowed_dirs`,即 session roots),防止 worker 把机器上任意路径的文件塞进一份会被"每次对话都能用"的技能里。工具本身写死了"worker authored 的技能永远落在 GLOBAL 作用域"——不会是一次性的、随手可能被清理掉的位置。

## 常见问题/易踩坑

**Q:一份没有严格 YAML frontmatter、甚至完全没有 `---` 头的 `SKILL.md` 能正常工作吗?**

能。`_parse_skill()` 在完全没有 frontmatter 时,`name` 直接退化成技能所在目录的名字,`description` 保持为空字符串。这意味着这样一份技能仍然会被加载、出现在目录里,只是它在系统提示词里的那一行会变成"名字:(空描述)"——模型很难判断什么时候该用它。实践中几乎所有真实技能(包括本篇引用的三个 security 技能)都写了完整的 frontmatter,这不是强制要求,而是"写了才好用"的经验结论。

**Q:persona 的 `skills:` 字段和技能目录本身是什么关系,可以只声明目录里的一部分技能吗?**

可以,而且这正是它存在的意义。`persona_skill_scope()` 先定位到 persona bundle 的 `skills/` 目录(拿到这个目录下*所有*技能),再用 manifest 的 `skills:` 列表做一次交集过滤(`persona_names &= allow`)。如果 bundle 目录下有一份技能文件没有被 manifest 点名,它会被这个交集过滤掉,不会出现在任何会话里——manifest 的 `skills:` 字段既是"这个 persona 用到哪些技能"的声明,也是一份隐式的黑名单机制。

## 小结

Skills 机制把"操作规程"从固定的系统提示词里剥离出来,变成一份份独立的 `SKILL.md` 文件——加载时全部读入内存,但系统提示词(经由每轮重算的 `context_provider()`)只拼接名字和一句话描述,正文要等模型主动调用 `load_skill` 才真正进入对话上下文,这个假设在 `skill_catalog_text()`(只拼 `description`)和 `load_skill()`(唯一返回 `skill.instructions` 的地方)两处代码里都得到了验证。技能的作用域比单纯的 global/project 两级更丰富——persona 可以携带自己专属的技能目录,由 manifest 的 `skills:` 字段做二次收窄,`security` persona 的三个真实技能验证了这条从 bundle 目录到会话可用列表的完整链路。禁用状态被刻意从技能文件本身剥离,分成 Settings 全局禁用与会话级静音两层独立开关,`effective_skills()` 用"任一关闭即关闭"的规则合并它们。技能只是一个 persona 能携带的内容类型之一,和它并列的还有一整套"这个会话到底能调用哪些工具"的决策——下一篇转向 MCP,看 OpenWorker 作为 MCP client 是怎么发现、连接外部服务器,并把它暴露的每一个工具都变成本地工具调用循环里可以被单独授权的一等公民的。
