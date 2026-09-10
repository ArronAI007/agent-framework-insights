# 代表性 Connector 实现对照

> 上一篇看完了"连接器统一框架"的地基，这篇挑几个真正落地的连接器对照着读：GitHub 用的是"App 安装"模式，凭证从不落盘，靠短时效令牌现铸；Slack 拆成了地址编码和名录查询两个互不相关的文件，还同时支持手动 Socket Mode 和托管云中继两条完全不同的接入路径；Gmail 和 Google Calendar 各自维护着一份几乎相同的多账号存取代码，是"抽象滞后于实践"的活标本；HubSpot 则引入了一个 Slack/GitHub 都没有的概念——portal（一个 HubSpot 账号可能对应多个门户）。看完这四个,再回头看 `descriptors.py` 里四十个连接器条目,会发现"一个连接器文件对应一个服务"这句话大体成立,但也有明显的例外。

## 学习目标

- 通过 GitHub 的 `github_installs.py`/`github_relay.py`，理解"App 安装"模式如何用短时效令牌替代长期存储的凭证，以及它和手动 PAT 模式如何在同一个连接器名下并存。
- 通过 Slack 的 `slack_addr.py`/`slack_directory.py` 两个文件，理解"地址编码"和"名录查询"为什么被拆开维护，以及 Socket Mode（`adapters.py`）和托管中继（`relay_client.py`）两套适配器如何共用同一个 `platform = "slack"` 标识。
- 通过 `gmail_accounts.py`/`gcal_accounts.py`/`hubspot_portals.py` 对比，看清"多账号"这个需求在代码库里被解决了三次（外加通用层是第四次）的演化痕迹。
- 理解 `integration_tools.py` 里 `_profile`/`_account_profile`/连接器专属 `_gmail_profile` 这三种凭证解析辅助函数分别对应哪一代设计。
- 弄清楚 25+ 集成里，哪些是"一个连接器一份独立实现"，哪些共享了同一批 HTTP 脚手架函数。

## 背景与设计动机

SaaS 服务的认证方式五花八门：有的提供传统 OAuth（Notion、Attio），有的只给一个静态 API Key（Linear、Apollo），有的走"应用市场安装"模式而不是传统 OAuth（GitHub App），有的用工作区级别的 bot token（Slack），还有的一个账号下辖多个可切换的子实体（HubSpot 的 portal、Google 的多个邮箱）。`ConnectorDescriptor` 只声明了 `auth` 字段的取值范围（`"bot_token" | "socket_app" | "oauth" | "token" | "api_token" | "none"`），真正把这些差异落地成可用凭证的，是每个连接器自己的账号管理模块加上 `integration_tools.py` 里对应的工具函数。挑几个跨度最大的实现对照着看，比孤立地读某一个连接器更容易看出这套框架的弹性边界在哪。

## 核心机制详解

### GitHub：手动 PAT 与 App 安装并存，但只有后者是"双向"的

GitHub 连接器同时存在两条完全独立的路径。手动路径最简单：用户在 `github:default` 档案里粘贴一个 Personal Access Token，`integration_tools.py` 里的 `github_search`/`github_get_issue`/`github_create_issue` 直接拿这个 token 发请求。但正如上一篇提到的，这条路径在 `config.py` 里被硬编码为永不在 Gateway 里启用——它没有能力"主动告诉"桌面端有人在 issue 下面 @ocw 了。

真正让 GitHub 变成双向连接器的是托管的 GitHub App 安装模式。`github_installs.py` 管理的是"安装"这个实体，而不是"凭证"：

```python
# coworker/connectors/github_installs.py:1-13
"""Managed GitHub App installations: per-installation profiles + allow-lists.

`github:install:<installation_id>` holds ONE installation's routing metadata —
account_login (org/user the App is installed on), the connecting user's own
github_login, repo_selection, and that installation's inbound allow-list.
There is deliberately NO token field: API access runs on short-lived
installation tokens minted from the broker and cached in memory only
(github-relay-spec §4); the manual PAT path keeps living in `github:default`.
"""
```

每个 `github:install:<installation_id>` 档案里存的是"这个 App 装在哪个组织/用户上""是谁连接的""选中了哪些仓库""这个安装自己的允许列表"——**没有 token 字段**。真正调用 GitHub API 时用的是从云代理现铸的短时效安装令牌（下一篇细讲），装进内存缓存，从不落盘。入站方向由 `GitHubRelayAdapter`（`github_relay.py`）承接，它把 relay 推来的事件帧映射成 `MessageEvent`：

```python
# coworker/connectors/github_relay.py:126-155（节选）
async def _on_event(self, frame: dict) -> None:
    """A routed trigger (mention / label). Senders are logins — readable as
    they are, no resolution round-trips."""
    self.last_event_at = time.time()
    installation_id = str(frame.get("installation_id", ""))
    owner_repo = frame.get("owner_repo", "")
    number = frame.get("number", "")
    if not owner_repo:
        return
    if installation_id:
        self._repo_installs[owner_repo] = installation_id
    chat_id = f"{owner_repo}#{number}" if number else owner_repo
    ...
    event = MessageEvent(
        text=f"{header} {body}".strip(),
        source=SessionSource(
            platform=self.platform,
            chat_id=chat_id,
            user_id=frame.get("sender", ""),
            user_name=frame.get("sender", ""),
            chat_name=chat_id,
            chat_type="channel",  # a repo thread is a channel, not a DM
            team_id=installation_id,  # the allow-list scope (≙ Slack team)
        ),
        raw=frame,
    )
    await self.handle_message(event)
```

这里的寻址方式是 `owner/repo#N`（`split_thread()` 负责拆解），`installation_id` 借用 `SessionSource.team_id` 字段传递——正好复用了 Gateway 按"团队"分组的允许列表机制，只是这里的"团队"概念对应的是"这个 App 安装在哪"而不是"Slack 工作区"。GitHub 的 sender 身份比 Slack 简单得多：登录名本身就是人类可读的，不需要 `users.info` 那样的额外解析往返。回复走的是短时效令牌 + 一次 REST 调用：

```python
# coworker/connectors/github_relay.py:158-177（节选）
async def send(
    self, chat_id: str, text: str, *, thread_id: Optional[str] = None
) -> SendResult:
    """Comment on the issue/PR the event came from, as `ocw[bot]`."""
    owner_repo, number = split_thread(chat_id)
    if number is None:
        return SendResult(False, error=f"no issue/PR number in {chat_id!r}")
    installation_id = self._repo_installs.get(owner_repo) or next(
        iter(self._installs), ""
    )
    if not (self._token_client and installation_id):
        return SendResult(False, error="no installation token available")
    try:
        token = await self._token_client(installation_id)
    except Exception as exc:
        self._note_token_health(installation_id, False)
        return SendResult(False, error=f"token mint failed: {exc}")
```

值得一提的是这条注释——"Wave-1 relay write tools (github-relay-spec §8). The write ceiling is enforced by what exists here: comments, reviews, issues — no push, branch-delete, or repo-settings tools on any auth path."（`integration_tools.py`）。也就是说，无论走手动 PAT 还是托管 App，GitHub 连接器暴露给模型的写操作天花板都被有意限制在"评论、创建 issue"这个级别，代码里根本不存在能推送代码或删分支的工具——这是一种"能力上限写死在实现里，而不是靠审批兜底"的防御方式。

### Slack：地址编码与名录查询分成两个文件，两种适配器共用一个 platform 标识

Slack 是这几个连接器里接入路径最丰富的一个：既支持手动 Socket Mode（单工作区，直连 Slack 的 WebSocket），也支持托管云中继（多工作区，事件从 OpenWorker Cloud 转发过来）。这两种模式对应两个完全不同的适配器类——`SlackAdapter`（`adapters.py`）和 `SlackRelayAdapter`（`relay_client.py`）——但它们的 `platform` 类属性都是 `"slack"`，`make_adapter()` 根据档案里的 `mode` 字段二选一构建：

```python
# coworker/connectors/adapters.py:444-461（节选）
if platform == "slack":
    if profile.get("mode") == "relay":
        if not (relay_url and token_provider):
            logger.warning(...)
            return None
        from .relay_client import SlackRelayAdapter
        return SlackRelayAdapter(
            relay_url, token_provider, teams=_load_slack_teams(secrets), hub=relay_hub,
        )
    if profile.get("bot_token") and profile.get("app_token"):
        return SlackAdapter(profile["bot_token"], profile["app_token"])
```

多工作区场景下，一个 Slack 频道 ID 单独看是有歧义的——`C0123` 在两个不同工作区里可能是两个完全不同的频道。`slack_addr.py` 只做一件事：把 `team_id` 和频道 ID 编码进同一个 `chat_id` 字符串里，同时不破坏 `base.parse_target()` 认识的 `platform:chat_id[:thread]` 语法：

```python
# coworker/connectors/slack_addr.py:20-34
def qualify(team_id: Optional[str], channel: str) -> str:
    """Build a team-qualified chat_id, or the bare channel when no team."""
    return f"{team_id}/{channel}" if team_id else channel


def split(chat_id: str) -> tuple[Optional[str], str]:
    """`'T…/C…' -> ('T…', 'C…')`; a bare `'C…' -> (None, 'C…')`."""
    if chat_id and "/" in chat_id:
        team, _, channel = chat_id.partition("/")
        return (team or None), channel
    return None, chat_id
```

用 `/` 而不是 `:` 分隔是故意的——回复地址语法本身是冒号分隔的（`platform:chat_id[:thread]`），团队和频道之间用斜杠拼接，才能让 `slack:T012345/C0123` 整体套进这个语法而不产生歧义。手动 Socket Mode 是单工作区场景，`chat_id` 保持不带团队前缀的裸格式；托管中继是多工作区场景，`chat_id` 一律团队限定。`send_message` 工具和 `senders.py` 里的发送函数在真正调用 Slack API 之前，都会先 `split()` 一次把团队前缀剥掉，因为 Slack 的 Web API 只认裸频道 ID——团队信息只是本地路由用的。

`slack_directory.py` 解决的是完全不同的问题：给 GUI 的允许列表设置界面提供"按名字搜人""按名字搜频道"的体验，而不是让用户去 Slack 里翻 ID 再粘贴过来。它是一个纯读操作 + 15 分钟 TTL 内存缓存：

```python
# coworker/connectors/slack_directory.py:1-13（节选）
"""Workspace rosters for the Slack pickers (people + channels).

Backs "find your name in a list" instead of the park→approve-only flow, and
channel-by-name instead of pasted IDs. Pure reads on scopes every install
already granted (`users:read`, `channels:read`, `groups:read`) — no consent
bump, and the roster never leaves this machine (in-memory cache, not the
SecretStore; names/ids are routing metadata, not content).
"""
```

之所以要拆成两个文件，是因为这两件事的变化频率和风险等级完全不同：地址编码是协议细节，几乎不会变，但只要变了就会牵连 `send_message`、`Gateway`、`relay_client.py` 好几处调用点；名录查询是纯 UI 便利功能，随时可能加缓存策略、加分页参数，但改动完全不会影响任何回复地址的语义。把易变和稳定的部分分开放，是这两个文件各自都很短小（34 行 vs 197 行，但职责边界干净）的直接原因。

顺带一提，`pyproject.toml` 的 `messaging` 可选依赖组里有一条容易被忽略的注释：

```toml
# aiohttp is slack-bolt's Socket Mode transport at runtime (and the FakeSlack test harness
# drives the real handler) — declare it so CI installs it, not just transitively.
messaging = ["python-telegram-bot>=21", "slack-bolt>=1.18", "aiohttp>=3.9"]
```

`slack-bolt`/`slack_sdk` 的 Socket Mode 客户端在运行时是靠 `aiohttp` 承载 WebSocket 连接的，但 `aiohttp` 从来不会被 `adapters.py` 直接 `import`——它是 `slack-bolt` 的传递依赖，声明成一等公民只是为了确保 CI 环境里一定装得上，而不是因为代码里哪里显式用到了它。而 `coworker/testing/fake_slack/server.py` 里的 `FakeSlack` 之所以能拿真实的 `slack_bolt.AsyncApp` 跑端到端测试而不用真连 Slack，靠的正是把 `SLACK_API_URL` 环境变量指向本地 FakeSlack 服务——包括 Socket Mode 建连时用到的 `apps.connections.open` 调用也会被重定向，让"假 Slack"决定 WebSocket 到底连去哪。这意味着测试跑的是**真实的** `slack_bolt`/`aiohttp` 处理逻辑，只是网络的另一端是本地进程,而不是伪造整条协议栈。

### Gmail / Google Calendar：账号模式的"手搓"先驱

`gmail_accounts.py` 和 `gcal_accounts.py` 几乎是同一份代码抄了两遍。两者的 `list_accounts`/`default_account`/`resolve`/`managed_connect_account`/`set_default`/`disconnect_account` 函数签名和实现逻辑几乎逐行对应，唯一的实质差异是 Gmail 多了一层账号范围内的隐私过滤：

```python
# coworker/connectors/gmail_accounts.py:140-168（节选）
def get_filters(secrets: SecretStore) -> dict[str, list[str]]:
    f = (secrets.get(DEFAULT_KEY) or {}).get("filters") or {}
    return {"senders": list(f.get("senders") or []), "labels": list(f.get("labels") or [])}


def set_filters(
    secrets: SecretStore, senders: Optional[list[str]] = None, labels: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Replace either list (None = leave unchanged). Senders are `addr@x` or
    `@domain`; labels are Gmail label names (matched case-insensitively)."""
```

这是"永不让模型看到某些发件人/标签下的邮件"的开关，`sender_matches()` 支持精确地址匹配和 `@domain.com` 域名后缀匹配两种规则，实际的过滤动作发生在 `integration_tools.py` 的工具层（读取邮件时静默跳过命中的消息，不留下"这里有一条被隐藏的邮件"这种模型能推理出来的痕迹，只在 UI 卡片上给人看到"隐藏了几条"的计数）。`gcal_accounts.py` 的 docstring 直接写明了这层差异——"Same shape as gmail_accounts, minus the privacy filters (calendar has no 'Never show agents' policy yet)"，日历数据没有这类敏感度分级需求，所以少了这一段。

这两个模块和 `hubspot_portals.py`（下面细讲）、以及 Slack 的按团队分档案机制，正是上一篇提到的"四个手搓多账号模块"里的三个——它们的存在时间早于通用的 `accounts.py`，形状高度相似但各自独立维护，是同一个需求被解决了三四次的真实痕迹。

### HubSpot：portal 概念与"模型不可见"的字段黑名单

HubSpot 引入了一个前面两个连接器都没有的实体——portal（大致对应一个 HubSpot 账号/门户，一个用户可能同时管理多个）。`hubspot_portals.py` 用 `hubspot:portal:<hub_id>` 存每个门户的凭证，`hubspot:default` 只存指针和门户级策略：

```python
# coworker/connectors/hubspot_portals.py:1-16（节选）
"""Multi-portal HubSpot: per-portal profiles + the hidden-fields denylist.

Hidden fields are enforced in the hubspot TOOL layer on this desktop: the
named properties are stripped from every record an agent reads. This hides
data from the MODEL — it is not an ACL against humans (HubSpot permission
sets are; UX-DECISIONS §21). Stripped-field counts go to the audit log.
"""
```

`hidden_fields` 是这个连接器独有的概念——用户可以指定"永远不要把这个 CRM 字段（比如客户的家庭住址、内部风险评分）给模型看"，`strip_hidden()` 在读取记录时按属性名（大小写不敏感）逐一剔除并计数：

```python
# coworker/connectors/hubspot_portals.py:160-190（节选）
def strip_hidden(record: Any, hidden: list[str]) -> tuple[Any, int]:
    """Remove denylisted property keys from a CRM record (or a search page of
    records), case-insensitively. Returns (cleaned, number of values removed)."""
    if not hidden:
        return record, 0
    wanted = {h.lower() for h in hidden}
    removed = 0

    def _clean_obj(obj: dict[str, Any]) -> dict[str, Any]:
        nonlocal removed
        out = dict(obj)
        props = out.get("properties")
        if isinstance(props, dict):
            kept = {}
            for k, v in props.items():
                if k.lower() in wanted:
                    removed += 1
                else:
                    kept[k] = v
            out["properties"] = kept
        return out
    ...
```

docstring 里那句"This hides data from the MODEL — it is not an ACL against humans"值得反复读——这不是权限控制（谁能看这条记录由 HubSpot 自己的权限集决定），而是"模型不该知道的信息，即使有权限读也不给模型看"。这和 Gmail 的发件人/标签过滤是同一类思路在两个不同连接器上的应用：账号层的凭证归属和内容层的可见性策略，是两件独立的事情，`hidden_fields`/`filters` 都存在账号档案的"指针"记录里，作为门户/邮箱级别的策略，而不是随着单次工具调用传入。

有意思的是，HubSpot 的描述符（`descriptors.py` 里 `name="hubspot"`）并**没有**设置 `account_field`——它没有走通用的 `accounts.py` 多账号层，而是像 Gmail/Calendar 一样保留了独立的 `hubspot_portals.py`。这进一步印证了上一篇的观察：通用层是给"第二批"连接器（Notion、Attio、PostHog 等新接入的服务）用的，HubSpot 作为"先驱四人组"之一，目前还没有被迁移过去。

### 凭证解析的三代写法：一份代码里能读出演化史

`integration_tools.py` 里有三种不同的"取这个连接器的凭证档案"辅助函数，分别对应三个不同的时期：

最朴素的单档案模式，给没有多账号需求的连接器用：

```python
# coworker/connectors/integration_tools.py:75-90（节选）
def _profile(
    secrets: SecretStore, name: str, *keys: str
) -> tuple[Optional[dict[str, Any]], Optional[dict[str, str]]]:
    profile = secrets.get(f"{name}:default") or {}
    if profile.get("managed"):
        from ..cloud import ensure_fresh_connector_token
        from ..config import load_config
        ensure_fresh_connector_token(secrets, load_config(), name)
        profile = secrets.get(f"{name}:default") or {}
    missing = [k for k in keys if not profile.get(k)]
    if missing:
        return None, {"error": f"{name} is not connected; missing {', '.join(missing)}"}
    return profile, None
```

通用多账号层，给 Notion/Attio/Outlook 这类"第二批"连接器用：

```python
# coworker/connectors/integration_tools.py:93-122（节选）
def _account_profile(
    secrets: SecretStore, connector: str, account: str = "", *keys: str
) -> tuple[str, Optional[dict[str, Any]], Optional[dict[str, str]]]:
    """(account_id, profile, err) for an account-patterned connector (generic
    accounts.py layer): requested — or default — account, managed tokens
    refreshed in place. The gmail/gcal/hubspot bespoke helpers predate this."""
    from . import accounts as _accounts
    account_id, key, profile = _accounts.resolve(secrets, connector, account)
    ...
```

以及给"先驱四人组"各自定制的专属版本，比如 `_gmail_profile`/`_gcal_profile`，签名和 `_account_profile` 几乎一样，只是内部调的是 `gmail_accounts.resolve()`/`gcal_accounts.resolve()` 而不是通用的 `accounts.resolve()`。三种函数并存、注释里互相点名对方（`_account_profile` 的 docstring 直接写"The gmail/gcal/hubspot bespoke helpers predate this"），是这个代码库愿意在文档里承认技术债、而不是假装只有一种"标准写法"的一个例子。

### 25+ 集成：大体一个文件对应一个服务，但共享脚手架

回到 README 的"25+ integrations"这句话——`descriptors.py` 里注册了 40 个连接器条目（其中 5 个是尚未接线的占位符），每个条目对应 `integration_tools.py` 里一组独立命名的工具函数（`github_*`、`jira_*`、`hubspot_*`……），从"每个连接器自己的业务函数"这个角度看，"一个连接器对应一份独立实现"基本成立。但同一个厂商家族内部，多个连接器会共享底层的 HTTP 脚手架：比如 Jira 和 Confluence 都用同一个 `_atlassian_base()`/`_bearer_headers()`；GitHub 的所有工具函数都经过同一个 `_github_call()`；Notion/Attio/PostHog 这类"whoami 校验"新连接器共享同一个 `_validate_whoami()` 辅助函数（见 `descriptors.py` 里那一串 `_validate_notion`/`_validate_attio`/`_validate_posthog`，它们的实现只是传入不同的 URL、header 和身份提取表达式）。

也有值得留意的不对称：Jira 的描述符声明了 `mcp_url="https://mcp.atlassian.com/v1/mcp"`，支持走 Atlassian 官方托管的 MCP 服务器一键连接；而同属 Atlassian 家族的 Confluence 描述符里没有这个字段，只能走手动的 `api_token` 路径。这大概率反映的是 Atlassian 官方 MCP 服务当前的产品边界（是否覆盖 Confluence 由对方决定），而不是 OpenWorker 这边故意区别对待——但从代码本身只能看到"Jira 有、Confluence 没有"这个事实，具体原因需要读者自己去 Atlassian 的 MCP 文档确认。

## 常见问题/易踩坑

- **"托管一键连接"从来不是唯一路径。** Slack、GitHub、Gmail、Notion、HubSpot 的描述符都设了 `managed=True`，但 `descriptors.py` 的注释反复强调"Manual token paste ALWAYS remains available — signed out or in — managed is an extra path, never a replacement"。读某个连接器的接入逻辑时，一定要同时看它的手动路径和托管路径，两者的凭证形状必须兼容（字段名对得上），工具层才能对两条路径一视同仁。
- **`account_field` 的取值不是随便选的。** 大多数连接器（Outlook）用哨兵值 `"@identity"`——因为凭证本身没有一个天然字段能命名账号，只能靠 `validate()` 返回的身份字符串；少数连接器（Notion）用一个实际存在的凭证字段（`account_id`）。选错了会导致同一个账号被误判成两个不同账号，或者反过来。
- **HubSpot 和 Gmail/Calendar 目前没有走通用 `accounts.py`。** 如果要给这几个连接器加新功能，需要先确认改的是 `hubspot_portals.py`/`gmail_accounts.py` 这些独立模块，而不是 `accounts.py`——改错地方不会报错，只是改动完全不会生效在这几个连接器上。

## 小结

GitHub 用短时效令牌 + App 安装解决了"凭证不落盘"的问题；Slack 把地址编码和名录查询拆成两个文件，并让 Socket Mode 和托管中继两种适配器共用同一个 `platform` 标识；Gmail/Calendar/HubSpot 三个"先驱"连接器各自手搓了一套几乎相同的多账号存取逻辑，是抽象滞后于实践的真实痕迹；25+ 集成里"一个连接器一份实现"基本成立，但同厂商家族内部普遍共享 HTTP 脚手架函数。这些具体实现能落地，靠的是 SaaS 服务本身提供了标准的 token/API Key 认证——但世界上大多数网站根本没有开放 API。下一篇看这套框架怎么用 Playwright 驱动的浏览器自动化和最古老的 IMAP/SMTP 协议，去覆盖"没有 API"的那一半世界。
