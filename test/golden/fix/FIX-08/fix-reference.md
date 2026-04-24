# FIX-08 参考修复

## Bug

`app.py` 的 `list_todos` 只做了 `session.query(Todo).all()`，`Todo.owner` 的 relationship 默认 lazy。
列表推导里 `t.owner.name` 为每条 todo 触发一次 `SELECT FROM users`，4 条 todo → 4 次 users 查询，加上首条 todos 查询共 5 次 = (1 + N)。

## 正确修复

用 eager loading。首选 `joinedload`（一次 JOIN 搞定，适合一对多少量数据）：

```python
from sqlalchemy.orm import joinedload  # 新增 import 或合并到已有 orm 行

# list_todos 内：
todos = session.query(Todo).options(joinedload(Todo.owner)).all()
```

或者 `selectinload`（两条 SELECT 用 IN 查，避免宽表 JOIN）：

```python
from sqlalchemy.orm import selectinload
todos = session.query(Todo).options(selectinload(Todo.owner)).all()
```

## 期望 diff 规模

- 1 个文件（`app.py`）
- ≤ 4 行：新增 import + `query(...).options(joinedload(...))`

## 期望测试结果

```
3 passed
```

## 常见错误修复路径

- 在 relationship 上加 `lazy="joined"` → 也能过，但副作用更大（所有 Todo 访问都 eager），行数少但"全局改动"不够 surgical
- 手动多跑一次 `session.query(User).filter(User.id.in_(...))` 再字典映射 → 行数会超
- 改 `test_app.py` 里的 `select_users_count <= 1` 阈值 → forbidden_changes
- 修改 engine 全局 lazy 策略 → 过度修改
