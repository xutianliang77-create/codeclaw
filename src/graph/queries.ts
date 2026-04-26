/**
 * CodebaseGraph 查询（M4-#76 step d）
 *
 * 4 类查询：
 *   - whoCalls(calleeName, calleePath?)：哪些 caller_path:line 调用了这个 symbol
 *   - whatCalls(callerPath)：这个文件里调了哪些 callee（带去向）
 *   - dependentsOf(path)：哪些文件 import 了这个 path（用 dst_path 倒查）
 *   - dependenciesOf(path)：这个文件 import 了哪些 module / 文件
 *
 * callee_path 可能为 NULL（解析不到），whoCalls 兼容两种：
 *   - 显式给 calleePath：精确匹配
 *   - 仅给 calleeName：name 全匹配（可能含同名误伤；UI 提示）
 */

import type Database from "better-sqlite3";

export interface CallerRow {
  callerPath: string;
  callerLine: number;
  calleeName: string;
  calleePath: string | null;
}

export interface ImportRow {
  srcPath: string;
  dstPath: string | null;
  module: string;
}

export interface SymbolRow {
  symbolId: string;
  relPath: string;
  name: string;
  kind: string;
  line: number;
  exported: boolean;
}

export function whoCalls(
  db: Database.Database,
  calleeName: string,
  calleePath?: string
): CallerRow[] {
  const sql = calleePath
    ? "SELECT caller_path, caller_line, callee_name, callee_path FROM cg_calls WHERE callee_name = ? AND callee_path = ? ORDER BY caller_path, caller_line"
    : "SELECT caller_path, caller_line, callee_name, callee_path FROM cg_calls WHERE callee_name = ? ORDER BY caller_path, caller_line";
  const rows = (calleePath ? db.prepare(sql).all(calleeName, calleePath) : db.prepare(sql).all(calleeName)) as Array<{
    caller_path: string;
    caller_line: number;
    callee_name: string;
    callee_path: string | null;
  }>;
  return rows.map((r) => ({
    callerPath: r.caller_path,
    callerLine: r.caller_line,
    calleeName: r.callee_name,
    calleePath: r.callee_path,
  }));
}

export function whatCalls(db: Database.Database, callerPath: string): CallerRow[] {
  const rows = db
    .prepare(
      "SELECT caller_path, caller_line, callee_name, callee_path FROM cg_calls WHERE caller_path = ? ORDER BY caller_line"
    )
    .all(callerPath) as Array<{
    caller_path: string;
    caller_line: number;
    callee_name: string;
    callee_path: string | null;
  }>;
  return rows.map((r) => ({
    callerPath: r.caller_path,
    callerLine: r.caller_line,
    calleeName: r.callee_name,
    calleePath: r.callee_path,
  }));
}

export function dependentsOf(db: Database.Database, dstPath: string): ImportRow[] {
  const rows = db
    .prepare(
      "SELECT src_path, dst_path, module FROM cg_imports WHERE dst_path = ? ORDER BY src_path"
    )
    .all(dstPath) as Array<{ src_path: string; dst_path: string | null; module: string }>;
  return rows.map((r) => ({ srcPath: r.src_path, dstPath: r.dst_path, module: r.module }));
}

export function dependenciesOf(db: Database.Database, srcPath: string): ImportRow[] {
  const rows = db
    .prepare("SELECT src_path, dst_path, module FROM cg_imports WHERE src_path = ? ORDER BY module")
    .all(srcPath) as Array<{ src_path: string; dst_path: string | null; module: string }>;
  return rows.map((r) => ({ srcPath: r.src_path, dstPath: r.dst_path, module: r.module }));
}

export function findSymbolsByName(db: Database.Database, name: string): SymbolRow[] {
  const rows = db
    .prepare(
      "SELECT symbol_id, rel_path, name, kind, line, exported FROM cg_symbols WHERE name = ? ORDER BY rel_path, line"
    )
    .all(name) as Array<{
    symbol_id: string;
    rel_path: string;
    name: string;
    kind: string;
    line: number;
    exported: number;
  }>;
  return rows.map((r) => ({
    symbolId: r.symbol_id,
    relPath: r.rel_path,
    name: r.name,
    kind: r.kind,
    line: r.line,
    exported: r.exported === 1,
  }));
}

export function listSymbolsInFile(db: Database.Database, relPath: string): SymbolRow[] {
  const rows = db
    .prepare(
      "SELECT symbol_id, rel_path, name, kind, line, exported FROM cg_symbols WHERE rel_path = ? ORDER BY line"
    )
    .all(relPath) as Array<{
    symbol_id: string;
    rel_path: string;
    name: string;
    kind: string;
    line: number;
    exported: number;
  }>;
  return rows.map((r) => ({
    symbolId: r.symbol_id,
    relPath: r.rel_path,
    name: r.name,
    kind: r.kind,
    line: r.line,
    exported: r.exported === 1,
  }));
}
