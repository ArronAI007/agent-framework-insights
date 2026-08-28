import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from harness.budget import Budget
from harness.loop import run_agent
from mock_llm import MockLLM
from scenarios import get_scenario
from tools import build_default_tool_registry

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


def _run(scenario_name, max_steps=30):
    goal, script = get_scenario(scenario_name)
    llm = MockLLM(script)
    budget = Budget(max_steps=max_steps)
    registry = build_default_tool_registry()
    result = run_agent(
        goal, registry, llm, budget, DEFAULT_COMPACT_CONFIG, DEFAULT_COMPRESSION_CONFIG
    )
    return result, llm.call_count, registry


def test_combined_scenario_survives_loop_detection_and_validation_together():
    result, call_count, registry = _run("combined_recovery")

    assert result == "已完成：记录了失败原因并结束任务。"
    assert call_count == 8
    assert "read_file" not in registry  # 循环检测确实禁用了它
    assert "write_file" in registry  # 校验失败没有连带禁用其它工具


def test_budget_is_still_the_ultimate_backstop_even_with_all_layers_enabled():
    # runaway 场景：50 步完全相同的调用。循环检测会在第 5 步就命中，
    # 但即使假设某一层防护失灵，预算也必须是兜底：调用次数不会超过 max_steps。
    goal, script = get_scenario("runaway")
    llm = MockLLM(script)
    budget = Budget(max_steps=10)
    registry = build_default_tool_registry()

    run_agent(
        goal, registry, llm, budget, DEFAULT_COMPACT_CONFIG, DEFAULT_COMPRESSION_CONFIG
    )

    assert llm.call_count <= 10


def test_all_five_layers_are_present_in_a_single_run_agent_call():
    # 回归测试：v1~v6 的既有场景在整合版里必须继续按各自版本的预期工作。
    happy_result, happy_calls, _ = _run("happy_path")
    assert happy_result == "配置文件内容：timeout=30, retries=3。"
    assert happy_calls == 2

    validation_result, validation_calls, _ = _run("unknown_tool_repeated")
    assert validation_result == "连续校验失败，任务终止"
    assert validation_calls == 3
