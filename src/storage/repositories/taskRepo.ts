/**
 * tasks 表最小工具（供 observations / steps 外键引用）
 * 完整 FSM 状态机由 orchestration 层管理；此处只负责"建 task 入库" + 读取
 */

import type Database from "better-sqlite3";

export interface TaskInsert {
  traceId: string;
  sessionId: string;
  goal: string;
  state: "planning" | "executing" | "completed" | "halted" | "failed";
  riskLevel?: "low" | "medium" | "high";
  startedAt?: number;
}

export function insertTask(db: Database.Database, t: TaskInsert): void {
  db.prepare(
    `INSERT INTO tasks(trace_id, session_id, goal, state, risk_level, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    t.traceId,
    t.sessionId,
    t.goal,
    t.state,
    t.riskLevel ?? null,
    t.startedAt ?? Date.now()
  );
}
