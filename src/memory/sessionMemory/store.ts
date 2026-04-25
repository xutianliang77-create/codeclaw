/**
 * L2 Session Memory · 摘要持久化层
 *
 * 接 002_session_memory.sql 的 memory_digest 表。纯 SQL CRUD，不接 LLM。
 * summarizer / recaller 在此之上构建。
 *
 * 设计：
 *   - saveMemoryDigest：UPSERT-by-id（同 digestId 重新写入会覆盖；通常调用方传新 ULID）
 *   - loadRecentDigests：按 channel+user_id 拉最近 N 条；recall 路径主入口
 *   - loadDigestsBySession：按 sessionId 拉，用于审计/调试
 *   - forgetMemoryDigests：/forget 命令主入口；按 sessionId / since / all 删；返回删除数
 */

import type Database from "better-sqlite3";
import type { ChannelType } from "../../channels/channelAdapter";

export interface MemoryDigest {
  digestId: string;
  sessionId: string;
  channel: ChannelType;
  userId: string;
  summary: string;
  messageCount: number;
  tokenEstimate: number;
  createdAt: number;
}

interface MemoryDigestRow {
  digest_id: string;
  session_id: string;
  channel: string;
  user_id: string;
  summary_text: string;       // 001 schema 用 summary_text；外部 API 映射成 summary
  message_count: number;
  token_estimate: number;
  created_at: number;
}

function rowToDigest(row: MemoryDigestRow): MemoryDigest {
  return {
    digestId: row.digest_id,
    sessionId: row.session_id,
    channel: row.channel as ChannelType,
    userId: row.user_id,
    summary: row.summary_text,
    messageCount: row.message_count,
    tokenEstimate: row.token_estimate,
    createdAt: row.created_at,
  };
}

export function saveMemoryDigest(db: Database.Database, digest: MemoryDigest): void {
  // INSERT OR REPLACE 在表有 FOREIGN KEY 约束时（001 的 session_id → sessions(session_id)）
  // 要求 session 已存在；测试场景需放宽 fk_check（PRAGMA foreign_keys=ON 是 db.ts 默认）
  db.prepare(
    `INSERT OR REPLACE INTO memory_digest(
       digest_id, session_id, channel, user_id, summary_text,
       message_count, token_estimate, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    digest.digestId,
    digest.sessionId,
    digest.channel,
    digest.userId,
    digest.summary,
    digest.messageCount,
    digest.tokenEstimate,
    digest.createdAt
  );
}

/**
 * 按 (channel, user_id) 拉最近 N 条摘要，按 created_at 倒序。
 * recall 主入口：让新会话能"想起"该用户最近的对话。
 */
export function loadRecentDigests(
  db: Database.Database,
  channel: ChannelType,
  userId: string,
  limit = 5
): MemoryDigest[] {
  const rows = db
    .prepare<unknown[], MemoryDigestRow>(
      `SELECT digest_id, session_id, channel, user_id, summary_text,
              message_count, token_estimate, created_at
       FROM memory_digest
       WHERE channel = ? AND user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(channel, userId, limit);
  return rows.map(rowToDigest);
}

export function loadDigestsBySession(
  db: Database.Database,
  sessionId: string
): MemoryDigest[] {
  const rows = db
    .prepare<unknown[], MemoryDigestRow>(
      `SELECT digest_id, session_id, channel, user_id, summary_text,
              message_count, token_estimate, created_at
       FROM memory_digest
       WHERE session_id = ?
       ORDER BY created_at DESC`
    )
    .all(sessionId);
  return rows.map(rowToDigest);
}

export interface ForgetOptions {
  sessionId?: string;
  /** 删除 created_at < since 的（毫秒时间戳）；与 sessionId 互斥 */
  since?: number;
  /** 全清；优先级最高 */
  all?: boolean;
}

/**
 * /forget 主入口。返回实际删除条数。
 * 优先级：all > sessionId > since（互斥时上层先选）。
 */
export function forgetMemoryDigests(
  db: Database.Database,
  opts: ForgetOptions
): number {
  if (opts.all) {
    const r = db.prepare("DELETE FROM memory_digest").run();
    return r.changes;
  }
  if (opts.sessionId) {
    const r = db.prepare("DELETE FROM memory_digest WHERE session_id = ?").run(opts.sessionId);
    return r.changes;
  }
  if (opts.since !== undefined) {
    const r = db.prepare("DELETE FROM memory_digest WHERE created_at < ?").run(opts.since);
    return r.changes;
  }
  return 0;
}
