/**
 * cron 任务运行历史 sqlite 后端（#116 阶段 🅑）
 *
 * 与 jsonl 历史并行：jsonl 适合 grep / 离线查阅，sqlite 适合聚合查询。
 */

import type Database from "better-sqlite3";
import type { CronRun, CronTask } from "./types";

export function appendRunRow(
  db: Database.Database,
  task: CronTask,
  run: CronRun
): void {
  const stmt = db.prepare(
    `INSERT INTO cron_runs (task_id, task_name, task_kind, started_at, ended_at, status, output, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    task.id,
    task.name,
    task.kind,
    run.startedAt,
    run.endedAt,
    run.status,
    run.output ?? "",
    run.error ?? null
  );
}

export interface CronRunHistoryRow {
  runId: number;
  taskId: string;
  taskName: string;
  taskKind: string;
  startedAt: number;
  endedAt: number;
  status: string;
  output: string;
  error: string | null;
}

export function listRunsByTask(
  db: Database.Database,
  taskId: string,
  limit = 20
): CronRunHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT run_id, task_id, task_name, task_kind, started_at, ended_at, status, output, error
       FROM cron_runs WHERE task_id = ? ORDER BY ended_at DESC LIMIT ?`
    )
    .all(taskId, limit) as Array<{
    run_id: number;
    task_id: string;
    task_name: string;
    task_kind: string;
    started_at: number;
    ended_at: number;
    status: string;
    output: string;
    error: string | null;
  }>;
  return rows.map((r) => ({
    runId: r.run_id,
    taskId: r.task_id,
    taskName: r.task_name,
    taskKind: r.task_kind,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    output: r.output,
    error: r.error,
  }));
}

export function summarizeRecent(
  db: Database.Database,
  sinceTs: number
): {
  total: number;
  byStatus: Record<string, number>;
  byTask: Array<{ taskId: string; taskName: string; total: number; lastEndedAt: number }>;
} {
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM cron_runs WHERE ended_at >= ?`)
    .get(sinceTs) as { n: number };
  const statusRows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM cron_runs WHERE ended_at >= ? GROUP BY status`)
    .all(sinceTs) as Array<{ status: string; n: number }>;
  const taskRows = db
    .prepare(
      `SELECT task_id, task_name, COUNT(*) AS n, MAX(ended_at) AS last_ended_at
       FROM cron_runs WHERE ended_at >= ? GROUP BY task_id, task_name ORDER BY n DESC`
    )
    .all(sinceTs) as Array<{ task_id: string; task_name: string; n: number; last_ended_at: number }>;
  return {
    total: totalRow.n,
    byStatus: Object.fromEntries(statusRows.map((r) => [r.status, r.n])),
    byTask: taskRows.map((r) => ({
      taskId: r.task_id,
      taskName: r.task_name,
      total: r.n,
      lastEndedAt: r.last_ended_at,
    })),
  };
}

export function purgeOlderThan(db: Database.Database, sinceTs: number): number {
  const r = db.prepare(`DELETE FROM cron_runs WHERE ended_at < ?`).run(sinceTs);
  return r.changes;
}
