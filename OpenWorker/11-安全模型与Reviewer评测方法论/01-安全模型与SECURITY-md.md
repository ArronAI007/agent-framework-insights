# 安全模型与 SECURITY.md

> `SECURITY.md` 只有 37 行,却是这个仓库对外做出的最直白的一份承诺书:"OpenWorker is a security-positioned project; we hold ourselves to the standard we pitch."——一个专门卖"帮你做安全审查"的产品,先把自己摆上台面接受审查。这份文档没有停留在"欢迎提交漏洞报告"这句公关辞令上,而是把范围条款写到了具体的攻击面:"绕过人类专属红线或审批闸门(比如通过 prompt injection 或恶意 MCP 工具)"被明文列为高优先级、在范围内的漏洞类型。本文精读这份安全政策,并把它和 README"Security review"这个 use case 里"修复者不能是唯一的检查者"这句设计哲学对照起来看——两者背后其实是同一条原则:任何环节都不能自我认证,必须有独立于自身的第二方验证。

## 学习目标

- 逐条读懂 `SECURITY.md` 的报告渠道、响应承诺、范围界定与版本支持策略,建立"这份安全政策具体承诺了什么、又明确排除了什么"的准确认识。
- 理解为什么"绕过人类专属红线或审批闸门"被单独点名为高优先级范围——这与第 04 章讲过的三层治理体系(硬性红线、自主权阶梯、审计轨迹)是同一件事的两种表述:一份是内部实现,一份是对外的安全边界声明。
- 理解 README"Security review" use case 里"findings come from deterministic scanners plus model reasoning...the fixer is never the only checker"这条设计哲学,并看清它和治理系统、以及本章第二篇要讲的 Reviewer 评测方法论,在精神上是同一条原则的三次不同应用。
- 能够说清楚"latest release only"这条版本支持策略,与"the app auto-updates"这个产品特性之间的因果关系。

## 背景与设计动机

大多数开源项目的 `SECURITY.md` 是一份模板文档:一个邮箱地址,几句"感谢你的负责任披露"的客套话,再加一张受支持版本表。OpenWorker 的 `SECURITY.md` 表面上遵循同样的骨架,但内容分量不对称——范围(Scope)那一节明确把"人类专属红线或审批闸门被绕过"点了名,而不是笼统地写"欢迎报告任何安全问题"。这个细节值得停下来想一想:一个把"治理是架构本身"当作核心卖点的产品,如果它的安全政策对"治理本身被绕过"这件事含糊其辞,那这份承诺就是空的。反过来,把这类漏洞明确划入"高严重度、范围内",相当于把第 04 章讲过的整套治理机制(硬性红线、自主权阶梯、审计轨迹)公开挂了一个靶子,邀请外部研究者拿真实的攻击手法——prompt injection、恶意 MCP 工具——去戳它。这是一种"以战止战"式的信任建立方式:不说"我们的护栏很安全",而是说"如果护栏能被绕过,我们把这当成头等大事,请来找茬"。

## 核心机制详解

### 报告渠道与响应承诺

`SECURITY.md` 对报告流程的要求很具体:

```text
Email security@openworker.com with:
- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- the version you tested (app version from the About screen, or a commit hash).
```

三个响应承诺紧随其后:3 个工作日内确认收到、过程中持续同步进展、修复上线后在发布说明里署名致谢(除非报告者要求匿名)。文档还特别要求"用邮件而不是公开 issue",理由写得很直接——"so a fix can ship before details are public"。这是负责任披露(responsible disclosure)的标准做法,但在一个由 AI agent 自主执行文件写入、shell 命令、网络请求的产品里,这条要求的分量更重:一份公开 issue 里如果详细描述了"如何用 prompt injection 绕过审批闸门",在补丁上线前就相当于给了所有安装了该版本的用户一份现成的攻击脚本。

### 范围条款:治理系统本身就是被保护的资产

Scope 一节是这份文档里信息密度最高的部分:

```text
- The desktop app and local agent server in this repository - including the
  permission gates, approval/reviewer flow, and audit trail. Bypasses of the
  human-only floors or approval gates (e.g. via prompt injection or a malicious
  MCP tool) are in scope and treated as high severity.
- The OAuth broker service used for managed connectors.

Out of scope: vulnerabilities in third-party model providers or connected
services themselves, and issues requiring an already-compromised machine.
```

拆开看三层意思:

- **"permission gates, approval/reviewer flow, and audit trail" 被逐字点名**——这三个词组几乎就是第 04 章"三层治理"的英文原词:硬性红线对应 permission gates,自主权阶梯里的 reviewer 对应 approval/reviewer flow,审计轨迹对应 audit trail。安全政策没有笼统地写"整个 agent 服务器",而是直接指向治理系统的三个具体组成部分,说明团队清楚自己产品里真正的高价值攻击面在哪——不是某个 REST 端点的 SQL 注入,而是"agent 会不会在没有人批准的情况下做了不该做的事"。
- **攻击手法被具体点名**——"prompt injection or a malicious MCP tool"。这两种手法恰好对应仓库里两类真实的信任边界:prompt injection 对应"外部抓取内容里混入的指令"(这正是本章第二篇 `injection.jsonl` 语料专门测试的场景),恶意 MCP 工具对应"第三方工具描述本身可能携带误导性文本"。安全政策把这两类攻击面直接和"人类专属红线/审批闸门被绕过"挂钩,划成高严重度——这不是通用安全模板里的套话,而是针对这个产品真实攻击模型写出来的条款。
- **明确的排除项**——"third-party model providers or connected services themselves"和"issues requiring an already-compromised machine"被划出范围。前者划清了"模型本身犯错"和"我们的治理系统失效"之间的责任边界:模型说错话、模型被越狱,是模型提供商的问题;但模型的错误判断能不能被治理系统拦住,才是 OpenWorker 的责任。后者是本地优先(local-first)架构下一条现实的边界——如果攻击者已经拿到了用户机器的完整控制权,任何运行在这台机器上的软件都谈不上"安全",这不是治理系统需要覆盖的威胁模型。

### 版本支持策略:auto-update 换来的"只支持最新版"

```text
## Supported versions

The latest release only. The app auto-updates, so fixes reach installs quickly -
this is also why we don't patch older versions.

There is no bug bounty program at this time.
```

这条策略乍看像是在推卸维护责任,但它的因果关系其实是反过来的:正因为产品本身具备自动更新能力,"只支持最新版"才是一个合理决定而不是偷懒——传统软件因为用户可能常年停留在旧版本,才不得不维护多个受支持分支;而 OpenWorker 把"让用户尽快用上修复版本"这件事做成了产品能力的一部分(auto-updates),于是"我们只对最新版负责"就不再是甩锅,而是把维护资源集中在唯一真正有效的战线上。"目前没有 bug bounty 项目"这一句也值得如实记录——这是一个仍处于 beta 阶段的开源项目在安全响应上的诚实姿态:承诺的是负责任披露的流程和致谢,而不是金钱激励,这与其"beta,持续打磨"的产品定位是一致的。

### 对照:"修复者不能是唯一的检查者"

README"Use cases"一节描述"Security review"这个 use case 时写了一句在整个仓库里都少见地精确的工程原则:

```text
Security review - scan a codebase and its dependencies for real risk. Findings
come from deterministic scanners (like semgrep) plus model reasoning; proposed
fixes are re-scanned and diff-reviewed before you approve them - the fixer is
never the only checker.
```

"the fixer is never the only checker"这句话描述的是 OpenWorker 作为产品对外提供的一项能力——它帮用户审查代码库时,遵守的正是"生成修复的模型不能自己给自己的修复打分"这条分离原则:发现问题靠确定性扫描器(semgrep)加模型推理两条腿,而不是只靠模型自己说"这里有洞";提出的修复方案要被重新扫描、逐行 diff 审查,而不是模型说"改好了"就直接采纳。

这条原则和 `SECURITY.md` 的范围条款、和第 04 章讲过的治理系统,其实是同一条思路在三个不同场景里的具体应用:

| 场景 | "谁提出" | "谁检查"——不能是同一个角色 |
|---|---|---|
| 治理系统(第 04 章) | agent 提议一次工具调用 | 硬性红线 + reviewer 模型 + 人类审批,三者都独立于提议者 |
| 安全政策(本篇) | OpenWorker 团队自己写代码、自己声称"治理很安全" | 外部安全研究者通过 `SECURITY.md` 的渠道独立验证这个声称 |
| Security review use case | 模型生成一份代码修复 | 确定性扫描器 + 二次 diff 审查独立验证这份修复 |

三行看似不相关,但都在回答同一个问题:"如果只相信提出方案的那个角色自己的判断,风险由谁兜底?"答案永远是引入一个不受第一个角色控制的独立环节。`SECURITY.md` 之所以把"治理系统被绕过"列为高严重度范围,本质上就是把"外部安全研究者"这个角色,正式请进了"独立于 OpenWorker 团队自身"的检查链条里——这是"不能自我认证"这条原则在公司边界之外的延伸:内部有硬性红线和 reviewer 顶着,外部还要留一条负责任披露的入口,防止内部这套机制本身出现团队自己没发现的漏洞。

## 小结

`SECURITY.md` 这份 37 行的文档,把"治理系统的正确性不能只由 OpenWorker 自己说了算"这件事落实成了具体的报告渠道、响应时限和严重度分级——尤其是把"绕过人类专属红线或审批闸门"明确列为高优先级范围,这等于公开承认:治理系统再精心设计,也需要接受外部独立验证,而不是关起门来自证。README"Security review"use case 里"the fixer is never the only checker"这句话,则是同一条"不能自我认证"原则在产品能力层面的体现。

但外部披露渠道只能覆盖"已经被人发现的问题"——它是被动的、事后的。一个团队如果真的相信"reviewer 的判断是判断,不是保证"这句话,就不能只等外部研究者来找茬,还需要在内部建立一套主动的、持续运行的验证机制,在漏洞报告寄到 `security@openworker.com` 之前,先用真实数据把 Reviewer 模型的表现测清楚。下一篇就来看这套机制——`scripts/eval_reviewer.py` 和分层语料构成的 Reviewer 评测方法论,以及 `reports/` 目录下八份跨越近三周、覆盖六款候选模型的真实评测报告,如何把"这只是模型判断,不是保证"这句免责声明,变成一套可持续验证、留痕可查的工程实践。
