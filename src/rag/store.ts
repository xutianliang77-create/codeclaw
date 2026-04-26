/**
 * RAG store · 每 workspace 独立 sqlite db（M4-#75 step a）
 *
 * 路径：~/.codeclaw/projects/<workspace-hash>/rag.db
 *   - workspace hash 复用 projectMemory 算法（realpath + sha256[:16]）
 *   - 与 memory/MEMORY.md 同目录；切 workspace 自动隔离
 *   - 不进全局 data.db，避免跨项目污染 + migration 耦合
 *
 * 表结构：
 *   - rag_chunks:  每 (file, line_range) 一条；含 content + token_count + content_hash
 *   - rag_terms:   BM25 倒排，(term, chunk_id) → freq
 *   - rag_meta:    key/value 存 doc count, avg length, last_indexed_at 等聚合量
 *
 * 索引粒度：文件级 chunk（默认 30 行/chunk + 5 行 overlap），见 chunker.ts。
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RagDbHandle {
  db: Database.Database;
  path: string;
  close(): void;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rag_chunks (
  chunk_id      TEXT    PRIMARY KEY,
  rel_path      TEXT    NOT NULL,
  line_start    INTEGER NOT NULL,
  line_end      INTEGER NOT NULL,
  content       TEXT    NOT NULL,
  token_count   INTEGER NOT NULL,
  content_hash  TEXT    NOT NULL,
  indexed_at    INTEGER NOT NULL,
  embedding     BLOB
);
CREATE INDEX IF NOT EXISTS idx_chunks_path ON rag_chunks(rel_path);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON rag_chunks(content_hash);

CREATE TABLE IF NOT EXISTS rag_terms (
  term          TEXT    NOT NULL,
  chunk_id      TEXT    NOT NULL,
  freq          INTEGER NOT NULL,
  PRIMARY KEY (term, chunk_id),
  FOREIGN KEY (chunk_id) REFERENCES rag_chunks(chunk_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_terms_chunk ON rag_terms(chunk_id);

CREATE TABLE IF NOT EXISTS rag_meta (
  key   TEXT    PRIMARY KEY,
  value TEXT    NOT NULL
);
`;

export function getRagDbPath(workspace: string, homeDir: string = os.homedir()): string {
  let canonical: string;
  try {
    canonical = realpathSync(path.resolve(workspace));
  } catch {
    canonical = path.resolve(workspace);
  }
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const dir = path.join(homeDir, ".codeclaw", "projects", hash);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "rag.db");
}

export interface OpenRagDbOptions {
  /** 显式路径覆盖；测试常用 */
  path?: string;
}

export function openRagDb(workspace: string, opts: OpenRagDbOptions = {}): RagDbHandle {
  const dbPath = opts.path ?? getRagDbPath(workspace);
  if (!existsSync(path.dirname(dbPath))) mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  return {
    db,
    path: dbPath,
    close: () => db.close(),
  };
}

export interface ChunkRecord {
  chunkId: string;
  relPath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  tokenCount: number;
  contentHash: string;
  indexedAt: number;
}

/** 单条插入；冲突 chunk_id 时 REPLACE 整条记录（同时保留外键关联会通过 ON DELETE CASCADE 处理） */
export function upsertChunk(db: Database.Database, c: ChunkRecord): void {
  // 由于 rag_terms 用 chunk_id 作 FK，必须先删旧 terms 再 REPLACE chunk
  db.prepare("DELETE FROM rag_terms WHERE chunk_id = ?").run(c.chunkId);
  db.prepare(
    `INSERT OR REPLACE INTO rag_chunks
       (chunk_id, rel_path, line_start, line_end, content, token_count, content_hash, indexed_at, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    c.chunkId,
    c.relPath,
    c.lineStart,
    c.lineEnd,
    c.content,
    c.tokenCount,
    c.contentHash,
    c.indexedAt
  );
}

export function deleteChunk(db: Database.Database, chunkId: string): void {
  db.prepare("DELETE FROM rag_chunks WHERE chunk_id = ?").run(chunkId);
  // ON DELETE CASCADE 已处理 rag_terms
}

export function listChunkIdsByPath(db: Database.Database, relPath: string): string[] {
  return db
    .prepare("SELECT chunk_id FROM rag_chunks WHERE rel_path = ?")
    .all(relPath)
    .map((row) => (row as { chunk_id: string }).chunk_id);
}

export function getChunk(db: Database.Database, chunkId: string): ChunkRecord | undefined {
  const row = db.prepare("SELECT * FROM rag_chunks WHERE chunk_id = ?").get(chunkId) as
    | undefined
    | {
        chunk_id: string;
        rel_path: string;
        line_start: number;
        line_end: number;
        content: string;
        token_count: number;
        content_hash: string;
        indexed_at: number;
      };
  if (!row) return undefined;
  return {
    chunkId: row.chunk_id,
    relPath: row.rel_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    content: row.content,
    tokenCount: row.token_count,
    contentHash: row.content_hash,
    indexedAt: row.indexed_at,
  };
}

export interface TermPosting {
  chunkId: string;
  freq: number;
}

export function insertTerms(
  db: Database.Database,
  chunkId: string,
  termFreqs: Map<string, number>
): void {
  const stmt = db.prepare("INSERT OR REPLACE INTO rag_terms (term, chunk_id, freq) VALUES (?, ?, ?)");
  const tx = db.transaction((entries: Array<[string, number]>) => {
    for (const [term, freq] of entries) {
      stmt.run(term, chunkId, freq);
    }
  });
  tx([...termFreqs.entries()]);
}

export function listPostings(db: Database.Database, term: string): TermPosting[] {
  return db
    .prepare("SELECT chunk_id, freq FROM rag_terms WHERE term = ?")
    .all(term)
    .map((row) => ({ chunkId: (row as { chunk_id: string }).chunk_id, freq: (row as { freq: number }).freq }));
}

export function countChunks(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM rag_chunks").get() as { n: number }).n;
}

export function avgTokenCount(db: Database.Database): number {
  const row = db.prepare("SELECT AVG(token_count) AS avg FROM rag_chunks").get() as { avg: number | null };
  return row.avg ?? 0;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO rag_meta (key, value) VALUES (?, ?)").run(key, value);
}

export function getMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM rag_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function clearAll(db: Database.Database): void {
  db.exec("DELETE FROM rag_terms; DELETE FROM rag_chunks; DELETE FROM rag_meta;");
}

/* ---------- Embedding helpers (M4-#75 step c) ---------- */

export function setEmbedding(db: Database.Database, chunkId: string, blob: Buffer): void {
  db.prepare("UPDATE rag_chunks SET embedding = ? WHERE chunk_id = ?").run(blob, chunkId);
}

export function getEmbedding(db: Database.Database, chunkId: string): Buffer | undefined {
  const row = db.prepare("SELECT embedding FROM rag_chunks WHERE chunk_id = ?").get(chunkId) as
    | { embedding: Buffer | null }
    | undefined;
  return row?.embedding ?? undefined;
}

export function listChunksMissingEmbedding(
  db: Database.Database,
  limit: number = 1000
): Array<{ chunkId: string; content: string }> {
  return (
    db
      .prepare("SELECT chunk_id, content FROM rag_chunks WHERE embedding IS NULL LIMIT ?")
      .all(limit) as Array<{ chunk_id: string; content: string }>
  ).map((r) => ({ chunkId: r.chunk_id, content: r.content }));
}

export function listAllEmbeddings(
  db: Database.Database
): Array<{ chunkId: string; embedding: Buffer }> {
  return (
    db
      .prepare("SELECT chunk_id, embedding FROM rag_chunks WHERE embedding IS NOT NULL")
      .all() as Array<{ chunk_id: string; embedding: Buffer }>
  ).map((r) => ({ chunkId: r.chunk_id, embedding: r.embedding }));
}

export function countEmbeddedChunks(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM rag_chunks WHERE embedding IS NOT NULL").get() as {
    n: number;
  }).n;
}
