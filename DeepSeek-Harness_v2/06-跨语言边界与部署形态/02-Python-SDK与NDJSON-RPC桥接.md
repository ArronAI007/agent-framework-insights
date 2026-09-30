# Python SDK 与 NDJSON-RPC 桥接：不移植，只驱动

这一篇要回答的问题是：`dsh` 的运行时是 TypeScript/Node 写的，一个 Python 用户怎样才能在不懂 Node 的前提下用上它；跨进程的协议怎么设计才够健壮；分发时"不需要装 Node"是靠什么做到的。

结论有三句。第一，Python SDK 不移植任何 Agent 逻辑，它把完整的 `dsh` CLI 当作子进程，用 `--profile sdk` 切进 JSON-RPC serving 模式，通过 stdio 上的 NDJSON-RPC 驱动，两种语言只需维护一份 wire protocol。第二，`HarnessClient` 是一个双向协议的客户端：独立读线程、每请求一个 Queue、服务端通知的订阅与过滤、服务端反向请求，全部用标准库实现。第三，分发靠把整个 `dsh` 闭包打成单文件可执行程序随 wheel 发布，代价是要背上 ripgrep、Office 转换引擎等一堆 sidecar。

## 驱动子进程，而不是移植

`python/README.md` 一句话定位：以子进程方式驱动 DeepSeek Harness，客户端 SDK 与捆绑运行时通过 stdio 上按行分隔的 JSON-RPC 通信。这个选择的要点在于：移植意味着两种语言里维护两份行为一致的业务逻辑，驱动子进程只需要维护一份协议实现。

值得注意的是启动的对象。Python SDK 没有单独的应用入口，`python/sdk/README.md` 说得明确：它启动捆绑的 `dsh` CLI 并传 `--profile sdk`，JSON-RPC serving、Agent 组装、凭据、持久化、工具和关停行为全部由所选 profile 决定。也就是说，"要不要对外提供 JSON-RPC 接口"是 `dsh` profile 系统里的一种可插拔组合（装配了 `@deepseek-ai/dsh-sdk-jsonrpc-server` 插件），而不是为 Python 场景另做的构建产物。收益很实际：CLI 主线加了新工具、新沙箱策略，`sdk` profile 自动就有，不需要同步维护两条各自演化的路径。

仓库里有两个包分工：`deepseek-harness-sdk`（模块 `deepseek_harness`）是纯 Python 客户端；`deepseek-harness-runtime-bin`（模块 `deepseek_harness_runtime`）是运行时载体，它的 `package.json` 是一份不含业务逻辑的依赖清单，列出 `@deepseek-ai/dsh` 及全部内置工具、Provider、subagent、ACP 与 hooks 兼容层等约 130 个依赖。`python/sdk-runtime/README.md` 的说法是"没有 Python 专属的 Node 应用，也没有提交进仓库的默认 `cordis.yml`"。

## 一个健壮的 NDJSON-RPC 客户端

`HarnessClient` 用标准库 `subprocess.Popen` 启动子进程，stdin、stdout、stderr 三个管道分别处理。协议约定是：stdout 只承载协议帧，每条消息是一行紧凑 JSON 加换行；stderr 只承载诊断，由单独线程收集，用 `deque(maxlen=400)` 只留最近 400 行，超时或连接关闭时拼进错误信息。课程材料指出这个"stdout 只放协议"的约定与 TypeScript 版通用 SDK 一致，部署方不能在 stdout 上叠加日志。写入侧有一把 `_write_lock` 保护 stdin，读取侧是一个守护线程逐行 `json.loads`，无法解析的行直接跳过，读线程异常或 stdout 关闭时把错误广播给所有等待者。

请求与响应的关联不是"发一句等一句"。每个请求生成 `uuid.uuid4()` 作为 id，并建一个 `maxsize=1` 的 `queue.Queue` 登记到 `_responses` 字典，然后调用线程阻塞在自己的队列上；读线程收到响应后按 id 弹出对应 waiter，把结果或包装好的 `JsonRpcError` 放进去。这样多个请求可以真正并发挂起，互不干扰，读线程的分发也不需要知道当前有几个人在等。用 uuid 而不是自增整数，是因为不需要围绕 id 分配加锁。

```python
request_id = str(uuid.uuid4())
waiter: queue.Queue = queue.Queue(maxsize=1)
with self._lock:
    self._responses[request_id] = waiter
self._write_message({"jsonrpc": "2.0", "id": request_id, "method": method})
item = waiter.get(timeout=wait_timeout)  # 读线程按 id 投递结果
```

如果调用方传了 `on_notification`，等待循环会每 50 毫秒醒一次，把等待期间收到的通知转发给回调，而不是让它们在队列里干等到请求结束；没传回调时就是一个纯阻塞等待。

## 通知订阅与本地重建的 session 树

运行时会主动推送 notification（只有 `method`、没有 `id`）。客户端用 `subscribe_notifications` 支持多个订阅者，每次订阅是一个独立 Queue 加一个可选过滤谓词；分发时命中谓词的订阅者各收一份，没有任何订阅者命中的落进兜底的全局队列。

比较有意思的是 `subscribe_session_notifications`：订阅某个 session 及其所有后代。服务端并没有下发一棵树，客户端靠监听 `subagent.started` 通知里的 `parentSessionId`、`childSessionId`，在本地维护一张 `_session_parents` 映射表，过滤器沿这张表向上追溯，判断一条通知是否属于目标 session 的后代。这个设计把树的知情权放在客户端，服务端只需广播边沿事件，不用同步任何树快照。对一棵随子 Agent 创建销毁而不断变化的树，事件驱动的重建比推快照更省事。它的固有限制是：如果订阅发生在某个子 session 已存在、但客户端尚未见过它的 `subagent.started` 之前，那条边暂时不在映射里。

在这层之上，`api.py` 的 `Session.run()` 提供了 turn 语义：订阅 session 树通知，发出 `session_prompt`，先等到对应的 inbox 回执，再收集属于本 session 的 `session.event`，直到看到 `session.status` 为 `idle`。`final_response()` 和 `finish_reason()` 从收集到的事件里按类型倒着找答案，与 `run()` 分离，便于单独测试。

## 服务端反向请求

普通 JSON-RPC 客户端只发请求收响应，但这套协议允许服务端也发带 `id` 的请求。`_handle_message` 靠字段组合区分三类消息：只有 `id` 的是响应，只有 `method` 的是通知，两者都有的是服务端发来的反向请求，进专属队列。调用方用 `next_request()` 取出，处理后用 `respond()` 或 `respond_error()` 写回 stdin。

这条通路存在的理由是，运行时有时需要向外部世界问一个问题再往下走，材料里举的例子是某个工具执行前需要用户批准。双向协议让"服务端阻塞、等外部给答案"不需要另开一条反向连接。风险也很直接：`next_request()` 取出的每条请求都应该被及时应答，不应答的后果取决于服务端是否设置超时，课程材料中未展开。

## 拒绝隐式落到 ~/.dsh

启动参数的拼装在 `_default_launch_args()` 里。`HarnessConfig` 有 `dsh_bin`、`profile`（默认 `sdk`）、`patches`、`dsh_home`、`cwd`、`env` 和几个超时配置。其中 `dsh_home` 必须显式给出：要么在配置里传，要么子进程环境里有非空的 `DSH_HOME`，两者都没有就抛 `ValueError`，错误信息明确写着"Python SDK 从不隐式使用 `~/.dsh`"。README 的表述是 SDK 刻意不发现 `~/.dsh`。

理由是隐式落到用户主目录，在多租户、CI、并发测试里很容易悄悄读写到别的调用方的 Harness home 而不自知；启动失败比隐式共享同一个 home 危险性低得多。这与前面沙箱"找不到后端就拒绝执行"是同一种直觉：模糊的默认行为宁可拒绝。同一原则也出现在 wheel 附带的 `dsh` 控制台命令上，它转发参数给捆绑可执行文件，要求非空 `DSH_HOME`，不回退到 `~/.dsh`。

## 把整个 dsh 打成单文件

如果 Python SDK 要求用户先装 Node.js 再 `npm install`，这个包对纯 Python 团队就没意义了。`scripts/build-exe-for-python-sdk.ts` 用 `@yao-pkg/pkg` 的 `--sea`（single executable application）模式，把 `dsh-python-runtime-closure` 这个部署根打成 `deepseek-harness-sdk-runtime`，默认 Node 范围 `node24`。因为打包的是完整 CLI，`ASSET_GLOBS` 要显式覆盖 `pkg` 静态分析扫不到的部分：Markdown（内置 skill 说明）、`.dylib`、`.dll`、`.node`、`.so`、`.wasm`、`.yaml`，以及 Web 前端构建产物和 skill-badge 的图片资源，前者由 web-app 动态构建路径，后者通过 `import.meta.url` 解析。

产物按 `python/sdk-runtime/platforms.json` 分五个平台发布：linux-x64、linux-arm64、macos-arm64、macos-x64、win-x64。`hatch_build.py` 的构建钩子校验平台目录内容与声明一致，并把 wheel tag 强制设成平台专属值 `py3-none-{platform_tag}`，而不是纯 Python 的默认值。

完整 CLI 带来的行李不少。每个平台包还要求一个 `<可执行文件名去掉扩展名>-office/` 目录，里面是完整安装的 Office 转换引擎及其依赖，缺失会让 sidecar 构建失败并报出 npm 包名和目标平台；Linux 与 macOS 附带 ripgrep（`-rg`），Windows 附带 `-rg.exe`，macOS 另有 `-spawn-helper`；每个 wheel 还带随包分发的 `primary-runtime/`（一个 CPython 与锁定版本的 Office Python 库）和 `office-skills/`。这些是普通可搬迁文件而不是嵌进 exe 的资源，打包和安装期检查都会拒绝缺失资源、错误平台元数据或丢失可执行权限。这里有个技术原因：SEA 产物内部是虚拟文件系统，而 Office 引擎需要 spawn 真实子进程、使用真实路径，所以入口 `runtime-bootstrap.mjs` 要把 Office 相关的 import 解析重定向到 exe 旁边真实存在的目录，并在检测到自己被当作沙箱 ACL runner 或 PTC runtime 子进程重新拉起时切换角色，不重走完整启动。`DSH_BUNDLED_PRIMARY_RUNTIME` 是载体给出的默认值，`sdk` profile 在 `DSH_PRIMARY_RUNTIME` 未设置时使用，显式路径覆盖它，空字符串则禁用查询和 Office provider。

## 载体选择与三种消费形态

生产环境只走 exe。`resolve_bundled_launch_args` 的优先级是显式参数、环境变量 `DSH_RUNTIME_MODE`（`exe` 或 `node`）、自动选择；自动解析只找生产 exe，开发用的 node 载体必须显式选择，源码注释的理由是生产部署不能悄悄跑在源码构建上。贡献者调试的方式现在是两条：设 `DSH_RUNTIME_MODE=node` 复用构建脚本刷新的部署闭包（要求系统 Node 至少 22.19），或把 `dsh_bin` 指向本地构建的 `apps/cli/lib/bin.js`，且必须显式给 `dsh_home`。两条路跑的都是正常的 `dsh --profile sdk` 启动器。测试里保留的 `_launch_args` 整条 argv 替换口子，README 明确说是内部 fake-runtime 测试适配器，不是公开 API。

放进整体坐标系看，`dsh` 有三种消费形态：Web Client 通过 WebSocket 连 Host，消费 Typert 生成的契约，面向浏览器里的人；直接 npm 依赖，在同一进程内组装 Cordis 插件，可以定制到插件级别；Python 子进程完全不共享进程空间，只认 NDJSON-RPC，启动的进程和终端里敲 `dsh --profile sdk` 是同一个二进制。耦合度依次降低、可移植性依次提高，可定制深度则依次下降：Python 一侧只能通过协议暴露的方法加 `--patch` 补丁机制交互。

## 我的看法

读下来我觉得有两处值得留意，都是判断而非官方结论。一是读线程对无法解析的行直接 `continue`，静默丢弃。stdout 纪律靠约定维持，如果部署方违反了"不在 stdout 叠加日志"，问题会表现为请求悬挂而不是明确报错；不过材料里 stderr 缓冲和关闭时统一失败所有 waiter 的处理，已经补上了大部分可诊断性。二是 wheel 的体积与平台矩阵：完整 CLI、Office 引擎、CPython 和 ripgrep 都随包分发，换来了零依赖安装，但对只想用最小 Agent 循环的用户，这是较重的成本。材料中提到有独立的 `sdk-minimal` 树，但细节课程材料中未展开。

## 小结

- 跨语言接入选择"驱动完整 CLI 子进程"，而不是移植；`sdk` 只是 `dsh` 的一个 profile，新能力自动继承。
- NDJSON-RPC 客户端用独立读线程加逐请求 Queue 支撑并发，用本地重建的 session 树做通知过滤，并支持服务端反向请求。
- 分发靠单文件 exe 加平台专属 wheel 一步到位，代价是 Office、ripgrep 等 sidecar 的重量；显式 `dsh_home` 则是拒绝模糊默认值的一次收紧。

对应原课程篇目：`DeepSeek-Harness/06-跨语言边界与部署形态/02-Python-SDK与NDJSON-RPC桥接.md`
