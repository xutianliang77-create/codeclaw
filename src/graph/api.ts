/**
 * CodebaseGraph 高层 API（M4-#76 step e）
 *
 * 包装 store/builder/queries 给 queryEngine 与 native tool。
 * 复用 RAG 的 workspace hash db 路径（rag.db）；不开新 db。
 */

import { openRagDb } from "../rag/store";
import { buildGraph, graphCounts, summarizeBuildProgress, type BuildProgress } from "./builder";
import { ensureGraphSchema } from "./store";
import {
  dependenciesOf,
  dependentsOf,
  findSymbolsByName,
  listSymbolsInFile,
  whatCalls,
  whoCalls,
  type CallerRow,
  type ImportRow,
  type SymbolRow,
} from "./queries";

export interface RunBuildResult {
  ok: true;
  progress: BuildProgress;
  summary: string;
}

export function runBuild(workspace: string): RunBuildResult {
  const handle = openRagDb(workspace);
  try {
    const progress = buildGraph(handle.db, workspace);
    return { ok: true, progress, summary: summarizeBuildProgress(progress) };
  } finally {
    handle.close();
  }
}

export interface GraphStatus {
  symbols: number;
  imports: number;
  calls: number;
}

export function runStatus(workspace: string): GraphStatus {
  const handle = openRagDb(workspace);
  try {
    ensureGraphSchema(handle.db);
    return graphCounts(handle.db);
  } finally {
    handle.close();
  }
}

export interface QueryResult {
  callers?: CallerRow[];
  callees?: CallerRow[];
  dependents?: ImportRow[];
  dependencies?: ImportRow[];
  symbols?: SymbolRow[];
}

export function runQuery(
  workspace: string,
  type: "callers" | "callees" | "dependents" | "dependencies" | "symbol",
  arg: string,
  arg2?: string
): QueryResult {
  const handle = openRagDb(workspace);
  try {
    ensureGraphSchema(handle.db);
    if (type === "callers") return { callers: whoCalls(handle.db, arg, arg2) };
    if (type === "callees") return { callees: whatCalls(handle.db, arg) };
    if (type === "dependents") return { dependents: dependentsOf(handle.db, arg) };
    if (type === "dependencies") return { dependencies: dependenciesOf(handle.db, arg) };
    if (type === "symbol") {
      // arg 含 '/' 视为 path，否则按 name
      if (arg.includes("/") || arg.includes("\\")) {
        return { symbols: listSymbolsInFile(handle.db, arg) };
      }
      return { symbols: findSymbolsByName(handle.db, arg) };
    }
    return {};
  } finally {
    handle.close();
  }
}

export function formatStatus(s: GraphStatus): string {
  return [
    `symbols: ${s.symbols}`,
    `imports: ${s.imports}`,
    `calls: ${s.calls}`,
  ].join("\n");
}

export function formatQueryResult(r: QueryResult): string {
  if (r.callers) {
    if (r.callers.length === 0) return "(no callers)";
    return r.callers.map((c) => `${c.callerPath}:${c.callerLine}  → ${c.calleePath ?? "?"}::${c.calleeName}`).join("\n");
  }
  if (r.callees) {
    if (r.callees.length === 0) return "(no callees)";
    return r.callees.map((c) => `:${c.callerLine}  ${c.calleeName}${c.calleePath ? ` → ${c.calleePath}` : ""}`).join("\n");
  }
  if (r.dependents) {
    if (r.dependents.length === 0) return "(no dependents)";
    return r.dependents.map((d) => `${d.srcPath}  imports ${d.module}`).join("\n");
  }
  if (r.dependencies) {
    if (r.dependencies.length === 0) return "(no dependencies)";
    return r.dependencies.map((d) => `${d.module}${d.dstPath ? ` → ${d.dstPath}` : "  (external)"}`).join("\n");
  }
  if (r.symbols) {
    if (r.symbols.length === 0) return "(no symbols)";
    return r.symbols
      .map((s) => `${s.relPath}:${s.line}  ${s.kind} ${s.name}${s.exported ? " (exported)" : ""}`)
      .join("\n");
  }
  return "(empty result)";
}
