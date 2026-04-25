/**
 * /fix v3 W4-02 · detectVerifyCmd 单测
 *
 * 覆盖 package.json 嗅探的全部分支：
 *   - 缺失文件 / 解析失败 / 字段缺失 / 空字符串 / placeholder
 *   - 有效 scripts.test → 返回 "npm test"
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { detectVerifyCmd } from "../../../src/agent/queryEngine";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function mkWorkspace(pkgContent: string | null): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-verify-detect-"));
  tempDirs.push(dir);
  if (pkgContent !== null) {
    writeFileSync(path.join(dir, "package.json"), pkgContent, "utf8");
  }
  return dir;
}

describe("detectVerifyCmd", () => {
  it("有效 scripts.test → 返回 'npm test'", () => {
    const dir = mkWorkspace(JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(detectVerifyCmd(dir)).toBe("npm test");
  });

  it("缺 package.json → null", () => {
    const dir = mkWorkspace(null);
    expect(detectVerifyCmd(dir)).toBeNull();
  });

  it("JSON 解析失败 → null（不抛）", () => {
    const dir = mkWorkspace("{ this is not json");
    expect(detectVerifyCmd(dir)).toBeNull();
  });

  it("无 scripts 字段 → null", () => {
    const dir = mkWorkspace(JSON.stringify({ name: "foo", version: "1.0.0" }));
    expect(detectVerifyCmd(dir)).toBeNull();
  });

  it("scripts 存在但无 test 字段 → null", () => {
    const dir = mkWorkspace(JSON.stringify({ scripts: { build: "tsc" } }));
    expect(detectVerifyCmd(dir)).toBeNull();
  });

  it("scripts.test 是空字符串 → null", () => {
    const dir = mkWorkspace(JSON.stringify({ scripts: { test: "" } }));
    expect(detectVerifyCmd(dir)).toBeNull();
  });

  it("scripts.test 是只含空白的字符串 → null", () => {
    const dir = mkWorkspace(JSON.stringify({ scripts: { test: "   " } }));
    expect(detectVerifyCmd(dir)).toBeNull();
  });

  it("npm init 默认 placeholder → null（避免必败 verify）", () => {
    const dir = mkWorkspace(
      JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      })
    );
    expect(detectVerifyCmd(dir)).toBeNull();
  });

  it("placeholder 大小写不敏感", () => {
    const dir = mkWorkspace(
      JSON.stringify({ scripts: { test: "echo NO TEST SPECIFIED" } })
    );
    expect(detectVerifyCmd(dir)).toBeNull();
  });

  it("scripts.test 是非字符串（数字）→ null", () => {
    const dir = mkWorkspace(JSON.stringify({ scripts: { test: 42 } }));
    expect(detectVerifyCmd(dir)).toBeNull();
  });

  it("scripts.test 是对象 → null", () => {
    const dir = mkWorkspace(
      JSON.stringify({ scripts: { test: { cmd: "vitest" } } })
    );
    expect(detectVerifyCmd(dir)).toBeNull();
  });

  it("workspace 路径不存在 → null（不抛）", () => {
    expect(detectVerifyCmd("/nonexistent/path/codeclaw-fake-12345")).toBeNull();
  });
});
