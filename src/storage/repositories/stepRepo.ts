/**
 * steps 表最小工具 + 状态流转
 */

import type Database from "better-sqlite3";

export type StepStatus = "ready" | "invoking" | "done" | "failed" | "replanned";

export interface StepInsert {
  stepId: string;
  traceId: string;
  stepNo: number;
  actionType: string;
  target?: string;
  dependsOn?: string[];
  status: StepStatus;
  createdAt?: number;
}

export function insertStep(db: Database.Database, s: StepInsert): void {
  const now = s.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO steps(
       step_id, trace_id, step_no, action_type, target,
       depends_on_json, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    s.stepId,
    s.traceId,
    s.stepNo,
    s.actionType,
    s.target ?? null,
    s.dependsOn && s.dependsOn.length > 0 ? JSON.stringify(s.dependsOn) : null,
    s.status,
    now,
    now
  );
}

export function updateStepStatus(
  db: Database.Database,
  stepId: string,
  status: StepStatus
): void {
  db.prepare(`UPDATE steps SET status = ?, updated_at = ? WHERE step_id = ?`).run(
    status,
    Date.now(),
    stepId
  );
}
