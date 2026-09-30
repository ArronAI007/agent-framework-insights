# Skill 技能系统与动态插件扩展：能力边界该在启动时固定，还是运行中调整

这一篇要回答的问题是：Agent 的能力可以在运行中扩展，但扩展多少、以什么信任代价，`dsh` 怎么划这条线。

三句话概括。Skill 系统是温和的一端：一份"名字加一句话描述"的目录随会话常驻，完整正文只在模型点名要用时才加载，本领是静态的操作说明，不带来新的执行权限。Cordis 动态插件是彻底的一端：模型写出真正会被执行的代码，装进宿主，相当于给自己造工具；当前模型侧只剩两个只读自省工具，自我扩展改走"工作区写插件包，再用 `plugin_manager install_bundle` 持久安装到 Profile"。这扇门被锁在一个非默认的 `cordis` 预设里，源码多处明说沙箱"不是安全边界"。

## Skill：目录常驻，正文按需

一套技能库越丰富，越容易把每个 skill 的完整说明都塞进 system prompt。`dsh` 把这件事拆成两个方法。`packages/skill/skill/src/index.ts` 里的 `SkillProvider` 有 `list()` 和 `get()`：`list()` 返回轻量候选（`name`、`description`、`whenToUse?`、`invocation`、`source`、`provider`），不含正文；`get()` 才加载带 `content` 的完整 `SkillDefinition`。`list()` 的返回可以是完整数组，也可以是 `SkillProviderObservation`（`{ candidates, complete }`），后者的 `complete: false` 告诉调用方这批结果暂时不能长期缓存；Provider 还能通过 `SkillProviderControl.invalidate()` 主动让目录缓存失效。

`SkillRegistry` 是分层注册表：host 级 Provider 加每个 Agent Preset 自己的层，同名冲突按固定优先级取最近层，`RUNTIME_RANK=250`、`BUNDLED_SKILL_RANK=600`，数值越小越优先。它的一个关键选择是不缓存正文，只缓存候选映射（默认上限 128 条），每次 `get()` 都重新走 `provider.get()`。这样正文文件被改了，下一次加载立刻拿到最新内容，不需要设计缓存失效或版本机制。

两个内置 Provider 展示了不同的复杂度。`skill-badge` 是最小示例：`list()` 零 I/O 直接返回一个 `dsh-badge` 候选，`get()` 才去读正文文件；它在标准 CLI 组合里默认禁用，连这么轻的技能也要求部署方显式打开。`skill-filesystem` 是真实的发现引擎，扫描 `<name>/SKILL.md` 包目录或扁平的 `<name>.md`，按五种根目录的优先级查找，并用 Chokidar 加不存在路径的轮询兜底监听变更。

| 根目录 | 优先级 |
|---|---|
| 项目级 `.dsh/skills` | 100 |
| 项目级 `.agents/skills` | 200 |
| 自定义配置根 | 300 |
| 用户级 `~/.dsh/skills` | 400 |
| 用户级 `~/.agents/skills` | 500 |

失效判定很有分寸：只有顶层技能包的增删，或 `SKILL.md`、扁平 `.md` 自身变化才刷新目录，包内 `references/`、`scripts/`、`assets/` 的变化不触发。结合"正文不缓存"，形成从磁盘到模型的短闭环：目录变了才刷新目录，内容变了无需管缓存。整条优先级链的意图是项目级配置高于运行时注册，高于用户级，高于内置默认，团队可以用项目内的技能统一约束行为，不怕被个人的全局配置覆盖。此外还有内置的 `skill-office`，打包 `office-docx`、`office-pptx`、`office-xlsx` 三个技能，机制上完全复用 Provider 接口。两个边界：技能元数据可标 `disable-model-invocation: true`，让它对模型不可见但用户仍可用 `/名字` 触发；整个系统没有版本号字段，同名冲突只靠层级和注册顺序。

## tool-skill：目录消息与加载动作分开

模型加载技能用 `packages/skill/tool-skill` 的 `skill` 工具，参数只有一个 `name`。真正体现按需加载的是另一条路径：一条注入会话历史的普通 `UserMessage`，由 `renderCatalogMessage()` 渲染，内容是包在 `<system-reminder>` 里的 `<available_skills>` 列表，附一句指令：用户点名或任务明显匹配某个技能描述时，先用准确名字调用 `skill` 工具，且目录只含摘要，加载前不要推断技能内容。消息的来源标记是 `{ kind: 'skill-catalog', form: 'catalog', entries }`。

每个目录条目只有名字和一句描述，描述还要过长度截断（默认 500 字符，`Config.catalogDescriptionMaxLength`）。目录要足够便宜，才值得常驻。它也不是每轮重发：`agent/pre-step` 钩子对候选集合算 SHA-256 摘要，摘要变了（增删了技能文件）才发一条替换版目录。另有一条旁路：用户直接输入 `/skill 名字`，由另一个 `agent/pre-step` 钩子用正则匹配后直接把正文注入对话，不经过 `skill` 工具。

这与上下文压缩是同一种方法论的两个方向：先给廉价摘要，需要细节时再展开。压缩作用于已经发生的历史，按需加载作用于尚未被选中的知识。一个必须记住的边界：目录的 token 预算压得很紧，但加载进来的技能正文长度目前没有上限，这是工具文档明确写出的已知局限，正文太长的成本完全靠技能作者自觉。

## 动态插件：模型现在能做什么

课程写作时，`tool-cordis` 注册了七个 `cordis_` 工具，包括 `cordis_define`、`cordis_run`、`cordis_stop`、`cordis_undefine` 四个直接改写运行时的"生成代码"工具。当前留给模型的只有两个只读工具：`cordis_inspect_list` 列出 Host 当前已知的全部 Inspect Provider（含从浏览器页面同步来的 Client manifest），`cordis_inspect_query` 按平台、Provider、方法精确读取 Service 方法签名、Event 模式、插件 Config 的 JSON Schema、Tool 参数模式、主题 token 和 Slot 树。它们的描述把边界钉死：不要猜名字，也不要把 Inspect 方法当成插件代码能调用的业务 Service；这个工具不能调用业务方法，也不能修改运行时。两份 implemented 状态的设计笔记确认了这次撤编：模型看到两个只读 Cordis 检视工具，生成代码的 define、run、stop、undefine 均不存在。

自我扩展改走 Plugin Manager。Agent 把插件包和 Loader YAML 补丁写成工作区文件，再调用 `plugin_manager` 的 `install_bundle`。该工具的动作面是 `list_plugins`、`list_bundles`、`set_plugin`、`set_bundle`、`install_bundle`、`remove_bundle`，描述里直接写着改动影响该 Profile 下的每个会话，且安装的 Host 代码运行在工作区沙箱之外；每次调用都要过一次以 `'danger-full-access'` 为请求的逐次审批。持久化是这条路与旧路的关键区别：面板或程序化调用方发起的动态定义仍是进程内易失的，重启即消失；而 `install_bundle` 装上来的宿主代码是写进 Profile 的，对该 Profile 每个会话都生效。读者不应再把"重启即消失"当成可依赖的安全假设。

## 没拆的底层机制：vm 与 guard 挡住了什么

模型发起 define 的路没了，但底层机制还在。`DynamicCordisRunnerService`（`cordis-host-runner`）依然暴露 `define()`，请求 `DynamicCordisDefineRequest` 的 `code: { host?, client? }` 仍是纯 JavaScript 字符串（隐式 async 函数体），求值结果必须通过 `isPlugin`：是函数，或带 `apply` 方法的对象。也就是说动态插件与普通静态插件形态一致，可以自己用 `inject` 声明依赖，自己挂到活的运行时上。变的只是谁能发起 define：现在是 `ui-cordis` 的控制面板或程序化调用方，该包 README 明说 "this package exposes no model mutation tools"。

`sandbox.ts` 用 `node:vm` 建执行环境，但从一开始就否认这是安全边界。它挡的是会诱导误用的 Node 全局量：`require`、各种定时器、`fetch` 被替换成抛教学性错误的陷阱，提示改用 cordis 的服务；`process`、`Buffer` 这类数据型全局量则留空，因为抛错的访问器会炸掉常见的 `typeof process` 探测。vm 超时（`vmTimeoutMs`，默认 5000ms）拦不住异步函数体，文档认为在这套信任前提下可接受。

`guard.ts` 是白名单式的 `ctx` 访问代理：允许的方法限定在 `effect`、`on`、`once`、`provide`、`timeout`、`interval`、`setTimeout`、`setInterval`、`throttle`、`debounce`，未声明的服务读取抛错，所有写操作一律拒绝。其中一条反逃逸规则最值得注意：任何服务方法的返回值如果本身是活的 Cordis `Context`，直接拒绝，防止模型代码借此拿到未经代理的完整权限引用。跨边界的数据必须是无损纯 JSON，类实例、函数、`Map`、`Set`、`Date` 都会被拒。

真正的能力边界由插件自己声明的 `inject` 决定，而不是沙箱裁剪：声明依赖 `fs`、`bash`、`subprocess`、`pty`、`web` 就拿到真实服务对象。所以 host 侧 README 写的是 "Treat a dynamic package like bash access"，浏览器侧 `guard.ts` 头注释写的是"这是 API 纪律，不是安全边界"。

浏览器侧的 `cordis-client-runner` 更弱：没有 `node:vm`，只能用 `new Function(...)`，仍在同一个 JS realm 里。作为补偿，Client 代码的挂载需要人工点击审批，纯 Host 定义则不需要。审批粒度是插件身份而不是具体代码改动，勾选 "Allow future versions of this plugin" 后后续版本不再询问；审批是页面全局的，一个标签页发起的请求可在另一个标签页批准，最先回答的决定生效。`ui-cordis` 只管让人看见并批准这件事在发生，不给插件提供渲染能力。

## 为什么锁在非默认预设里

这套能力不随标准配置启用。当前的 `cordis` 预设打包成 `packages/bundle/web-app/presets/cordis.patch.yml`，只在 web 组合之上追加一条 `@deepseek-ai/dsh-agent-preset` 声明，`id: cordis`、`order: 4`，内容是 `standard` 的全部工具，加只读的 `tool-cordis`、指向预设包内技能目录的 `skill-filesystem`（携带 `cordis-plugin-development` 等组合写作技能），以及 `tool-plugin-manager`（未跑在 Profile 里则禁用）。persona 与 `standard` 相同，没有独立的 Creator 人格。系统默认预设 id 仍硬编码为 `standard`，而 `standard` 不引用 `tool-cordis` 和 `tool-plugin-manager`，所以从普通编码 Agent 切到"能把插件持久装进自己所在 Profile 的 Agent"，必须由部署方或使用者显式切换。

这与 `skill-badge` 默认关闭是同一种谨慎，但风险不在一个量级：前者关闭只是少一个生成徽章的技能，后者关闭意味着默认没有任何会话具备重写自己所在运行时的能力。

## 我的看法

风险声明的位置值得留意。早期预设文件头部有 `# TRUST:` 风险声明，迁移后消失，职责移到了 `plugin_manager` 的工具描述和逐次审批上；而正式的 `docs/` 目录至今没有单独讨论这个特性的安全考量，读者要自己从源码注释、README 和 `.agents/notes/implemented/` 的设计笔记里拼出全貌。我的判断是，把风险说明分散在工具描述和笔记里，对启用者是负担，启用前应当把这几处声明当作唯一可信的风险说明逐条读过。这是基于课程材料对文档现状的描述所作的判断。

## 小结

- Skill 用 `list`/`get` 分离和独立的目录消息实现"廉价目录常驻、昂贵正文按需"，正文不缓存，目录靠 SHA-256 摘要去重；已知缺口是正文长度无上限。
- 动态插件的模型面收窄为两个只读自省工具，自我扩展走 `plugin_manager install_bundle` 持久安装并逐次要求满权限审批；底层 vm 与 guard 只防误用，真实权限由插件的 `inject` 决定。
- 该能力被隔离在非默认的 `cordis` 预设里，不存在任何默认路径会悄悄打开它。

对应原课程篇目：`07-多智能体与工作流/03-Skill技能系统与动态插件扩展.md`
