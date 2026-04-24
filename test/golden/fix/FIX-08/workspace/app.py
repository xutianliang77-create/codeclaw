"""
极简 Flask + SQLAlchemy todo 服务。

已知 bug：GET /todos 存在 N+1：
  1 次 SELECT 取 todos
  每条 todo 再 SELECT 一次 owner（lazy load）
请改用 eager loading 消除。
"""

from flask import Flask, jsonify
from sqlalchemy import Column, ForeignKey, Integer, String, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, Session


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)


class Todo(Base):
    __tablename__ = "todos"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    owner_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    owner: Mapped[User] = relationship("User")


def create_app(engine=None):
    app = Flask(__name__)
    if engine is None:
        engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)

    app.config["engine"] = engine

    @app.get("/todos")
    def list_todos():
        with Session(engine) as session:
            # BUG: 直接 query(Todo) 不带 eager loading，
            # 访问 t.owner.name 会为每条触发一次 SELECT users
            todos = session.query(Todo).all()
            return jsonify([
                {"id": t.id, "title": t.title, "owner": t.owner.name}
                for t in todos
            ])

    return app
