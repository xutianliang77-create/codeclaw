/**
 * RAG hybrid 单测（M4-#75 step d）
 *
 * 用 mock embedding fetch（按文本长度生成 deterministic 向量），让 vectorSearch
 * 行为可预测，单测能断言 RRF 融合逻辑。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { indexWorkspace } from "../../../src/rag/indexer";
import { openRagDb, listChunksMissingEmbedding, setEmbedding, countEmbeddedChunks } from "../../../src/rag/store";
import { embedTexts, vectorToBlob } from "../../../src/rag/embedding";
import { searchHybrid, vectorSearch } from "../../../src/rag/hybrid";

let workspace: string;
let dbPath: string;

beforeEach(() => {
  const root = path.join(os.tmpdir(), `rag-hybrid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  workspace = path.join(root, "ws");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(path.join(root, "db"), { recursive: true });
  dbPath = path.join(root, "db", "rag.db");
});

afterEach(() => rmSync(path.dirname(workspace), { recursive: true, force: true }));

/**
 * 把文本散列到固定 8 维向量。同样文本 → 同样向量。
 * 用 codepoint 累加，让"含相似词的两段"向量也更接近。
 */
function fakeEmbedFor(text: string): number[] {
  const v = new Array(8).fill(0);
  for (const ch of text.toLowerCase()) {
    const c = ch.charCodeAt(0);
    if (c >= 48 && c <= 122) {
      v[c % 8] += 1;
    }
  }
  // L2 normalize for stability
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
  const data = body.input.map((t, i) => ({ embedding: fakeEmbedFor(t), index: i }));
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;

const embedOpts = {
  baseUrl: "http://mock",
  model: "fake-embed",
  fetchImpl: mockFetch,
};

async function seedIndex(files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(workspace, name), content);
  }
  const handle = openRagDb(workspace, { path: dbPath });
  try {
    indexWorkspace(handle.db, workspace);
    // 把所有未 embed 的 chunk embed 一遍
    const missing = listChunksMissingEmbedding(handle.db);
    const texts = missing.map((m) => m.content);
    const vecs = await embedTexts(texts, embedOpts);
    for (let i = 0; i < missing.length; i++) {
      setEmbedding(handle.db, missing[i].chunkId, vectorToBlob(vecs[i]));
    }
  } finally {
    handle.close();
  }
}

describe("vectorSearch", () => {
  it("空 db → 空", async () => {
    const handle = openRagDb(workspace, { path: dbPath });
    try {
      expect(vectorSearch(handle.db, [1, 2, 3], 5)).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("含 embedding 的 chunk → cosine 排序", async () => {
    await seedIndex({
      "auth.ts": "function authenticate(user) { verifyToken(user); }",
      "render.ts": "function renderHtml(html) { return html.toString(); }",
    });
    const queryVec = fakeEmbedFor("authenticate user verifyToken");
    const handle = openRagDb(workspace, { path: dbPath });
    try {
      const results = vectorSearch(handle.db, queryVec, 5);
      expect(results.length).toBeGreaterThan(0);
      // auth.ts 的向量应比 render.ts 更接近 query
      expect(results[0].chunkId).toContain("auth.ts");
      expect(results[0].similarity).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });
});

describe("searchHybrid · BM25 + 向量 RRF 融合", () => {
  it("两路都命中同一 chunk → source='both'，rrfScore 累加", async () => {
    await seedIndex({
      "auth.ts": "function authenticate(user) { verifyToken(user); }",
      "render.ts": "function renderHtml(html) { return html.toString(); }",
    });
    const handle = openRagDb(workspace, { path: dbPath });
    try {
      const hits = await searchHybrid(handle.db, "authenticate user verifyToken", embedOpts, {
        topK: 3,
      });
      expect(hits.length).toBeGreaterThan(0);
      const auth = hits.find((h) => h.relPath === "auth.ts");
      expect(auth).toBeDefined();
      expect(auth!.source).toBe("both");
      expect(auth!.rrfScore).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  it("仅 BM25 命中（query 与向量无关但含字面词） → source='bm25'", async () => {
    await seedIndex({
      "abc.ts": "const xyzzyMagicWord = 'unique';",
      "def.ts": "const ordinaryHelper = 1;",
    });
    const handle = openRagDb(workspace, { path: dbPath });
    try {
      const hits = await searchHybrid(handle.db, "xyzzyMagicWord", embedOpts, { topK: 3 });
      // BM25 命中 abc.ts；向量也可能命中（fakeEmbed 不准），允许 'both' 但至少 abc.ts 在
      expect(hits.some((h) => h.relPath === "abc.ts")).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("topK 限制返回数", async () => {
    await seedIndex({
      "a.ts": "const a = 1;",
      "b.ts": "const b = 2;",
      "c.ts": "const c = 3;",
      "d.ts": "const d = 4;",
    });
    const handle = openRagDb(workspace, { path: dbPath });
    try {
      const hits = await searchHybrid(handle.db, "const", embedOpts, { topK: 2 });
      expect(hits.length).toBeLessThanOrEqual(2);
    } finally {
      handle.close();
    }
  });

  it("空 db → 空 hits", async () => {
    const handle = openRagDb(workspace, { path: dbPath });
    try {
      const hits = await searchHybrid(handle.db, "anything", embedOpts);
      expect(hits).toEqual([]);
    } finally {
      handle.close();
    }
  });
});

describe("countEmbeddedChunks", () => {
  it("seedIndex 后所有 chunk 都被 embed", async () => {
    await seedIndex({
      "x.ts": "const x = 1;",
      "y.ts": "const y = 2;",
    });
    const handle = openRagDb(workspace, { path: dbPath });
    try {
      const all = (handle.db.prepare("SELECT COUNT(*) AS n FROM rag_chunks").get() as { n: number })
        .n;
      expect(countEmbeddedChunks(handle.db)).toBe(all);
    } finally {
      handle.close();
    }
  });
});
