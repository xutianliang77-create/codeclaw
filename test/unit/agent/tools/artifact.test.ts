/**
 * v0.8.1 #3 · artifact 兜底单测
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { wrapToolResult, readArtifact } from "../../../../src/agent/tools/artifact";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = path.join(
    os.tmpdir(),
    `codeclaw-artifact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("wrapToolResult", () => {
  it("≤ 4KB 原样返回（无 artifact 落盘）", () => {
    const env = wrapToolResult("hello world", "sess-1", "call-1", { artifactsRoot: tmpRoot });
    expect(env.summary).toBe("hello world");
    expect(env.artifactPath).toBeUndefined();
    expect(env.truncatedBytes).toBeUndefined();
  });

  it("> 4KB 落盘 + 摘要含头/尾/hint", () => {
    const head = "HEADHEAD".repeat(300); // 2400 bytes
    const middle = "MIDDLE".repeat(2000); // 12000 bytes
    const tail = "TAILTAIL".repeat(300); // 2400 bytes
    const raw = head + middle + tail;
    const env = wrapToolResult(raw, "sess-2", "call-2", { artifactsRoot: tmpRoot });
    expect(env.artifactPath).toBeDefined();
    expect(env.truncatedBytes).toBe(Buffer.byteLength(raw, "utf8"));
    expect(env.summary).toContain("HEADHEAD");
    expect(env.summary).toContain("TAILTAIL");
    expect(env.summary).toContain("[TRUNCATED");
    expect(env.summary).toContain("read_artifact");
    expect(existsSync(env.artifactPath!)).toBe(true);
  });

  it("artifact 文件名清洗特殊字符", () => {
    const raw = "x".repeat(10_000);
    const env = wrapToolResult(raw, "sess/with:bad*chars", "call!#$%", {
      artifactsRoot: tmpRoot,
    });
    expect(env.artifactPath).toBeDefined();
    // 清洗后路径应该不含 / 之外的特殊字符（除了路径分隔符自己）
    const fileName = path.basename(env.artifactPath!);
    expect(fileName).toMatch(/^[a-zA-Z0-9_.-]+$/);
  });
});

describe("readArtifact", () => {
  it("读全文（默认 limit）", () => {
    const f = path.join(tmpRoot, "x.txt");
    writeFileSync(f, "ABCDE");
    expect(readArtifact(f, { artifactsRoot: tmpRoot })).toBe("ABCDE");
  });

  it("offset + limit 取段", () => {
    const f = path.join(tmpRoot, "x.txt");
    writeFileSync(f, "ABCDEFGHIJ");
    expect(readArtifact(f, { artifactsRoot: tmpRoot, offset: 2, limit: 3 })).toBe("CDE");
  });

  it("path-traversal 防御：拒绝读 root 之外的文件", () => {
    const outside = path.join(tmpRoot, "..", "outside.txt");
    expect(() => readArtifact(outside, { artifactsRoot: tmpRoot })).toThrow(
      /refuse to read outside/
    );
  });

  it("不存在 → throw", () => {
    expect(() =>
      readArtifact(path.join(tmpRoot, "missing.txt"), { artifactsRoot: tmpRoot })
    ).toThrow(/not found/);
  });
});

describe("integration · wrap → read_artifact", () => {
  it("落盘后用 readArtifact 能取回完整原文", () => {
    const raw = "L".repeat(8000);
    const env = wrapToolResult(raw, "sess-x", "call-x", { artifactsRoot: tmpRoot });
    expect(env.artifactPath).toBeDefined();
    const restored = readArtifact(env.artifactPath!, { artifactsRoot: tmpRoot, limit: 8000 });
    expect(restored).toBe(raw);
  });
});
