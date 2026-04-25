# FIX-04 参考修复

## 根因

Python 经典陷阱：**默认参数在函数定义时求值一次**，可变对象（list / dict / set）会在所有调用间共享。

```python
def parse_csv_line(line: str, errors=[]) -> List[str]:  # ← errors 是同一个 list
    ...
```

效果：
- 第 1 次调用 `parse_csv_line("foo,,bar")` → `errors` 累计 1 条
- 第 2 次调用 `parse_csv_line("a,b")` → 还是同一个 list，但代码里没新增；不过下次有空字段时会接着 1 之后累计

测试 `test_independent_calls_dont_share_errors` 用显式传入 `errors=[]` 后期望长度为 0，但若实现里默认是 `[]` 而调用者也用了默认，前后调用互相污染。

## 修复

```python
def parse_csv_line(line: str, errors=None) -> List[str]:
    if errors is None:
        errors = []
    fields = []
    ...
```

要点：
- 默认值用 `None`（不可变 sentinel）
- 函数内 `if errors is None: errors = []` 给真新 list

## 不要这么改

```python
# ❌ 在函数体内 errors.clear() —— 调用者传了 list 会被清空
def parse_csv_line(line, errors=[]):
    errors.clear()
    ...

# ❌ 改用 mutable default 但每次重置 —— 风格丑还是有副作用
def parse_csv_line(line, errors=[]):
    errors = list(errors) if errors else []
    ...

# ❌ 改测试 / requirements
```

## 为什么这是经典坑

- `def f(x=[])`：`[]` 在 def 那一行求值，绑定到函数对象
- 调用时如果不传 `x`，所有调用复用同一个 list
- 解法是 `None` sentinel —— 几乎所有 Python 风格指南都建议这样
- ruff 规则 `B006` 会自动检测此 anti-pattern
