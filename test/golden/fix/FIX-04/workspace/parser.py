"""
极简 CSV 行解析器：按逗号切分，自动 strip 空白。
errors 参数用来收集解析中遇到的问题（如空字段）。

已知 bug：errors 默认参数用了可变对象 []，跨调用会共享同一个 list。
请修这里。
"""
from typing import List


def parse_csv_line(line: str, errors=[]) -> List[str]:
    fields = []
    for raw in line.split(","):
        s = raw.strip()
        if s == "":
            errors.append(f"empty field at index {len(fields)}")
        fields.append(s)
    return fields
