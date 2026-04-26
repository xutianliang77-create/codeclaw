/**
 * 向量召回 + RRF 混合（M4-#75 step d）
 *
 * 向量检索：
 *   - 把所有 chunk 的 embedding 拉到内存（~10K chunk × 1024 dim × 4B = 40MB 上限）
 *   - 与 query embedding 算 cosine similarity
 *   - top-K 排序
 *   - 真大型工程（>50K chunk）需要 sqlite-vec / faiss；这里先内存方案
 *
 * RRF (Reciprocal Rank Fusion)：
 *   - 论文：Cormack et al. 2009 "Reciprocal rank fusion outperforms Condorcet..."
 *   - 公式：score(d) = Σ_i 1 / (k + rank_i(d))，常用 k=60
 *   - 不依赖各路 score 量纲；只看排名，鲁棒性好
 */

import type Database from "better-sqlite3";

import { blobToVector, cosineSimilarity, embedTexts, type EmbedOptions } from "./embedding";
import { listAllEmbeddings, getChunk } from "./store";
import { bm25Search, type Bm25SearchResult } from "./bm25";
import type { SearchHit } from "./indexer";

const RRF_K = 60;

export interface VectorSearchResult {
  chunkId: string;
  similarity: number;
}

export function vectorSearch(
  db: Database.Database,
  queryVector: number[],
  topK: number = 10
): VectorSearchResult[] {
  if (queryVector.length === 0) return [];
  const all = listAllEmbeddings(db);
  if (all.length === 0) return [];

  const results: VectorSearchResult[] = [];
  for (const row of all) {
    const v = blobToVector(row.embedding);
    if (v.length !== queryVector.length) continue;
    const sim = cosineSimilarity(queryVector, v);
    results.push({ chunkId: row.chunkId, similarity: sim });
  }
  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

export interface HybridSearchOptions {
  topK?: number;
  /** 向量召回 + BM25 各自取 top-N 后融合（默认 N = topK * 3，至多 50） */
  candidateK?: number;
  /** RRF 调和参数；默认 60（论文推荐） */
  rrfK?: number;
  /** 过滤 RRF 分数 < minScore 的结果 */
  minScore?: number;
}

export interface HybridHit extends SearchHit {
  /** 来源标记：bm25-only / vector-only / both */
  source: "bm25" | "vector" | "both";
  /** RRF 融合分（不是 BM25 / cosine 的原始分） */
  rrfScore: number;
}

export async function searchHybrid(
  db: Database.Database,
  query: string,
  embedOpts: EmbedOptions,
  options: HybridSearchOptions = {}
): Promise<HybridHit[]> {
  const topK = Math.max(1, options.topK ?? 8);
  const candidateK = Math.min(50, Math.max(topK, options.candidateK ?? topK * 3));
  const rrfK = options.rrfK ?? RRF_K;

  // BM25
  const bm25Hits = bm25Search(db, query, candidateK);
  // Vector：先 embed query
  const [queryVector] = await embedTexts([query], embedOpts);
  const vecHits = queryVector ? vectorSearch(db, queryVector, candidateK) : [];

  // RRF 融合
  const rrf = new Map<string, { score: number; bm25Rank?: number; vecRank?: number; bm25Hits?: string[] }>();
  bm25Hits.forEach((h: Bm25SearchResult, rank) => {
    const cur = rrf.get(h.chunkId) ?? { score: 0 };
    cur.score += 1 / (rrfK + rank);
    cur.bm25Rank = rank;
    cur.bm25Hits = h.hits;
    rrf.set(h.chunkId, cur);
  });
  vecHits.forEach((h: VectorSearchResult, rank) => {
    const cur = rrf.get(h.chunkId) ?? { score: 0 };
    cur.score += 1 / (rrfK + rank);
    cur.vecRank = rank;
    rrf.set(h.chunkId, cur);
  });

  const ranked = [...rrf.entries()]
    .map(([chunkId, info]) => ({ chunkId, ...info }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter((r) => r.score >= (options.minScore ?? 0));

  const out: HybridHit[] = [];
  for (const r of ranked) {
    const c = getChunk(db, r.chunkId);
    if (!c) continue;
    const source: HybridHit["source"] =
      r.bm25Rank !== undefined && r.vecRank !== undefined
        ? "both"
        : r.bm25Rank !== undefined
          ? "bm25"
          : "vector";
    out.push({
      chunkId: r.chunkId,
      relPath: c.relPath,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd,
      content: c.content,
      score: r.score,
      hits: r.bm25Hits ?? [],
      source,
      rrfScore: r.score,
    });
  }
  return out;
}
