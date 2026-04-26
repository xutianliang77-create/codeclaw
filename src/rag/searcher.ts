/**
 * RAG searcher · 把 BM25 结果包装成 SearchHit（M4-#75 step b）
 *
 * 当前实现：仅 BM25。step c-d 后会增加 hybrid（BM25 + 向量召回 + RRF）。
 */

import type Database from "better-sqlite3";

import { bm25Search } from "./bm25";
import { getChunk } from "./store";
import type { SearchHit } from "./indexer";

export interface SearchOptions {
  topK?: number;
  /** 仅返回 score >= 阈值的结果（默认 0，都返） */
  minScore?: number;
}

export function searchKeyword(
  db: Database.Database,
  query: string,
  opts: SearchOptions = {}
): SearchHit[] {
  const topK = Math.max(1, opts.topK ?? 10);
  const minScore = opts.minScore ?? 0;
  const ranked = bm25Search(db, query, topK);
  const hits: SearchHit[] = [];
  for (const r of ranked) {
    if (r.score < minScore) continue;
    const c = getChunk(db, r.chunkId);
    if (!c) continue;
    hits.push({
      chunkId: r.chunkId,
      relPath: c.relPath,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd,
      content: c.content,
      score: r.score,
      hits: r.hits,
    });
  }
  return hits;
}

export function formatSearchHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "(no matches)";
  return hits
    .map((h, i) => {
      const head = `[${i + 1}] ${h.relPath}:${h.lineStart}-${h.lineEnd}  score=${h.score.toFixed(3)}  hits=${h.hits.join(",")}`;
      const body = h.content.length > 600 ? `${h.content.slice(0, 600)}\n...[truncated]` : h.content;
      return `${head}\n---\n${body}\n`;
    })
    .join("\n");
}
