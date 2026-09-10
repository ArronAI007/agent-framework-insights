# Connector 契约与 Gateway 架构

> `coworker/connectors/` 是 OpenWorker 体量最大的子系统：28 个文件、约 1.35 万行代码。但打开它会发现一件容易让人困惑的事——这个目录其实同时装着两套关系不大的东西。一套是"消息平台"：Slack、Telegram、GitHub 的 @提及能收发消息、能建立长连接、需要一个 Gateway 来路由；另一套是"SaaS 工具集成"：Jira、Notion、HubSpot、monday.com 这些服务没有"连接"这个动作本身的生命周期，它们就是一组包了 HTTP 调用的函数，模型要用的时候调一下、要凭证的时候读一下 SecretStore。README 里"25+ integrations"说的主要是后一套，但代码库把两者放进同一个目录、同一套 `ConnectorDescriptor` 元数据模型里管理。这篇文章先把地基铺清楚：`base.py` 定义的契约是什么、`gateway.py` 到底路由谁、`descriptors.py`/`accounts.py`/`config.py` 三层数据各自负责什么边界。

## 学习目标

- 理解 `BasePlatformAdapter`（`base.py`）定义的最小契约——`connect`/`disconnect`/`send` 三个抽象方法——以及它和 `MessageEvent`/`SessionSource`/target token 这几个值类型的关系。
- 弄清楚 `Gateway`（`gateway.py`）实际只服务"消息平台"这一类连接器（`config.py` 里 `PLATFORMS = ("telegram", "slack", "github")`），而 25+ 个 SaaS 集成完全不经过它——这是理解整个目录为什么要拆成两条腿的关键。
- 理解 `descriptors.py` 的 `ConnectorDescriptor` 如何把"接入一个新连接器"变成主要是数据声明而不是 UI 代码：认证方式、字段、校验函数、是否托管 OAuth、是否 MCP 托管。
- 理解 `accounts.py` 这一层通用多账号抽象是怎么从四个各自为政的"手搓"模块（Slack/Gmail/Calendar/HubSpot）里总结出来的，以及它和这四个先驱模块并存的现状。
- 理解 `config.py` 的默认拒绝（default-deny）授权模型，以及它和第 04 章治理系统里"审批"这件事是两回事。

## 背景与设计动机

OpenWorker 的定位是"桌面上的 AI 同事"：它要能在 Slack 里被 @提及后接话，要能在 GitHub PR 下面回复评论，也要能读你的 Jira、写你的 HubSpot 笔记、订阅你的 Gmail。这些能力在协议形态上几乎没有共同点——Slack 走 Socket Mode 长连接，GitHub 走一次性 REST 调用加 App 安装的 webhook 中继，Jira 走同步的 API Token 请求/响应。如果每接入一个新服务都要重新设计"怎么存凭证""怎么给用户看设置向导""怎么决定这个操作要不要弹审批"，28 个文件很快会变成 28 种不同的写法。

`connectors/` 目录的解法是分层：最底下是两三个真正需要"建立连接、持续监听"的消息平台，它们共享 `BasePlatformAdapter` 契约和一个 `Gateway` 路由器；往上是四十个左右的 SaaS 集成，它们共享 `ConnectorDescriptor` 描述的设置向导数据模型和几套凭证解析辅助函数，但本质上只是"函数 + 一份存在 SecretStore 里的 token"。两条腿粗细悬殊，但都要接入同一套设置 UI、同一套审批与账号管理机制，这就是为什么 `descriptors.py`、`accounts.py`、`config.py` 这几个"元数据"文件会显得比任何单个连接器实现都更重的原因。

## 核心机制详解

### BasePlatformAdapter：三个抽象方法 + 一套值类型

`coworker/connectors/base.py` 的模块级 docstring 说得很直白："借鉴自 Hermes 的 gateway（只读参考）"——这与本系列此前分析过的 OpenHarness `BaseChannel` 是同一血统的设计。契约同样极简：

```python
# coworker/connectors/base.py:141-185
class BasePlatformAdapter(ABC):
    """One messaging platform. Subclasses implement connect/disconnect/send and call
    `handle_message` for inbound events."""

    platform: str = "base"

    def __init__(self) -> None:
        self._handler: Optional[MessageHandler] = None
        self._interaction_handler: Optional[InteractionHandler] = None

    def set_message_handler(self, handler: MessageHandler) -> None:
        self._handler = handler

    async def send_interactive(
        self, chat_id: str, text: str, buttons, *, thread_id: Optional[str] = None
    ) -> SendResult:
        """Send a prompt with choice buttons. Default: plain text (adapters without interactive
        support just show the text — the user answers in the app)."""
        return await self.send(chat_id, text, thread_id=thread_id)

    @abstractmethod
    async def connect(self) -> bool:
        """Connect + start the inbound listener. True on success."""

    @abstractmethod
    async def disconnect(self) -> None:
        """Stop the listener and close connections."""

    @abstractmethod
    async def send(
        self, chat_id: str, text: str, *, thread_id: Optional[str] = None
    ) -> SendResult:
        """Send an outbound message."""

    async def handle_message(self, event: MessageEvent) -> None:
        if self._handler is not None:
            await self._handler(event)
```

`connect`/`disconnect`/`send` 是唯一必须实现的三件事，`send_interactive` 有一个默认降级实现——不支持按钮交互的平台就退化成纯文本，"用户在 App 里回答"。这比 OpenHarness 的 `BaseChannel` 多了一个概念：`InteractionEvent`/`InteractionHandler`，专门服务于"审批按钮被点击"这类交互（第 04 章治理系统里的 Approve/Deny 按钮，就是靠这条通道回传的）。

真正把不同协议的消息拉平的，是 `base.py` 里的一组 dataclass。核心是 `SessionSource`——发送者身份 + 会话定位：

```python
# coworker/connectors/base.py:41-61
@dataclass
class SessionSource:
    platform: str
    chat_id: str
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    chat_name: Optional[str] = None  # channel/DM display name (resolved, §2.3)
    chat_type: str = "dm"  # "dm" | "group" | "channel"
    thread_id: Optional[str] = None
    team_id: Optional[str] = None  # workspace id for managed-relay multi-workspace

    @property
    def target(self) -> str:
        return format_target(self.platform, self.chat_id, self.thread_id)
```

`target` 属性把 `platform:chat_id[:thread]` 这个"回复地址"编码成一个字符串（`format_target`/`parse_target` 两个纯函数负责编解码），这个字符串会被塞进 `MessageEvent.tagged_text()` 里，随对话历史一起交给模型：

```python
# coworker/connectors/base.py:99-107
def tagged_text(self) -> str:
    """How the message enters the super-agent thread: source + reply handle + text.

    The local GUI owner ('gui') is answered with plain assistant text (no `send_message`);
    messaging platforms carry a reply handle the agent passes back to `send_message`.
    """
    if self.source.platform == "gui":
        return f"[Owner, in the app]: {self.text}"
    return f"[{self.source.label()} | reply→{self.source.target}]: {self.text}"
```

模型看到的不是"Slack 的某个 JSON 事件"，而是一句人类可读的前缀加原文，外加一个不透明的回复地址。它要回消息时只需要把这个地址原样传给 `send_message` 工具（下一篇会细讲这个工具），完全不需要知道这条地址背后对应的是 Socket Mode 连接还是云端 relay。这也是为什么 Slack 的多工作区寻址（`team_id/channel_id` 这种"团队限定"编码，第 02、04 篇会展开）能够在不改 `MessageEvent` 结构的前提下塞进同一个 `chat_id` 字段——它对模型永远只是一段不透明字符串。

### Gateway：只路由"消息平台"，不是所有连接器的入口

这是理解整个目录分层最关键的一点。`gateway.py` 顶部写得很清楚：

```python
# coworker/connectors/gateway.py:1-7
"""Gateway — owns the messaging adapters and routes inbound messages.

Lives inside the always-on `openworker-server` (started/stopped in its lifespan). On inbound:
enforce the per-platform allowlist, then hand the message to the registered handler (the
super-agent runner, wired in the next increment). Outbound replies go through the
`send_message` tool, not the gateway — so the gateway stays a thin inbound router here.
"""
```

`Gateway` 只认识注册进来的 `BasePlatformAdapter` 实例，而 `config.py` 里定义的平台清单只有三个：

```python
# coworker/connectors/config.py:17
PLATFORMS = ("telegram", "slack", "github")
```

也就是说，Jira、Notion、HubSpot、monday.com……这四十来个 SaaS 集成从来不会出现在 `Gateway._adapters` 里，它们没有"入站消息"这个概念，自然也不需要允许列表、不需要 `connect()`/`disconnect()` 生命周期。`Gateway` 的职责被压缩得很纯粹：

```python
# coworker/connectors/gateway.py:122-143（节选）
async def _on_inbound(self, event: MessageEvent) -> None:
    self._record_recent(event)  # capture identity even from unauthorized senders
    settings = self.settings.get(event.source.platform)
    if settings is None or not is_authorized(settings, event.source):
        logger.info("parking unauthorized inbound from %s", event.source.label())
        if self._on_unauthorized is not None:
            try:
                await self._on_unauthorized(event)
            except Exception:
                logger.exception("parking unauthorized inbound failed")
        return
    if self._reply_resolver is not None:
        try:
            if self._reply_resolver(event):
                return
        except Exception:
            logger.exception("inbox reply resolver failed")
    if self._handler is not None:
        await self._handler(event)
```

三件事按顺序发生：先记录"最近发信人"（用于允许列表 UI 的"从最近发信人里选"体验，即使这条消息本身被拒绝也要记）；然后检查 `is_authorized`，不通过就交给 `_on_unauthorized`（下一节会讲这条路径通向 `ParkedStore`）；通过了之后先看这是不是在回复审批/收件箱里的一个待办项（`_reply_resolver`），是的话就地消费掉，不会作为新一轮对话转发给模型；都不是才真正调用注册的 `_handler`——也就是 super-agent 的入口。

`start()`/`stop()` 遍历 `self.settings` 里 `enabled=True` 的平台，找到对应的已注册 adapter 逐个 `connect()`，单个失败只记日志不影响其他平台：

```python
# coworker/connectors/gateway.py:169-183（节选）
async def start(self) -> list[str]:
    live: list[str] = []
    for platform, settings in self.settings.items():
        if not settings.enabled:
            continue
        adapter = self._adapters.get(platform)
        if adapter is None:
            continue
        try:
            if await adapter.connect():
                live.append(platform)
        except Exception:  # bad token / network — skip, don't break the server
            logger.exception("failed to connect %s adapter", platform)
    return live
```

这套"单点失败不拖累整体"的写法和 OpenHarness `ChannelManager` 的 `try/except ImportError` 是同一种工程直觉的不同应用场景。

### descriptors.py：让新增连接器主要是数据，不是代码

`ConnectorDescriptor` 是驱动"引导式设置向导"的数据结构，文件开头写明了设计意图：

```python
# coworker/connectors/descriptors.py:1-8
"""Connector descriptors — data that drives the guided setup wizard.

Adding a connector is (mostly) data, not UI code: a descriptor declares its auth method,
the fields the user pastes, step-by-step instructions, and a `validate` that confirms the
token by a real API call (and returns the bot identity to show back). Designed so a managed
one-click OAuth (`auth="oauth"`) can slot in later for the cloud product without changing the
data model — only the connect action differs.
"""
```

一个 `ConnectorDescriptor` 大致声明这些东西：`auth`（`"bot_token" | "socket_app" | "oauth" | "token" | "api_token" | "none"`）、需要用户粘贴的 `fields`、一段人类可读的 `instructions`、一个 `validate` 回调（真的打一次 API 确认凭证有效并抓回身份标识）。截至这次通读，`DESCRIPTORS` 列表里注册了 40 个连接器条目（其中 5 个 `available=False`，是尚未真正接线、只是给persona 推荐用的占位符，比如 Datadog、Salesforce）。

几个字段值得单独展开，因为它们决定了一个连接器实际落地的方式：

- `mcp_url`：如果非空，说明这个连接器是"MCP 托管"的——一键连接走的是本地 MCP OAuth 流程（DCR，token 留在本机，不经过任何代理），工具面是 `tool_defs.py` 里手工"钉死"的一个子集（`mcp__<name>__<tool>` 命名），而不是厂商 MCP 服务器的全量目录。这个设计的用意很直白：漂移只能让能力变少，不能让能力变多。
- `managed`：这个连接器支持"一键托管 OAuth"（走 OpenWorker Cloud），但手动粘贴 token 的路径**永远保留**，登录与否都一样——下一篇会看到 Slack、GitHub、Gmail 都是这个模式。
- `account_field`：多账号连接器的账号命名字段，要么是凭证里的某个字段（比如 Notion 的 `account_id`），要么是哨兵值 `"@identity"`——用校验器返回的身份字符串（比如 Outlook 的邮箱）来命名这个账号。空字符串表示这个连接器只支持单一档案。
- `experimental`：标记为实验性的连接器由独立的 `connectors/experimental/` 包承载，正式发布构建会把这个包整个剔除（`packaging/openworker-server.spec`）；截至目前 `EXPERIMENTAL_DESCRIPTORS` 是一个空列表，也就是说这套机制已经搭好，但还没有任何连接器真的挂在实验分支上。

### accounts.py：从四个"手搓"模块里长出来的通用多账号层

`accounts.py` 的 docstring 自己交代了这层抽象的来历：

```python
# coworker/connectors/accounts.py:1-16
"""Generic multi-account profiles — one layer for every new connector.

Slack, Gmail, Calendar, and HubSpot each grew a bespoke accounts module;
this is the same proven shape (per-account token profiles at
`<connector>:account:<id>`, a token-free `<connector>:default` holding only
the default-account pointer + connector-wide flags, lazy migration of a
legacy token-bearing default) parameterized by connector so batch-2
connectors (notion, attio, posthog, …) — and eventually the bespoke four —
share one implementation.
"""
```

也就是说，Slack（`slack:team:*`）、Gmail（`gmail_accounts.py`）、Google Calendar（`gcal_accounts.py`）、HubSpot（`hubspot_portals.py`）这四个连接器是最早支持"多账号/多工作区"的，各自独立写了一套几乎相同的存取逻辑：`<connector>:account:<id>` 存单个账号的凭证，`<connector>:default` 只存"默认账号指针"，外加把老版本"单账号时代"遗留的、凭证直接躺在 `:default` 里的档案懒迁移成一条账号记录。等到第二批连接器（Notion、Attio、PostHog……）要支持多账号时，团队把这套形状抽成了通用的 `accounts.py`，用 `account_field` 这个描述符字段参数化，而不是再复制粘贴四份。docstring 里"and eventually the bespoke four"这句话说得也很坦率——那四个先驱模块目前还没有被替换掉，通用层和手搓层并存，这是真实代码库里"抽象滞后于实践"的一个诚实切面（第 02 篇会具体对比 Gmail/Calendar 这两个手搓模块和通用层的接口差异）。

通用层的核心函数其实就是把这套"档案 + 默认指针"的形状写成了参数化版本：

```python
# coworker/connectors/accounts.py:46-56
def derive_account_id(d: ConnectorDescriptor, profile: dict[str, Any]) -> str:
    """The stable id naming this account: the designated creds field, or the
    validator identity (stored as `account` at connect time). "default" only
    when neither exists — never fails, so migration can't strand a profile."""
    if d.account_field and d.account_field != IDENTITY:
        return (
            _norm(profile.get(d.account_field))
            or _norm(profile.get("account"))
            or "default"
        )
    return _norm(profile.get("account")) or "default"
```

`is_account_connector(name)` 通过检查描述符的 `account_field` 是否非空来判断"这个连接器要不要走多账号档案"，`resolve()`/`add_account()`/`set_default()`/`disconnect_account()` 是完整的 CRUD——这一层是纯数据操作，完全不知道它背后对应的是 Notion 的 workspace 还是 Attio 的 workspace，业务语义留给上层调用者。

### config.py：默认拒绝的允许列表

`ConnectorSettings`/`TeamAuth`/`is_authorized` 构成了 Gateway 用来判断"这条入站消息能不能被处理"的授权模型，模块 docstring 开门见山：

```python
# coworker/connectors/config.py:1-6
"""Connector settings — which platforms are enabled + the inbound allowlist.

Tokens live in the SecretStore (profile `<platform>:default`); this module only carries
enablement + authorization. The allowlist is the inbound security guard: **empty = nobody**
(you must add your own user id), `allow_all` opens it.
"""
```

`is_authorized()` 分两条路径：托管 relay 场景下的每工作区独立授权（`team_id` 命中哪个 `TeamAuth` 就按哪个的 `allowed_users`/`allow_all` 判断，未知的 `team_id` 直接拒绝），以及单工作区场景下的扁平 `allowed_users`/`allow_all`。`load_settings()` 里有一处特别值得注意的分支：

```python
# coworker/connectors/config.py:84-93（节选）
if profile.get("mode") == "relay":
    enabled = bool(profile.get("enabled", True))
elif platform == "github":
    enabled = False
else:
    enabled = bool(token) and profile.get("enabled", True)
```

GitHub 的手动 PAT 档案**永远不会**让 Gateway 认为它"已启用"——因为一个手动粘贴的 Personal Access Token 只能支撑请求/响应式的工具调用（`github_search`、`github_create_issue` 这些），它没有能力主动把"issue 下面有人 @ocw 了"这件事推送过来。只有走托管的 GitHub App relay 模式（`mode == "relay"`），GitHub 才会作为一个真正的"入站消息平台"注册进 Gateway——这也是为什么 `descriptors.py` 里 GitHub 的 `two_way=True` 要专门写注释说明"是靠 relay 实现的，手动 PAT 路径仍是单向的"。这个细节留到第 02 篇细讲 GitHub 的两种模式时会更完整。

需要强调的是：这里的"授权"（谁可以给 bot 发消息）和第 04 章讲的"审批"（一个写操作要不要弹审批卡片）是两套完全不同的机制——一个决定谁能进门，一个决定进门之后能做什么，两者互不替代。

## 常见问题/易踩坑

- **目录名字容易造成误解。** `connectors/` 听起来像一个统一的东西，但 `Gateway`/`BasePlatformAdapter` 服务的"消息平台"和 `descriptors.py`/`integration_tools.py` 服务的"SaaS 工具集成"是两套完全不同复杂度的子系统，只是共享了 `SecretStore` 存储和 `ConnectorDescriptor` 这一层设置向导元数据。读代码时先分清楚一个具体文件属于哪一条腿，能省下很多困惑。
- **`parked.py` 的名字容易望文生义。** 直觉上很容易猜它是"被搁置、未启用的连接器列表"，但读过代码后这个猜测是错的：`parked.py` 里的 `ParkedStore`/`ParkedMessage` 存的是**被允许列表拒绝的入站消息**本身——当一个不在 `allowed_users` 里的人发消息过来，Gateway 不是直接丢弃，而是通过 `_on_unauthorized` 把这条消息"停放"下来，让所有者在连接器页面上一步完成"放行并投递"（不需要对方重新发一遍）。这是一个消息队列，不是连接器状态标记。
- **`fake.py` 和 `coworker/testing/fake_slack/` 不是一回事。** `FakeAdapter`（`fake.py`）是一个平台无关的、纯内存的测试替身，配合 `cli.py` 的 `fake` REPL 命令用来手动敲字符串模拟入站消息；`FakeSlack`（`coworker/testing/fake_slack/server.py`）则是一个跑在 Starlette/uvicorn 上的、真正实现了 Slack Web API 和 Socket Mode 协议切片的完整测试替身，通过环境变量 `SLACK_API_URL` 重定向，让真实的 `slack_bolt.AsyncApp` 处理器完整跑一遍——两者的仿真粒度完全不在一个量级上，第 02 篇讲 Slack 双文件设计时会再提到它。
- **实验性连接器目前是"空的"。** `experimental=True` 的隔离机制（独立包、发布构建剔除、需要用户显式风险确认）已经就位，但 `EXPERIMENTAL_DESCRIPTORS` 目前是空列表——这是"机制先于内容"的正常状态，不代表代码有问题。

## 小结

`base.py` 用三个抽象方法定义了消息平台适配器的最小契约，`SessionSource`/`MessageEvent`/target token 这几个值类型是所有平台差异被拉平之后的统一表示；`Gateway` 只服务 `config.PLATFORMS` 里的三个消息平台（Telegram、Slack、GitHub relay），四十来个 SaaS 集成完全不经过它；`descriptors.py` 用一份声明式的 `ConnectorDescriptor` 把"接入新连接器"变成主要是数据工作；`accounts.py` 是从 Slack/Gmail/Calendar/HubSpot 四个手搓模块里提炼出的通用多账号层，目前与这四个先驱并存；`config.py` 的默认拒绝授权模型守住了"谁能给 bot 发消息"这道门。下一篇我们对照几个具体连接器的真实实现——GitHub 的 App 安装模式、Slack 的双文件设计、Gmail/Calendar 的账号模式、HubSpot 的 portal 概念——看看这套统一框架在接入不同 SaaS 服务时具体是怎么被使用的。
