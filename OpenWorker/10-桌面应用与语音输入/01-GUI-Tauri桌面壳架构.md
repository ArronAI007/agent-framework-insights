# GUI:Tauri 桌面壳架构

> OpenWorker 的 README 用一张三层图概括了整个桌面产品:最上层是"native shell + GUI",中间是"local agent server (Python)",底层才是文件、工具、模型这些真正干活的东西。这三层分属三种技术栈——TypeScript/React、Rust/Tauri、Python——却要在用户点开一个应用图标之后,表现得像一个单一、连贯的程序。这篇拆开 `surfaces/gui/` 这个目录,看 Tauri 壳具体怎么把一个独立的 Python 子进程"管"起来,认证 token 怎么在跨进程边界之间传递而不落盘,以及前端那一串看似普通的 npm 依赖(`react-markdown`、`pdfjs-dist`、`xlsx`)是如何撑起 README 里"Produce real deliverables"这句承诺的。

## 学习目标

- 理解 `surfaces/gui/src-tauri/src/lib.rs` 里 `run()` 函数如何拉起、监督、并在退出时清理 Python `openworker-server` 子进程,以及为什么它要自己探测一遍用户的登录 shell 环境。
- 弄清 per-launch token 认证在两种运行形态下的区别:`npm run dev` 起的独立 server 会把 token 写进 `<state-dir>/sidecar-<port>.token` 文件,而 Tauri 桌面壳生成的 token 只活在内存里,从不落盘——两端分别对应 `coworker/server/run.py` 的 `_ensure_api_token` 和 `lib.rs` 的 `launch_token()`。
- 看懂前端 `surfaces/gui/src/api.ts` 如何用一个模块级 `fetch` 包装器和 `Session` WebSocket 类统一消费后端的事件流,并把认证 token 分别塞进 HTTP 请求头和 WebSocket 子协议。
- 区分 `src-tauri/capabilities/default.json` 声明的操作系统级权限边界,和治理系统在应用层做的审批门槛——两者在完全不同的层次上起作用,不能互相替代。
- 认识前端依赖列表里 `react-markdown`/`pdfjs-dist`/`xlsx` 这类"不起眼"的包,是如何直接对应 README 强调的"文档、表格、报告能落地成可打开的文件"这条产品主张的。

## 背景与设计动机

OpenWorker 的定位不是一个聊天窗口,而是"an open-source AI coworker that lives on your desktop"——它要长期驻留在用户的桌面上,访问用户的文件、终端、日历、Slack,并且在没有模型 API 调用时也要能跑定时任务(README 里的"Standing automations")。这种产品形态天然排除了纯网页应用的路径:一个标签页关掉,后台的自动化就没了;而排除纯 Python 桌面框架(如 PyQt、Tkinter)的原因也很直接——README 明确写着 Agent 引擎"built on aisuite",核心逻辑必须是 Python,但一个能打磨出现代桌面应用观感的 UI 工具链,今天几乎只存在于 Web 前端生态里。

于是仓库选择了一种如今在桌面应用里越来越常见的组合:Tauri 提供原生窗口壳(比 Electron 轻,不用整个打包 Chromium + Node),React 写界面逻辑,Python 继续跑 Agent 引擎——三者之间用 HTTP + WebSocket 通信,而不是像某些同类项目那样用 stdin/stdout 行协议(那是给纯终端 UI 用的组合方式)。选择 HTTP/WS 而不是行协议,一个直接的好处在 `lib.rs` 顶部的模块注释里写得很清楚:"single codebase — the browser build still hits 8765"。也就是说,`surfaces/gui/` 下的 React 代码只有一份,浏览器版(`npm run dev`)和桌面版(`npm run tauri dev`)运行的是完全相同的前端产物,区别只在于运行时注入的几个全局变量指向哪个端口、要不要带认证 token。这是一种用"运行时配置差异"换"单一代码库"的工程选择,避免了维护两套前端实现。

## 核心机制详解

### 三层架构:谁在什么时候启动谁

`lib.rs` 文件头部的模块文档把 Tauri 壳的职责列得非常克制,只有四条:

```rust
//! OpenWorker desktop shell.
//!
//! Tauri is a thin native window over the existing React SPA. It:
//!   1. picks a free localhost port and starts the Python `openworker-server` as a managed
//!      sidecar on that port (so it never clashes with a hand-run server on 8765);
//!   2. injects the sidecar HTTP/WS addresses and per-launch authentication token before the
//!      SPA loads (single codebase — the browser build still hits 8765);
//!   3. lives in the system tray: closing the window hides it (keeps MyHelper + the scheduler
//!      running); only tray → Quit stops the sidecar;
//!   4. exposes native commands: folder picker, autostart (open-at-login), and keep-awake
//!      (caffeinate, so scheduled tasks fire while the Mac is idle).
```

这四条职责刻意地"薄"——Tauri 壳不做任何 Agent 逻辑,它只是给已经存在的 React SPA 套一层原生窗口,顺带管一下 Python 进程的生命周期。`README.md` 里对应的一句话是:"the Tauri shell launches the window and supervises the server itself"。这个"supervises"具体做了什么,值得逐段拆开看。

### Tauri 壳如何拉起并监督 Python server 子进程

`run()` 函数是整个桌面应用的入口。启动流程从选端口、生成 token 开始:

```rust
// surfaces/gui/src-tauri/src/lib.rs
pub fn run() {
    let port = free_port();
    let api_token = launch_token();
    let http = format!("http://127.0.0.1:{port}");
    let ws = format!("ws://127.0.0.1:{port}");
    let inject = format!(
        "window.__COWORKER_HTTP__={http:?};window.__COWORKER_WS__={ws:?};window.__COWORKER_API_TOKEN__={api_token:?};window.__OCW_PLATFORM__={:?};",
        std::env::consts::OS
    );
```

`free_port()` 绑定 `127.0.0.1:0` 让操作系统分配一个空闲端口——这是为了让桌面版和一个手动跑在 8765 端口上的开发用 server 互不冲突。`launch_token()` 生成一个由两段 UUID 拼接成的随机字符串:

```rust
fn launch_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
```

拿到端口和 token 之后,`setup` 钩子里真正拉起 Python 子进程:

```rust
// surfaces/gui/src-tauri/src/lib.rs（.setup 闭包内)
let mut server_cmd = Command::new(server_bin());
server_cmd
    .args(["--host", "127.0.0.1", "--port", &port.to_string()])
    .envs(sidecar_env())
    .env("COWORKER_EXIT_WITH_PARENT", "1")
    .env("COWORKER_PARENT_PID", std::process::id().to_string())
    .env("COWORKER_API_TOKEN", &api_token)
    .stdin(Stdio::null());
```

这里有三个值得注意的细节。第一,`server_bin()` 要在四种候选路径里找可执行文件:环境变量覆盖、Tauri `resources` 目录里打包好的 onedir sidecar、旧版 onefile 的兼容位置、开发环境下 repo 根目录的 `.venv`——这对应了从源码跑和打包后跑是两套完全不同的文件布局。第二,`COWORKER_EXIT_WITH_PARENT` + `COWORKER_PARENT_PID` 是显式传给 Python 进程的"父进程还活着吗"检查依据;代码注释解释了为什么不能只靠 `getppid()`——PyInstaller onefile 打包出的进程有一个 bootloader 做中间层,Python 进程实际上是壳进程的**孙进程**而不是子进程,单纯判断父进程是否重新分配(reparenting)会让两边都判断错,进而在极端情况下泄漏进程。第三,`.env("COWORKER_API_TOKEN", &api_token)` 直接把内存里生成的 token 通过环境变量传给子进程,子进程读到这个环境变量后就不会再去生成、也不会再写文件——这是下一节要展开的重点。

进程句柄被包进一个 Tauri 托管状态里:

```rust
struct ServerProcess(Mutex<Option<Child>>);
```

清理逻辑挂在 `run()` 尾部的事件处理器上,并且做了双重保险:

```rust
.run(|app, event| {
    if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
        if let Some(state) = app.try_state::<ServerProcess>() {
            if let Some(mut child) = state.0.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
        ...
    }
});
```

注释里写"orphaned servers have bitten us before"——两个事件(`ExitRequested` 和 `Exit`)都杀一次,是因为观察到过 macOS 下 Cmd+Q 有路径能绕过前一个而直接走到后一个。窗口本身的关闭行为则完全不等于进程退出:

```rust
win.on_window_event(move |event| {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let _ = w.hide();
        api.prevent_close();
    }
});
```

点右上角关闭按钮只是隐藏窗口,Python server、定时任务调度器都继续在后台跑;只有系统托盘菜单里的"Quit"才真正杀掉子进程。这个设计直接服务于 README 里"Standing automations"这条能力——一个每天早晨发简报的自动化,不应该因为用户随手关了一次窗口就停摆。

`sidecar_env()` 函数本身也值得一提,它解决的是一个 GUI 应用普遍会踩的坑:通过 Finder/Dock 启动的应用继承的是 `launchd` 给的极简 PATH(`/usr/bin:/bin:/usr/sbin:/sbin`),用户用 Homebrew、nvm、pyenv 装的工具——包括安全类 coworker 依赖的 `semgrep`、`gitleaks`、`gh`——全都不可见。函数体内用登录 shell(`sh -ilc`)跑一次 `env` 把真实环境探测出来,加了 5 秒超时防止一个卡住的 profile 脚本挡住整个应用启动,并且用 `START`/`END` 两个哨兵标记防止 shell 启动时的杂散输出被误当成环境变量解析。当进程本身就是从终端里用 `npm run tauri dev` 拉起时(`SHLVL` 环境变量存在),这一整套探测直接跳过——因为那种情况下环境本来就是真实的。

### per-launch token:桌面版内存态 vs 独立 server 落盘态

README 里这句话是整节的核心:"The standalone server creates a per-launch token at `<state-dir>/sidecar-8765.token`...The desktop app uses an in-memory launch token instead and never writes it to disk." 这个分岔点的判断逻辑在后端:

```python
# coworker/server/run.py
def _ensure_api_token(port: int) -> Path | None:
    """Set launch auth; standalone/dev tokens use a user-only, port-specific file."""
    if os.environ.get("COWORKER_API_TOKEN"):
        return None  # Tauri supplied an in-memory token; never persist it.
    token = secrets.token_hex(32)
    os.environ["COWORKER_API_TOKEN"] = token
    return write_private_text(
        state_dir() / f"sidecar-{port}.token", token + "\n"
    )
```

逻辑非常直接:如果环境变量里已经有 `COWORKER_API_TOKEN`(说明是被 Tauri 壳拉起的),函数直接返回,什么文件也不写;否则自己生成一个 32 字节的十六进制 token,写进一个按端口命名、权限收紧到当前用户的文件里,并在进程退出的 `finally` 块里把这个文件删掉(`generated_token_path.unlink(missing_ok=True)`)。这意味着即便是"独立跑 server"这种模式,token 文件也只在进程存活期间存在,不是永久凭证。

服务端用这个 token 做的鉴权覆盖了 HTTP 和 WebSocket 两条路径,分别对应不同的传递方式:

```python
# coworker/server/app.py
def _request_authenticated(request: Request) -> bool:
    provided = request.headers.get("x-openworker-token", "")
    return bool(
        api_token and provided and secrets.compare_digest(provided, api_token)
    )

def _websocket_authenticated(ws: WebSocket) -> bool:
    if not api_token:
        return True
    protocols = {
        part.strip()
        for part in ws.headers.get("sec-websocket-protocol", "").split(",")
        if part.strip()
    }
    return any(secrets.compare_digest(part, api_token) for part in protocols)
```

HTTP 走标准请求头 `X-OpenWorker-Token`,用 `secrets.compare_digest` 做常数时间比较防时序攻击;WebSocket 没有自定义请求头的余地(浏览器 `WebSocket` 构造函数不支持任意 header),于是把 token 塞进 `Sec-WebSocket-Protocol` 子协议列表里传过去。前端两条路径严格对称地实现了这一点:

```typescript
// surfaces/gui/src/api.ts
const fetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  const token = apiToken();
  if (token) headers.set("X-OpenWorker-Token", token);
  return globalThis.fetch(input, { ...init, headers });
};

const openWebSocket = (url: string): WebSocket => {
  const token = apiToken();
  return token ? new WebSocket(url, ["openworker", token]) : new WebSocket(url);
};
```

而 `apiToken()` 本身的取值顺序,恰好体现了桌面版/浏览器版/开发环境三种场景:

```typescript
const apiToken = (): string =>
  (globalThis as any).__COWORKER_API_TOKEN__ ||
  (import.meta as any).env?.VITE_COWORKER_API_TOKEN ||
  (typeof __COWORKER_DEV_TOKEN__ === "string" ? __COWORKER_DEV_TOKEN__ : "");
```

`__COWORKER_API_TOKEN__` 就是 `lib.rs` 里 `run()` 函数通过 `initialization_script` 在 SPA 加载前注入的那个全局变量,对应内存态 token;`VITE_COWORKER_API_TOKEN` 是浏览器开发场景下从 `.env` 读到的值,对应独立 server 落盘态 token(开发者需要自己把 `sidecar-8765.token` 文件的内容抄进 Vite 的环境变量,或用某种脚本自动读取);`__COWORKER_DEV_TOKEN__` 是构建时可能注入的编译期常量兜底。三层优先级共同保证了同一份前端代码在不同宿主下都能拿到正确的凭证,而不需要为每种宿主写专门的鉴权分支。

需要强调的是,这套 token 机制解决的是"防止本机其他进程冒充 UI 调用本地 Agent server"这一类威胁,而不是网络层面的身份认证——server 只监听 `127.0.0.1`,token 的意义在于同一台机器上的其他程序不能随意打开 8765/随机端口去驱动用户的 Agent。

### 前端如何消费后端的事件流

`surfaces/gui/src/api.ts` 里的 `Session` 类是前端与运行中会话对话的唯一入口,它对每个打开的会话建立一条 WebSocket 连接:

```typescript
// surfaces/gui/src/api.ts
export class Session {
  private ws: WebSocket;
  private outbox: object[] = [];

  constructor(sessionId: string, workspace: string, agent: string, handlers: Handlers) {
    const q = `?workspace=${encodeURIComponent(workspace)}&agent=${encodeURIComponent(agent)}`;
    this.ws = openWebSocket(`${wsBase()}/ws/session/${sessionId}${q}`);
    this.ws.onmessage = (e) => {
      try {
        handlers.onEvent(JSON.parse(e.data));
      } catch {
        /* malformed frame — ignore */
      }
    };
    this.ws.onopen = () => {
      this.flush();
      handlers.onOpen?.();
    };
    this.ws.onclose = () => handlers.onClose?.();
  }

  private send(payload: object) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
    else if (this.ws.readyState === WebSocket.CONNECTING) this.outbox.push(payload);
  }
  ...
}
```

值得留意的是 `outbox` 这个小机制:如果用户在 WebSocket 还没握手完成的窗口期就发了消息(比如页面刚加载完就立刻提交了一条初始 prompt),`send` 不会丢弃这条消息,而是先存进 `outbox`,等 `onopen` 触发之后用 `flush()` 补发。这是一种"消息不因为时序竞争而丢失"的防御性写法,注释里称之为"belt-and-suspenders"。`Session` 类之外还封装了 `approve`/`allowAnyway`/`respondDirectory`/`respondTool`/`respondPlan` 等一组方法,分别对应治理系统各类审批弹窗的用户回应——这些方法把 UI 上的一次点击,序列化成协议里约定好的 `{type, ...}` JSON 帧发给后端。事件流协议本身(`WsEvent` 的具体形状、`turn_start`/`assistant_delta`/`tool_proposed`/`permission_required` 这些事件类型)由后端的会话引擎定义并推送,是贯穿整个 Agent 核心循环的基础设施,这里只关注前端消费这条流的方式:一条 WebSocket、一个事件回调、一个用于审批交互的命令式方法集合。

`e2e/README.md` 里对这套协议的描述从另一个角度印证了它的严谨性——GUI 的端到端测试用一个"scripted fake agent"在网络层重放同样的 `{type, data}` 协议(`ready` → `user_message` → `turn_start` → 增量 → `assistant_message` → `turn_done`,遇到包含"run a tool"的消息则改发 `tool_proposed` + `permission_required` 并暂停等待 `approval` 决策),这使得 GUI 的发送/流式渲染/审批代码路径可以在零模型开销的情况下被完整测试到。

### `capabilities/` 声明的系统权限边界

`src-tauri/capabilities/default.json` 是 Tauri 2.x 的权限声明文件,决定了这个 WebView 窗口在原生层面能调用哪些命令:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capabilities for the main coworker window.",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-hide",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    "core:window:allow-unminimize",
    "dialog:default",
    "autostart:default"
  ]
}
```

这份清单很短:窗口的显示/隐藏/聚焦/取消最小化(对应托盘"Open"和单实例重新聚焦的场景)、原生对话框(文件夹选择器)、开机自启动。它没有声明文件系统、shell、网络这些更敏感的 Tauri 插件权限——因为 OpenWorker 的桌面壳本身并不需要直接触碰用户文件或执行命令,那些操作全部发生在 Python `openworker-server` 进程里,由治理系统的审批链路控制。`entitlements.plist` 则是 macOS 层面更底层的授权,只声明了两条:

```xml
<key>com.apple.security.cs.disable-library-validation</key>
<true/>
<key>com.apple.security.device.audio-input</key>
<true/>
```

前者是 PyInstaller 打包的 Python 运行时需要加载非同一 Team ID 签名的动态库时必须放行的选项;后者是语音输入功能读取麦克风所必需的硬化运行时(hardened runtime)授权,注释里特别指出:"Info.plist's NSMicrophoneUsageDescription is only the prompt text, not the grant"——也就是说 `Info.plist` 里的文案只负责弹窗提示语,真正决定"能不能拿到麦克风"的是这条 entitlement。

这里恰好能说明两个不同层次的"权限边界"如何分工:`capabilities/`、`entitlements.plist` 这一层管的是"这个应用作为一个操作系统进程,能不能碰摄像头、麦克风、任意文件系统调用"——这是 OS 和应用商店审核关心的静态声明,一旦签名打包就固定下来,运行期不能动态更改。而 OpenWorker 的治理系统(写、发送、执行 shell 命令的三层门槛与逐次审批)管的是另一件事:"这个已经拿到了系统权限的进程,这一次具体要写哪个文件、发哪条消息、跑哪条命令,用户是否当场同意"——这是应用层面对每一次具体动作的运行时决策,会根据审批历史、自动放行规则动态变化。前者是一次性的、粗粒度的"能不能"(不管 Agent 想不想读文件,这个进程物理上就是能读文件的桌面应用,不受 App 沙盒隔离),后者是持续的、细粒度的"这一次要不要"。两层缺一不可:没有前者,应用连基本功能都跑不起来;没有后者,一个能访问文件系统的进程就没有任何行为约束。

### 前端依赖如何撑起"真实可交付成品"

`surfaces/gui/package.json` 里的依赖列表,拆开看每一项都对应 README"What it can do"一节里的具体承诺:

```json
"dependencies": {
  "i18next": "^26.3.6",
  "pdfjs-dist": "^4.10.38",
  "react": "^18.3.1",
  "react-dom": "^18.3.1",
  "react-i18next": "^17.0.11",
  "react-markdown": "^10.1.0",
  "remark-gfm": "^4.0.1",
  "simple-icons": "^16.26.0",
  "xlsx": "^0.18.5"
}
```

`react-markdown` + `remark-gfm`(GitHub Flavored Markdown 扩展,支持表格、任务列表、删除线)负责把 Agent 回复里的 Markdown 文本渲染成排版正常的富文本——这是对话界面最基础的需求。`pdfjs-dist` 是 Mozilla 的 PDF.js 在 npm 上的分发包,让前端可以在不依赖系统 PDF 阅读器的情况下,直接在应用内预览 Agent 产出的 PDF 报告;`xlsx`(SheetJS)则处理表格类交付物的读写,对应 README 里"spreadsheets"这一类文档形态——如果 Agent 生成了一份 Excel 报表,用户能在右侧栏直接打开看内容而不必等下载完成后再启动 Excel。这些依赖共同支撑的是 `api.ts` 里 `ArtifactContent`/`getArtifacts`/`readArtifact` 这组接口背后的产品逻辑:Agent 干完活不是把结果甩进聊天记录里等用户自己去文件管理器里找,而是作为"Artifact"直接可预览、可在系统文件管理器里"reveal"。

`i18next` + `react-i18next` 支撑多语言——`surfaces/gui/src/locales/` 下的 `en.json`/`zh.json` 是当前落地的两种语言,`i18n.ts` 负责运行时的语言切换和加载。`simple-icons` 则是一个体量不小但很实用的选择:它收录了几千个品牌的官方单色 SVG 图标,`connectors/registry.tsx` 用它给 25+ 个连接器(GitHub、Slack、Jira、Notion……)配上准确的品牌图标,而不是每个连接器都要美术单独出一版图标资源——文件头部的注释还提到 Slack、Salesforce、Outlook、Canva 这几个品牌因为商标方要求已经从 `simple-icons` 包里撤下,只能在仓库里手工 vendor 一份路径数据,这是一个第三方图标包生态里常见的、需要工程上主动应对的现实问题。

## 常见问题/易踩坑

- **不要以为 `stt/` crate 是独立进程**:`surfaces/gui/src-tauri/Cargo.toml` 里 `ocw-stt = { path = "../../../stt" }` 是一条普通的 Rust 路径依赖,和 Tauri 壳编译进同一个二进制、跑在同一个进程里。README 表格里说它是"speech-to-text sidecar",这个"sidecar"指的是它在代码组织上是一个独立、可复用、不依赖 Tauri 的库 crate,而不是操作系统意义上的另一个子进程——这一点和真正作为独立子进程存在的 Python `openworker-server` 有本质区别,下一篇会展开。
- **token 落盘与否不是"安全性差异",而是"生命周期差异"**:两种模式的 token 都是每次启动随机生成、进程退出即失效;区别只在于独立 server 模式下需要一个文件把 token 从后端进程传给同样独立启动的前端开发服务器,而桌面模式下 Tauri 壳本身就同时持有并注入这个值,不需要文件这个中间媒介。
- **`capabilities/default.json` 改动要谨慎**:新增一个 Tauri 插件权限意味着放宽了 WebView 能调用的原生命令范围,这和治理系统里放宽某个工具的审批规则是两件完全独立的事,不要把两者的改动混在一次评审里。

## 小结

OpenWorker 的桌面壳是一个刻意做"薄"的 Rust/Tauri 程序:它只管拉起 Python server、监督其生命周期、在系统托盘里维持后台存活、并把动态端口和内存态认证 token 注入到启动前的 SPA 里,真正的 Agent 逻辑、文件访问、工具执行全部留在 Python 进程一侧,由治理系统统一把关。前端与后端之间的 HTTP + WebSocket 通信,用同一份 `X-OpenWorker-Token`/`Sec-WebSocket-Protocol` 鉴权机制贯穿两种运行形态——桌面版内存态、独立 server 落盘态——保证了同一份前端代码不需要为不同宿主写分支逻辑。`capabilities/` 和 `entitlements.plist` 声明的是操作系统级、打包时固化的权限边界,与治理系统运行时逐次审批的应用级门槛,分别在两个不同层次上共同构成了"这个应用能做什么"的完整答案。下一篇转向这套桌面产品里最"跨界"的一块:`stt/` 语音输入 sidecar 到底是怎么实现的,以及 `packaging/` 目录如何把 Python、Rust、TypeScript 这三种完全不同的构建产物,拧成一个用户可以直接下载安装、还能自动升级的桌面应用。
