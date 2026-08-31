import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from harness.budget import Budget
from harness.loop import run_agent
from harness.tool_registry import ToolRegistry
from harness.validator import validate_tool_call
from mock_llm import MockLLM
from scenarios import get_scenario
from tools import Tool, build_default_tool_registry

DEFAULT_COMPACT_CONFIG = {
    "trigger_every": 3,
    "keep_recent_count": 4,
    "exempt_tools": {"read_file"},
}
DEFAULT_COMPRESSION_CONFIG = {
    "char_threshold": 4000,
    "max_compressions": 3,
    "keep_recent_count": 6,
}


async def _noop():
    return "ok"


def test_tool_registry_register_adds_tool():
    registry = ToolRegistry()
    tool = Tool("noop", _noop, {})
    registry.register(tool)
    assert "noop" in registry
    assert registry["noop"] is tool


def test_tool_registry_unregister_removes_tool():
    registry = ToolRegistry()
    registry.register(Tool("noop", _noop, {}))
    registry.unregister("noop")
    assert "noop" not in registry


def test_tool_registry_unregister_missing_tool_is_a_no_op():
    registry = ToolRegistry()
    registry.unregister("does_not_exist")  # 不应该抛异常
    assert "does_not_exist" not in registry


def test_weather_lookup_is_unknown_before_plugin_loaded():
    registry = build_default_tool_registry()
    call = {"name": "weather_lookup", "args": {"city": "北京"}}
    result = validate_tool_call(call, registry)
    assert result["ok"] is False
    assert "未知工具" in result["error"]


def test_plugin_then_use_scenario_dynamically_registers_and_calls_new_tool():
    async def scenario_body():
        goal, script = get_scenario("plugin_then_use")
        llm = MockLLM(script)
        budget = Budget(max_steps=30)
        registry = build_default_tool_registry()

        result = await run_agent(
            goal, registry, llm, budget, DEFAULT_COMPACT_CONFIG, DEFAULT_COMPRESSION_CONFIG
        )

        assert result == "北京今天晴，22°C。"
        assert "weather_lookup" in registry

    asyncio.run(scenario_body())
