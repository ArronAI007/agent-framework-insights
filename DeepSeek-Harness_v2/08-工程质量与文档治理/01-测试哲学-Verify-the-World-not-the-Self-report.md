# 测试哲学：Verify the World, not the Self-Report

这一篇回答一个问题：被测对象是一个会自己写"我做完了"的模型时，测试该怎么写才不会变成让考生自己判卷。DeepSeek Harness（`dsh`）的答案写在 `docs/testing.md` 里，可以用三句话概括：断言必须落在外部可观测的世界上（文件、进程退出码），而不是模型的自述；测试必须走产品真实的入口路径，手工搭建的挂载方式不算数；覆盖率只能证明代码行跑过，不能证明功能按交付方式工作。这三条都不是抽象的教条，而是从一次"178 个单元测试全绿、行覆盖率 100%，真实编辑器连上第一秒就崩溃"的事故里提炼出来的。

## agent 测试多出来的那个混淆变量

普通单元测试里，被测代码和测试之间没有共谋空间：字符串拼接的结果要么对要么错。agent 不一样，它的输出里天然带一段自然语言叙述，比如"bug 已修复，测试通过"。这段话是模型生成的，"说得像真的"是它的本性，"事情真的做对了"却不是。如果断言写成在最后一条回复里搜索 fixed、成功之类的关键词，测试通过的条件就退化成"模型说了正确的话"，而不是"模型做了正确的事"。一个投机取巧的 agent，比如把测试文件改成永远通过，同样能让这种断言变绿。

`docs/testing.md` 因此把规则写得很硬：e2e 断言要在 agent 之外重新运行命令，或者重新读取文件；对于不该被改动的文件，要断言逐字节一致；e2e 测试自己拥有资源，在测试里创建，在 `afterEach` 里销毁，哪怕失败、重试或超时也一样；共享 fixture 放在普通的 `tests/harness.ts`，不能从另一个 `*.e2e.ts` 里导入，因为导入一个 spec 会把它的 `describe` 重新注册一遍，重复发起真实 API 调用。

## 一个 e2e 文件里这条规则怎么落地

`apps/cli/tests/profiles/headless/tests/coding-task.e2e.ts` 是 SWE-bench 风格的冒烟测试：让真实模型在临时目录里只用 bash 工具修一个真实的 bug，修复结果由测试自己去验证。核心断言只有这么几行：

```typescript
const summary = finalText(agent.session.snapshotEvents()).toLowerCase()
expect(summary.length).toBeGreaterThan(0)          // 只确认模型说了点什么

const untouchedTest = await readFile(join(workdir, 'add.test.js'), 'utf8')
expect(untouchedTest).toBe(TEST_FILE)              // 测试文件必须逐字节不变

const after = spawnSync('node', ['add.test.js'], { cwd: workdir, encoding: 'utf8' })
expect(after.stdout).toContain('PASS')             // 由测试自己重跑
expect(after.status).toBe(0)

const fixed = await readFile(join(workdir, 'add.js'), 'utf8')
expect(fixed).not.toMatch(/a\s*-\s*b/)             // bug 模式确实消失
```

这几行把"验证外部世界"拆成四个动作。对模型自己的输出只做最弱的健全性检查，只看长度，不看内容，判定权完全移出叙述。对不该被改的文件断言字节一致，堵住"改测试代替修 bug"的捷径，失败信号是"世界里留下了错误的痕迹"，而不是"模型嘴上说了假话"。命令由测试自己用 `spawnSync` 重新发起，不依赖 agent 在会话里是否跑过。最后对源码里的具体 bug 模式做结构性断言。

同一个测试在调用 agent 之前还确认了 fixture 本身是坏的：先跑一遍，断言退出码非零。这是同一原则的另一半：不仅验证终态，也验证起点确实需要被修复，否则一个什么都没做的 agent 会因为 fixture 碰巧能跑通而"通过"。

资源管理也有讲究。`afterEach` 里先 `ctx?.fiber.dispose()`，再删除临时目录。注释写明：agent-loop 的 teardown 会停掉循环，`LocalBashExecutor` 的 teardown 会杀掉模型留下的进程。这不只是卫生习惯，因为真实 API 测试会拉起真实子进程和真实目录，如果 dispose 只在成功时执行，一次超时就会在磁盘和进程表里留下垃圾，污染后面的测试。

## 不要吝惜真实 API 测试，也不要滥用真实调用

`docs/testing.md` 有一句近乎宣言的话："We are DeepSeek — do not ration real-API tests."。理由是无密钥测试只能证明管路是通的，只有带密钥的运行才能证明 agent 在真实模型上工作。其中价值最高的是冒烟测试：启动一个交付形态的 `dsh` profile，发一条提示，然后检查世界。它们专门捕获"单元测试全绿、产品是坏的"这一类问题，这是 mock 做不到的。套件在没有对应密钥时会自我跳过（self-skip），但文档特意强调，跳过是访问控制信号，不是成本信号：它让没有密钥的 CI 和贡献者不被卡住，并不意味着真实调用应该省着用。

这和"只 mock 昂贵或不确定的边界"并不矛盾。规则的原文是：只 mock 昂贵或非确定性的边界（LLM adapter、网络、时钟），下游一律保持真实。桥接层的工具调用测试就是这样搭的：`makeBridgeHarness()` 把循环、会话存储、工具注册表和 JSONL 持久化都挂真的，只有 `MockAdapter` 是唯一的 mock。要证明模型这一层的真实行为，就用带密钥的冒烟测试；要证明下游链路正确搬运字节，就用脚本化模型加真实管线。手写的替身只能证明"桥能搬字节"，不能证明交付的工具行为符合断言。

## 七层测试，各守一种证据

测试被拆成七层，每层守住一种别的层顶替不了的证据。单元测试守函数和模块内部的边界、错误路径、事件顺序和并发竞态，每个注册表都要有 HMR 安全测试（对贡献者的 fiber 执行 dispose，断言清理完成），这样第 03 章的"注册即副作用"就被机械地强制。覆盖率门禁（`pnpm run test:coverage`）要求 `packages/*/*/src` 逐文件 100%。真实 API e2e（`pnpm run test:e2e`）证明 agent 能对接活的模型。属主本地期望输出（`test:expected`）是无密钥的、直接组装出来的 CLI 与进程行为期望。性能基准（`test:bench`）把时间、堆内存和伸缩性预算做成 Linux PR 门禁。会话快照（`test:snapshot`）把一份录制的父代会话同时用作输入、模型回放和期望的持久化结果。Web 快照（`test:web`）用 Chromium 比对浏览器渲染，因为样式和 DOM 结构在 Node 单元测试里根本没有对应的失败模式。

这张表本身是一种设计声明：任何一类 bug，都应该能回答"哪一层本该抓到它却没抓到"。所以每篇 postmortem 结尾都指明新增的是哪一层的哪个具体测试，而不是笼统说"补了测试"。

快照层还带着一条流程义务：每一个非平凡的、模型可见、协议可见或用户可见的改动，都要在同一个 PR 里新增或更新一份无密钥的录制会话场景，包内测试、e2e、纯 mock 和文字说明都不能替代组装后的 transcript。这是第 04 章"模型可见即留痕"不变量在测试上的对应：声称改变了模型看到的内容，就要留下可以被别人重新比对的具体证据，而不是停在作者的自我陈述上。它和本篇标题是同一种不信任，只是对象从 agent 的自我报告换成了 PR 作者的自我陈述。

## 测试真实入口路径

第二条主线来自 postmortem 0001。ACP 服务器的入口 `packages/acp/acp/src/index.ts` 本该是命名空间插件，`name`、`inject`、`Config`、`apply` 作为独立具名导出，却多了一行别的插件都没有的 `export default apply`。Cordis Loader 在真实加载时会规范化模块：

```ts
unwrapExports(exports: any) {
  if (isNullable(exports)) return exports
  exports = exports.default ?? exports        // 优先取 .default
  if (!exports.__esModule) return exports
  return exports.default ?? exports
}
```

存在默认导出时，解析出来的是裸的 `apply` 函数，同级的 `inject`、`name`、`Config` 全部丢失，`apply` 在一个没有注入任何服务的 fiber 里运行，第一行读 `ctx.agents` 就抛异常。178 个单元测试全绿的原因是，它们全部通过手写的 `ctx.plugin({ name, inject, apply })` 挂载，`inject` 是手工喂给 Cordis 的，而 `unwrapExports` 只在真实 Loader 里才会被调用。不是测试写得少，而是所有测试统一避开了唯一会暴露 bug 的那条路径。

因此 `docs/testing.md` 规定：面向产品可见的插件必须有一个非单元的真实组合测试。手工 `ctx.plugin(...)` 的套件不够，要通过 Loader 和 app 或进程启动一份仅供测试用的 `cordis.yml`，只 mock 外部服务或非确定性输入，断言模型可见的请求或日志、持久状态或用户可见输出，并且不能把选择性开启的项混进交付默认配置。对没有 `inject` 的 bundle 或组合插件，Loader 冒烟测试在默认导出顶替了具名导出时仍会保持绿色，所以要显式加 `expect('default' in mod).toBe(false)` 和一个 `unwrapExports` 往返断言。

紧跟着的一句话概括了整套方法论：A guard only guards if the regression fails it。一个守卫必须证明自己有效，办法是引入回归、看它变红、再撤回。postmortem 0001 记录了这一步：恢复 `export default apply` 时测试确实失败。

这条规则后来又延伸到发布产物本身。包的 `bin` 要用纯 `node` 运行构建出来的 `lib/bin.js`，因为 tsx 加载源码会掩盖只有构建产物才暴露的失败（settle 竞争、模块解析、被吞掉的加载失败）。仓库里有专门的 built-artifact 冒烟测试守这条路，例如 `packages/sdk/server/tests/built-scope-carrier.e2e.ts` 和 `packages/ptc-runtime/ptc-runtime-node/tests/built-lib.e2e.ts`，并要求真正缺失的配置必须以非零码退出。

## 覆盖率门禁的边界

覆盖率门禁在文档里被明确限定：Line coverage is necessary, never sufficient，它证明代码行跑过，不证明功能按交付方式工作。postmortem 0001 用事实回应了这句话：100% 行覆盖率始终满足，两个 bug 仍然逃过。每一行确实执行过，但执行的方式（手工挂载、把服务平铺在根上下文）和产品真实运行的方式（经过 Loader 的 `unwrapExports`、经过 shadow 代理的祖先遍历）是两条不同的路径。覆盖率统计的是哪些行被跑过，不检查这些行依赖的前提是否与生产一致。

所以门禁的正确用法不是当功能已验证的证书。文档说得很直接：没覆盖到的行往往是门禁在正确地提示死代码该删，而不是缺一个测试去补。

## 代价与边界

无密钥测试跑通，不等于逻辑没问题。postmortem 0001 里，无密钥的 stdout 纯净性 e2e 全绿，却没有触达真正会崩的 `session/new` 和 `session/load` 路径，因为触达它的测试恰好需要密钥，而 CI 在无密钥时会跳过。这暴露了"自我跳过"机制自身的局限：它保证了不阻塞，代价是关键路径可能在无密钥环境里整体缺席。逐文件 100% 的覆盖率要求也不是没有例外，这一点在第 09 章总结里会再谈。

规则也不是禁止对模型输出做任何检查。上面的 `summary.length` 检查说明，对自述做健全性检查是允许的，被禁止的是让它承担"证明任务完成"的责任。

## 小结

一、agent 测试比传统测试多一个信任问题：被测系统会自己写一份可信的成功报告，这份报告不能当证据，判定权要交给重跑的命令、重读的文件和退出码。
二、测试要走产品真实的入口路径，并且守卫要靠"引入回归、看它变红"来证明有效；mock 只收窄在昂贵或不确定的边界，模型层的承诺由带密钥的冒烟测试验证。
三、七层测试各守一种证据，覆盖率门禁被限定在"代码跑过"这一层含义上，不替功能背书。

对应原课程篇目：`08-工程质量与文档治理/01-测试哲学-Verify-the-World-not-the-Self-report.md`。
