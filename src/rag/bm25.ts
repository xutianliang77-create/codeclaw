/**
 * BM25 评分（M4-#75 step b）
 *
 * 公式：
 *   score(D, Q) = Σ_{q ∈ Q} IDF(q) · ( f(q,D) · (k1 + 1) ) /
 *                                       ( f(q,D) + k1 · (1 - b + b · |D| / avgdl) )
 *
 *   IDF(q) = ln( (N - n(q) + 0.5) / (n(q) + 0.5) + 1 )
 *
 * 参数：k1=1.2, b=0.75（业界缺省）
 *
 * 调用方式：buildBm25Stats 一次拿 N + avgdl + IDF 表（依赖整个索引），
 * 然后 scoreChunkAgainstQuery 拿单 chunk 的 BM25 分。
 *
 * 不做：磁盘端 SQL JOIN 算分（~10K chunk 时 in-memory 累加足够快），
 * 真大型工程（>100K chunk）再上 sqlite-fts5 / vector store。
 */

import { listPostings, countChunks, avgTokenCount, type TermPosting } from "./store";
import { tokenize } from "./tokenize";
import type Database from "better-sqlite3";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export interface Bm25Stats {
  /** 总 chunk 数 N */
  n: number;
  /** 平均 chunk token 数 */
  avgdl: number;
}

export function buildBm25Stats(db: Database.Database): Bm25Stats {
  return { n: countChunks(db), avgdl: avgTokenCount(db) || 1 };
}

export function idf(termDocCount: number, totalDocs: number): number {
  return Math.log((totalDocs - termDocCount + 0.5) / (termDocCount + 0.5) + 1);
}

export interface Bm25SearchResult {
  chunkId: string;
  score: number;
  /** 哪些查询 term 命中了 */
  hits: string[];
}

/**
 * 单查询 → BM25 top-K chunk_id + 分数。
 * 实现：对查询每个 token 拿倒排表，累加各 chunk 的 score，最后排序。
 */
export function bm25Search(
  db: Database.Database,
  query: string,
  k: number = 10
): Bm25SearchResult[] {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0) return [];

  const stats = buildBm25Stats(db);
  if (stats.n === 0) return [];

  // chunkId → token_count 缓存（按需填充）
  const lengthStmt = db.prepare("SELECT token_count FROM rag_chunks WHERE chunk_id = ?");
  const tokenCountCache = new Map<string, number>();
  const getTokenCount = (chunkId: string): number => {
    let v = tokenCountCache.get(chunkId);
    if (v !== undefined) return v;
    const row = lengthStmt.get(chunkId) as { token_count: number } | undefined;
    v = row?.token_count ?? 0;
    tokenCountCache.set(chunkId, v);
    return v;
  };

  const scores = new Map<string, { score: number; hits: Set<string> }>();
  for (const term of queryTokens) {
    const postings: TermPosting[] = listPostings(db, term);
    if (postings.length === 0) continue;
    const termIdf = idf(postings.length, stats.n);
    for (const p of postings) {
      const dl = getTokenCount(p.chunkId);
      const numer = p.freq * (BM25_K1 + 1);
      const denom = p.freq + BM25_K1 * (1 - BM25_B + BM25_B * (dl / stats.avgdl));
      const delta = termIdf * (numer / denom);
      const entry = scores.get(p.chunkId);
      if (entry) {
        entry.score += delta;
        entry.hits.add(term);
      } else {
        scores.set(p.chunkId, { score: delta, hits: new Set([term]) });
      }
    }
  }

  return [...scores.entries()]
    .map(([chunkId, { score, hits }]) => ({ chunkId, score, hits: [...hits].sort() }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
