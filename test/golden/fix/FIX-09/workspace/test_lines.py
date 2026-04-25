"""测试 last_n_lines 边界。"""
from lines import last_n_lines


def test_last_2_of_5():
    assert last_n_lines(["a", "b", "c", "d", "e"], 2) == ["d", "e"]


def test_last_3_of_5():
    assert last_n_lines(["a", "b", "c", "d", "e"], 3) == ["c", "d", "e"]


def test_last_1_of_5():
    assert last_n_lines(["a", "b", "c", "d", "e"], 1) == ["e"]


def test_n_equals_len():
    assert last_n_lines(["a", "b", "c"], 3) == ["a", "b", "c"]


def test_n_zero_or_negative():
    assert last_n_lines(["a", "b"], 0) == []
    assert last_n_lines(["a", "b"], -1) == []


def test_n_greater_than_len():
    assert last_n_lines(["a", "b"], 10) == ["a", "b"]
