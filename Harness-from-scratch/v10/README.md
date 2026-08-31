# v10：并发工具调用 + 超时取消

## 本版目标

到 v9 为止，即便模型一轮返回好几个互相独立的工具调用，Harness 也是一个接一个顺序执行的；一个工具卡住不返回，整个运行就跟着卡住。这一版把 `run_agent` 改成 `async def`，同一轮里的多个工具调用改为并发执行，并给每个调用套上超时，卡住的工具会被取消而不是拖死整条运行。

## 新增/修改文件（对照 v9）

- 修改 `mock_llm.py`：`MockLLM.chat()` 改成 `async def`。
- 修改 `tools.py`：`Tool.run()` 和内部的工具函数全部改成 `async def`；新增 `ConcurrencyTracker`（记录同时在执行的调用数峰值，用来在测试里证明并发确实发生）和 `slow_tool`（人为耗时 0.2 秒，用来演示超时取消）。
- 修改 `harness/loop.py`：`run_agent()` 改成 `async def`；校验和熔断检查仍然顺序执行，只有通过检查、真正要执行的调用才通过 `asyncio.gather` 并发跑；每个调用外层套 `asyncio.wait_for(..., timeout=timeout_seconds)`。`sleep_fn` 默认值从 `time.sleep` 换成 `asyncio.sleep`。
- 修改 `scenarios.py`：新增 `parallel_tools`（一轮两个独立调用）和 `slow_tool_timeout`（演示超时取消）。
- 修改 `main.py`：新增 `run_main()` 异步入口，`main()` 用 `asyncio.run()` 驱动；沿用 v9 的会话续跑提示打印。
- 其余文件（`harness/budget.py`、`harness/loop_detector.py`、`harness/context_manager.py`、`harness/validator.py`、`harness/errors.py`、`harness/retry.py`、`harness/session_store.py`）与 v9 完全一致，不涉及 async 改造。

## 核心设计

**为什么校验/熔断检查不并发，只有真正的工具执行并发**：校验和熔断判断本身是纯内存操作，几乎不耗时，而且它们的结果会影响"这一轮到底要不要终止整个任务"（比如连续校验失败达到阈值），这类决策必须按顺序做，不能并发；真正值得并发化的是"调用工具、等待它返回结果"这个可能有真实 I/O 延迟的部分。

**为什么用一个共享的"在途调用数"计数器而不是用真实计时来验证并发**：如果测试断言"两个调用的总耗时比顺序执行短"，测试结果会因为运行测试的机器负载、CI 环境的抖动而变得不稳定（flaky）。而"同一时刻有几个调用同时挂在 `active` 状态"这个数字不依赖具体耗时多少，只要两个协程确实同时在跑，`peak` 就一定会 `>= 2`，是一个更稳定、更直接的并发证明方式。

**为什么超时的处理方式是"记一次熔断失败"，而不是重试**：超时到底该不该重试是一个更微妙的问题（重试一个本来就慢的操作，可能只是让它更慢），本版本把它简化成和普通失败一样处理，交给已有的熔断机制去判断"这个工具是不是已经不可靠了"，不在这一版引入额外的超时专属重试策略。

## 如何运行 demo

```bash
python3 main.py --scenario parallel_tools       # 一轮两个调用并发跑完
python3 main.py --scenario slow_tool_timeout    # 演示慢工具被超时机制处理（默认超时较宽松，测试里用更短的超时更容易看到取消效果）
```

## 局限性

本版本明确不实现真正的流式增量输出——`MockLLM` 一次性返回完整的 response，没有真实的增量 token/chunk 可以流式吐出，强行把已有字符串拆成逐字符输出没有教学意义，这是与设计文档"并发与流式"标题相对应、经过确认的范围收窄。另外，超时后的工具调用在 Python 的 `asyncio.wait_for` 实现里，被取消的协程本身可能仍在后台继续运行到某个 `await` 点才真正终止（不是瞬间强杀），本版本没有对这类"僵尸任务"做额外的清理或资源回收演示，真实生产系统里这通常需要工具自身支持协作式取消（在内部检查 `asyncio.CancelledError` 并做清理）。
