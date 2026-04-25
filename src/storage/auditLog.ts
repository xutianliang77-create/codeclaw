/**
 * Audit Log · BLAKE3 链式哈希（ADR-001 §5 / 详细技术设计 §7.2 / v4.2 附录 E）
 *
 * 不变式：
 *   - 首条 prev_hash = "genesis"（固定常量）
 *   - event_hash = BLAKE3(prev_hash ⍛ event_id ⍛ actor ⍛ action ⍛ resource ⍛ decision ⍛ timestamp)
 *     其中 ⍛ 是 ASCII Unit Separator (U+001F)，防止字段内容里出现分隔符歧义
 *   - 同一进程内 append 走事务，保证"读最新 prev_hash → 写入"的原子性
 *
 * 不做：
 *   - 跨进程并发锁：SQLite WAL 内建；应用层事务 immediate 足够
 *   - 签名 / 时间戳服务：P2+ 企业版
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type Database from "better-sqlite3";

import { createEventId } from "../lib/traceId";

export const GENESIS_HASH = "genesis";
const FS = "\x1f"; // ASCII Unit Separator
const ENCODER = new TextEncoder();

export type AuditDecision = "allow" | "deny" | "approved" | "rejected" | "pending";

export interface AuditEventInput {
  traceId: string;
  sessionId?: string | null;
  actor: string;                              // user | tool | skill | system | agent:<role>
  action: string;                             // tool.bash | skill.run | llm.call | permission.check
  resource?: string | null;                   // path / command / skill name
  decision: AuditDecision;
  mode?: string | null;                       // PermissionMode
  reason?: string | null;
  details?: Record<string, unknown> | null;
  timestamp?: number;                         // 默认 Date.now()
}

export interface AuditEvent {
  eventId: string;
  traceId: string;
  sessionId: string | null;
  actor: string;
  action: string;
  resource: string | null;
  decision: AuditDecision;
  mode: string | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  prevHash: string;
  eventHash: string;
  timestamp: number;
}

export interface AuditFilter {
  traceId?: string;
  sessionId?: string;
  actor?: string;
  action?: string;
  decision?: AuditDecision;
  from?: number;                              // timestamp lower bound
  to?: number;                                // upper bound
  limit?: number;                             // 默认 1000
  orderBy?: "asc" | "desc";                   // 默认 asc
}

export type VerifyResult =
  | { ok: true; checkedCount: number; durationMs: number }
  | {
      ok: false;
      checkedCount: number;
      brokenAt: string;                       // 断链事件 id
      reason: string;
      durationMs: number;
    };

interface AuditRow {
  event_id: string;
  trace_id: string;
  session_id: string | null;
  actor: string;
  action: string;
  resource: string | null;
  decision: AuditDecision;
  mode: string | null;
  reason: string | null;
  details_json: string | null;
  prev_hash: string;
  event_hash: string;
  timestamp: number;
}

/** 计算 event_hash（纯函数；供 append 与 verify 复用） */
export function computeEventHash(parts: {
  prevHash: string;
  eventId: string;
  actor: string;
  action: string;
  resource: string | null;
  decision: string;
  timestamp: number;
}): string {
  const payload = [
    parts.prevHash,
    parts.eventId,
    parts.actor,
    parts.action,
    parts.resource ?? "",
    parts.decision,
    String(parts.timestamp),
  ].join(FS);
  return bytesToHex(blake3(ENCODER.encode(payload)));
}

function rowToEvent(row: AuditRow): AuditEvent {
  return {
    eventId: row.event_id,
    traceId: row.trace_id,
    sessionId: row.session_id,
    actor: row.actor,
    action: row.action,
    resource: row.resource,
    decision: row.decision,
    mode: row.mode,
    reason: row.reason,
    details: row.details_json ? JSON.parse(row.details_json) : null,
    prevHash: row.prev_hash,
    eventHash: row.event_hash,
    timestamp: row.timestamp,
  };
}

/** 审计链客户端；传入一个 audit.db handle（见 src/storage/audit.ts） */
export class AuditLog {
  constructor(private readonly db: Database.Database) {}

  /**
   * 追加一条审计事件（事务内"读最新 → 算哈希 → 写入"）
   * @param input 必填 traceId / actor / action / decision；其他可选
   */
  append(input: AuditEventInput): AuditEvent {
    const eventId = createEventId();
    const incomingTs = input.timestamp ?? Date.now();

    const selectLast = this.db.prepare(
      `SELECT event_hash, timestamp FROM audit_events
       ORDER BY timestamp DESC, event_id DESC
       LIMIT 1`
    );
    const insert = this.db.prepare(
      `INSERT INTO audit_events(
         event_id, trace_id, session_id, actor, action, resource,
         decision, mode, reason, details_json, prev_hash, event_hash, timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const tx = this.db.transaction(() => {
      const last = selectLast.get() as { event_hash: string; timestamp: number } | undefined;
      const prevHash = last?.event_hash ?? GENESIS_HASH;
      // W3-02：强制 timestamp 单调。incoming 即使比 latest 早（NTP 回拨 / 测试 mock /
      // 跨节点合并），也要至少 latest+1，避免 verify 路径用 timestamp ASC 排序时
      // "最新 prev_hash" 与"排序后的上一条"不一致导致断链。
      const timestamp = last ? Math.max(incomingTs, last.timestamp + 1) : incomingTs;
      const resource = input.resource ?? null;
      const eventHash = computeEventHash({
        prevHash,
        eventId,
        actor: input.actor,
        action: input.action,
        resource,
        decision: input.decision,
        timestamp,
      });
      const detailsJson = input.details ? JSON.stringify(input.details) : null;
      insert.run(
        eventId,
        input.traceId,
        input.sessionId ?? null,
        input.actor,
        input.action,
        resource,
        input.decision,
        input.mode ?? null,
        input.reason ?? null,
        detailsJson,
        prevHash,
        eventHash,
        timestamp
      );
      return { prevHash, eventHash, timestamp };
    });

    const { prevHash, eventHash, timestamp } = tx.immediate();
    return {
      eventId,
      traceId: input.traceId,
      sessionId: input.sessionId ?? null,
      actor: input.actor,
      action: input.action,
      resource: input.resource ?? null,
      decision: input.decision,
      mode: input.mode ?? null,
      reason: input.reason ?? null,
      details: input.details ?? null,
      prevHash,
      eventHash,
      timestamp,
    };
  }

  /**
   * 校验整条链（按 timestamp asc + event_id asc 遍历）
   * 检查两个不变式：
   *   1. 每条的 prev_hash 等于上一条的 event_hash（首条 = "genesis"）
   *   2. 每条的 event_hash = BLAKE3(...字段...)
   * 任何一条断裂即返回 ok=false + brokenAt
   */
  verify(): VerifyResult {
    const start = Date.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_events ORDER BY timestamp ASC, event_id ASC`
      )
      .all() as AuditRow[];

    let lastHash = GENESIS_HASH;
    let checked = 0;

    for (const r of rows) {
      if (r.prev_hash !== lastHash) {
        return {
          ok: false,
          checkedCount: checked,
          brokenAt: r.event_id,
          reason: `prev_hash mismatch at ${r.event_id}: expected ${lastHash}, got ${r.prev_hash}`,
          durationMs: Date.now() - start,
        };
      }
      const expected = computeEventHash({
        prevHash: r.prev_hash,
        eventId: r.event_id,
        actor: r.actor,
        action: r.action,
        resource: r.resource,
        decision: r.decision,
        timestamp: r.timestamp,
      });
      if (expected !== r.event_hash) {
        return {
          ok: false,
          checkedCount: checked,
          brokenAt: r.event_id,
          reason: `event_hash mismatch at ${r.event_id}: expected ${expected}, got ${r.event_hash}`,
          durationMs: Date.now() - start,
        };
      }
      lastHash = r.event_hash;
      checked++;
    }

    return { ok: true, checkedCount: checked, durationMs: Date.now() - start };
  }

  /** 按过滤查询 */
  list(filter: AuditFilter = {}): AuditEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.traceId) {
      clauses.push("trace_id = ?");
      params.push(filter.traceId);
    }
    if (filter.sessionId) {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.actor) {
      clauses.push("actor = ?");
      params.push(filter.actor);
    }
    if (filter.action) {
      clauses.push("action = ?");
      params.push(filter.action);
    }
    if (filter.decision) {
      clauses.push("decision = ?");
      params.push(filter.decision);
    }
    if (filter.from !== undefined) {
      clauses.push("timestamp >= ?");
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      clauses.push("timestamp <= ?");
      params.push(filter.to);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const order = filter.orderBy === "desc" ? "DESC" : "ASC";
    const limit = Math.max(1, Math.min(filter.limit ?? 1000, 100_000));

    const rows = this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY timestamp ${order}, event_id ${order} LIMIT ?`)
      .all(...params, limit) as AuditRow[];

    return rows.map(rowToEvent);
  }

  /** 按过滤导出为 JSONL 或 CSV */
  export(filter: AuditFilter, format: "jsonl" | "csv"): string {
    const events = this.list(filter);
    if (format === "jsonl") {
      return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
    }
    // CSV：固定字段顺序；details_json 转字符串
    const header = [
      "event_id",
      "trace_id",
      "session_id",
      "actor",
      "action",
      "resource",
      "decision",
      "mode",
      "reason",
      "details",
      "prev_hash",
      "event_hash",
      "timestamp",
    ];
    const escapeCsv = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "string" ? v : JSON.stringify(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [header.join(",")];
    for (const e of events) {
      lines.push(
        [
          e.eventId,
          e.traceId,
          e.sessionId ?? "",
          e.actor,
          e.action,
          e.resource ?? "",
          e.decision,
          e.mode ?? "",
          e.reason ?? "",
          e.details ? JSON.stringify(e.details) : "",
          e.prevHash,
          e.eventHash,
          e.timestamp,
        ]
          .map(escapeCsv)
          .join(",")
      );
    }
    return lines.join("\n") + "\n";
  }

  /** 返回当前链上最后一条事件的 event_hash（无数据则返回 GENESIS_HASH） */
  latestHash(): string {
    const row = this.db
      .prepare(
        `SELECT event_hash FROM audit_events
         ORDER BY timestamp DESC, event_id DESC LIMIT 1`
      )
      .get() as { event_hash: string } | undefined;
    return row?.event_hash ?? GENESIS_HASH;
  }

  /** 总数 */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM audit_events").get() as { c: number };
    return row.c;
  }
}
