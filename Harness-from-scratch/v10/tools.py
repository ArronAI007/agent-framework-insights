"""示例工具集：内存态假文件系统 + 假搜索，配合 MockLLM 复现固定场景。"""

import asyncio

from harness.errors import TransientError


class Tool:
    def __init__(self, name, func, params=None):
        self.name = name
        self.func = func
        self.params = params or {}  # param_name -> {"required": bool}

    async def run(self, args):
        return await self.func(**args)


class ConcurrencyTracker:
    """记录同一时刻有多少个工具调用正在执行，用来证明"真的并发了"而不是靠计时猜测。"""

    def __init__(self):
        self.active = 0
        self.peak = 0

    def enter(self):
        self.active += 1
        self.peak = max(self.peak, self.active)

    def exit(self):
        self.active -= 1


def _make_fake_fs():
    return {"config.yaml": "timeout: 30\nretries: 3\n"}


def build_default_tool_registry(concurrency_tracker=None):
    fake_fs = _make_fake_fs()
    flaky_state = {"attempts": 0}

    async def read_file(path):
        if concurrency_tracker is not None:
            concurrency_tracker.enter()
        try:
            await asyncio.sleep(0.01)
            if path not in fake_fs:
                raise FileNotFoundError(f"文件不存在: {path}")
            return fake_fs[path]
        finally:
            if concurrency_tracker is not None:
                concurrency_tracker.exit()

    async def search_web(query):
        if concurrency_tracker is not None:
            concurrency_tracker.enter()
        try:
            await asyncio.sleep(0.01)
            return f"搜索 '{query}' 的结果：暂无相关信息（mock 数据）。"
        finally:
            if concurrency_tracker is not None:
                concurrency_tracker.exit()

    async def write_file(path, content):
        fake_fs[path] = content
        return f"已写入 {path}（{len(content)} 字符）"

    async def flaky_api(query):
        flaky_state["attempts"] += 1
        if flaky_state["attempts"] <= 2:
            raise TransientError(f"临时故障（第 {flaky_state['attempts']} 次尝试）")
        return f"flaky_api 调用成功（第 {flaky_state['attempts']} 次尝试）：{query}"

    async def always_fails_api(query):
        raise TransientError("这个接口一直不可用")

    async def slow_tool(query):
        await asyncio.sleep(0.2)
        return f"slow_tool 终于处理完了：{query}"

    return {
        "read_file": Tool("read_file", read_file, {"path": {"required": True}}),
        "search_web": Tool("search_web", search_web, {"query": {"required": True}}),
        "write_file": Tool(
            "write_file",
            write_file,
            {"path": {"required": True}, "content": {"required": True}},
        ),
        "flaky_api": Tool("flaky_api", flaky_api, {"query": {"required": True}}),
        "always_fails_api": Tool(
            "always_fails_api", always_fails_api, {"query": {"required": True}}
        ),
        "slow_tool": Tool("slow_tool", slow_tool, {"query": {"required": True}}),
    }
