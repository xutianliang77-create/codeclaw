# FIX-10 参考修复

## 根因

```python
return re.search(pattern, text) is not None
```

不带词边界 `\b`，"foo" 会子串命中 "football"、"afoo"、"foobar"。

## 修复

```python
return re.search(rf"\b{pattern}\b", text) is not None
```

或用 `r"\b" + pattern + r"\b"`。

## 关键点

| 点 | 说明 |
|---|---|
| `\b` 词边界 | `\w` 与 `\W`（或字符串边界）的分界 |
| `re.escape(word)` | 必须保留：让 `a.b` 中的 `.` 不被当成正则 metachar |
| 大小写敏感 | 题目要求区分大小写（默认行为）；不应加 `re.IGNORECASE` |

## 验证

```python
import re
re.search(r"\bfoo\b", "I love foo.")     # match
re.search(r"\bfoo\b", "football is great") # None
re.search(r"\bfoo\b", "foo!")             # match
re.search(r"\bfoo\b", "(foo)")            # match
```

## 不要这么改

```python
# ❌ 用 split + in 检查 —— 不通用，标点/换行处理坑多
words = text.split()
return word in words

# ❌ 移除 re.escape —— 让 "a.b" 当通配符匹配 "axb"
return re.search(rf"\b{word}\b", text) is not None

# ❌ 改测试期望
```
