/**
 * RAG chunker 单测（M4-#75 step a）
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  chunkFile,
  chunkId,
  shouldSkipDir,
  isPathInWorkspace,
  SKIPPED_DIRECTORIES,
} from "../../../src/rag/chunker";

let tmp: string;
beforeEach(() => {
  tmp = path.join(os.tmpdir(), `rag-chunk-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("chunkFile", () => {
  it("空文件 → []", () => {
    const p = path.join(tmp, "empty.txt");
    writeFileSync(p, "");
    expect(chunkFile(p, "empty.txt")).toEqual([]);
  });

  it("短文件 → 1 chunk", () => {
    const p = path.join(tmp, "small.ts");
    writeFileSync(p, "const a = 1;\nconst b = 2;\n");
    const chunks = chunkFile(p, "small.ts");
    expect(chunks.length).toBe(1);
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].content).toContain("const a = 1");
  });

  it("长文件 → 多 chunk + overlap", () => {
    const lines: string[] = [];
    for (let i = 0; i < 80; i++) lines.push(`line-${i}`);
    const p = path.join(tmp, "long.txt");
    writeFileSync(p, lines.join("\n"));
    const chunks = chunkFile(p, "long.txt", { chunkLines: 30, overlapLines: 5 });
    // 80 lines, step = 25 (chunkLines - overlap)。chunks 起点 1, 26, 51；
    // i=50 时 slice(50,80) 已吃完所有 line → break。所以 3 chunks（不是 4）。
    expect(chunks.length).toBe(3);
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[1].lineStart).toBe(26);
    expect(chunks[2].lineStart).toBe(51);
    // overlap：chunk[0] 含 line-0~29，chunk[1] 含 line-25~54
    expect(chunks[0].content).toContain("line-25");
    expect(chunks[1].content).toContain("line-25");
  });

  it("binary 文件（含 NUL）→ []", () => {
    const p = path.join(tmp, "bin.bin");
    writeFileSync(p, Buffer.from([0x01, 0x00, 0x02, 0x03]));
    expect(chunkFile(p, "bin.bin")).toEqual([]);
  });

  it("> 500KB 文件 → []", () => {
    const p = path.join(tmp, "huge.txt");
    writeFileSync(p, "x".repeat(600 * 1024));
    expect(chunkFile(p, "huge.txt")).toEqual([]);
  });

  it("不存在文件 → []", () => {
    expect(chunkFile(path.join(tmp, "no.txt"), "no.txt")).toEqual([]);
  });

  it("contentHash 同内容 → 同 hash；不同内容 → 不同 hash", () => {
    const a = path.join(tmp, "a.txt");
    const b = path.join(tmp, "b.txt");
    writeFileSync(a, "line1\nline2\nline3");
    writeFileSync(b, "line1\nline2\nline3");
    const ca = chunkFile(a, "a.txt");
    const cb = chunkFile(b, "b.txt");
    expect(ca[0].contentHash).toBe(cb[0].contentHash);

    writeFileSync(b, "line1\nline2\nline-DIFFERENT");
    const cb2 = chunkFile(b, "b.txt");
    expect(cb2[0].contentHash).not.toBe(ca[0].contentHash);
  });
});

describe("chunkId", () => {
  it("path:line", () => {
    expect(chunkId({ relPath: "src/foo.ts", lineStart: 42 })).toBe("src/foo.ts:42");
  });
});

describe("shouldSkipDir", () => {
  it("黑名单目录 → true", () => {
    for (const name of SKIPPED_DIRECTORIES) {
      expect(shouldSkipDir(name)).toBe(true);
    }
  });

  it("隐藏目录 → true", () => {
    expect(shouldSkipDir(".git")).toBe(true);
    expect(shouldSkipDir(".hidden")).toBe(true);
  });

  it("普通目录 → false", () => {
    expect(shouldSkipDir("src")).toBe(false);
    expect(shouldSkipDir("test")).toBe(false);
  });
});

describe("isPathInWorkspace", () => {
  it("workspace 自身 + 子路径 → true", () => {
    expect(isPathInWorkspace("/work", "/work")).toBe(true);
    expect(isPathInWorkspace("/work/src/a.ts", "/work")).toBe(true);
  });
  it("外部路径 → false", () => {
    expect(isPathInWorkspace("/elsewhere/x", "/work")).toBe(false);
    // 防 prefix 误匹配
    expect(isPathInWorkspace("/work2/x", "/work")).toBe(false);
  });
});
