/**
 * RAG 高层 API（M4-#75 step e）
 *
 * 包装 store/indexer/searcher 给 queryEngine 与 native tool 调用。
 * 自动按 workspace 解析 db 路径，无需调用方手动 openRagDb。
 *
 * 不持久化连接：每次调用打开 db → 用完 close。索引 / 搜索都不在热路径，
 * sqlite 打开成本可接受（< 5ms）。如未来变频繁可改 lazy singleton。
 */

import {
  openRagDb,
  countEmbeddedChunks,
  listChunksMissingEmbedding,
  setEmbedding,
} from "./store";
import { indexWorkspace, summarizeIndexProgress, type IndexProgress } from "./indexer";
import { searchKeyword, formatSearchHits } from "./searcher";
import type { SearchHit } from "./indexer";
import { embedTexts, vectorToBlob, type EmbedOptions } from "./embedding";
import { searchHybrid, type HybridHit } from "./hybrid";

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
  embeddedCount: number;
  lastIndexedAt: number | null;
  workspaceMeta: string | null;
}

export function runStatus(workspace: string): RagStatusResult {
  const handle = openRagDb(workspace);
  try {
    const chunkCount = (handle.db.prepare("SELECT COUNT(*) AS n FROM rag_chunks").get() as {
      n: number;
    }).n;
    const embeddedCount = countEmbeddedChunks(handle.db);
    const lastRow = handle.db.prepare("SELECT value FROM rag_meta WHERE key = ?").get("last_indexed_at") as
      | { value: string }
      | undefined;
    const wsRow = handle.db.prepare("SELECT value FROM rag_meta WHERE key = ?").get("workspace") as
      | { value: string }
      | undefined;
    return {
      chunkCount,
      embeddedCount,
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
    `embedded: ${s.embeddedCount}/${s.chunkCount}`,
    `last-indexed: ${lastIndexed}`,
    `workspace: ${s.workspaceMeta ?? "(empty)"}`,
  ].join("\n");
}

/* ---------- step c: 批量 embed ---------- */

export interface RagEmbedResult {
  embeddedNow: number;
  embeddedTotal: number;
  remaining: number;
  durationMs: number;
}

export async function runEmbed(
  workspace: string,
  embedOpts: EmbedOptions,
  options: { batch?: number; maxChunks?: number } = {}
): Promise<RagEmbedResult> {
  const start = Date.now();
  const handle = openRagDb(workspace);
  try {
    const limit = Math.min(options.maxChunks ?? 500, 5000);
    const missing = listChunksMissingEmbedding(handle.db, limit);
    if (missing.length === 0) {
      return {
        embeddedNow: 0,
        embeddedTotal: countEmbeddedChunks(handle.db),
        remaining: 0,
        durationMs: Date.now() - start,
      };
    }
    const texts = missing.map((m) => m.content);
    const vectors = await embedTexts(texts, {
      ...embedOpts,
      ...(options.batch ? { batchSize: options.batch } : {}),
    });
    for (let i = 0; i < missing.length && i < vectors.length; i++) {
      setEmbedding(handle.db, missing[i].chunkId, vectorToBlob(vectors[i]));
    }
    const remaining = listChunksMissingEmbedding(handle.db, 1).length;
    return {
      embeddedNow: missing.length,
      embeddedTotal: countEmbeddedChunks(handle.db),
      remaining,
      durationMs: Date.now() - start,
    };
  } finally {
    handle.close();
  }
}

/* ---------- step d: hybrid search ---------- */

export interface RagHybridResult {
  ok: true;
  hits: HybridHit[];
  text: string;
}

export async function runHybridSearch(
  workspace: string,
  query: string,
  embedOpts: EmbedOptions,
  topK: number = 8
): Promise<RagHybridResult> {
  const handle = openRagDb(workspace);
  try {
    const hits = await searchHybrid(handle.db, query, embedOpts, { topK });
    return { ok: true, hits, text: formatHybridHits(hits) };
  } finally {
    handle.close();
  }
}

export function formatHybridHits(hits: HybridHit[]): string {
  if (hits.length === 0) return "(no matches)";
  return hits
    .map((h, i) => {
      const head = `[${i + 1}] ${h.relPath}:${h.lineStart}-${h.lineEnd}  rrf=${h.rrfScore.toFixed(4)}  src=${h.source}${h.hits.length ? `  hits=${h.hits.join(",")}` : ""}`;
      const body = h.content.length > 600 ? `${h.content.slice(0, 600)}\n...[truncated]` : h.content;
      return `${head}\n---\n${body}\n`;
    })
    .join("\n");
}
