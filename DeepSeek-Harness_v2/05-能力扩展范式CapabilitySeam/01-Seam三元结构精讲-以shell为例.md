# Seam 三元结构精讲：以 shell 为例

这一篇回答一个具体问题：一条 `bash` 命令从模型发出到进程结算，中间经过了哪几层对象，每一层各自负责什么，换掉其中一层为什么不用动其他层。三元结构的概念在概览里已经讲过，这里不复述定义，只沿着 `packages/shell` 这一个官方指定的范例，把 `resolve`、`execute`、前台与后台、继承与非继承这几个细节讲透。

结论有三句。第一，`ShellExecutor` 的契约只有 `resolve` 和 `execute` 两个方法，“前台还是后台”不属于启动，而属于调用方怎么等。第二，沙箱版本靠继承本地版本、只换 argv 的准备方式来叠加能力，进程管理一行没有重写；但继承只是优化，PowerShell 版本就是独立实现的。第三，消费者 `dsh-tool-bash` 只认 `ctx.shell` 和一个只读的能力事实 `sandboxMode`，工具的参数表和行为随背后的实现自动变化。

## 契约为什么只有两个方法

`packages/shell/shell/src/index.ts` 里，`ShellExecutor` 继承 Cordis 的 `Service`，构造时以 `super(ctx, 'shell')` 注册成 `ctx.shell`。它的全部接口面是两个抽象方法加一个 getter：

```typescript
export abstract class ShellExecutor extends Service {
  constructor(ctx: Context) { super(ctx, 'shell') }
  get sandboxMode(): SandboxMode | undefined { return undefined }
  abstract resolve(request: ShellExecRequest): ShellExecSpec
  abstract execute(spec: ShellExecSpec): Promise<ShellExecution>
}
```

`resolve` 把请求补全成规范。`ShellExecRequest` 的字段基本都是可选的，是调用方的视角；`ShellExecSpec` 的字段基本都是必填的，超时已经被夹到配置允许的范围内。`execute` 只接受 spec，所以“忘了 resolve 就直接执行一个字段不全的请求”在类型层面就写不出来，一个必须发生的运行时步骤被编译器强制了。

spec 里有两个值得单说的字段。`onExpiry` 决定超时那一刻做什么：默认 `'kill'`，到点杀进程并把 `timedOut` 记为 true；`'none'` 则完全不设时限。`stdoutMaxBytes` 是前台 stdout 的捕获预算，未指定时取配置里的 `maxOutputBytes`。`LocalBashExecutor` 的默认值是超时 120 秒、上限 600 秒、输出 64000 字节。

`execute` 的返回值是 `ShellExecution`，由一个活的进程句柄 `ShellProcess`（`status`、`done`、`readOutput()`、`kill()`）加一个前台投影 `result()` 组成。这个形状是整个契约里最关键的一次收敛。早期契约是 `resolve`、`run`、`start` 三件套，前台跑用 `run`，后台跑用 `start`。现在只剩 `execute`，源码 JSDoc 给出的理由是：前台是等待方的属性，不是启动的属性。同一个执行，谁 `await` 了 `result()`，谁就是前台；只握着句柄看 `status` 和 `readOutput()` 的，就是后台。想要“先等一会儿，等不到再放后台”，就用 `onExpiry: 'none'` 启动，自己给等待设界。

`result()` 的 reject 条件也定得很窄：只在基础设施失败时才 reject。非零退出、超时被杀、外部取消，全部 resolve 成一份 `ShellRunResult`，靠 `timedOut`、`aborted` 这类首因分类字段表达。这样调用方处理命令失败和处理基础设施故障走的是两条不同的路径，不会把 `exit 1` 当成异常抛出来。

## 本地实现：resolve 补全，executeArgv 兜底

`dsh-bash-local` 的 `LocalBashExecutor` 声明依赖 `subprocess`，即另一个 seam。它的 `resolve` 做三件事：用 `clampTimeout` 把请求超时夹进 `[.., maxTimeoutMs]`，把 `workdir` 依次回落到请求值、配置里的 `cwd`、`process.cwd()`，把 `onExpiry` 缺省成 `'kill'`；可选字段如 `signal`、`stdin`、`env`、`dshEnv` 原样透传。它的 `execute` 只有一行，把 `['bash', '-c', spec.command]` 交给受保护方法 `executeArgv`。

`executeArgv` 才是真正的重心。它接收的第二个参数除了现成的 argv，还可以是一个异步的准备函数 `(signal) => Promise<argv>`。准备函数被接进超时信号，准备阶段超时不会把调用挂死，而是落成一个已经结算好的空句柄。进程生命周期、环境变量、输出收集、超时熔断、abort，都在这一个方法后面。这个拆分让子类只需要回答“最终执行哪条 argv”，不必回答“怎么管进程”。

## 沙箱实现：只换 argv

`SandboxBashExecutor` 继承 `LocalBashExecutor`，依赖 `subprocess`、`sandbox`、`sandboxPolicy` 三个服务。它覆写三样东西。

`sandboxMode` getter 返回部署默认模式，这是给消费者看的能力事实。`resolve` 在父类结果上补一个 `sandboxPolicy` 字段，取值是 `request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()`。前者是工具已经算好的、带调用上下文的策略，后者是兜底的部署级默认，所以两处解析不是重复，而是“消费者尽量算好、提供方兜底”的分层。`execute` 则按模式分两条路。

`danger-full-access` 走最短路径：直接 `super.execute(spec)`，连 `confine` 都不调用，只在前台投影上补一条 `sandbox: { mode, denied: false }`。其余模式把一个准备函数交给 `executeArgv`，准备函数里调用 `ctx.sandbox.confine(['bash','-c',command], policy, signal)`，拿到被包裹过的 argv 再去 spawn。`confine` 是异步的，并且带 `signal`，包装本身可能要探测运行器、建目录 ACL，取消或超时会像普通超时一样结算。

沙箱事实通过 `decorateResult` 叠加：它改写句柄的 `result()`，同时进程结算时把同一组事实钉在句柄的 `sandbox` 字段上。这样 `await result()` 的前台调用方和只读句柄的后台观察者，看到的是同一份“实际跑在什么模式、有没有被拒、runner 是否失败”的记录。runner 自身失败优先判为 `SANDBOX_UNAVAILABLE`，否则再根据 stderr 里的拒绝签名判定 `denied`。这部分判定规则在权限一篇里展开。

## 不继承也合法：PowerShell 版本

`PwshLocalExecutor` 直接 `extends ShellExecutor`，独立实现了一套与 `bash-local` 几乎逐行对应的进程管理，源码注释自称 deliberate call-for-call mirror，重复代码还用 `jscpd:ignore` 标注为有意为之。原因是两种 shell 的字符串世界不同。`bash -c` 有转义规则；`pwsh -NoLogo -NoProfile -NonInteractive -Command` 把整段命令作为一个 argv 元素交给 PowerShell 自己解析，中间没有额外的 shell 层，Win32 路径 `C:\...` 原样通过。编码也不同：Windows PowerShell 5.1 默认用系统代码页，所以命令前要拼接 `ENCODING_PREAMBLE` 钉住 UTF-8。环境变量约定同样不同，`NO_COLOR=1`、`PAGER=cat`、`GIT_PAGER=cat` 保留，`TERM=dumb` 是 POSIX 概念，pwsh 场景故意不设。

把这三个实现放在一起看，能读出一条规律：`ShellExecutor` 真正强制的只有两个方法签名，继承是“恰好共享大量机制时”的优化手段。强行为 bash 和 pwsh 抽一个共享基类，会把两套本来不同的语义拗成一套接口，这个取舍比“消除重复”更重要。

## 消费者：工具 schema 由能力事实生成

`dsh-tool-bash` 的 `inject` 列表是 `['tools','shell','systemPrompt','shellEnv']`，包里不 import 任何具体执行器。`apply()` 开头读一次 `ctx.shell.sandboxMode`：如果是 `undefined`，升级目标列表为空，`sandbox_permissions` 和 `justification` 两个参数根本不会出现在给模型的参数表里；如果是某个具体模式，它们就出现，`sandbox_permissions` 的枚举取自 `ESCALATION_TARGETS`。同一份工具代码，换一个 Provider，模型看到的工具形状就变了，代码中没有任何 `instanceof`。

这里的 getter 是“事实”而不是“配置”，差别很实际。如果做成部署配置项，就要靠人保证配置与实际加载的插件一致，两者一旦不同步，模型看到的参数表会与真实能力不符。事实来自 Provider 自己，只可能是真的。

## 前台命令为什么从第一秒就是 job

`bash` 的 `execute` 有三条路径，分支的依据是有没有 `ctx.jobs` 注册表。

显式 `run_in_background: true`：以 `onExpiry: 'none'` 启动，登记成 job，立刻返回 job id。

有注册表的前台命令：同样以 `onExpiry: 'none'` 启动并登记，然后走 `waitOnJob`，通过 `registry.wait(id, timeoutMs, owner, signal)` 有界地等待。命令自己没有时限，`timeoutMs` 只约束这一次等待。登记失败时降级成纯前台。

没有注册表：直接 `ctx.shell.execute(ctx.shell.resolve({...request, signal}))` 再 `await result()`，若 `aborted` 则抛出工具中止错误。

`waitOnJob` 有三种结局。命令在等待期内跑完：记录被 `registry.remove(id)` 删掉，模型从头到尾没见过 id，返回普通前台结果；如果命令是被外部杀掉的（用户在 Web 任务列表点停止，或有人调用 `job_kill`），杀停原因写进结果的 `stopped` 字段，渲染为 `[stopped: <reason>]`。等待超时而命令仍在跑：不杀进程，返回 `{ kind: 'promoted', jobId, timeoutMs, output }`，渲染成 `[still running after <ms>; moved to background job <id>]` 加交接指引，并做一次消费式读取带上已有输出，之后 `job_output` 从断点继续。调用方 abort：杀掉 job，等它结算，再抛出中止错误，语义与纯前台路径对齐。

这里有一个设计取舍值得留意。命令并不是“超时后被提升”成另一个 job，它从启动那一刻起就是注册表里的那条记录，只是这次等待结束了。课程材料提到早期存在过一个超时后向模型提供“提升选项”的协议，评审中被否决删除，因为命令没有从一个类别迁移到另一个类别。这个决定的好处是命令从第一秒起就能被列出、被流式观看、被 Web 侧停止，代价是每次前台命令都要在注册表里走一遍登记与删除。配置项 `promoteOnTimeout: false` 可以关掉这套行为，此时超时退回执行器自己的 deadline 到点杀进程。

`jobs` 不在工具的 `inject` 里，是可选依赖。`apply()` 末尾用 `ctx.inject(['jobs'], ...)` 守候注册表的出现和消失，据此注册两个互斥的工具变体：有注册表的变体，描述文本里会写超时迁移语义；纯前台变体不写。注册表卸载时，disposer 把工具换回纯前台版本。这是 Cordis 可选依赖织补的一个完整示例，也说明模型看到的工具描述是与运行时装配同步的，不是写死的。

## 换个域看同一套骨架

同样的三元结构在其他能力域里有对应：`ctx.fs` 有 `fs-local`、`fs-sandbox`、`fs-ssh` 三个 Provider，`tool-fs` 只调用 `ctx.fs.read`、`editText`、`write` 这些抽象方法，所以文件读写在本地、沙箱围栏内和远端主机之间切换，只换 Provider。`ctx.llm` 是定义与消费者合在同一个包里的特例，`dsh-llm` 既声明注册表契约，也是直接消费方之一。术语表对此的说法是：角色需要独立演进时通常在不同包，属于同一关注点时一个包也可以承担多个角色，三元讲的是职责边界，不是物理拆包数量。

早期还有过运行在 E2B 云端 microVM 里的 `fs-e2b` 家族，后来整体移除。它作为反例说明了这套结构的价值：Provider 可以生灭，Consumer 不用动。

## 边界与常见误解

最常见的误解是想在同一个 context 里同时加载 `bash-local` 和 `bash-sandbox`，让一部分工具走沙箱。Cordis 对同一个 key 的重复注册是硬性报错，不是后者覆盖前者。`ctx.shell` 表达的是“这个部署或这个 scope 默认怎么执行命令”，不是路由表。想要细粒度差异，办法在消费者层：走 `sandbox_permissions` 升级机制，或者按 scope 注册不同的工具实例。

另一个边界是三个角色各自不能越界：定义里不含具体执行逻辑，Provider 不新增模型可见接口，Consumer 不直接 spawn 进程或触碰沙箱细节。三条叠加，才是这套范式实际的约束力。

## 小结

- 契约极小：`resolve` 补全请求，`execute` 启动进程，前台还是后台由谁等待决定，`result()` 只在基础设施失败时 reject。
- 复用靠 `executeArgv` 这一个拆分点：沙箱版本只替换 argv 的准备方式；PowerShell 版本因为语义不同而独立实现，二者同样合法。
- 消费者通过 `sandboxMode` 这类能力事实生成工具 schema，并通过 `ctx.jobs` 让前台命令从启动起就可观察、可停止、超时不杀而是移交。

对应原课程篇目：`05-能力扩展范式CapabilitySeam/01-Seam三元结构精讲-以shell为例`。
