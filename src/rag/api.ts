/**
 * RAG 高层 API（M4-#75 step e）
 *
 * 包装 store/indexer/searcher 给 queryEngine 与 native tool 调用。
 * 自动按 workspace 解析 db 路径，无需调用方手动 openRagDb。
 *
 * 不持久化连接：每次调用打开 db → 用完 close。索引 / 搜索都不在热路径，
 * sqlite 打开成本可接受（< 5ms）。如未来变频繁可改 lazy singleton。
 */

import { openRagDb } from "./store";
import { indexWorkspace, summarizeIndexProgress, type IndexProgress } from "./indexer";
import { searchKeyword, formatSearchHits } from "./searcher";
import type { SearchHit } from "./indexer";

export interface RagIndexResult {
  ok: true;
  progress: IndexProgress;
  summary: string;
}

export function runIndex(workspace: string): RagIndexResult {
  const handle = openRagDb(workspace);
  try {
    const progress = indexWorkspace(handle.db, workspace);
    return { ok: true, progress, summary: summarizeIndexProgress(progress) };
  } finally {
    handle.close();
  }
}

export interface RagSearchResult {
  ok: true;
  hits: SearchHit[];
  text: string;
}

export function runSearch(
  workspace: string,
  query: string,
  topK: number = 8
): RagSearchResult {
  const handle = openRagDb(workspace);
  try {
    const hits = searchKeyword(handle.db, query, { topK });
    return { ok: true, hits, text: formatSearchHits(hits) };
  } finally {
    handle.close();
  }
}

export interface RagStatusResult {
  chunkCount: number;
  lastIndexedAt: number | null;
  workspaceMeta: string | null;
}

export function runStatus(workspace: string): RagStatusResult {
  const handle = openRagDb(workspace);
  try {
    const chunkCount = (handle.db.prepare("SELECT COUNT(*) AS n FROM rag_chunks").get() as {
      n: number;
    }).n;
    const lastRow = handle.db.prepare("SELECT value FROM rag_meta WHERE key = ?").get("last_indexed_at") as
      | { value: string }
      | undefined;
    const wsRow = handle.db.prepare("SELECT value FROM rag_meta WHERE key = ?").get("workspace") as
      | { value: string }
      | undefined;
    return {
      chunkCount,
      lastIndexedAt: lastRow ? Number.parseInt(lastRow.value, 10) : null,
      workspaceMeta: wsRow?.value ?? null,
    };
  } finally {
    handle.close();
  }
}

export function runClear(workspace: string): { cleared: number } {
  const handle = openRagDb(workspace);
  try {
    const before = (handle.db.prepare("SELECT COUNT(*) AS n FROM rag_chunks").get() as {
      n: number;
    }).n;
    handle.db.exec("DELETE FROM rag_terms; DELETE FROM rag_chunks; DELETE FROM rag_meta;");
    return { cleared: before };
  } finally {
    handle.close();
  }
}

export function formatStatus(s: RagStatusResult): string {
  const lastIndexed = s.lastIndexedAt ? new Date(s.lastIndexedAt).toISOString() : "never";
  return [
    `chunks: ${s.chunkCount}`,
    `last-indexed: ${lastIndexed}`,
    `workspace: ${s.workspaceMeta ?? "(empty)"}`,
  ].join("\n");
}
