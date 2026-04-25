"""
工具：判断文本是否含某个完整单词（区分大小写）。
"foo" 应该匹配 "I love foo." 但不应匹配 "football" 或 "afoo".

已知 bug：用了 re.search(pattern) 不带词边界 \\b，子串也会命中。
请修 contains_word，使其只识别独立单词（前后是字符串边界或非字母数字字符）。
"""
import re


def contains_word(text: str, word: str) -> bool:
    pattern = re.escape(word)
    # BUG：缺词边界，子串命中
    return re.search(pattern, text) is not None
