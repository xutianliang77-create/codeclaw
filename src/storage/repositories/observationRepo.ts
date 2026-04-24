/**
 * ObservationRepo · P0-W1-10
 *
 * 职责：Tool / Skill / MCP 执行完 → 写入 observation
 *   - 元信息入 `observations` 表（体积小、可索引）
 *   - 正文（执行输出、工具 stdout 等）入 JSONL
 *       · 正文 ≤ OVERFLOW_THRESHOLD（100 KB）：追加到 `sessions/{sid}/observations.jsonl`
 *       · 正文 > OVERFLOW_THRESHOLD：独立文件 `sessions/{sid}/observations/{stepId}.jsonl`
 *
 * 不变式：
 *   - `body_inline = 1` 表示正文在合并 jsonl 内（按行查找）
 *   - `body_inline = 0` 表示正文在溢出文件（整文件即一条 observation）
 *   - `body_path` 是相对 sessions/{sid}/ 的路径（便于目录整体迁移）
 *
 * 依赖外键：observations(trace_id) → tasks, observations(step_id) → steps
 * 调用者需先保证 sessions / tasks / steps 行已建（见 sessionRepo / taskRepo / stepRepo）
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

export const OBSERVATION_OVERFLOW_THRESHOLD = 100 * 1024; // 100 KB

export type ObservationStatus = "completed" | "blocked" | "failed" | "pending";

export interface ObservationInsert {
  observationId: string;
  traceId: string;
  stepId: string;
  sessionId: string;
  status: ObservationStatus;
  summary?: string;
  body: string;
  latencyMs?: number;
  tokenCost?: number;
  createdAt?: number;
}

export interface ObservationRecord {
  observationId: string;
  traceId: string;
  stepId: string;
  status: ObservationStatus;
  summary: string | null;
  latencyMs: number | null;
  tokenCost: number | null;
  bodyInline: boolean;
  bodyPath: string;
  createdAt: number;
}

interface ObservationRow {
  observation_id: string;
  trace_id: string;
  step_id: string;
  status: ObservationStatus;
  summary: string | null;
  latency_ms: number | null;
  token_cost: number | null;
  body_inline: number;
  body_path: string;
  created_at: number;
}

export class ObservationRepo {
  constructor(
    private readonly db: Database.Database,
    /** 通常为 `~/.codeclaw/sessions`；测试里用 tmp */
    private readonly sessionsDir: string
  ) {}

  record(input: ObservationInsert): ObservationRecord {
    const createdAt = input.createdAt ?? Date.now();
    const sessionDir = path.join(this.sessionsDir, input.sessionId);
    mkdirSync(sessionDir, { recursive: true });

    const size = Buffer.byteLength(input.body, "utf8");
    const inlineEntry =
      JSON.stringify({
        observationId: input.observationId,
        stepId: input.stepId,
        status: input.status,
        body: input.body,
        createdAt,
      }) + "\n";

    let bodyInline: boolean;
    let bodyPath: string;

    if (size <= OBSERVATION_OVERFLOW_THRESHOLD) {
      bodyInline = true;
      bodyPath = "observations.jsonl";
      appendFileSync(path.join(sessionDir, bodyPath), inlineEntry);
    } else {
      bodyInline = false;
      const overflowDir = path.join(sessionDir, "observations");
      mkdirSync(overflowDir, { recursive: true });
      bodyPath = path.join("observations", `${input.stepId}.jsonl`);
      appendFileSync(path.join(sessionDir, bodyPath), inlineEntry);
    }

    this.db
      .prepare(
        `INSERT INTO observations(
           observation_id, trace_id, step_id, status,
           summary, latency_ms, token_cost,
           body_inline, body_path, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.observationId,
        input.traceId,
        input.stepId,
        input.status,
        input.summary ?? null,
        input.latencyMs ?? null,
        input.tokenCost ?? null,
        bodyInline ? 1 : 0,
        bodyPath,
        createdAt
      );

    return {
      observationId: input.observationId,
      traceId: input.traceId,
      stepId: input.stepId,
      status: input.status,
      summary: input.summary ?? null,
      latencyMs: input.latencyMs ?? null,
      tokenCost: input.tokenCost ?? null,
      bodyInline,
      bodyPath,
      createdAt,
    };
  }

  /** 查某 trace 下所有 observation 元信息（不含正文） */
  listByTrace(traceId: string): ObservationRecord[] {
    const rows = this.db
      .prepare<[string], ObservationRow>(
        `SELECT observation_id, trace_id, step_id, status, summary,
                latency_ms, token_cost, body_inline, body_path, created_at
         FROM observations
         WHERE trace_id = ?
         ORDER BY created_at ASC, observation_id ASC`
      )
      .all(traceId);
    return rows.map(rowToRecord);
  }

  /** 元信息查询（单条） */
  get(observationId: string): ObservationRecord | null {
    const row = this.db
      .prepare<[string], ObservationRow>(
        `SELECT observation_id, trace_id, step_id, status, summary,
                latency_ms, token_cost, body_inline, body_path, created_at
         FROM observations WHERE observation_id = ?`
      )
      .get(observationId);
    return row ? rowToRecord(row) : null;
  }
}

function rowToRecord(row: ObservationRow): ObservationRecord {
  return {
    observationId: row.observation_id,
    traceId: row.trace_id,
    stepId: row.step_id,
    status: row.status,
    summary: row.summary,
    latencyMs: row.latency_ms,
    tokenCost: row.token_cost,
    bodyInline: row.body_inline === 1,
    bodyPath: row.body_path,
    createdAt: row.created_at,
  };
}
