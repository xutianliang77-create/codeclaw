/**
 * RAG indexer + searcher 端到端单测（M4-#75 step a+b）
 *
 * 用临时 workspace 装几个 fixture 文件，跑 indexWorkspace + searchKeyword 验证：
 *   - 全量索引产 chunk + 倒排
 *   - 按关键字 BM25 召回 top-K，最相关命中应排第一
 *   - 增量索引：未变文件 skip，变化文件重写
 *   - 删除文件 → 该 path 的 chunk 被清理
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { indexWorkspace, summarizeIndexProgress } from "../../../src/rag/indexer";
import { openRagDb } from "../../../src/rag/store";
import { searchKeyword, formatSearchHits } from "../../../src/rag/searcher";

let workspace: string;
let dbDir: string;
let dbPath: string;

beforeEach(() => {
  const root = path.join(os.tmpdir(), `rag-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  workspace = path.join(root, "ws"); // workspace 与 db 分目录，避免 walker 扫到 sqlite 文件
  dbDir = path.join(root, "db");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  dbPath = path.join(dbDir, "rag.db");
});

afterEach(() => {
  rmSync(path.dirname(workspace), { recursive: true, force: true });
});

function withDb<T>(fn: (db: import("better-sqlite3").Database) => T): T {
  const handle = openRagDb(workspace, { path: dbPath });
  try {
    return fn(handle.db);
  } finally {
    handle.close();
  }
}

describe("indexWorkspace · 全量索引", () => {
  it("索引 3 个 ts 文件 → chunk 表 + 倒排建立", () => {
    writeFileSync(path.join(workspace, "alpha.ts"), "function alphaParser() { return 'alpha'; }\n");
    writeFileSync(path.join(workspace, "beta.ts"), "class BetaService { handle() {} }\n");
    writeFileSync(path.join(workspace, "gamma.ts"), "const gammaConst = 42;\n");

    withDb((db) => {
      const p = indexWorkspace(db, workspace);
      expect(p.filesScanned).toBe(3);
      expect(p.filesIndexed).toBe(3);
      expect(p.chunksUpserted).toBeGreaterThanOrEqual(3);
      expect(p.chunksDeleted).toBe(0);

      const summary = summarizeIndexProgress(p);
      expect(summary).toContain("files-scanned: 3");
    });
  });

  it("跳过 node_modules / .git", () => {
    mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
    writeFileSync(path.join(workspace, "node_modules", "x.js"), "module.exports = {};\n");
    mkdirSync(path.join(workspace, ".git"), { recursive: true });
    writeFileSync(path.join(workspace, ".git", "config"), "[core]\n");
    writeFileSync(path.join(workspace, "real.ts"), "const real = true;\n");

    withDb((db) => {
      const p = indexWorkspace(db, workspace);
      expect(p.filesScanned).toBe(1); // 只 real.ts
      expect(p.filesIndexed).toBe(1);
    });
  });
});

describe("searchKeyword · BM25", () => {
  it("命中包含查询词的 chunk", () => {
    writeFileSync(
      path.join(workspace, "auth.ts"),
      "export function authenticate(user) { return user.token; }\n"
    );
    writeFileSync(
      path.join(workspace, "render.ts"),
      "export function renderTemplate(html) { return html; }\n"
    );
    writeFileSync(
      path.join(workspace, "cache.ts"),
      "export class TokenCache { get(key) { return null; } }\n"
    );

    withDb((db) => {
      indexWorkspace(db, workspace);
      const hits = searchKeyword(db, "authenticate user token", { topK: 3 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].relPath).toBe("auth.ts");
      expect(hits[0].score).toBeGreaterThan(0);
    });
  });

  it("查询无命中 → 返空", () => {
    writeFileSync(path.join(workspace, "x.ts"), "const x = 1;\n");
    withDb((db) => {
      indexWorkspace(db, workspace);
      const hits = searchKeyword(db, "completely-unknown-token-zzz");
      expect(hits).toEqual([]);
    });
  });

  it("BM25 偏向稀有词（rare term 排序高）", () => {
    writeFileSync(
      path.join(workspace, "common.ts"),
      "import x from 'a'; import y from 'b'; import z from 'c'; const a = 1;\n"
    );
    writeFileSync(
      path.join(workspace, "unique.ts"),
      "import x from 'a'; const wormholeDistortion = true;\n"
    );

    withDb((db) => {
      indexWorkspace(db, workspace);
      const hits = searchKeyword(db, "wormholeDistortion import", { topK: 5 });
      expect(hits[0].relPath).toBe("unique.ts");
    });
  });

  it("formatSearchHits 渲染含路径 / 行 / 分数", () => {
    writeFileSync(path.join(workspace, "f.ts"), "const tokenizer = parser();\n");
    withDb((db) => {
      indexWorkspace(db, workspace);
      const hits = searchKeyword(db, "tokenizer parser");
      const text = formatSearchHits(hits);
      expect(text).toContain("f.ts:1");
      expect(text).toContain("score=");
      expect(text).toContain("hits=");
    });
  });
});

describe("indexWorkspace · 增量", () => {
  it("文件未变 → 第二次 index 0 chunk upsert", () => {
    writeFileSync(path.join(workspace, "a.ts"), "const a = 1;\n");
    withDb((db) => {
      const p1 = indexWorkspace(db, workspace);
      expect(p1.chunksUpserted).toBeGreaterThan(0);
      const p2 = indexWorkspace(db, workspace);
      expect(p2.chunksUpserted).toBe(0);
      expect(p2.chunksDeleted).toBe(0);
    });
  });

  it("文件改动 → 重新写 chunk", () => {
    const f = path.join(workspace, "mut.ts");
    writeFileSync(f, "const v = 1;\n");
    withDb((db) => {
      indexWorkspace(db, workspace);
      writeFileSync(f, "const v = 99; // changed\n");
      const p = indexWorkspace(db, workspace);
      expect(p.chunksUpserted).toBeGreaterThan(0);
    });
  });

  it("文件被删 → 该 path 的 chunk 被清", () => {
    const f = path.join(workspace, "gone.ts");
    writeFileSync(f, "const gone = true;\n");
    withDb((db) => {
      indexWorkspace(db, workspace);
      // 验证可搜到
      expect(searchKeyword(db, "gone").length).toBeGreaterThan(0);
      unlinkSync(f);
      const p = indexWorkspace(db, workspace);
      expect(p.chunksDeleted).toBeGreaterThan(0);
      expect(searchKeyword(db, "gone")).toEqual([]);
    });
  });
});
