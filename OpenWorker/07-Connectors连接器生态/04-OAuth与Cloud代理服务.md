# OAuth 与 Cloud 代理服务

> README 的 Privacy 一节说得很坚决："OpenWorker is local-first. Everything lives on your machine: the agent loop, your conversations, connector tokens, and model keys — all in the app's local secret store. The only cloud piece is a small service that brokers OAuth handshakes for connectors." 这句话读起来像一句公关文案，但 `coworker/cloud.py` 这一个将近 700 行的文件把它变成了可以逐行核对的实现——云端到底做了什么、故意不做什么，代码里写得明明白白。Slack 场景下还多一层 `relay_client.py`：为什么手动 Socket Mode 不够用，还要在云端加一层中继。这篇文章把这两个文件读透，作为本章的收尾。

## 学习目标

- 理解为什么 OAuth 握手这件事没办法完全在本地完成——桌面应用没有稳定的公网地址，也不该替每个用户去持有一份第三方 SaaS 的开发者密钥。
- 理解 `cloud.py` 里托管连接的具体边界：云端转发一次性的 token，从不存储、从不接触连接器凭证本身；GitHub 安装令牌是这条规则里最严格的一个例外说明。
- 理解 Auth0 PKCE 登录流程里"稳定回调地址 + 随机端口 loopback"这个两跳设计要解决的实际问题。
- 理解 `relay_client.py` 的 `RelayHub` 抽象——为什么 Slack 需要一条额外的云端 WebSocket 通道，以及它和手动 Socket Mode（`aiohttp` 传输）是两条完全独立的传输层。
- 理解 GitHub 安装令牌"内存缓存、从不落盘"这一条比其他任何 SaaS 凭证都更严格的规则从何而来。

## 背景与设计动机

一个 OAuth App（不管是 Google、Slack 还是 Notion 的）背后都有一个 `client_id`/`client_secret`，这对密钥是厂商颁发给"某个具体应用"的，而不是颁发给"某个具体用户"。如果 OpenWorker 想让用户一键连接 Gmail 而不用去手动申请 Google Cloud 项目、配置 OAuth 同意屏幕，就必须有一个地方持有这份 `client_secret`——但这份密钥绝不能塞进一个开源的、跑在每个用户自己电脑上的桌面客户端里，否则任何人反编译一下就能拿到它冒充这个应用。另一个更琐碎的问题是：大多数 OAuth 授权服务器的重定向地址必须提前在开发者后台注册白名单，而 OpenWorker 桌面应用绑定的端口是随机的（打包版本甚至每次启动都不同），根本没法把"随机端口"注册进白名单。

`OpenWorker Cloud` 存在的唯一理由就是解决这两个问题：持有各个 SaaS 应用的 `client_secret`，并且提供一个稳定、已经在白名单里的回调地址。除此之外——连接器的 token 本身、消息内容、模型对话——都不途经这个云端。`cloud.py` 的模块 docstring 把这个边界写得很克制：

```python
# coworker/cloud.py:1-20（节选）
"""OpenWorker Cloud client: sign-in and managed one-click connectors.

Everything here is OPTIONAL. The app is fully functional signed out — manual
token paste stays available for every connector (and remains available after
sign-in too). Cloud sign-in only unlocks the one-click managed OAuth path and
the metadata conveniences that come with it.
...
- Managed connect: authenticated `POST /v1/oauth/{provider}/start` returns the
  provider authorize URL; the broker's callback page form-POSTs the token
  payload to the sidecar's loopback `POST /oauth/callback`; the profile is
  written locally. Connector tokens never touch cloud storage.
"""
```

## 核心机制详解

### 登录：Auth0 PKCE + 两跳回调解决"随机端口"问题

`begin_login()` 生成一对 PKCE 校验码，把 `state` 编码成"随机字符串 + 端口号"的组合，交给用户浏览器去 Auth0 走标准的 Authorization Code + PKCE 流程：

```python
# coworker/cloud.py:74-111（节选）
def begin_login(config: Config) -> dict[str, Any]:
    """Create a PKCE login and return the browser URL. The sidecar's
    GET /auth/callback completes it.

    The redirect goes through the BROKER's stable callback, which bounces the
    browser to our actual loopback port (carried as state's `.port` suffix —
    Auth0 echoes state untouched). Direct loopback redirects can't work in the
    packaged app: Auth0's allow-list rejects unregistered ports, and the
    desktop shell binds the sidecar to a RANDOM free port. This shipped once
    as "Firefox can't connect to 127.0.0.1:8765" right after Auth0 finished.
    """
    verifier = _b64url(_secrets.token_bytes(48))
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    port = os.environ.get("COWORKER_PORT") or config.port
    state = f"{_secrets.token_urlsafe(16)}.{port}"
    ...
    redirect_uri = config.cloud_base_url.rstrip("/") + "/v1/auth/callback"
    authorize_url = (
        f"https://{config.cloud_auth_domain}/authorize?"
        + urllib.parse.urlencode({
            "response_type": "code", "client_id": config.cloud_client_id,
            "redirect_uri": redirect_uri, "scope": LOGIN_SCOPES,
            "audience": config.cloud_audience, "state": state,
            "code_challenge": challenge, "code_challenge_method": "S256",
        })
    )
    return {"authorize_url": authorize_url, "state": state}
```

这里的关键设计是：Auth0 的 `redirect_uri` 永远指向云代理自己的一个稳定地址（`/v1/auth/callback`），而不是直接指向本机随机端口。云代理收到 Auth0 的回调之后，再把浏览器"弹"回本机——真正的目的地端口，就藏在 `state` 参数里那个 `.port` 后缀，Auth0 只是原样透传 `state`，从不解析它。docstring 里那句"This shipped once as 'Firefox can't connect to 127.0.0.1:8765' right after Auth0 finished"是一句带着实战伤疤的注释——直接把 Auth0 重定向到随机端口在打包应用里根本行不通，因为 Auth0 的白名单机制不允许注册一个"任意端口"的通配地址，桌面应用绑定的端口又是运行时决定的，两者结构性地冲突，只能靠云端这一跳来做"翻译"。

`complete_login()` 用换回来的 `code` + PKCE `verifier` 去 Auth0 换 token，`redirect_uri` 必须和 `begin_login` 里发起时**逐字节一致**（这是 OAuth 规范 RFC 6749 §4.1.3 的硬性要求）——代码注释里甚至留了一条真实故障复盘："the stale loopback here made Auth0 reject every exchange ('token exchange failed' on all sign-ins from 07-09 to 07-11)"，提醒后来的维护者这一处很容易在重构时不小心改错。

### Managed connect：云端只转发一次性 token，不留存

一键连接某个连接器（比如 Gmail）的流程分两步。第一步 `begin_managed_connect()` 认证请求云端的 `/v1/oauth/{provider}/start`，拿到厂商的授权页面地址：

```python
# coworker/cloud.py:345-392（节选）
def begin_managed_connect(
    secrets: SecretStore, config: Config, connector: str, *, access: str = "", flow: str = "",
) -> dict[str, Any]:
    """Authenticated start: returns the provider consent URL for the browser.
    Requires sign-in — the manual token path stays available regardless."""
    provider = PROVIDER_FOR_CONNECTOR.get(connector)
    if provider is None:
        return {"ok": False, "error": f"{connector} has no managed OAuth path"}
    token = fresh_access_token(secrets, config)
    if not token:
        return {"ok": False, "error": "not signed in", "signed_in": False}

    app_state = _secrets.token_urlsafe(16)
    port = os.environ.get("COWORKER_PORT") or config.port
    resp = httpx.post(
        config.cloud_base_url.rstrip("/") + f"/v1/oauth/{provider}/start",
        json={
            "connector": connector,
            "redirect": f"http://127.0.0.1:{port}/oauth/callback",
            "app_state": app_state,
            **({"access": access} if access else {}),
            **({"flow": flow} if flow else {}),
        },
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    ...
```

注意这里的 `redirect` 直接指向本机的 loopback（不像登录流程那样需要云端二次转发）——因为这一步的"回调"不是 Auth0 那种受白名单约束的重定向,而是云代理自己的服务在拿到厂商 OAuth 的 token 之后,主动向这个地址发起一次 `POST`(表单提交),把 token 塞进请求体里。`PROVIDER_FOR_CONNECTOR` 这张映射表本身也值得一提：

```python
# coworker/cloud.py:43-53
PROVIDER_FOR_CONNECTOR = {
    "gmail": "google",
    "google_calendar": "google",
    "google_drive": "google",
    "slack": "slack",
    "notion": "notion",
    "attio": "attio",
    "hubspot": "hubspot",
    "github": "github",
    "outlook": "microsoft",
}
```

Gmail、Google Calendar、Google Drive 三个不同的连接器共享同一个 `google` 厂商 OAuth App——这是"厂商 OAuth 应用粒度"和"连接器粒度"不是一一对应关系的直接证据：云端只需要维护一份 Google App 的凭证，就能同时支撑三个功能完全不同的连接器。

第二步，云代理拿到厂商颁发的 token 之后，把它表单提交回桌面应用的本地回环端点，`managed_profile_from_callback()` 负责把这份表单数据转换成本地档案：

```python
# coworker/cloud.py:403-427
def managed_profile_from_callback(form: dict[str, str]) -> dict[str, Any]:
    """Local connector profile from the broker's form-POST payload.

    Field-compatible with a manual paste (`access_token` etc.) so tools and
    gating treat both paths identically; the managed extras (refresh_token,
    connection_id) are what enable broker refresh and cloud disconnect.
    """
    profile = {
        "type": "oauth", "enabled": True, "managed": True,
        "access_token": form.get("access_token", ""),
        "refresh_token": form.get("refresh_token", ""),
        "scope": form.get("scope", ""),
        "connection_id": form.get("connection_id", ""),
        "provider": form.get("provider", ""),
        "account": form.get("account", ""),
    }
    ...
    return profile
```

这里"field-compatible with a manual paste"这句注释是整个托管 OAuth 设计里最重要的一句话——托管连接生成的档案和用户手动粘贴 token 生成的档案在字段形状上完全兼容（都有 `access_token`），`integration_tools.py` 里读取凭证的工具函数根本不需要知道、也不关心这份凭证是手动粘贴的还是托管流程换来的，两条路径在工具层是无差别对待的。`managed`/`refresh_token`/`connection_id` 这几个额外字段才是区分标志，它们只用来决定"这份凭证快过期时该不该、以及怎么去云端续期"。

### 续期与断开：只有 managed 档案会再碰云端

`ensure_fresh_connector_token()` 是每次工具调用前的一道前置钩子，只对 `managed=True` 的档案生效：

```python
# coworker/cloud.py:473-490
def ensure_fresh_connector_token(
    secrets: SecretStore, config: Config, connector: str, *,
    profile_key: Optional[str] = None, leeway: int = 120,
) -> None:
    """Refresh-on-expiry hook for connector tools: if this is a managed profile
    about to expire, renew it in place. No-op for manual profiles."""
    key = profile_key or f"{connector}:default"
    profile = secrets.get(key) or {}
    if not profile.get("managed"):
        return
    expires = float(profile.get("expires") or 0)
    if expires and expires > _now() + leeway:
        return
    refresh_managed_token(secrets, config, connector, profile_key=profile_key)
```

手动粘贴的 token 永远不会被这段代码碰到——`if not profile.get("managed"): return` 直接短路。`cloud_disconnect()` 同理，只有档案里同时有 `managed=True` 和 `connection_id` 才会去通知云端"这个连接断开了"，纯本地删除操作对手动档案永远是唯一发生的事情。这条"manual 路径与云端零交互"的边界在好几个函数里被反复申明，是一种在代码层面兑现隐私承诺的写法——不是写在文档里让人相信，而是每个可能触达云端的函数入口都显式检查一次。

### GitHub 安装令牌：唯一"内存缓存、绝不落盘"的例外

`sync_connections()` 的注释里有一句关键的话："Only GitHub restores fully on a fresh install: its rows are routing metadata (installation ids + logins) and installation tokens mint on demand — nothing secret ever needs to live here."——GitHub 走的是比其他任何连接器都更严格的模式。本地的 `github:install:<id>` 档案（`github_installs.py`）里压根没有 token 字段，每次真正要调用 GitHub API 时，都要现场向云代理换一个：

```python
# coworker/cloud.py:520-569（节选）
# installation_id -> (token, expires_epoch). MEMORY ONLY by design: GitHub
# installation tokens live ~1 h and are re-minted from the broker; they must
# never touch the secret store (github-relay-spec §4).
_GITHUB_TOKEN_CACHE: dict[str, tuple[str, float]] = {}
_GITHUB_TOKEN_LEEWAY = 600  # re-mint when < 10 min of life remains


def github_installation_token(
    secrets: SecretStore, config: Config, installation_id: str, *, force: bool = False
) -> str:
    """A live installation access token for GitHub API calls, minted via the
    authenticated broker route and cached in memory (~50 min)."""
    installation_id = str(installation_id or "").strip()
    if not installation_id:
        return ""
    if not force:
        cached = _GITHUB_TOKEN_CACHE.get(installation_id)
        if cached and cached[1] > _now() + _GITHUB_TOKEN_LEEWAY:
            return cached[0]
    token = fresh_access_token(secrets, config)
    if not token:
        return ""
    resp = httpx.post(
        config.cloud_base_url.rstrip("/") + "/v1/github/token",
        json={"installation_id": installation_id},
        headers={"Authorization": f"Bearer {token}"},
        timeout=20,
    )
    ...
```

`_GITHUB_TOKEN_CACHE` 是一个模块级的 Python 字典——进程重启就清空，从来没有任何时刻被写进 `SecretStore`。这解释了上一篇 `github_relay.py` 里 `send()` 为什么每次发送评论前都要 `await self._token_client(installation_id)`：这不是设计疏忽导致每次都要多一次网络往返，而是刻意为之——GitHub App 的安装令牌本身设计寿命就短（约一小时），比起持久化一份很快过期的秘密，不如每次现铸更安全，反正云代理这一跳本身就是轻量的。

### relay_client.py：为什么 Slack 还需要一条额外的云端通道

`SlackAdapter`（手动 Socket Mode）已经能让 bot 直接收发消息，为什么还要 `SlackRelayAdapter` 这一整套托管中继？`relay_client.py` 顶部的对比说得很清楚：

```python
# coworker/connectors/relay_client.py:1-16（节选）
"""Managed-relay inbound adapter — the cloud-relay alternative to Socket Mode.

The desktop offers the user two ways to receive Slack:
- **Socket Mode** (`SlackAdapter`): manual bot + app tokens, one workspace, a
  direct WebSocket to Slack. No cloud involved.
- **Managed relay** (`SlackRelayAdapter`, here): "Add to Slack" OAuth, no tokens
  typed, *many* workspaces, events pushed from OpenWorker Cloud over one
  authenticated WebSocket. Replies still go desktop → Slack Web API directly
  with the per-team bot token (the relay is inbound-only).
"""
```

核心差异是"一个工作区"还是"任意多个工作区"。手动 Socket Mode 要求用户自己在 `api.slack.com` 创建一个 Slack App、打开 Socket Mode、拿到 `xoxb-`/`xapp-` 两个 token——这套流程对一个工作区可以走一次，但用户想接入第二个工作区就要整套重来一遍，而且每个工作区都要维护一条独立的 WebSocket 连接。托管中继反过来：用户点一次"Add to Slack"完成标准 OAuth 授权，往后云端把这个工作区的 bot token 记下来（对应本地的 `slack:team:<team_id>` 档案），所有已授权工作区的事件都通过**同一条**桌面↔云端 WebSocket 推送过来，`RelayHub` 按事件帧里的 `provider`/`team_id` 字段分发。回复仍然是桌面直接调 Slack Web API——中继只负责入站，出站从来不经过云端，这也是为什么每个工作区的 bot token 必须留在本地（`slack:team:<id>` 档案），云端转发的只是事件内容，不持有能代表 bot 说话的凭证。

`RelayHub` 本身被设计成可以被多个 provider 共享的一条连接：

```python
# coworker/connectors/relay_client.py:62-69, 97-106（节选）
class RelayHub:
    """The ONE desktop↔cloud relay socket, shared by every provider adapter.

    The cloud pushes all of a user's events down a single authenticated WS;
    frames fan out here by their `provider` tag (slack / github / …). Owns the
    transport, the read loop, and the reconnect watchdog — adapters own only
    their provider's frame handling."""

    def register(self, provider: str, handler: Callable[[dict], Awaitable[None]]) -> None:
        self._handlers[provider] = handler

    async def release(self, provider: str) -> None:
        """An adapter is done; the socket closes when the last one leaves."""
        self._handlers.pop(provider, None)
        if not self._handlers:
            await self.stop()
```

`GitHubRelayAdapter`（上一篇讲过）和 `SlackRelayAdapter` 可以共用同一个 `RelayHub` 实例——一个用户同时托管了 Slack 和 GitHub，本机也只需要维持一条云端 WebSocket，两个 provider 按 `frame.get("provider")` 标签分流到各自的 `_dispatch()` 方法。断线重连由 `RelayHub._run()`/`_reconnect()` 处理，`state()` 方法能报告 `"live"`/`"reconnecting"`/`"offline"` 三种状态供 GUI 展示；更进一步，如果连接断开期间云端丢弃了一些事件（超过 TTL 或者缓冲区溢出），会收到一个 `kind == "missed"` 的通知帧，`SlackRelayAdapter._on_missed()` 会主动用这个工作区的 bot token 去 Slack 拉一段最近的频道历史来补偿：

```python
# coworker/connectors/relay_client.py:368-383（节选）
async def _on_missed(self, frame: dict) -> None:
    """A nudge: content was dropped (offline > TTL / overflow). Pull the
    recent channel history ourselves via the per-team bot token and replay
    the missed messages (spec §7 channel-context / nudge)."""
    team_id = frame.get("team_id", "")
    channel = frame.get("channel", "")
    count = int(frame.get("count", 0)) or 1
    if self._history_fetcher is None or not channel:
        return
    messages = await self._history_fetcher(team_id, channel, count)
    for raw in messages:
        await self._dispatch_slack_event(team_id, {**raw, "channel": channel})
```

云端只负责"提醒你漏了几条"，真正补齐内容的动作还是本机直接找 Slack 要——这再一次体现了"云端只传路由信息，内容永远走本地到厂商的直连"这条一以贯之的边界。

这条边界也解释了为什么 `pyproject.toml` 里会同时声明 `aiohttp`（`messaging` 组，slack-bolt 的 Socket Mode 传输）和 `websockets`（核心依赖，`relay_client.py` 的 `_WebSocketsTransport`）——两个库分别服务两条完全独立的传输路径：手动 Socket Mode 是"桌面直连 Slack"，走 slack-bolt 内部的 `aiohttp`；托管中继是"桌面连云代理"，走 `relay_client.py` 自己实现的、更薄的 `websockets` 客户端。这两条路径互不依赖，用户选择其中一种，另一种的依赖库根本不会被触发加载。

## 常见问题/易踩坑

- **"云端代理 OAuth 握手"不等于"消息内容经过云端"。** Slack 的托管中继只转发入站事件的路由信息，回复始终是桌面直接调用 Slack API；GitHub 安装令牌虽然要向云端换取，换回来之后调用 GitHub REST API 仍是本地发起的直连请求。读这部分代码时，一定要分清"谁转发了什么"和"谁真正持有并使用了凭证"，这两者在这套系统里被刻意分开。
- **托管路径不会让手动路径消失。** 即使用户已经登录云账号、连了托管的 Gmail，手动粘贴 access token 的字段在设置界面上依然存在且可用——`begin_managed_connect()`/`cloud_disconnect()` 这些函数只操作 `managed=True` 的档案，纯手动档案对它们完全不可见。
- **GitHub 安装令牌的内存缓存会在进程重启后清空。** 这是有意的行为而不是 bug——重启后下一次调用会自动向云代理重新换一个，`force=True` 参数专门用于处理 401 之后的强制刷新重试。

## 小结

`cloud.py` 把 README 里"本地优先，唯一的云组件是 OAuth 代理"这句话落到了实处：Auth0 PKCE 登录靠"稳定回调 + state 里藏端口号"解决随机端口无法白名单的问题，托管连接生成的档案与手动粘贴 token 字段兼容，云端只转发一次性的 token 而从不持久化任何连接器凭证；GitHub 安装令牌是唯一一个更严格的例外——完全不落盘，只在内存里缓存约一小时。`relay_client.py` 的 `RelayHub` 解释了 Slack 为什么需要额外的托管中继：手动 Socket Mode 只能服务单个工作区,一条桌面↔云端的共享 WebSocket 才能让"任意多个工作区共用一次授权"成立,而回复始终经由本地直连,内容从不途经云端。

至此，`coworker/connectors/` 这个仓库里体量最大的子系统就完整地走了一遍：从 `base.py` 的最小契约，到具体连接器的四种接入模式，到浏览器/邮件这两个"非典型" SaaS 连接器，再到撑起隐私边界的云代理服务。下一章我们转向 Personas 与 Teams——OpenWorker 的专家协作体系，看看这些连接器暴露出来的工具能力，最终是怎么被组织进不同分工的"专家同事"角色里的。
