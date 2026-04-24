/**
 * SessionManager · 会话映射
 *
 * 双模式：
 *   - 纯内存（`new SessionManager()`）：保留现有语义，测试与未启用 SQLite 的调用方零影响
 *   - 内存 + SQLite 双写（`new SessionManager({ db })`）：按 ADR-001 §5.3.1 持久化
 *
 * 持久化模式的不变式：
 *   - 同 (channel, user_id) 同一时间只允许一个 state='active' 行（db UNIQUE 约束保证）
 *   - bind 时对老 active 行用 UPDATE 调整 session_id（避免 archived 行堆积）
 *   - touch 仅更新 last_seen_at
 *   - destroy 把 state 改为 'archived'（保留审计 trail；不物理删）
 *   - boot() 启动时从 db load state='active' 填内存 Map
 */

import type Database from "better-sqlite3";
import type { ChannelType } from "../channels/channelAdapter";

export type SessionState = "active" | "idle" | "archived";

export interface SessionInfo {
  sessionId: string;
  channel: ChannelType;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  state?: SessionState;
  workspace?: string;
  meta?: Record<string, unknown>;
}

export interface SessionManagerOptions {
  /** 传入则启用 SQLite 双写；不传 = 纯内存（向后兼容） */
  db?: Database.Database;
  /** 构造时自动 boot（默认 true when db provided） */
  autoBoot?: boolean;
}

interface SessionRow {
  session_id: string;
  channel: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  state: SessionState;
  meta_json: string | null;
  workspace: string | null;
}

function buildSessionKey(channel: ChannelType, userId: string): string {
  return `${channel}:${userId}`;
}

export class SessionManager {
  private readonly sessionsByKey = new Map<string, SessionInfo>();
  private readonly db: Database.Database | null;

  constructor(options: SessionManagerOptions = {}) {
    this.db = options.db ?? null;
    if (this.db && options.autoBoot !== false) {
      this.boot();
    }
  }

  /** 从 sessions 表 load state='active' 填内存（幂等，可重入） */
  boot(): void {
    if (!this.db) return;
    const rows = this.db
      .prepare<[], SessionRow>(
        `SELECT session_id, channel, user_id, created_at, last_seen_at,
                state, meta_json, workspace
         FROM sessions
         WHERE state = 'active'`
      )
      .all();
    for (const row of rows) {
      const info = rowToInfo(row);
      this.sessionsByKey.set(buildSessionKey(info.channel, info.userId), info);
    }
  }

  /**
   * 绑定 (channel, userId) → sessionId。
   * 若已有同 (channel, userId) 的 active session：
   *   - 更新 session_id + last_seen_at + workspace + meta（内存与 db 同步）
   * 否则新建一条 active row。
   */
  bind(
    channel: ChannelType,
    userId: string,
    sessionId: string,
    opts: { workspace?: string; meta?: Record<string, unknown> } = {}
  ): SessionInfo {
    const key = buildSessionKey(channel, userId);
    const current = this.sessionsByKey.get(key);
    const now = Date.now();

    const next: SessionInfo = current
      ? {
          ...current,
          sessionId,
          lastSeenAt: now,
          workspace: opts.workspace ?? current.workspace,
          meta: opts.meta ?? current.meta,
        }
      : {
          sessionId,
          channel,
          userId,
          createdAt: now,
          lastSeenAt: now,
          state: "active",
          workspace: opts.workspace,
          meta: opts.meta,
        };

    this.sessionsByKey.set(key, next);
    this.persistBind(channel, userId, next, !!current);
    return next;
  }

  /** 等价于 bind（保留旧 API） */
  resolve(channel: ChannelType, userId: string, fallbackSessionId: string): SessionInfo {
    return this.bind(channel, userId, fallbackSessionId);
  }

  touch(sessionId: string): void {
    const now = Date.now();
    for (const [key, value] of this.sessionsByKey.entries()) {
      if (value.sessionId === sessionId) {
        this.sessionsByKey.set(key, { ...value, lastSeenAt: now });
        this.persistTouch(sessionId, now);
        return;
      }
    }
  }

  list(): SessionInfo[] {
    return [...this.sessionsByKey.values()];
  }

  destroy(sessionId: string): void {
    for (const [key, value] of this.sessionsByKey.entries()) {
      if (value.sessionId === sessionId) {
        this.sessionsByKey.delete(key);
      }
    }
    this.persistDestroy(sessionId);
  }

  // —— 内部：持久化路径（db 为空时 no-op） ————————————————————————————————

  private persistBind(
    channel: ChannelType,
    userId: string,
    info: SessionInfo,
    existed: boolean
  ): void {
    if (!this.db) return;
    const metaJson = info.meta ? JSON.stringify(info.meta) : null;
    if (existed) {
      // 同 (channel, user_id) 已有 active row：UPDATE 保持 UNIQUE 约束不冲突
      this.db
        .prepare(
          `UPDATE sessions
             SET session_id = ?, last_seen_at = ?, workspace = ?, meta_json = ?
           WHERE channel = ? AND user_id = ? AND state = 'active'`
        )
        .run(
          info.sessionId,
          info.lastSeenAt,
          info.workspace ?? null,
          metaJson,
          channel,
          userId
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO sessions(
             session_id, channel, user_id, created_at, last_seen_at,
             state, meta_json, workspace
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
        )
        .run(
          info.sessionId,
          channel,
          userId,
          info.createdAt,
          info.lastSeenAt,
          metaJson,
          info.workspace ?? null
        );
    }
  }

  private persistTouch(sessionId: string, now: number): void {
    if (!this.db) return;
    this.db
      .prepare(`UPDATE sessions SET last_seen_at = ? WHERE session_id = ?`)
      .run(now, sessionId);
  }

  private persistDestroy(sessionId: string): void {
    if (!this.db) return;
    this.db
      .prepare(`UPDATE sessions SET state = 'archived' WHERE session_id = ?`)
      .run(sessionId);
  }
}

function rowToInfo(row: SessionRow): SessionInfo {
  return {
    sessionId: row.session_id,
    channel: row.channel as ChannelType,
    userId: row.user_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    state: row.state,
    workspace: row.workspace ?? undefined,
    meta: row.meta_json ? (JSON.parse(row.meta_json) as Record<string, unknown>) : undefined,
  };
}
