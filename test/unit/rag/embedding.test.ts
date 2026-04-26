/**
 * embedding 模块单测（M4-#75 step c）
 */

import { describe, expect, it } from "vitest";

import {
  blobToVector,
  cosineSimilarity,
  embedTexts,
  vectorToBlob,
} from "../../../src/rag/embedding";

function mockEmbedFetch(vectorPerInput: (text: string) => number[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      input: string[];
      model: string;
    };
    const data = body.input.map((text, index) => ({
      object: "embedding",
      embedding: vectorPerInput(text),
      index,
    }));
    return new Response(JSON.stringify({ object: "list", data, model: body.model }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("embedTexts", () => {
  it("空数组 → 空", async () => {
    const r = await embedTexts([], {
      baseUrl: "http://x",
      model: "m",
      fetchImpl: mockEmbedFetch(() => [0]),
    });
    expect(r).toEqual([]);
  });

  it("批量请求按 input order 返回向量", async () => {
    const vec = await embedTexts(["alpha", "beta", "gamma"], {
      baseUrl: "http://x",
      model: "m",
      fetchImpl: mockEmbedFetch((t) => [t.length, t.charCodeAt(0)]),
    });
    expect(vec).toEqual([
      [5, 97], // alpha
      [4, 98], // beta
      [5, 103], // gamma
    ]);
  });

  it("非 ok 响应抛错", async () => {
    const failFetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      embedTexts(["x"], { baseUrl: "http://x", model: "m", fetchImpl: failFetch })
    ).rejects.toThrow(/embedding request failed/);
  });

  it("响应缺 data 数组抛错", async () => {
    const noData = (async () =>
      new Response(JSON.stringify({ wrong: "shape" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(
      embedTexts(["x"], { baseUrl: "http://x", model: "m", fetchImpl: noData })
    ).rejects.toThrow(/no data array/);
  });

  it("分批：63 行单批，65 行 2 批", async () => {
    const inputs = Array.from({ length: 65 }, (_, i) => `text-${i}`);
    let calls = 0;
    const tracking = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
      const data = body.input.map((_, i) => ({ embedding: [calls, i], index: i }));
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await embedTexts(inputs, {
      baseUrl: "http://x",
      model: "m",
      fetchImpl: tracking,
      batchSize: 64,
    });
    expect(calls).toBe(2); // 64 + 1
  });
});

describe("BLOB 序列化", () => {
  it("vectorToBlob → blobToVector 可逆", () => {
    const v = [0.1, -0.2, 3.14, -1e-5];
    const blob = vectorToBlob(v);
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(blob.byteLength).toBe(v.length * 4);
    const back = blobToVector(blob);
    expect(back).toHaveLength(v.length);
    for (let i = 0; i < v.length; i++) {
      expect(back[i]).toBeCloseTo(v[i], 5); // float32 精度
    }
  });

  it("空向量 → 空 blob → 空向量", () => {
    expect(blobToVector(vectorToBlob([]))).toEqual([]);
  });
});

describe("cosineSimilarity", () => {
  it("相同向量 → 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0);
  });
  it("正交向量 → 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("反向向量 → -1", () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1.0);
  });
  it("零向量 → 0（避免除以 0）", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it("长度不一致 → 0", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});
