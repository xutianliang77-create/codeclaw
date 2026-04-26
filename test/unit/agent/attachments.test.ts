/**
 * 附件文本提取单测（M2-05）
 *
 * 覆盖 spec §8.4 + patch 后版本：
 *   - .txt / .md / .csv 读 utf8
 *   - .pdf 通过 pdf-parse import（PoC 已验证 ESM 默认 import 可用）
 *   - 不存在 / 读失败：返 marker 不抛
 *   - > 1MB 截断 + 末尾 "...[truncated at 1048576 bytes]"
 *   - 不支持扩展名（.xlsx）→ marker
 *   - 异常 PDF（合成 buffer）→ "[pdf parse failed: ...]" 不抛
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  MAX_ATTACHMENT_BYTES,
  PDF_PARSE_TIMEOUT_MS,
  extractAttachmentText,
} from "../../../src/agent/attachments/extract";

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `att-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("extractAttachmentText", () => {
  it(".txt utf8 解码", async () => {
    const p = path.join(tmpDir, "hello.txt");
    writeFileSync(p, "你好 hello world");
    const text = await extractAttachmentText(p);
    expect(text).toBe("你好 hello world");
  });

  it(".md 文本读取", async () => {
    const p = path.join(tmpDir, "doc.md");
    writeFileSync(p, "# Title\n\ncontent");
    const text = await extractAttachmentText(p);
    expect(text).toContain("# Title");
    expect(text).toContain("content");
  });

  it(".csv 逐行返回（utf8）", async () => {
    const p = path.join(tmpDir, "data.csv");
    writeFileSync(p, "a,b,c\n1,2,3\n4,5,6");
    const text = await extractAttachmentText(p);
    expect(text).toContain("a,b,c");
    expect(text).toContain("4,5,6");
  });

  it("常见代码扩展（.ts/.py/.go/.rs）走文本", async () => {
    for (const ext of [".ts", ".py", ".go", ".rs"]) {
      const p = path.join(tmpDir, `code${ext}`);
      writeFileSync(p, `code-content-${ext}`);
      const text = await extractAttachmentText(p);
      expect(text).toBe(`code-content-${ext}`);
    }
  });

  it("> 1MB 截断 + truncated marker", async () => {
    const p = path.join(tmpDir, "big.txt");
    const huge = "x".repeat(MAX_ATTACHMENT_BYTES + 1000);
    writeFileSync(p, huge);
    const text = await extractAttachmentText(p);
    expect(text.length).toBeGreaterThan(MAX_ATTACHMENT_BYTES);
    expect(text).toContain(`...[truncated at ${MAX_ATTACHMENT_BYTES} bytes]`);
    // 内容前 1MB 是原始数据（不是 marker）
    expect(text.slice(0, MAX_ATTACHMENT_BYTES)).toBe("x".repeat(MAX_ATTACHMENT_BYTES));
  });

  it("不支持扩展名（.xlsx）→ marker", async () => {
    const p = path.join(tmpDir, "data.xlsx");
    writeFileSync(p, "fake binary");
    const text = await extractAttachmentText(p);
    expect(text).toBe("[unsupported attachment type: .xlsx]");
  });

  it("无扩展名（.foo 不存在）→ unsupported marker", async () => {
    const p = path.join(tmpDir, "noext");
    writeFileSync(p, "data");
    const text = await extractAttachmentText(p);
    expect(text).toBe("[unsupported attachment type: (none)]");
  });

  it("不存在文件 → marker 不抛", async () => {
    const text = await extractAttachmentText(path.join(tmpDir, "ghost.txt"));
    expect(text).toContain("attachment read failed");
  });

  it("异常 PDF buffer → '[pdf parse failed: ...]' 不抛", async () => {
    const p = path.join(tmpDir, "bad.pdf");
    writeFileSync(p, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x33, 0x0a])); // 仅 %PDF-1.3\n
    const text = await extractAttachmentText(p);
    expect(text).toMatch(/pdf parse failed/);
  });

  it("常量 export 一致", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(1048576);
    expect(PDF_PARSE_TIMEOUT_MS).toBe(5000);
  });
});
