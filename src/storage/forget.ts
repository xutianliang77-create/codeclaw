/**
 * /forget 跨表 + 跨文件物理清理 · W3-16 残余补完
 *
 * plan §4 W3-16 出口标准：/forget 真删除，grep 文件系统无残留（T14 用例通过）。
 * commit ded5991 只清了 memory_digest。本模块补完所有 user-facing 数据：
 *
 *   db 表（按 session_id 删行）：
 *     - sessions / tasks / l1_memory / observations / llm_calls_raw / approvals
 *   文件（rm -rf）：
 *     - <sessionsDir>/<sessionId>/   含 transcript.jsonl + observations.jsonl + 子目录
 *
 * **audit_events 故意不动**：
 *   - hash 链不可破坏（破坏即失审计 trail）
 *   - 合规要求保留（即便用户 forget，操作记录本身留作 SOC/GDPR 取证）
 *   - 文档化：audit 中含 session_id 字符串可能被 grep 扫到——这是设计妥协
 *     P0 评审材料中明确标注，T14 验证只覆盖 user-facing 数据范围
 *
 * 整体走单 transaction（DB 部分）；文件 IO 失败不回滚 db（已删的就让它删）。
 */

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

import { forgetMemoryDigests } from "../memory/sessionMemory/store";

export interface ForgetSessionResult {
  sessionId: string;
  tableRowsDeleted: Record<string, number>;
  fileRemoved: boolean;
  /** 透明告知：audit_events 中关联此 sessionId 的行数（不会被删，仅展示）*/
  auditEventsPreserved: number;
}

// 直接含 session_id 列的表（DELETE WHERE session_id = ?）
const TABLES_BY_SESSION_ID = [
  "approvals",
  "llm_calls_raw",
  "l1_memory",
  "memory_digest",
  "tasks",      // 必须在 sessions 之前删（即便无 FK 约束，排序更直观）
  "sessions",   // 最后删，因为 observations / steps 通过 trace_id JOIN tasks
] as const;

// 通过 trace_id 间接关联到 session_id 的表（observations / steps）
// 删除顺序：在 tasks 删之前先查出 trace_ids，然后这些表用 trace_id IN (...) 删
const TABLES_BY_TRACE_ID = ["observations", "steps"] as const;

/**
 * 物理清除一个 sessionId 的全部 user-facing 数据。
 * @param dataDb data.db 实例（含 sessions/approvals/observations/... 等表）
 * @param auditDb audit.db 只读实例（仅用于统计透明告知；可传 null 跳过）
 * @param sessionsDir 会话文件根（通常 ~/.codeclaw/sessions）
 * @param sessionId 要清除的 session
 */
export function forgetSession(
  dataDb: Database.Database,
  auditDb: Database.Database | null,
  sessionsDir: string,
  sessionId: string
): ForgetSessionResult {
  const tableRowsDeleted: Record<string, number> = {};

  // 1) 跨表 DELETE（事务内，保证一致性）
  const tx = dataDb.transaction(() => {
    // 1a) 先按 trace_id 删 observations / steps（在 tasks 行还在时拿子查询）
    for (const table of TABLES_BY_TRACE_ID) {
      try {
        const r = dataDb
          .prepare(
            `DELETE FROM ${table}
             WHERE trace_id IN (SELECT trace_id FROM tasks WHERE session_id = ?)`
          )
          .run(sessionId);
        tableRowsDeleted[table] = r.changes;
      } catch {
        tableRowsDeleted[table] = 0;
      }
    }

    // 1b) 再按 session_id 直接删
    for (const table of TABLES_BY_SESSION_ID) {
      try {
        const r = dataDb.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
        tableRowsDeleted[table] = r.changes;
      } catch {
        // 表不存在（旧 schema）→ 标 0
        tableRowsDeleted[table] = 0;
      }
    }
  });
  tx();

  // 2) memory_digest 也走 store API 一遍（双保险，且与 /forget --session 行为一致）
  forgetMemoryDigests(dataDb, { sessionId });

  // 3) 物理删 session 目录（含 transcript.jsonl / observations.jsonl / overflow）
  const sessionDir = path.join(sessionsDir, sessionId);
  let fileRemoved = false;
  if (existsSync(sessionDir)) {
    try {
      rmSync(sessionDir, { recursive: true, force: true });
      fileRemoved = true;
    } catch {
      // 文件锁 / 权限失败 → 不回滚 DB；用户可手动 rm
      fileRemoved = false;
    }
  }

  // 4) audit 透明告知（不删）
  let auditEventsPreserved = 0;
  if (auditDb) {
    try {
      const row = auditDb
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE session_id = ?")
        .get(sessionId) as { n: number } | undefined;
      auditEventsPreserved = row?.n ?? 0;
    } catch {
      auditEventsPreserved = 0;
    }
  }

  return {
    sessionId,
    tableRowsDeleted,
    fileRemoved,
    auditEventsPreserved,
  };
}

/**
 * 全清模式：清所有 session 的 user-facing 数据 + 文件目录（**保留 audit**）。
 * 实现：先列 sessions 表所有 sessionId，再对每个跑 forgetSession。
 */
export function forgetAllSessions(
  dataDb: Database.Database,
  auditDb: Database.Database | null,
  sessionsDir: string
): { results: ForgetSessionResult[]; totalSessions: number } {
  let sessionIds: string[] = [];
  try {
    sessionIds = dataDb
      .prepare("SELECT session_id FROM sessions")
      .all()
      .map((r) => (r as { session_id: string }).session_id);
  } catch {
    sessionIds = [];
  }
  // 也清 memory_digest 中那些 sessions 表里没有的 sessionId（孤儿摘要）
  try {
    const orphans = dataDb
      .prepare("SELECT DISTINCT session_id FROM memory_digest WHERE session_id NOT IN (SELECT session_id FROM sessions)")
      .all()
      .map((r) => (r as { session_id: string }).session_id);
    sessionIds = [...new Set([...sessionIds, ...orphans])];
  } catch {
    // memory_digest 不存在或孤儿查询失败，跳过
  }

  const results = sessionIds.map((sid) => forgetSession(dataDb, auditDb, sessionsDir, sid));
  return { results, totalSessions: sessionIds.length };
}
