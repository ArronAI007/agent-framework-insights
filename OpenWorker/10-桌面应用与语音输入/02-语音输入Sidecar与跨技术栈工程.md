# 语音输入 Sidecar 与跨技术栈工程

> 上一篇拆完了 Tauri 壳如何监督 Python `openworker-server` 这个真正意义上的独立子进程,这一篇转向仓库里另一个自称"sidecar"的组件——`stt/`。它和 `openworker-server` 表面上被 README 用同一张表格并列描述,骨子里却是完全不同的工程形态:一个是跨进程、跨语言运行时的子进程管理,另一个是编译期静态链接的 Rust 库 crate。把这两者的区别看清楚,再顺着 `packaging/` 目录看这三种技术栈(Python、Rust 桌面壳、Rust STT 库)最终怎么被拧成一个用户能双击安装的 `.dmg`/`.exe`,是理解"把一个 Agent Harness 做成桌面产品"这件事需要额外投入多少工程量的最好切口。

## 学习目标

- 弄清 `stt/` crate 的真实定位:它是一个 Tauri-free、可被其他产品复用的 Rust 库,通过 Cargo 路径依赖被静态编译进桌面壳的同一个二进制,而不是一个独立启动、独立通信的操作系统进程。
- 读懂 `Dictation` 结构体如何用一个专用线程隔离 `cpal` 的 `!Send` 音频流对象,以及模型下载、SHA-256 校验、本地转写这条链路的具体实现。
- 理解 `packaging/openworker-server.spec` 如何用 PyInstaller 把整个 Python 后端(包括 `aisuite`、`uvicorn`、可选的消息连接器)冻结成一个不依赖用户机器 Python 环境的 onedir 可执行文件夹。
- 看懂 `build_dmg.sh`/`build_windows.ps1` 如何把 PyInstaller 产物、Tauri 打包产物这两条完全独立的构建流水线,在同一次构建里合流成一个签名、公证、可分发的安装包。
- 认识 `make_update_manifest.py` + `tauri-plugin-updater` + minisign 签名共同构成的自动更新机制,以及它对"桌面产品"这个形态提出的、纯后端服务不需要考虑的额外要求。

## 背景与设计动机

一个只需要跑在服务器上的 Agent Harness,交付形态可以很简单:一个 Docker 镜像,或者一条 `pip install` 命令。但 OpenWorker 选择的是桌面应用这条路——README 的下载区直接给出 macOS `.dmg` 和 Windows 安装包的链接,并且强调"auto-updates"。这个选择带来了一整层纯后端项目不会遇到的工程负担:目标用户的机器上大概率没有装 Python、没有装 Node、不知道什么是虚拟环境;应用还要能读写用户的麦克风做语音输入;发布出去的二进制要经过操作系统的签名与公证机制,否则用户点开安装包看到的第一件事就是"来源不明,已阻止运行"的警告;版本更新也不能指望用户自己回到官网重新下载。

`stt/` 这个语音输入模块进一步放大了这层负担:它依赖一个几百 MB 的语音识别模型文件、需要跨平台读取麦克风、需要处理浮点音频重采样,还要在打包阶段决定这个模型是随应用一起分发还是运行时按需下载。`packaging/` 目录里那几个脚本文件的体量和注释密度(`build_dmg.sh` 单文件接近三百行,大半是注释),恰好说明了"把 Agent 核心逻辑做出来"和"把它做成一个普通人愿意也能够安装、信任、长期使用的桌面产品"之间,存在相当大的距离。

## 核心机制详解

### `stt/`:进程内库,而非独立进程

先纠正一个容易望文生义的地方。README 的仓库结构表把 `stt/` 描述为"Speech-to-text sidecar (Rust) for voice input",而"sidecar"这个词在容器编排、服务网格的语境里通常指与主进程并行运行、通过 IPC 通信的独立进程——上一篇提到的 Python `openworker-server` 正是这个意义上的 sidecar:它由 Tauri 壳 `Command::new(server_bin()).spawn()` 拉起,是一个独立的、有自己 PID、通过 HTTP/WebSocket 通信的操作系统进程。

但 `stt/` 完全不是这么回事。它的 `Cargo.toml` 声明:

```toml
[package]
name = "ocw-stt"
version = "0.1.0"
description = "Local, offline speech-to-text engine for OpenWorker hosts"
```

而桌面壳的 `Cargo.toml` 里这样引用它:

```toml
# surfaces/gui/src-tauri/Cargo.toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
...
# Kept outside the Tauri shell so another product can depend on the same local STT engine.
ocw-stt = { path = "../../../stt" }
```

这是一条普通的 **Cargo 路径依赖**——`ocw-stt` 在编译时被静态链接进 `openworker-desktop` 这一个二进制里,运行时是同一个进程、同一个地址空间,没有进程边界,没有 IPC,没有序列化协议。`lib.rs` 顶部对这层设计的注释说得很直接:"The actual microphone/model code lives in the Tauri-free `ocw-stt` crate. This shell owns the macOS permission prompt and translates the reusable API into React-friendly Tauri commands." 这里"sidecar"真正想表达的含义是**代码组织上的独立**:`ocw-stt` 不依赖 Tauri 的任何类型或运行时,任何其他 Rust 项目——不管是不是桌面应用——都可以把这个 crate 原样接进去获得同一套本地语音识别能力。这是"物理进程隔离"与"代码库/关注点隔离"两种完全不同的模块化手段,项目选择了后者,因为语音识别这个功能不需要像 Agent 引擎那样运行在独立的、可以单独重启和监控的进程里,反而是与调用它的宿主进程共享地址空间更省一次 IPC 的序列化开销(麦克风采样率本身就要求较低延迟)。

### `Dictation`:单线程持有音频流,命令式对外暴露状态机

`ocw-stt` 的公开接口收敛成一个 `Dictation` 结构体,`lib.rs` 里对它的职责描述很克制:

```rust
/// A reusable single-microphone dictation session manager.
///
/// It records only while a host has explicitly started a session; audio is held in memory for
/// that session and is never persisted. The downloaded recognition model is the only data kept
/// under `model_dir`.
pub struct Dictation {
    model_path: PathBuf,
    verified_marker_path: PathBuf,
    ready_marker_path: PathBuf,
    commands: Sender<Command>,
    recording: Arc<Mutex<bool>>,
    live: Arc<Mutex<Option<(Arc<Mutex<Vec<f32>>>, u32)>>>,
    download_in_progress: AtomicBool,
    cancel_download: AtomicBool,
}
```

构造函数里有一处专门的注释解释了为什么要单独起一个线程:

```rust
impl Dictation {
    pub fn new(model_dir: impl Into<PathBuf>) -> Self {
        // CPAL's CoreAudio stream is intentionally !Send. Keep it on one dedicated owner thread
        // rather than unsafely forcing it through Tauri's Send + Sync application state.
        let (commands, receiver) = mpsc::channel();
        ...
        thread::spawn(move || capture_worker(receiver, worker_recording, worker_live));
        ...
    }
}
```

`cpal`(Cross-Platform Audio Library)在 macOS 上封装的 CoreAudio 流对象不是 `Send` 的——这是音频框架的常见约束,因为底层的音频回调往往要求固定在某个线程上执行。Tauri 的应用状态要求托管对象是 `Send + Sync`,如果强行把这个流对象塞进 Tauri state,要么编译不过,要么得用 `unsafe` 手动断言线程安全(这在音频流对象上是危险的)。项目的解法是让 `capture_worker` 独占一个专用线程,`Dictation` 通过一个 `mpsc::channel` 发送 `Start`/`Stop`/`Cancel` 三种命令给这个线程,线程内部持有真正的 `cpal::Stream`,外部只通过 channel 消息和共享的 `Arc<Mutex<..>>` 状态交互——这是一条经典的"把非 Send 资源锁在一个所有者线程里,靠消息传递解耦"的 Rust 并发模式。

模型下载、校验、转写构成了这个 crate 另一条主线逻辑。默认模型是 Whisper 的 `ggml-base.en.bin`(约 142MB),下载地址、字节数、SHA-256 都写死为常量:

```rust
pub const DEFAULT_MODEL_FILE: &str = "ggml-base.en.bin";
pub const DEFAULT_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
pub const DEFAULT_MODEL_BYTES: u64 = 147_964_211;
pub const DEFAULT_MODEL_SHA256: &str =
    "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";
```

下载函数 `install_default_model_with_progress` 用 `ureq`(一个同步、轻量的 HTTP 客户端)分块读取,边下载边通过回调上报进度,写入一个 `.bin.part` 临时文件;下载完成后调用 `verify_model_file` 重新计算整个文件的 SHA-256 并与常量比对,只有校验通过才把 `.part` 文件原子地 `rename` 成正式的模型文件名,并写一个记录了哈希和文件修改时间的 `.verified` 标记文件。这一整套"先落临时文件、校验、再原子改名"的流程,保证了一次中断或失败的下载永远不会替换掉一个已经验证过的旧模型——`cancel_download` 标志只在每次读循环之间被检查,所以取消操作最坏情况下也只是多读一个 64KB 缓冲区的延迟,不会真正卡住。

真正的转写调用 `whisper-rs`(`whisper.cpp` 的 Rust 绑定):

```rust
fn transcribe(model_path: &Path, samples: &[f32]) -> Result<String, String> {
    let context = WhisperContext::new_with_params(..., WhisperContextParameters::default())?;
    let mut state = context.create_state()?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_translate(false);
    ...
    state.full(params, samples)?;
    ...
}
```

`Cargo.toml` 里对这个依赖的版本选择有一条专门的注释:"Keep the v1 engine compatible with macOS releases that predate newer Metal APIs. We can add an opt-in Metal build once the packaged app has a verified minimum macOS target."——也就是说当前版本刻意没有启用 Metal GPU 加速,以换取对更老版本 macOS 的兼容性,这是一个"性能 vs 兼容面"的权衡留痕。整条链路的输入侧还有一处重采样逻辑(`resample_mono`),把麦克风实际采样率(往往是 44.1kHz/48kHz)线性插值转换到 Whisper 要求的 16kHz——这是接入任何语音模型都绕不开的一步预处理。

`Dictation` 暴露给宿主(Tauri 壳)的方法基本一一对应 `lib.rs` 里注册的 Tauri 命令:`status`/`start`/`stop_and_transcribe`/`cancel`/`install_default_model_with_progress`/`verify_default_model`/`mark_test_passed`/`delete_default_model`/`input_level`。`lib.rs` 把它们包装成 `#[tauri::command]` 函数,再由前端 `surfaces/gui/src/tauri.ts` 的 `invoke`/`invokeStrict` 调用——这一层薄薄的转译,正是模块注释里"translates the reusable API into React-friendly Tauri commands"这句话的具体所指。麦克风权限的系统弹窗、macOS/Windows 各自的硬件兼容性判断(`voice_input_compatibility`,检查是否是 Apple Silicon、Windows 版本号是否达标)则完全留在 `lib.rs` 里,没有渗透进 `ocw-stt` crate——这条边界线划得很清楚:crate 只管"怎么录、怎么识别",宿主管"能不能录、要不要提示用户"。

### `packaging/`:把三种技术栈拧成一个安装包

如果说 `stt/` 是"进程内集成",那 `packaging/` 处理的就是真正的**跨技术栈打包**问题:Python 后端、Tauri/Rust 桌面壳(内含静态链接的 STT 库)要合并成一个用户可以直接安装的产物。这个流程分两条独立的构建流水线,再在最后一步合流。

第一条流水线是把 Python 后端冻结成可执行文件。`packaging/openworker-server.spec` 是 PyInstaller 的构建规范,`packaging/server_entry.py` 是它的入口脚本:

```python
# packaging/server_entry.py
"""PyInstaller entry point for the bundled desktop sidecar server.

Thin wrapper so PyInstaller has a concrete script to analyze (the console_script
`openworker-server` is generated metadata, not a file). Runs the same `main()`.
"""
from coworker.server.run import main

if __name__ == "__main__":
    main()
```

之所以需要这个几行的包装文件,是因为 `pyproject.toml` 里定义的 `openworker-server` 命令行入口点是 setuptools 生成的元数据(console_script),并不是一个实际存在的 `.py` 文件,而 PyInstaller 需要分析一个真实的脚本文件作为起点。`.spec` 文件里最值得注意的是它如何应对 PyInstaller 静态分析的局限——很多 Python 包用动态导入(`importlib`、字符串形式的模块路径),PyInstaller 的静态依赖扫描看不到这些导入路径,于是 spec 文件手工用 `collect_submodules`/`collect_all` 把它们强行囊括进来:

```python
for pkg in ("uvicorn", "certifi", "anyio", "websockets", "pypdf", "pypdfium2"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h
```

注释解释了每一个的必要性:`uvicorn` 动态加载协议/生命周期实现;`websockets` 是 Slack 托管中继客户端在函数内部才 `import` 的,静态分析必然漏掉;`certifi` 的 CA 证书包和 `pypdfium2` 携带的 `libpdfium` 动态库都属于"数据文件"而非"代码",只有 `collect_all` 才会连带搬运。builtin personas(`coworker/personas/builtin/`)同样以 `.md` 文件形式存在而非 `.py`,`collect_data_files("coworker")` 专门确保这些非代码资源不会在打包后凭空消失——spec 文件里的注释直接点出了后果:"without this the packaged sidecar starts with NO builtin coworkers — the picker comes up empty"。

打包产物选择 onedir(可执行文件 + `_internal/` 支持目录)而不是更"干净"的 onefile,`build_dmg.sh` 的头部注释给出了实测数据:onefile 每次启动都要把整个归档自解压到临时目录,实测 6-7 秒的"Starting coworker…"启动白屏,而实际的 Python 导入只需要约 0.5 秒——onedir 用一次性的目录铺开换来了每次启动的性能。

第二条流水线是 `npm run tauri build` 本身产出的 Rust/前端产物。两条流水线在 `build_dmg.sh` 的第 2 步合流:

```bash
# packaging/build_dmg.sh
echo "==> [2/5] staging sidecar resources"
mkdir -p "$GUI/src-tauri/binaries"
rm -rf "$GUI/src-tauri/binaries/sidecar" ...
cp -RL "$HERE/dist/openworker-server" "$GUI/src-tauri/binaries/sidecar"
```

PyInstaller 产出的 onedir 目录被整体拷贝进 `src-tauri/binaries/sidecar/`,对应 `tauri.conf.json` 里的资源映射:

```json
"bundle": {
  "resources": { "binaries/sidecar": "sidecar" }
}
```

`tauri build` 执行时会把这个目录原样塞进最终应用包(macOS 下落在 `Contents/Resources/sidecar/`,Windows 下落在安装目录同级的 `sidecar/`)——这正好对应上一篇 `server_bin()` 函数里第二优先级的候选路径。这一步里 `cp -RL`(解引用符号链接)不是随手加的参数,脚本注释记录了两次踩坑:Python.framework 内部的符号链接如果不解引用直接打包,会在 Tauri 的资源打包阶段被"拍平"成独立的真实文件副本,但这些副本脱离了 framework 语境后签名校验不通过,导致公证被拒绝了两次;脚本索性在拷贝时就解引用、再显式删除整个伪 `Python.framework` 目录,确保打包产物里不存在任何触发 framework 签名推断的路径结构。这类"因为一次失败的公证记录而写进脚本的防御性检查"贯穿了整个 `build_dmg.sh`——包括校验签名后的 sidecar 目录里不能再有符号链接、不能再有 `.framework` 目录这两处显式 `exit 1` 检查。

`build_windows.ps1` 是同一套思路的 Windows 版本,只是省去了签名/公证/DMG 卷标美化这些 macOS 特有的步骤,产出 NSIS 安装包(`.exe`)和 `.msi` 两种安装介质。两个脚本共享同一个版本号来源——都从 `tauri.conf.json` 的 `version` 字段读取,保证同一次发布里 Python 后端、Rust 壳、安装包文件名对应的是同一个版本。

### 自动更新:manifest、签名、`tauri-plugin-updater` 三件套

打包出来的应用要能自动升级,需要三个部分配合。第一部分是 `tauri.conf.json` 里的更新器配置:

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://download.openworker.com/latest.json",
      "https://github.com/andrewyng/openworker/releases/latest/download/latest.json"
    ],
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6...",
    "windows": { "installMode": "passive" }
  }
}
```

`pubkey` 是一个 minisign 公钥,客户端只信任用对应私钥签过名的更新包。第二部分是 `packaging/make_update_manifest.py`,它在 CI 发布流程里把已经产出并签名的各平台安装包,拼装成一份客户端能读懂的 `latest.json`:

```python
ARTIFACTS = {
    "OpenWorker-macos-arm64.app.tar.gz": "darwin-aarch64",
    "OpenWorker-macos-x64.app.tar.gz": "darwin-x86_64",
    "OpenWorker-windows-setup.exe": "windows-x86_64",
}
...
if not sig.exists():
    print(f"warning: {asset} has no .sig — skipping {platform} (unsigned updates never install)", file=sys.stderr)
    continue
```

脚本对"缺签名"这件事的处理很克制:不是报错终止整个发布,而是跳过这一个平台,让其他平台正常发布——一次 mac-only 的热修复不该因为 Windows 产物暂时缺失而被整个拦下。manifest 里的下载地址永远指向具体 tag 而不是 `latest/` 路径,注释解释了原因:"a manifest must reference exactly the artifacts it shipped with, or a half-published release would mix versions"——这是为了防止一次发布过程中途被覆盖导致清单和实际产物版本不一致。第三部分是运行时:`lib.rs` 里注册的 `check_for_update`/`download_update`/`install_update` 三个 Tauri 命令,底层调用 `tauri-plugin-updater` 完成"查询 manifest → 校验 minisign 签名 → 下载 → 安装 → 重启"整条链路,`lib.rs` 里专门做了预下载优化(`download_update` 在提示用户之前就把更新包下载并缓存进内存,用户点击"Restart to update"时是从内存瞬间安装,而不是在点击后才开始一次可能长达数分钟的下载)。前端 `surfaces/gui/src/tauri.ts` 把这三个命令包成 `checkForUpdate`/`downloadUpdate`/`installUpdate`,供 `UpdateBanner.tsx` 组件驱动 UI。

`build_dmg.sh` 里这一段体现了签名密钥缺失时的降级策略:

```bash
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  UPDATER_OVERLAY=(--config '{"bundle":{"createUpdaterArtifacts":true}}')
else
  echo "    WARNING: no updater signing key — building WITHOUT auto-update artifacts (not releasable)."
fi
```

本地开发者没有签名私钥也能正常构建、正常调试应用,只是产物不带自动更新能力——这条"keyless 也能跑,只是不可发布"的设计,让贡献者不需要拿到发布密钥就能验证自己的改动。

### 观察:从"Agent 引擎"到"桌面产品"之间的额外投入

把这一篇和上一篇串起来看,能提炼出一个具体的观察:一个 Agent Harness 的核心能力(模型调用、工具执行、会话管理)可能只需要 `coworker/` 这一个 Python 包就能完整实现,但要把它做成一款普通用户愿意下载安装、长期驻留在桌面上的产品,至少还要额外投入以下几类工程——而且每一类都不是"锦上添花",缺了任何一类,产品都无法真正交到非技术用户手上:

- **进程生命周期管理**:谁在什么时机拉起谁、退出时如何保证不留孤儿进程、崩溃后是否需要重启——这些在纯服务端场景下靠容器编排/进程监控工具(systemd、Kubernetes)解决的问题,桌面场景下必须由应用自己在几百行 Rust 代码里手写。
- **无运行时依赖的可执行文件**:普通用户机器上不会有匹配版本的 Python/Node,`packaging/openworker-server.spec` 这类打包脚本要处理的是"把整个语言运行时和所有隐式导入的依赖都冻结进一个独立文件夹"这种细致到每个包动态导入行为的工作。
- **操作系统信任链**:代码签名、公证、SmartScreen——这些机制存在的目的是保护用户免受恶意软件侵害,但也意味着任何想合法分发桌面应用的团队,都要投入证书管理、CI 密钥保管、公证流程排错(`build_dmg.sh` 里那些因为真实踩过坑才写下的检查,就是这类投入的直接证据)。
- **自动更新基础设施**:manifest 生成、签名验证、多端点容灾(`download.openworker.com` 失败时回退到 GitHub Releases)——用户不会手动重新下载安装包,产品必须自己解决"怎么把修复推给已经装机的用户"这个问题。
- **原生能力的最小暴露面**:麦克风、文件系统、开机自启——每一项原生能力都要经过 `capabilities/`、`entitlements.plist` 这类声明式权限清单,并且要在系统权限对话框、应用内治理审批之间找准分工,而不是简单地"要来一个大权限一劳永逸"。

这些工作绝大部分与"Agent 变得更聪明"没有关系,却决定了一个开源 Agent 项目能不能真正跑到普通用户的桌面上,而不是停留在开发者用命令行把玩的阶段。

## 常见问题/易踩坑

- **不要把 `stt/` 当成需要单独部署或单独监控的服务**:它随桌面壳一起编译、一起启动、一起退出,没有独立的健康检查或重启逻辑;调试语音识别问题时,应该在同一个进程的日志/崩溃报告里找线索,而不是去找一个不存在的"STT 进程"。
- **onedir 打包产物不能随意用符号链接搬运**:`build_dmg.sh` 明确要求 `cp -RL` 解引用,并在拷贝之后主动检查、移除任何残留的符号链接和伪 framework 目录——这不是可选的整洁度要求,而是公证失败的直接原因,历史上已经踩过两次。
- **改动模型下载地址或哈希值要同步更新三处常量**:`DEFAULT_MODEL_URL`/`DEFAULT_MODEL_BYTES`/`DEFAULT_MODEL_SHA256` 三者任何一处与实际文件不匹配,`verify_model_file` 都会判定校验失败,已经下载好的模型也会被判定为不可信,需要用户重新下载。
- **发布一次更新至少要备齐 manifest + 签名两样东西**:`make_update_manifest.py` 在缺签名文件时只会跳过对应平台并打印警告,不会让整个流程失败——这意味着一次疏忽可能导致某个平台的用户悄悄地收不到更新,而不是在发布时就报错提醒。

## 小结

`stt/` 和 `packaging/` 从两个不同的方向补全了"桌面应用"这个形态:前者展示了一个语音识别引擎如何以 Tauri-free 库 crate 的形式,被静态编译进同一个进程,用专用线程隔离音频框架的线程亲和限制,用下载-校验-原子改名这条链路保证本地模型的完整性;后者展示了 PyInstaller、Tauri 打包、代码签名、公证、minisign 更新签名这一整套机制,如何把 Python、Rust、TypeScript 三种技术栈的构建产物拧成一个用户能双击安装、还能自动升级的单一应用。两者共同说明的是同一件事:把一个 Agent Harness 做成真正意义上的桌面产品,需要的工程投入远不止"让 Agent 更好用"这一个维度。下一章将从"桌面应用"这个具体形态里跳出来,回到贯穿全书的两个更基础的主题——OpenWorker 的安全模型到底如何设计,以及它用什么样的 Reviewer 评测方法论,去验证"审批门槛"和"自动放行规则"这套治理机制在真实场景下是否真的可靠。
