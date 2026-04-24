/**
 * sessions 表基础 CRUD（供 L1 / Task 等表外键引用）
 *
 * SessionManager（src/ingress/sessionManager.ts）里已对 sessions 表做双写；
 * 本 repo 是更底层的"单表工具"，专用于 repositories 层测试与内部模块互引。
 */

import type Database from "better-sqlite3";
import type { ChannelType } from "../../channels/channelAdapter";

export interface SessionInsert {
  sessionId: string;
  channel: ChannelType;
  userId: string;
  createdAt?: number;
  lastSeenAt?: number;
  workspace?: string;
  meta?: Record<string, unknown>;
}

export interface SessionRow {
  session_id: string;
  channel: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  state: string;
  workspace: string | null;
  meta_json: string | null;
}

/** 简单 upsert；若 (channel,user_id,'active') 已占用，UPDATE 现有行 */
export function upsertActiveSession(db: Database.Database, s: SessionInsert): void {
  const now = Date.now();
  const metaJson = s.meta ? JSON.stringify(s.meta) : null;
  const existing = db
    .prepare(
      `SELECT session_id FROM sessions WHERE channel = ? AND user_id = ? AND state = 'active'`
    )
    .get(s.channel, s.userId) as { session_id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE sessions
         SET session_id = ?, last_seen_at = ?, workspace = ?, meta_json = ?
       WHERE channel = ? AND user_id = ? AND state = 'active'`
    ).run(s.sessionId, s.lastSeenAt ?? now, s.workspace ?? null, metaJson, s.channel, s.userId);
  } else {
    db.prepare(
      `INSERT INTO sessions(
         session_id, channel, user_id, created_at, last_seen_at,
         state, workspace, meta_json
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run(
      s.sessionId,
      s.channel,
      s.userId,
      s.createdAt ?? now,
      s.lastSeenAt ?? now,
      s.workspace ?? null,
      metaJson
    );
  }
}

export function getSession(db: Database.Database, sessionId: string): SessionRow | null {
  const row = db
    .prepare<[string], SessionRow>(
      `SELECT session_id, channel, user_id, created_at, last_seen_at,
              state, workspace, meta_json
       FROM sessions WHERE session_id = ?`
    )
    .get(sessionId);
  return row ?? null;
}
