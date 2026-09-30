# Native 沙箱内核 landlock-run：为什么沙箱要落到一个独立的 C 可执行文件上

这一篇要回答的问题是：Linux 上已经有 `bwrap`，`dsh` 为什么还要另写一个沙箱启动器；这个启动器为什么是不到 300 行的 C，而不是 TypeScript 或某个原生绑定；它和 Node 侧怎么通信，出错时怎么保证不会"悄悄裸奔"。

结论可以先说三句。第一，`bwrap` 依赖 mount namespace 权限，而容器套容器、CI runner、被策略收紧的宿主机常常不给这个权限，`native/system` 里的 `landlock-run` 是只依赖 Landlock LSM 的备选路径。第二，它是一个独立的命令行可执行文件，Node 侧只是 `spawn` 它，跨语言边界靠 argv、退出码和一行 stdout 报告完成。第三，整个设计围绕 fail-closed 展开：任何不确定都拒绝执行，能力声明靠真实施加一次规则集来验证，而不是查内核版本号。

## 为什么 bwrap 之外还要一条路

`packages/sandbox/sandbox-local` 的职责，是把"允许访问哪些路径"落实到子进程身上。Linux 上首选 `bwrap`，它用 mount namespace 重新拼装一个受限的文件系统视图，能力强，但前提是调用者能创建 user namespace 和 mount namespace。不少生产环境出于安全考虑关掉了这个权限，比如 `CAP_SYS_ADMIN` 受限、`unprivileged_userns_clone` 被禁用，或容器本身已经跑在收紧的 seccomp、AppArmor 策略下。这时候如果沙箱层的选择只剩"用 bwrap"或"不设防"，就等于在最需要沙箱的受限环境里放弃了沙箱。

Landlock 是 Linux 5.13 引入的 LSM，专为非特权的自我限制设计：任何进程无需额外权限，就能给自己施加一份文件系统访问的白名单，规则一旦施加不可撤销，并且随 `execve` 继承给所有后代进程。它不如 `bwrap` 全面，目前只管文件系统访问，但足够轻，也不需要特权。`landlock-run` 就是围绕这三个内核系统调用写的启动器：自己先施加规则，再 `exec` 目标命令。

平台选择链体现了两者的主次关系：`sandbox-local/src/index.ts` 里 Linux 的候选顺序是 `['bwrap', 'landlock']`，macOS 是 `seatbelt`，Windows 是 `windows-acl`。只有 `bwrap` 探测不可用时才会降级到 Landlock。三种后端消费同一份 `SandboxPolicy`，`profiles.ts` 里的 `landlockProfileArgs` 把它翻译成授权参数：根目录只读，`/dev/null` 可读写；`workspace-write` 模式下再加上 `/tmp` 和工作区根目录的读写权限。

## 一个文件，连内核头文件都不引

启动器的全部逻辑在 `native/system/packages/entry/src/main.c` 一个文件里，纯 C11，静态链接 musl，除 libc 外没有任何依赖。文件头注释把用意说得很直白：审计面就是这一个文件加上内核稳定的系统调用契约。

更极端的一点是，它没有 `#include <linux/landlock.h>`，Landlock 的结构体和常量照着内核头文件的布局手写在源码里，系统调用号（444、445、446）也是手写的回退定义，三个核心调用直接用 `syscall()` 发起。理由有两个：内核的用户态 ABI 承诺稳定，自己定义可以让构建不受工具链头文件新旧影响；手写的定义同时也是审计记录，明确列出这个启动器碰了内核的哪些接口。整个沙箱与内核的交互面，就是 `landlock_create_ruleset`、`landlock_add_rule`、`landlock_restrict_self` 这三个调用。

这里有一个容易读错的命名。包名 `@deepseek-ai/node-addon-system` 带着 `node-addon-` 前缀，容易让人以为是 N-API 绑定，但对 `landlock-run` 这一半来说不是：`index.ts` 只导入了 `node:child_process`、`node:module`、`node:path`、`node:url`，没有任何 `.node` 加载。这个前缀沿用的是"一个 JS 入口包加每平台一个二进制包"的分发形态，入口包用 `optionalDependencies` 列出 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64` 四个平台包，安装时由 npm 的 `os`、`cpu` 字段筛出匹配当前机器的那个。课程材料里说明，这个包家族后来又加入了一个真正基于 Node-API 的 POSIX `flock` 绑定，所以 darwin 平台包只含 flock，没有 Landlock，因为 Landlock 是 Linux 专属能力。两个能力通过 `exports` 拆成 `./landlock-run` 和 `./flock` 两个子路径，不再有根导出。

## 跨语言协议：argv、退出码和一行报告

Node 与 C 之间没有共享内存，也没有 FFI，协议只有三样东西。第一是命令行语法，`docs/cli-contract.md` 钉死为：

```text
landlock-run [--ro <path>]... [--rw <path>]... -- <argv>...
landlock-run --probe
```

`--ro` 授予路径之下的读和执行，`--rw` 授予内核当前 ABI 能治理的全部文件系统访问，未授予的一律拒绝。`--` 是强制分隔符，之后的内容原样交给 `execvp`，环境变量不变。除此之外没有别的 flag，也没有任何环境变量输入。解析用手写代码，四个 flag 不值得引入解析库，遇到未知参数直接报错。

第二是退出码：所有启动器级致命错误打印 `landlock-run: <message>` 到 stderr，并以 125 退出。选 125 是因为被包装的命令自己很少用这个码，外层因此能区分"启动器失败"和"命令失败"。消费方 `sandbox-local` 把它接进失败分类规则：`landlock` 分支的 `allowedExitCodes` 是启动器失败码，`fatalSignatures` 是 `landlock-run: ` 前缀，另有一条针对 partial enforcement 的 informational 行。两个信号叠加，才判定为启动器故障。

第三是 `--probe` 的一行 stdout 报告，下一节再讲。JS 侧的三个导出函数都很薄：`launcherPath()` 用 `require.resolve` 找当前平台包里的二进制；`grantArgs()` 把 `{ readOnly, readWrite }` 拼成 flag 数组，不做路径校验，校验责任在 C 端；`probe()` 负责探测。真正的执行由 `sandbox-local` 把 `[launcherPath(), ...grantArgs(...), '--', ...命令]` 拼成 argv，交给自己的进程管理器去 `spawn`。启动器在这条 argv 里和 `bash`、`git` 没有区别。

这一边界有两处刻意的保守。`launcherPath()` 在平台包解析失败时，回退到一个绝对的、位于本包边界之内的路径，而不是任何 cwd 相对路径，因为哪个二进制来限制进程，不能由调用时的当前目录决定。模块头注释更进一步：整个模块刻意不读任何环境变量来覆盖，测试注入靠函数参数。原因同样是"用哪个二进制做限制"不该由环境决定，一个能被环境变量替换的沙箱启动器，本身就是一个绕过点。

## 探测：真的施加一次，而不是查版本号

沙箱能不能用，不能靠 `uname -r` 猜。同一个版本号的内核可能没编译 Landlock，或者编译了但被禁用。`--probe` 的做法是：用 `--ro /` 构建一个覆盖全盘的规则集，真的对当前这个马上就要退出的探测进程施加限制，看内核接不接受。源码注释的理由是，`--version` 式检查会漏掉"有 syscall 但拒绝执行 enforcement"的内核，实际去限制一次是唯一诚实的信号。

结果通过 stdout 一行文字回报，`probe()` 用 `spawnSync` 加 2 秒默认超时来跑：退出码非 0 归为 `unusable`，输出里有 `partially enforced` 归为 `partial`，否则是 `full`。这三态正是 `sandbox-local` 判断能否走 Landlock 路径的依据，`enforcement` 字段会一路带到最终返回给调用方的 `ConfinedArgv` 里，让上层知道这次沙箱是完整强制还是部分强制。所以这一行输出是协议的一部分，不是调试信息。darwin 上 `launcherPath()` 仍会拼出一个 `bin/landlock-run` 路径，但文件不存在，`probe()` 因执行失败自然归为 `unusable`，不需要在路径解析函数里做平台特判。

## full 与 partial：旧内核上的诚实降级

Landlock 的 ABI 一直在演进：ABI 2 加了 `REFER`，ABI 3 加了 truncate 治理，ABI 5 加了设备 ioctl 治理。`main.c` 里 `MAX_ABI` 是 5，启动时先向内核询问支持到哪一版，再把规则集缩到内核实际能治理的子集，而不是要求全有或全无。协商出的 ABI 低于 `MAX_ABI` 时，规则集照样施加，只是打一行 `partial enforcement (older Landlock ABI)` 提示。

这里的取舍是：旧内核上继续强制它能强制的部分，并如实标注，把是否接受 `partial` 的决定交给调用方，而不是因为不完整就拒绝。partial 不等于不安全，已协商的部分严格生效，没有被治理的访问类型（比如 ABI 3 之前的 truncate）则不受限。课程材料也强调，探测结果才是权威，内核版本号不是可用性保证。

## fail-closed 落到哪些具体决定上

fail-closed 的核心是 `main()` 的控制流：每一步失败就直接 `return`，只有全部成功才会走到最后的 `execvp`。几处典型决定：

内核不支持 Landlock（`ENOSYS` 未编译或 `EOPNOTSUPP` 被禁用）时，直接以 125 退出，源码注释写明"不可强制，则失败于关闭，绝不无限制地 exec"。某条授权路径打不开时（比如调用方传了不存在的目录）也是同样处理。源码注释承认悄悄缩小授权范围看起来是安全的，但"用一份调用者没拿到的配置去运行，这份歧义不值得"。`exec` 本身失败时同样返回 125 并带错误信息。

测试用一个真实场景证明这不是空话：授权路径 `/no/such/grant/root` 不存在，命令是 `echo x > marker`，断言退出码为 125、stderr 有前缀和 `cannot open rule path`，并且 marker 文件不存在，命令从未运行。

## 白名单与继承：为什么"自我限制后再 exec"成立

`cli-contract.md` 的 Confinement semantics 一节点出两个支柱。一是白名单：启动器设置 `no_new_privs`，给自己施加规则集，然后 `exec` 命令，`--ro`、`--rw` 之外的路径一律拒绝，和"拦截危险操作"的黑名单思路相反，一条没被显式授权的路径不论看上去多无害，都会被拒。二是继承：规则随 `execve` 传给所有后代，子进程无法撤销。测试里有专门用例：被包装的 shell 再拉起一层子 shell 去写文件，写入照样被拒，`nested.txt` 不存在，尽管外层命令退出码为 0（内层失败被 `; true` 吞掉，重点是文件确实没创建）。

这两点合在一起，才使"先限制自己再 exec"这种一次性、单向的模型对不可信命令有效：限制在 exec 之前就已生效，命令没有机会先跑一段再自我放宽。

## 代价与边界

几个代价材料里已经写明或可以直接读出。Landlock 目前只管文件系统访问，不管网络和进程，不如 `bwrap` 全面，所以它是备选而不是替代。旧内核上只能得到 `partial`。平台覆盖有限：Windows 既没有 Landlock 启动器，也没有 POSIX flock 绑定，保留原有的 Windows 信号量实现；其他 CPU、OS 组合没有发布平台包，Landlock 探测为 `unusable`。新增平台需要原生构建器和已安装产物验证。

另外，跨语言边界选择"独立可执行文件加 argv、退出码、stdout 一行"，意味着协议的所有细节都要靠文档和测试钉死（`docs/cli-contract.md`、`test/launcher.test.js` 锁定 flag 语法、退出码和拼接顺序），而不是靠类型系统。这是可审计性的代价：换来的是没有 FFI、没有内存共享，Node 进程里不会加载任何执行限制逻辑的代码。

## 小结

- 沙箱层需要一条不依赖 namespace 权限的路径，`landlock-run` 用 Landlock 的非特权自我限制补上这块空白，位置排在 `bwrap` 之后。
- 跨语言边界被压到最小：argv 语法、125 退出码加 stderr 前缀、`--probe` 的一行报告，没有 FFI，没有环境变量覆盖。
- 一切以 fail-closed 和诚实声明为准：任何不确定都拒绝执行，能力用真实施加一次来验证，`full`、`partial`、`unusable` 三态交给上层决策。

对应原课程篇目：`DeepSeek-Harness/06-跨语言边界与部署形态/01-Native沙箱内核landlock-run.md`
