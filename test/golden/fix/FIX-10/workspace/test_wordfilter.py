"""测试 contains_word：必须识别完整单词，不能误匹配子串。"""
from wordfilter import contains_word


def test_simple_match():
    assert contains_word("I love foo.", "foo") is True
    assert contains_word("foo bar baz", "bar") is True


def test_substring_should_not_match():
    assert contains_word("football is great", "foo") is False
    assert contains_word("afoo is wrong", "foo") is False
    assert contains_word("foobar is bigger", "foo") is False


def test_punctuation_boundary():
    assert contains_word("foo, bar, baz!", "foo") is True
    assert contains_word("foo!", "foo") is True
    assert contains_word("(foo)", "foo") is True


def test_word_at_start_or_end():
    assert contains_word("foo is here", "foo") is True
    assert contains_word("here is foo", "foo") is True


def test_meta_chars_escaped():
    # word 中含 regex meta char 应被 escape，不该被解释为正则
    assert contains_word("a.b is greek", "a.b") is True
    assert contains_word("axb is no greek", "a.b") is False


def test_empty_text():
    assert contains_word("", "foo") is False
