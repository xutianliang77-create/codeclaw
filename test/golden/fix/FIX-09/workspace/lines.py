"""
工具函数 last_n_lines：返回列表的最后 n 行。
已知 bug：切片 -n-1: 多取了一行。
请只改这个文件。
"""
from typing import List


def last_n_lines(lines: List[str], n: int) -> List[str]:
    if n <= 0:
        return []
    if n >= len(lines):
        return list(lines)
    # BUG：切片偏移错；实际取了 n+1 行
    return lines[-n - 1:]
