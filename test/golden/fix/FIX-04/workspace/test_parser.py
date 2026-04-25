"""测试 parse_csv_line 的纯净性 + 错误收集行为。"""
import inspect
import importlib

import parser as parser_mod


def _reload():
    """每个 test 前重新 import，让 default arg 状态干净。"""
    return importlib.reload(parser_mod)


def test_basic_split():
    mod = _reload()
    assert mod.parse_csv_line("a,b,c") == ["a", "b", "c"]


def test_independent_calls_dont_share_errors():
    """关键 bug 检测：用默认参数连续调用，第二次的 errors 应只反映本次。"""
    mod = _reload()

    # 第一次：用默认参数调用，遇到 1 个空字段
    mod.parse_csv_line("foo,,bar")
    # 第二次：用默认参数调用，遇到 2 个空字段
    mod.parse_csv_line(",a,,b")

    # 此时检查：函数签名上 errors 的默认值，应是 None 或 (空) tuple 等
    # 不可变 sentinel；不应是 mutable list（更不应是被污染的 list）
    default = inspect.signature(mod.parse_csv_line).parameters["errors"].default
    assert default is None or isinstance(default, tuple), (
        f"default should be a non-mutable sentinel (None / tuple), "
        f"got {type(default).__name__}: {default!r}. "
        f"Mutable default args are shared across calls."
    )


def test_explicit_errors_list_collects():
    mod = _reload()
    errs = []
    mod.parse_csv_line("x,,y", errors=errs)
    assert len(errs) == 1
    assert "empty field" in errs[0]
