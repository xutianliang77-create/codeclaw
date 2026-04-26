/**
 * CodebaseGraph store · 在 rag.db 加 cg_* 表（M4-#76 step c）
 *
 * 复用 RAG 的 workspace hash 隔离 db（~/.codeclaw/projects/<hash>/rag.db）。
 * 不开新 db 避免双连接 / 双 close 复杂度。
 *
 * 三张表：
 *   - cg_imports：文件 → 文件 import 边（外部 module 时 dst_path 为 NULL）
 *   - cg_symbols：顶层声明 (function / class / const / export) 索引
 *   - cg_calls：调用点（caller_path:line → callee_name [callee_path]）
 *
 * 表为 IF NOT EXISTS 创建；与 rag schema 共存且互不影响。
 */

import type Database from "better-sqlite3";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cg_imports (
  src_path  TEXT NOT NULL,
  module    TEXT NOT NULL,
  dst_path  TEXT,
  PRIMARY KEY (src_path, module)
);
CREATE INDEX IF NOT EXISTS idx_cg_imports_src ON cg_imports(src_path);
CREATE INDEX IF NOT EXISTS idx_cg_imports_dst ON cg_imports(dst_path);

CREATE TABLE IF NOT EXISTS cg_symbols (
  symbol_id   TEXT PRIMARY KEY,
  rel_path    TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  exported    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cg_symbols_path ON cg_symbols(rel_path);
CREATE INDEX IF NOT EXISTS idx_cg_symbols_name ON cg_symbols(name);

CREATE TABLE IF NOT EXISTS cg_calls (
  caller_path   TEXT NOT NULL,
  caller_line   INTEGER NOT NULL,
  callee_name   TEXT NOT NULL,
  callee_path   TEXT,
  PRIMARY KEY (caller_path, caller_line, callee_name)
);
CREATE INDEX IF NOT EXISTS idx_cg_calls_callee ON cg_calls(callee_name);
CREATE INDEX IF NOT EXISTS idx_cg_calls_callee_path ON cg_calls(callee_path);
`;

export function ensureGraphSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}

export interface ImportEdge {
  srcPath: string;
  module: string;
  dstPath: string | null;
}

export type SymbolKind = "function" | "class" | "const" | "export" | "interface" | "type";

export interface SymbolRecord {
  symbolId: string; // <relPath>::<name>
  relPath: string;
  name: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
}

export interface CallEdge {
  callerPath: string;
  callerLine: number;
  calleeName: string;
  calleePath: string | null;
}

export function buildSymbolId(relPath: string, name: string): string {
  return `${relPath}::${name}`;
}

/* ---------- 写入 ---------- */

export function clearFileEntries(db: Database.Database, relPath: string): void {
  db.prepare("DELETE FROM cg_imports WHERE src_path = ?").run(relPath);
  db.prepare("DELETE FROM cg_symbols WHERE rel_path = ?").run(relPath);
  db.prepare("DELETE FROM cg_calls WHERE caller_path = ?").run(relPath);
}

export function clearAllGraph(db: Database.Database): void {
  db.exec("DELETE FROM cg_imports; DELETE FROM cg_symbols; DELETE FROM cg_calls;");
}

export function insertImports(db: Database.Database, edges: ReadonlyArray<ImportEdge>): void {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO cg_imports (src_path, module, dst_path) VALUES (?, ?, ?)"
  );
  const tx = db.transaction((rows: ReadonlyArray<ImportEdge>) => {
    for (const r of rows) stmt.run(r.srcPath, r.module, r.dstPath);
  });
  tx(edges);
}

export function insertSymbols(db: Database.Database, syms: ReadonlyArray<SymbolRecord>): void {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO cg_symbols (symbol_id, rel_path, name, kind, line, exported) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const tx = db.transaction((rows: ReadonlyArray<SymbolRecord>) => {
    for (const r of rows) stmt.run(r.symbolId, r.relPath, r.name, r.kind, r.line, r.exported ? 1 : 0);
  });
  tx(syms);
}

export function insertCalls(db: Database.Database, calls: ReadonlyArray<CallEdge>): void {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO cg_calls (caller_path, caller_line, callee_name, callee_path) VALUES (?, ?, ?, ?)"
  );
  const tx = db.transaction((rows: ReadonlyArray<CallEdge>) => {
    for (const r of rows) stmt.run(r.callerPath, r.callerLine, r.calleeName, r.calleePath);
  });
  tx(calls);
}

/* ---------- 计数 / meta ---------- */

export function countSymbols(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM cg_symbols").get() as { n: number }).n;
}

export function countImports(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM cg_imports").get() as { n: number }).n;
}

export function countCalls(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM cg_calls").get() as { n: number }).n;
}
