# Persona 清单与专家 Coworker 设计

> README 里那句"Specialist coworkers arrive with the tools, working style, and check-ins for one job already set up"不是营销口号,而是精确对应到 `coworker/personas/manifest.py` 里的一个 `PersonaManifest` dataclass。OpenWorker 没有把"专家角色"做成一个需要写 Python 代码才能扩展的插件系统,而是把它压缩成一份 YAML frontmatter + Markdown 正文——前者声明这个角色能做什么、以什么权限做、多久汇报一次,后者就是喂给模型的系统提示词本身。`personas/registry.py` 把内置的 14 个专家目录、旧的硬编码 Agent(Code/Cowork)、以及第三方安装的 persona 统一成一张表;`agents/` 目录里那几个看似不同的"模式"——Chat、Code、Cowork、MyHelper——其实回答的是另一个问题:在 persona 体系接管"专家角色"之前,coworker 本来就有的几种通用工作模式该怎么摆放。本篇把这两层——persona 的清单结构、agents 的模式定位——一次讲清楚。

## 学习目标

- 理解 `PersonaManifest` 的字段构成:一个 persona 由身份信息(id/name/icon)、能力声明(tools/connectors/mcp/skills)、行为特征(requires_folder/subagents/scheduling/messaging/team)、系统提示词(Markdown 正文)四类内容拼成,以及 `to_agent()` 如何把它"物化"成运行时的 `Agent`。
- 理解 `team: lead | worker | None` 这个字段如何把 persona 分成"solo(独立干活)"、"lead(协调团队,不亲自动手)"、"worker(在 lead 麾下干活)"三种角色定位,并通过对比 `security`(solo)、`swe-lead`/`devsecops-lead`/`triage-lead`(lead)、`swe-worker`(worker)四份真实 manifest 体会这种设计如何在系统提示词层面落地。
- 弄清 `agents/base.py`、`agents/chat.py`、`agents/code.py`、`agents/cowork.py`、`agents/myhelper.py` 五个文件各自的真实定位,以及它们和 persona 体系是"底层材料"还是"平行系统"的关系——不要被目录名称误导,`agents/chat.py` 目前是一段保留给测试用的死代码,不是一个活跃的用户可选角色。
- 理解 `loading.py` 里第三方 persona 的"consent(同意)"模型:安装一个第三方 persona 为什么不需要审查代码,只需要审查一份能力摘要。

## 背景与设计动机

在 OpenWorker 出现"专家 coworker"这个产品概念之前,系统里只有几个通用的 Agent:`Chat`(纯对话)、`Code`(代码工作台)、`Cowork`(通用知识工作台)。这几个 Agent 的系统提示词、工具集、是否需要工作区都是硬编码在各自的 Python 模块里的——想要一个"安全专家"或"DevOps 专家",唯一的办法是复制一份 `code.py`,改提示词,改工具列表,再让它出现在硬编码的 Agent 列表里。这条路径对内部维护者可行,但完全不可能开放给第三方——没有人会为了定义一个新角色去改 OpenWorker 的源码并重新编译发布。

`personas/manifest.py` 的解法是把"定义一个专家"这件事从"写代码"降级为"写一份声明式文档"。文档的形状刻意模仿了 Anthropic 的 SKILL.md 格式(frontmatter + markdown body),模块开头的 docstring 直接写道:`persona ⊇ skill`——персона 是 skill 的超集,同样的两段式结构,只是字段更结构化。这个选择有两个直接后果:第一,一个 persona 天然可以被当作文件系统里的一个目录来分发、安装、卸载、导出成 zip,不需要任何构建步骤;第二,第三方 persona 不携带可执行代码,只引用"目录(catalog)里已经审查过的能力",于是安装一个 persona 的信任评估退化成"读一份能力摘要",而不是"审计一段脚本"——`loading.py` 的 docstring 把这一点说得很直白:"installing one is a light trust event"。

`team` 字段是这套体系里最新、也最有意思的一层设计。它源自"agent-teams"这个更大的设计方向:一个专家不再只能单打独斗,还可以是一个协调者(lead),指挥一批工作者(worker)在一块共享看板上干活。但 `team` 字段本身只是给 persona 打了个身份标签——真正的协作机制(看板、指派、日志)在 `teams/` 目录里,留给下一篇讲。本篇的重点是:这个标签如何反过来影响一个 persona 的系统提示词该怎么写、该声明哪些工具。

## 核心机制详解

### `PersonaManifest`:一份专家清单的四类字段

`manifest.py` 里的 `PersonaManifest` dataclass 把一个 persona 拆成四类信息:

```python
# coworker/personas/manifest.py:49-98(节选)
@dataclass
class PersonaManifest:
    id: str
    name: str
    system_prompt: str
    icon: str = ""
    tagline: str = ""
    description: str = ""
    tools: list[str] = field(default_factory=list)
    requires_folder: bool = False
    subagents: bool = False
    scheduling: bool = True
    messaging: bool = False
    connectors: bool | tuple[str, ...] = False
    team: Optional[str] = None
    default_permission_mode: str = "interactive"
    recommended_models: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    mcp: list[str] = field(default_factory=list)
    version: str = ""
    recommends: list[Recommendation] = field(default_factory=list)
    ships: bool = True
    group: str = "general"
    builtin: bool = False
    source: Optional[str] = None
```

- **身份信息**:`id`/`name`/`icon`/`tagline`/`description` 是给人看的——picker 列表里显示什么名字、什么图标、一句话说明。`id` 会成为持久化目录名和注册表的 key,所以要经过 `_ID_RE` 校验(小写字母数字加 `-`/`_`,最长 64 位),显式 `id:` 写错格式直接报错,靠文件名推导的 id 则被 `_slugify()` 静默规整。
- **能力声明**:`tools` 是一组"目录(catalog)能力名",`_validate_tools()` 会在解析时对照 `catalog.CATALOG` 校验,未知能力直接抛 `ManifestError`——一个 persona 不能声明一个系统里根本不存在的工具。`connectors`、`mcp`、`skills` 是另外三类外部能力引用,第 06 章已经讲过 skill 的加载机制,这里的 `skills: [...]` 字段就是一个 persona 绑定哪些 skill 供模型按需 `load_skill`。
- **行为特征**:`requires_folder`/`subagents`/`scheduling`/`messaging`/`team` 决定这个 persona 运行时具备哪些"平台能力"——是否要求用户先选一个工作目录、是否能用 `explore` 子代理、是否能被定时唤醒、是否能收发消息、以及团队身份。这几个字段最终会被塞进 `Agent` dataclass(见下一节)。
- **系统提示词**:frontmatter 之后的 Markdown 正文,`parse_manifest()` 里直接 `body.strip()` 塞进 `system_prompt`,空正文会报错——"persona 有清单没提示词"在这里是不允许的。

`to_agent()` 是这份清单"物化"成运行时对象的地方:

```python
# coworker/personas/manifest.py:100-118
def to_agent(self):
    """Materialize the runtime Agent (prompt + catalog-expanded tools + traits)."""
    from ..agents.base import Agent
    from ..catalog import expand

    tool_ids = list(self.tools)
    factory = (lambda ctx: expand(tool_ids, ctx)) if tool_ids else None
    return Agent(
        name=self.id,
        title=self.name,
        system_prompt=self.system_prompt,
        tool_factory=factory,
        requires_folder=self.requires_folder,
        subagents=self.subagents,
        scheduling=self.scheduling,
        messaging=self.messaging,
        connectors=self.connectors,
        team=self.team,
    )
```

`tools` 字段里的能力名字符串,通过 `catalog.expand()` 在会话真正建立时才展开成具体的工具对象列表——manifest 阶段只做声明和校验,不持有任何工具实例。这也是为什么 persona 的定义可以是纯数据(YAML+Markdown):没有一行代码需要在解析阶段执行。

### 一份真实 manifest 长什么样:`security` persona

`personas/builtin/security/manifest.md` 是这套体系里最完整的独立(solo)专家范例:

```yaml
---
group: security
id: security
name: Security Coworker
icon: shield
tagline: Find and fix security issues — scan, triage, PR
requires_folder: true
subagents: true
version: "1"
tools: [code_files, git, search, shell, todo]
connectors: [github]
skills: [semgrep-review, secret-scan, security-fix-pr]
recommended_models: [anthropic:claude-opus-4-8, openai:gpt-5.6-sol]
default_permission_mode: interactive
description: A code-security reviewer for teams without a security team. ...
recommends:
  - connector: github
    reason: open focused fix PRs and reference the findings they close
    tier: core
---
```

这份 frontmatter 里没有出现 `team:` 字段——`security` 是一个 solo persona,自己扫描、自己触发 `code_files`/`git`/`shell` 工具、自己开 PR,不参与"lead 指挥 worker"的协作模式。它的 `connectors: [github]` 是一个显式声明的允许列表(而不是 `connectors: true` 那种"授予全部已连接的 connector"),配合下方 `recommends` 里的 `connector: github` 条目——`loading.py` 里的 `_connectors()` 会强制校验:任何出现在 `recommends` 里的 connector 引用,必须同时出现在 `connectors` 的授权列表里,否则解析直接报 `ManifestError`。这是一条"作者意图必须自洽"的校验:一个 persona 不能一边推荐用户连接某个 connector,一边又没有为自己申请使用它的权限。

系统提示词正文里能看到 `requires_folder`/`subagents` 这两个行为特征如何转译成具体的工作纪律——"ALWAYS begin tool-using tasks with todo_write"、"NEVER inline multi-line scripts in shell commands"、"Secrets are radioactive: never print a discovered secret's value"——这些不是平台强制的约束,而是写进提示词里、靠模型自觉遵守的行为准则。这也说明了 persona 体系的一个基本设计立场:能力边界(能不能调用某个工具)由 manifest 的结构化字段严格控制,但工作方式(怎么用好这些工具)完全交给 Markdown 正文里的自然语言指导。

### `team` 字段:lead 与 worker 的提示词分野

对比 `swe-lead` 和 `swe-worker` 两份 manifest,能直接看到 `team: lead` 和 `team: worker` 在系统提示词层面被写成了两种完全不同的世界观。`swe-lead` 的 frontmatter 里只声明了 `tools: [code_files, search, todo]`——没有 `git`,没有 `shell`,正文里也明确点破原因:

```markdown
<!-- coworker/personas/builtin/swe-lead/manifest.md:16-19(节选) -->
You are the SWE Lead — a tech lead who runs a team of worker coworkers against a work
board. Your job is coordination and judgment: decompose, staff, assign, verify. You do
NOT implement — you carry no shell or git on purpose. The board is the shared ground
truth; your context window is disposable, the board is not.
```

"carry no shell or git on purpose"——lead 类 persona 被有意剥夺了动手能力,不是能力目录里没有 `shell`/`git` 这两个工具,而是 manifest 作者主动不声明它们。这是一种用工具清单实现的角色约束:一个 lead 想直接改代码也做不到,因为它压根没有对应的工具可调。`swe-lead` 正文接下来描述的六步工作法——UNDERSTAND → PLAN → STAFF → ASSIGN → VERIFY → TRIAGE——全部通过下一篇要讲的 `propose_work_items`/`propose_team`/看板工具完成,自己不写一行代码。

`swe-worker` 则反过来,`tools: [code_files, git, search, shell, todo]` 一应俱全,但正文第一句话就划清了汇报对象:

```markdown
<!-- coworker/personas/builtin/swe-worker/manifest.md:16-17 -->
You are a software engineer working ON A TEAM under a lead coworker. Your interlocutor
is the LEAD, not the end user — you never use ask_user; questions become item comments
```

"你的对话对象是 lead,不是最终用户"——这句话直接决定了 worker persona 完全不使用 `ask_user` 这类面向人类用户的工具,遇到问题改成在看板 item 上留评论。`devsecops-lead`(安全领域的 lead)和 `triage-lead`(收件箱/告警分诊的 lead)延续了同一套"只协调不动手"的模式,只是协调的对象换成了扫描类 worker(appsec/secrets/posture)或者观察类的 channel。三份 lead manifest 都反复出现同一句纪律:"NEVER end a turn with work in flight and no check-in timer set"——配合 `sleep_for` 工具做周期性自唤醒,这是团队协作机制对"lead 会不会忘记跟进"这个问题给出的提示词层面的答案(工具本身在下一篇细讲)。

需要指出一个容易被忽略的校验:`team` 的取值只有 `{"lead", "worker"}` 两种(`VALID_TEAM`),`team: None`(不声明)代表"solo-only"。`registry.py` 里 `_register_manifest()` 有一条专门的规则——

```python
# coworker/personas/registry.py:208-212(节选)
# Team workers never surface in the picker: they are purpose-built to be
# STAFFED by a lead, not started solo (their prompts talk to a lead, not
# a human). They stay enabled so the staffing gate can resolve them.
default_surfaced=m.team != "worker",
```

`team: worker` 的 persona 永远不会出现在"新建会话"的选择器里——它们只能被一个 lead 通过 `propose_team` 拉起,自己无法作为一个独立会话被用户直接选中启动。这与 `swe-worker` 正文里"你的对话对象是 lead"是同一个设计决定的两个层面的体现:提示词层面不认用户,平台层面也不给用户直接启动的入口。

### `agents/` 目录:persona 体系之外的几种通用模式

`agents/base.py` 定义的 `Agent` dataclass 是运行时的最终形态——不管来自硬编码的 Python 构建函数,还是来自 `PersonaManifest.to_agent()`,最终都收敛成同一个类型:

```python
# coworker/agents/base.py:28-53(节选)
@dataclass
class Agent:
    name: str
    title: str
    system_prompt: str
    tool_factory: Optional[Callable[[AgentContext], list]] = None
    requires_folder: bool = False
    subagents: bool = False
    scheduling: bool = False
    messaging: bool = False
    connectors: bool | tuple[str, ...] = False
    team: Optional[str] = None

    def build_tools(self, context: AgentContext) -> list:
        return list(self.tool_factory(context)) if self.tool_factory else []
```

`agents/code.py`(`code_agent()`)和 `agents/cowork.py`(`cowork_agent()`)是两个"核心 surface"——`personas/registry.py` 的 `_load_builtin()` 用 `_register_builder()` 直接把它们的构建函数注册进 persona 注册表,注释写得很清楚:"Core surfaces keep their exact prompts via the existing builders"。也就是说,Code 和 Cowork 并不是通过 manifest 的 YAML+Markdown 定义的,而是继续用手写的 Python 常量(`CODE_INSTRUCTIONS`、`COWORK_INSTRUCTIONS`)——它们比 persona 体系出现得更早,迁移过来的方式是"保留原有实现,只是把入口接进同一张注册表",而不是"重写成 manifest"。二者的定位也不同:Code 是 `requires_folder=True` 的代码工作台(围绕 git 展开),Cowork 是不强制绑定 git、面向"产出一份交付物"的通用知识工作台(`scheduling=True, messaging=True, connectors=True`——它是唯一默认拿到"全部已连接 connector"授权的内置 persona)。

`agents/myhelper.py` 不要被名字误导成什么特殊的"个人管家"专属机制——读代码就会发现它复用的是 `cowork_tool_factory`,也就是和 Cowork 完全相同的工具集(`files`/`search`/`shell`/`todo`),区别只在系统提示词的人设("always-on personal helper"、可通过 Telegram/Slack 触达)和默认名字可由用户自定义。模块 docstring 直接说明了它现在的地位:"the legacy always-on super-agent surface has been retired in favour of durable sessions + DM routing"——`myhelper` 作为一个持久化的常驻角色概念已经被"持久会话 + 消息路由"取代,保留这个 persona 只是因为可能还有历史会话引用它,`agents/registry.py` 的 `get_agent()` 对 `"myhelper"` 这个 name 做了特殊直连,不经过 persona 注册表。

`agents/chat.py` 则是一段更彻底的"考古样本"。`chat_agent()` 定义完整、可以正常构建出一个无工作区、无工具的 `Agent`,但 `personas/registry.py` 的注释直接写明:"Chat is GONE (owner call 2026-08-21; retired-but-listed since 2026-08-11) — stray `persona=chat` session ids resolve to the default via `agent()`'s unknown-id fallback"。也就是说 `chat` 已经从 persona 注册表里彻底移除,不再是一个可以被选中的角色;`chat_agent()` 这个构建函数之所以还活着,纯粹是因为测试代码(`tests/test_skills.py` 等)还在直接调用它验证"无工作区 Agent"这一形状。读源码而不是读目录名的必要性在这里体现得很直接:如果只看 `agents/` 目录列出的四个文件名,很容易误以为 Chat 是四种并列的可选模式之一,但它实际上是唯一一个已经退场、仅供测试引用的历史遗留。

### 第三方 persona 的信任模型:consent 而非代码审查

`personas/loading.py` 里的 `consent_summary()` 和 `capability_set()` 是"安装一个 persona"这件事的核心逻辑:

```python
# coworker/personas/loading.py:19-48(节选)
def consent_summary(m: PersonaManifest) -> dict:
    """What a persona will be able to do — shown at install for the user to approve."""
    from ..catalog import risk_summary
    return {
        "id": m.id, "name": m.name, "description": m.description,
        "tools": list(m.tools),
        "risk": sorted(rc.value for rc in risk_summary(m.tools)),
        "connectors": "all" if m.connectors is True else list(m.connectors or ()),
        "mcp": list(m.mcp),
        "messaging": m.messaging,
        "team": m.team,
        ...
    }
```

因为一个 persona 不携带可执行代码,只引用目录里已经审查过的能力(工具、connector、mcp、skill),用户面对的信任决策被简化成一屏"能力摘要":这个专家能碰哪些工具、风险等级如何、能不能连接哪些外部服务、是不是一个能指挥团队的 lead。`capability_set()` 则服务于持续安装场景——同一个 persona 的新版本如果**扩大**了能力面(比如从声明式允许列表里新增了一个 connector,或者从 solo 变成了 `team: lead`),`install_from_dir()` 会强制重新走一遍用户同意流程,而不是静默沿用旧版本的启用状态:

```python
# coworker/personas/registry.py:417-423(节选)
if replaces is None or replaces.get("capabilities_grew"):
    self._enabled[m.id] = False
    self._surfaced[m.id] = False
```

这与 `security` manifest 里 `connectors` 必须显式列出、`connectors: all` 被 `_connectors()` 硬性限制为"仅内置通用 persona 可用"(`builtin` 参数校验)是同一条设计主线:coworker 宁可让第三方 persona 的能力声明啰嗦一点,也不允许一份"我能连接一切"的模糊授权蒙混过关。

## 小结

一个 OpenWorker 专家 coworker,本质上是一份声明式清单加一段系统提示词:`manifest.py` 定义了这份清单必须包含哪些字段、每个字段如何被校验,`loading.py` 把"安装一个 persona"这件事变成一次基于能力摘要的用户同意,`registry.py` 把内置的手写 Agent(Code/Cowork)和 markdown-backed 的 persona(security、swe-lead、swe-worker……)统一收进一张表,靠 `to_agent()` 把清单物化成运行时对象。`team` 字段是这套体系里连接"单机专家"和"多智能体协作"的桥梁——它决定了一个 persona 是自己动手(solo)、只协调不动手(lead),还是在 lead 麾下按看板条目干活(worker),但字段本身只是一个身份标签;真正撑起协作的看板(Board)、日志(Journal)、指派与认领机制,以及 `dialect.py` 这层"board 到底在哪儿"的抽象,留给下一篇从 `teams/` 目录逐层展开。
