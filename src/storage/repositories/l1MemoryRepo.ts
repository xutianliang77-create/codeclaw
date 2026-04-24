/**
 * L1MemoryRepo · P0-W1-11
 *
 * 职责：当前会话消息双写
 *   - 元信息入 `l1_memory` 表（便于 /stats / /memory 跨 session 索引）
 *   - 正文 append 到 `sessions/{sid}/transcript.jsonl`（唯一事实源）
 *
 * 不变式：
 *   - 同一 `message_id` 只 insert 一次（PRIMARY KEY 约束）
 *   - `body_missing = 1` 表示 db 元信息存在但 jsonl 行不可读（P1+ 恢复模式用）
 *
 * 依赖：sessions(session_id) 外键。调用前确保 session 已建。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

export type MessageRole = "user" | "assistant" | "system" | "tool";
export type MessageSource = "user" | "command" | "model" | "local" | "summary";

export interface L1MessageInsert {
  messageId: string;
  sessionId: string;
  seq: number;
  role: MessageRole;
  source?: MessageSource;
  body: string;
  importance?: number;
  tokenCost?: number;
  createdAt?: number;
}

export interface L1MessageMeta {
  messageId: string;
  sessionId: string;
  seq: number;
  role: MessageRole;
  source: MessageSource | null;
  importance: number;
  tokenCost: number;
  createdAt: number;
  bodyMissing: boolean;
}

interface L1Row {
  message_id: string;
  session_id: string;
  seq: number;
  role: MessageRole;
  source: MessageSource | null;
  importance: number | null;
  token_cost: number | null;
  created_at: number;
  body_missing: number;
}

export class L1MemoryRepo {
  constructor(
    private readonly db: Database.Database,
    /** `~/.codeclaw/sessions` 根 */
    private readonly sessionsDir: string
  ) {}

  record(input: L1MessageInsert): L1MessageMeta {
    const createdAt = input.createdAt ?? Date.now();

    const sessionDir = path.join(this.sessionsDir, input.sessionId);
    mkdirSync(sessionDir, { recursive: true });

    const line =
      JSON.stringify({
        messageId: input.messageId,
        role: input.role,
        source: input.source ?? null,
        body: input.body,
        createdAt,
      }) + "\n";

    appendFileSync(path.join(sessionDir, "transcript.jsonl"), line);

    this.db
      .prepare(
        `INSERT INTO l1_memory(
           message_id, session_id, seq, role, source,
           importance, token_cost, created_at, body_missing
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        input.messageId,
        input.sessionId,
        input.seq,
        input.role,
        input.source ?? null,
        input.importance ?? 0,
        input.tokenCost ?? 0,
        createdAt
      );

    return {
      messageId: input.messageId,
      sessionId: input.sessionId,
      seq: input.seq,
      role: input.role,
      source: input.source ?? null,
      importance: input.importance ?? 0,
      tokenCost: input.tokenCost ?? 0,
      createdAt,
      bodyMissing: false,
    };
  }

  listBySession(sessionId: string, opts: { limit?: number; sinceSeq?: number } = {}): L1MessageMeta[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10_000, 100_000));
    const rows = opts.sinceSeq !== undefined
      ? this.db
          .prepare<[string, number, number], L1Row>(
            `SELECT message_id, session_id, seq, role, source, importance,
                    token_cost, created_at, body_missing
             FROM l1_memory WHERE session_id = ? AND seq > ?
             ORDER BY seq ASC LIMIT ?`
          )
          .all(sessionId, opts.sinceSeq, limit)
      : this.db
          .prepare<[string, number], L1Row>(
            `SELECT message_id, session_id, seq, role, source, importance,
                    token_cost, created_at, body_missing
             FROM l1_memory WHERE session_id = ?
             ORDER BY seq ASC LIMIT ?`
          )
          .all(sessionId, limit);
    return rows.map(rowToMeta);
  }

  countBySession(sessionId: string): number {
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM l1_memory WHERE session_id = ?`
      )
      .get(sessionId);
    return row?.c ?? 0;
  }

  /** 标 body_missing=1（P1 恢复模式；当前 placeholder） */
  markBodyMissing(messageId: string): void {
    this.db
      .prepare(`UPDATE l1_memory SET body_missing = 1 WHERE message_id = ?`)
      .run(messageId);
  }
}

function rowToMeta(row: L1Row): L1MessageMeta {
  return {
    messageId: row.message_id,
    sessionId: row.session_id,
    seq: row.seq,
    role: row.role,
    source: row.source,
    importance: row.importance ?? 0,
    tokenCost: row.token_cost ?? 0,
    createdAt: row.created_at,
    bodyMissing: row.body_missing === 1,
  };
}
