/**
 * 审批存储（P0-W1-07：从 JSON 文件迁到 SQLite `approvals` 表）
 *
 * 兼容策略：
 *   - 公开 API（loadPendingApprovals / savePendingApprovals / clearPendingApprovals）签名不变
 *   - `approvalsDir` 语义保留：
 *       · 指向 `~/.codeclaw/approvals` 这类目录
 *       · 从它推断 data.db 路径：`<approvalsDir>/../data.db`
 *   - 首次 load 触发"旧 JSON → SQLite 一次性迁移"：
 *       · 读 `<approvalsDir>/pending-approval.json`
 *       · upsert 到 approvals 表
 *       · 删掉旧 JSON 文件
 *       · 同一 `approvalsDir` 只迁一次（per process）
 *
 * 非目标：
 *   - 并发锁（SQLite WAL + 应用层事务已足够单进程；多进程场景 P2 处理）
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { openDataDb } from "../storage/db";
import type { LocalToolName } from "../tools/local";

export interface StoredPendingApproval {
  id: string;
  prompt: string;
  toolName: LocalToolName;
  detail: string;
  reason: string;
  createdAt: string;          // ISO 8601
  sessionId?: string;
}

// —— module 级缓存 ————————————————————————————————————————————————————————

/** approvalsDir → data.db Database 实例；测试用不同 tmp 时各自独立 */
const dbByPath = new Map<string, Database.Database>();

/** 同一 approvalsDir 只迁一次旧 JSON */
const migratedDirs = new Set<string>();

/** 测试钩子：直接注入 db（优先于路径查找） */
let injectedDb: Database.Database | null = null;

/**
 * 仅供测试使用：重置内部状态；在 afterEach 里调，避免跨用例串数据
 */
export function __resetApprovalStoreForTests(): void {
  injectedDb = null;
  dbByPath.clear();
  migratedDirs.clear();
}

/**
 * 仅供测试使用：直接注入一个 Database 实例
 */
export function __setApprovalDbForTests(db: Database.Database | null): void {
  injectedDb = db;
}

// —— 内部实现 ————————————————————————————————————————————————————————————

function inferDataDbPath(approvalsDir: string): string {
  // approvalsDir 通常是 ~/.codeclaw/approvals；data.db 在同级父目录
  return path.join(path.dirname(approvalsDir), "data.db");
}

function getDb(approvalsDir: string): Database.Database {
  if (injectedDb) return injectedDb;
  const dbPath = inferDataDbPath(approvalsDir);
  let db = dbByPath.get(dbPath);
  if (!db) {
    // 不走 singleton，避免与其他模块（后续 Session/L1 双写）产生"同路径多 open"冲突
    const h = openDataDb({ path: dbPath, singleton: false });
    db = h.db;
    dbByPath.set(dbPath, db);
  }
  return db;
}

function createApprovalId(): string {
  return `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeApproval(
  input: Partial<StoredPendingApproval> & Pick<StoredPendingApproval, "prompt" | "toolName" | "detail" | "reason">
): StoredPendingApproval {
  return {
    id: input.id ?? createApprovalId(),
    prompt: input.prompt,
    toolName: input.toolName,
    detail: input.detail,
    reason: input.reason,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sessionId: input.sessionId,
  };
}

function upsertPending(db: Database.Database, a: StoredPendingApproval): void {
  // 同一 approval_id 覆盖；非 pending 状态不会被这里改（DELETE + INSERT 的 save 路径负责 pending 的全量替换）
  const createdMs = Date.parse(a.createdAt);
  db.prepare(
    `INSERT OR REPLACE INTO approvals(
       approval_id, session_id, trace_id, prompt, tool_name, detail, reason,
       status, created_at, decided_at, decision_meta
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`
  ).run(
    a.id,
    a.sessionId ?? null,
    a.prompt,
    a.toolName,
    a.detail,
    a.reason,
    Number.isFinite(createdMs) ? createdMs : Date.now()
  );
}

interface ApprovalRow {
  approval_id: string;
  session_id: string | null;
  prompt: string;
  tool_name: string;
  detail: string | null;
  reason: string | null;
  status: string;
  created_at: number;
}

function rowToApproval(row: ApprovalRow): StoredPendingApproval {
  return {
    id: row.approval_id,
    prompt: row.prompt,
    toolName: row.tool_name as LocalToolName,
    detail: row.detail ?? "",
    reason: row.reason ?? "",
    createdAt: new Date(row.created_at).toISOString(),
    sessionId: row.session_id ?? undefined,
  };
}

function legacyJsonFile(approvalsDir: string): string {
  return path.join(approvalsDir, "pending-approval.json");
}

/**
 * 首次遇到某 approvalsDir 时，把旧 JSON 迁移进 db，并删除文件。
 * 非首次（已迁过）直接 no-op。
 */
function migrateLegacyIfNeeded(db: Database.Database, approvalsDir: string): void {
  if (migratedDirs.has(approvalsDir)) return;
  migratedDirs.add(approvalsDir);

  const file = legacyJsonFile(approvalsDir);
  if (!existsSync(file)) return;

  let items: StoredPendingApproval[] = [];
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    items = (list as Array<Partial<StoredPendingApproval>>).map((it) => normalizeApproval(it as never));
  } catch {
    // JSON 损坏：静默丢弃；迁移标记已置，后续不再尝试
    rmSync(file, { force: true });
    return;
  }

  const tx = db.transaction((list: StoredPendingApproval[]) => {
    for (const a of list) upsertPending(db, a);
  });
  tx(items);
  rmSync(file, { force: true });
}

// —— 公开 API（签名兼容） ————————————————————————————————————————————————

/**
 * W3-03（deep-review M2）：sessionId 可选过滤
 *   - 传了 sessionId → DELETE/SELECT 按 session_id 过滤，避免不同 session 共享同 db 时
 *     互相覆盖 pending
 *   - 不传 → 老行为（全删 / 全 load），保持向后兼容
 *
 * sessionId === null 表示"仅 session_id IS NULL 的行"，与 undefined 区分开。
 */
export interface ApprovalsScopeOptions {
  sessionId?: string | null;
}

function whereSessionScope(sessionId: string | null | undefined): {
  clause: string;
  params: unknown[];
} {
  if (sessionId === undefined) return { clause: "", params: [] };
  if (sessionId === null) return { clause: "AND session_id IS NULL", params: [] };
  return { clause: "AND session_id = ?", params: [sessionId] };
}

export function loadPendingApprovals(
  approvalsDir?: string,
  options: ApprovalsScopeOptions = {}
): StoredPendingApproval[] {
  if (!approvalsDir) return [];
  const db = getDb(approvalsDir);
  migrateLegacyIfNeeded(db, approvalsDir);

  // 严格按插入顺序返回（ROWID 在 INSERT OR REPLACE 下单调递增）
  // 保留原 JSON 文件实现的"数组顺序 = 入队顺序"语义
  const scope = whereSessionScope(options.sessionId);
  const rows = db
    .prepare<unknown[], ApprovalRow>(
      `SELECT approval_id, session_id, prompt, tool_name, detail, reason, status, created_at
       FROM approvals
       WHERE status = 'pending' ${scope.clause}
       ORDER BY ROWID ASC`
    )
    .all(...scope.params);
  return rows.map(rowToApproval);
}

export function savePendingApprovals(
  approvalsDir: string | undefined,
  approvals: StoredPendingApproval[],
  options: ApprovalsScopeOptions = {}
): void {
  if (!approvalsDir) return;
  const db = getDb(approvalsDir);
  migrateLegacyIfNeeded(db, approvalsDir);

  // 推断 scope：
  //   1. options.sessionId 显式传入 → 用它
  //   2. 否则看 list 里所有 sessionId 是否都同一个 → 用它（自动隔离）
  //   3. 否则 → undefined（全删，老行为）
  let scopeId: string | null | undefined = options.sessionId;
  if (scopeId === undefined && approvals.length > 0) {
    const unique = new Set(approvals.map((a) => a.sessionId ?? null));
    if (unique.size === 1) {
      scopeId = approvals[0]!.sessionId ?? null;
    }
  }
  const scope = whereSessionScope(scopeId);

  const tx = db.transaction((list: StoredPendingApproval[]) => {
    db.prepare(`DELETE FROM approvals WHERE status = 'pending' ${scope.clause}`).run(...scope.params);
    for (const a of list) upsertPending(db, a);
  });
  tx(approvals);
}

export function clearPendingApprovals(
  approvalsDir?: string,
  options: ApprovalsScopeOptions = {}
): void {
  if (!approvalsDir) return;
  const db = getDb(approvalsDir);
  migrateLegacyIfNeeded(db, approvalsDir);
  const scope = whereSessionScope(options.sessionId);
  db.prepare(`DELETE FROM approvals WHERE status = 'pending' ${scope.clause}`).run(...scope.params);
}
