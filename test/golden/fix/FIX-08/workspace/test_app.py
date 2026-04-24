"""
FIX-08 测试：验证 /todos 无 N+1。

通过给 SQLAlchemy engine 装一个 before_cursor_execute 事件监听器来计 SELECT 次数。
N+1 修好后，SELECT users 应只 1 次（或 0 次 + JOIN 到 todos）。
"""

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from app import Base, Todo, User, create_app


@pytest.fixture
def engine_with_data():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)

    with Session(engine) as session:
        alice = User(name="Alice")
        bob = User(name="Bob")
        session.add_all([alice, bob])
        session.flush()
        session.add_all([
            Todo(title="write tests", owner_id=alice.id),
            Todo(title="ship feature", owner_id=alice.id),
            Todo(title="review PR", owner_id=bob.id),
            Todo(title="clean inbox", owner_id=bob.id),
        ])
        session.commit()

    return engine


def test_todos_endpoint_returns_all(engine_with_data):
    app = create_app(engine_with_data)
    client = app.test_client()
    resp = client.get("/todos")
    assert resp.status_code == 200
    data = resp.get_json()
    assert len(data) == 4
    owners = {d["owner"] for d in data}
    assert owners == {"Alice", "Bob"}


def test_todos_endpoint_shape(engine_with_data):
    app = create_app(engine_with_data)
    client = app.test_client()
    resp = client.get("/todos")
    data = resp.get_json()
    for item in data:
        assert set(item.keys()) == {"id", "title", "owner"}


def test_list_todos_no_n_plus_1(engine_with_data):
    """核心 N+1 检查：对 users 表的 SELECT 最多发生 1 次（通常是 0 次，JOIN 消解）。"""
    select_users_count = 0

    @event.listens_for(engine_with_data, "before_cursor_execute")
    def count_user_selects(conn, cursor, statement, parameters, context, executemany):
        nonlocal select_users_count
        # 粗略匹配: "FROM users" 说明触发了 users 表扫描
        if "from users" in statement.lower():
            select_users_count += 1

    app = create_app(engine_with_data)
    client = app.test_client()
    resp = client.get("/todos")
    assert resp.status_code == 200

    assert select_users_count <= 1, (
        f"expected <=1 SELECT on users (N+1 fixed), got {select_users_count}"
    )
