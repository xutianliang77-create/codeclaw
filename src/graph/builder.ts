/**
 * CodebaseGraph builder · workspace 全量构建（M4-#76 step b）
 *
 * 入口：buildGraph(db, workspace)
 *   - 复用 RAG 的 SKIPPED_DIRECTORIES（同样跳 node_modules / .git / dist 等）
 *   - 仅处理 TS/JS 文件（chunker.isParseTarget）
 *   - 每文件清旧 cg_* 行 → parse → 解析 import 路径 → 写入
 *
 * import 路径解析（轻量版）：
 *   - 相对路径 './foo' / '../bar/baz'：相对当前文件目录 resolve，候选扩展名
 *     [.ts, .tsx, .js, .jsx, .mts, .cts] + 索引文件 'index.ts' 等
 *   - 绝对包名 'react' / '@scope/pkg'：dst_path 留 NULL（外部 module）
 *   - 路径解析失败：dst_path 留 NULL
 *
 * call 解析：
 *   - 在 parse 阶段已收集 calleeName + receiver
 *   - 在 builder 阶段做名字 → 路径解析：
 *     1. 命中 importBindings[name]：用 import 来源（依赖 import 解析的 dst_path）
 *     2. 命中本文件 declaration：callee_path = 当前 relPath
 *     3. 都不中：留 NULL（让查询时 fallback by-name）
 *
 * 不在本步：跨文件类型解析、namespace 导入展开、动态 import / require()
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

import { isParseTarget, parseTsFile } from "./parser";
import {
  buildSymbolId,
  clearAllGraph,
  clearFileEntries,
  countCalls,
  countImports,
  countSymbols,
  ensureGraphSchema,
  insertCalls,
  insertImports,
  insertSymbols,
  type CallEdge,
  type ImportEdge,
  type SymbolRecord,
} from "./store";
import { shouldSkipDir } from "../rag/chunker";

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"];
const INDEX_BASENAMES = ["index"];
const MAX_FILE_BYTES = 500 * 1024;

export interface BuildProgress {
  filesScanned: number;
  filesParsed: number;
  importsWritten: number;
  symbolsWritten: number;
  callsWritten: number;
  durationMs: number;
}

export function buildGraph(db: Database.Database, workspace: string): BuildProgress {
  ensureGraphSchema(db);
  clearAllGraph(db);

  const start = Date.now();
  const wsAbs = path.resolve(workspace);
  const progress: BuildProgress = {
    filesScanned: 0,
    filesParsed: 0,
    importsWritten: 0,
    symbolsWritten: 0,
    callsWritten: 0,
    durationMs: 0,
  };

  // 第 1 趟：收集所有 TS 文件路径（用于 import 解析时验证目标文件存在）
  const allFiles: string[] = [];
  walk(wsAbs, (abs) => {
    progress.filesScanned += 1;
    if (!isParseTarget(abs)) return;
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return;
    allFiles.push(abs);
  });

  const fileSet = new Set(allFiles.map((p) => path.relative(wsAbs, p)));

  // 第 2 趟：parse 每个文件，解析 import path，写入 db
  for (const abs of allFiles) {
    const rel = path.relative(wsAbs, abs);
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = parseTsFile(rel, content);
    } catch {
      // parse 失败（极少见）→ skip 不阻塞 builder
      continue;
    }
    progress.filesParsed += 1;

    clearFileEntries(db, rel);

    // import edges
    const importEdges: ImportEdge[] = [];
    const importBindings = new Map<string, string | null>(); // local name → dstPath (or null for external)
    for (const imp of parsed.imports) {
      const dstAbs = resolveImportPath(abs, imp.module, fileSet, wsAbs);
      const dstRel = dstAbs ? path.relative(wsAbs, dstAbs) : null;
      importEdges.push({ srcPath: rel, module: imp.module, dstPath: dstRel });
      // 记 binding name → dstPath
      if (imp.defaultBinding) importBindings.set(imp.defaultBinding, dstRel);
      if (imp.namespaceBinding) importBindings.set(imp.namespaceBinding, dstRel);
      for (const nb of imp.namedBindings) importBindings.set(nb.local, dstRel);
    }

    // symbols
    const symbolRecords: SymbolRecord[] = parsed.symbols.map((s) => ({
      symbolId: buildSymbolId(rel, s.name),
      relPath: rel,
      name: s.name,
      kind: s.kind,
      line: s.line,
      exported: s.exported,
    }));
    const localSymbolNames = new Set(symbolRecords.map((s) => s.name));

    // calls：解析 callee_path
    const callEdges: CallEdge[] = parsed.calls.map((c) => {
      let calleePath: string | null = null;
      if (importBindings.has(c.calleeName)) {
        calleePath = importBindings.get(c.calleeName) ?? null;
      } else if (localSymbolNames.has(c.calleeName)) {
        calleePath = rel;
      } else if (c.receiver && importBindings.has(c.receiver)) {
        // obj.foo() 形式：receiver 是 import 的 namespace / default 时，归到该 module
        calleePath = importBindings.get(c.receiver) ?? null;
      }
      return {
        callerPath: rel,
        callerLine: c.line,
        calleeName: c.calleeName,
        calleePath,
      };
    });

    if (importEdges.length) insertImports(db, importEdges);
    if (symbolRecords.length) insertSymbols(db, symbolRecords);
    if (callEdges.length) insertCalls(db, callEdges);

    progress.importsWritten += importEdges.length;
    progress.symbolsWritten += symbolRecords.length;
    progress.callsWritten += callEdges.length;
  }

  progress.durationMs = Date.now() - start;
  return progress;
}

export function summarizeBuildProgress(p: BuildProgress): string {
  return [
    `files-scanned: ${p.filesScanned}`,
    `files-parsed: ${p.filesParsed}`,
    `imports: ${p.importsWritten}`,
    `symbols: ${p.symbolsWritten}`,
    `calls: ${p.callsWritten}`,
    `duration: ${p.durationMs}ms`,
  ].join("\n");
}

export function graphCounts(db: Database.Database): {
  symbols: number;
  imports: number;
  calls: number;
} {
  return {
    symbols: countSymbols(db),
    imports: countImports(db),
    calls: countCalls(db),
  };
}

function walk(root: string, onFile: (abs: string) => void): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(root, e.name);
    if (e.isDirectory()) {
      if (shouldSkipDir(e.name)) continue;
      walk(abs, onFile);
      continue;
    }
    if (e.isFile()) onFile(abs);
  }
}

function resolveImportPath(
  fromAbs: string,
  module: string,
  workspaceFiles: ReadonlySet<string>,
  workspaceRoot: string
): string | null {
  // 仅相对路径解析；包名 / alias 留 NULL
  if (!module.startsWith(".") && !module.startsWith("/")) return null;
  const fromDir = path.dirname(fromAbs);
  const target = module.startsWith("/")
    ? path.resolve(module)
    : path.resolve(fromDir, module);

  // 候选 1：直接匹配文件（已带扩展名 / index）
  const candidates: string[] = [];
  if (path.extname(target)) candidates.push(target);
  for (const ext of RESOLVE_EXTENSIONS) {
    candidates.push(`${target}${ext}`);
  }
  for (const base of INDEX_BASENAMES) {
    for (const ext of RESOLVE_EXTENSIONS) {
      candidates.push(path.join(target, `${base}${ext}`));
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      const rel = path.relative(workspaceRoot, c);
      // 必须在 workspaceFiles 内（防 ../ 出 workspace）
      if (workspaceFiles.has(rel)) return c;
    }
  }
  return null;
}
