/**
 * RAG indexer · workspace 全量 / 增量索引（M4-#75 step a+b）
 *
 * 入口：indexWorkspace(workspace, options)
 *   - 遍历 workspace 文件（gitignore 友好的 SKIPPED_DIRECTORIES）
 *   - chunkFile 切块；contentHash 与磁盘对比决定是否重建 chunk
 *   - 同时填倒排（rag_terms）和 chunks（rag_chunks）
 *   - 删除磁盘已不存在的 chunk（被改动 / 删除的文件残留）
 *
 * 增量逻辑：
 *   - 文件 path 不变 + content hash 不变 → skip
 *   - 内容变 → 删旧 chunks + 重写
 *   - 文件被删 → 该 path 下所有 chunks 删
 *
 * 不阻塞主流程：indexWorkspace 是显式调用（/rag index），不在 createQueryEngine
 * 自动跑（避免大 codebase 启动卡顿）。
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

import { chunkFile, chunkId, shouldSkipDir } from "./chunker";
import { tokenFreqs, tokenize } from "./tokenize";
import {
  deleteChunk,
  getChunk,
  insertTerms,
  listChunkIdsByPath,
  setMeta,
  upsertChunk,
} from "./store";

export interface IndexProgress {
  filesScanned: number;
  filesIndexed: number;
  chunksUpserted: number;
  chunksDeleted: number;
  durationMs: number;
}

export interface IndexOptions {
  /** 自定义跳过路径（除 SKIPPED_DIRECTORIES 外） */
  skipDirs?: ReadonlySet<string>;
  /** 进度回调；每文件 1 次 */
  onProgress?(filesScanned: number): void;
}

export function indexWorkspace(
  db: Database.Database,
  workspace: string,
  opts: IndexOptions = {}
): IndexProgress {
  const start = Date.now();
  const wsAbs = path.resolve(workspace);
  const onDiskPaths = new Set<string>();
  const progress: IndexProgress = {
    filesScanned: 0,
    filesIndexed: 0,
    chunksUpserted: 0,
    chunksDeleted: 0,
    durationMs: 0,
  };

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (shouldSkipDir(e.name) || opts.skipDirs?.has(e.name)) continue;
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;

      progress.filesScanned += 1;
      opts.onProgress?.(progress.filesScanned);

      const rel = path.relative(wsAbs, abs);
      onDiskPaths.add(rel);
      const chunks = chunkFile(abs, rel);
      if (chunks.length === 0) continue;

      // 增量：删除该文件下所有当前不再存在的 chunk_id（内容变化导致 line_start 变化等）
      const currentIds = new Set(chunks.map(chunkId));
      const previousIds = listChunkIdsByPath(db, rel);
      for (const prev of previousIds) {
        if (!currentIds.has(prev)) {
          deleteChunk(db, prev);
          progress.chunksDeleted += 1;
        }
      }

      // hash 对比决定是否重写
      let fileIndexed = false;
      for (const c of chunks) {
        const id = chunkId(c);
        const existing = getChunk(db, id);
        if (existing && existing.contentHash === c.contentHash) continue;

        // 重写 chunk + 倒排
        const tokens = tokenize(c.content);
        const tf = tokenFreqs(c.content);
        upsertChunk(db, {
          chunkId: id,
          relPath: c.relPath,
          lineStart: c.lineStart,
          lineEnd: c.lineEnd,
          content: c.content,
          tokenCount: tokens.length,
          contentHash: c.contentHash,
          indexedAt: Date.now(),
        });
        insertTerms(db, id, tf);
        progress.chunksUpserted += 1;
        fileIndexed = true;
      }
      if (fileIndexed) progress.filesIndexed += 1;
    }
  };
  walk(wsAbs);

  // 删除磁盘上已不存在的文件对应的 chunk
  const allRelPaths = (db.prepare("SELECT DISTINCT rel_path FROM rag_chunks").all() as Array<{
    rel_path: string;
  }>).map((r) => r.rel_path);
  for (const rel of allRelPaths) {
    if (!onDiskPaths.has(rel)) {
      const ids = listChunkIdsByPath(db, rel);
      for (const id of ids) {
        deleteChunk(db, id);
        progress.chunksDeleted += 1;
      }
    }
  }

  setMeta(db, "last_indexed_at", String(Date.now()));
  setMeta(db, "workspace", wsAbs);

  progress.durationMs = Date.now() - start;
  return progress;
}

export function summarizeIndexProgress(p: IndexProgress): string {
  return [
    `files-scanned: ${p.filesScanned}`,
    `files-indexed: ${p.filesIndexed}`,
    `chunks-upserted: ${p.chunksUpserted}`,
    `chunks-deleted: ${p.chunksDeleted}`,
    `duration: ${p.durationMs}ms`,
  ].join("\n");
}

/** chunk record + score；search 接口对外暴露的形态 */
export interface SearchHit {
  chunkId: string;
  relPath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  score: number;
  hits: string[];
}
