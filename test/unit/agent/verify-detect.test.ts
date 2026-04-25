/**
 * /fix v3 W4-02/03 · detectVerifyCmd 单测
 *
 * 覆盖：
 *   - npm（package.json）：缺失/解析失败/字段缺失/placeholder/类型错/有效
 *   - pytest（pyproject.toml | pytest.ini）：单独命中
 *   - cargo（Cargo.toml）：命中
 *   - go（go.mod）：命中
 *   - 优先级：npm > pytest > cargo > go（polyglot 仓库取最高优先）
 *   - 全空目录：null
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

/** 创建空 workspace 后随手撒几个标志文件（多语言探测用） */
function mkEmpty(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-verify-multi-"));
  tempDirs.push(dir);
  return dir;
}

function touch(dir: string, name: string, content = ""): void {
  writeFileSync(path.join(dir, name), content, "utf8");
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

  // ───── W4-03 多语言探测 ─────

  it("Python · pyproject.toml → pytest", () => {
    const dir = mkEmpty();
    touch(dir, "pyproject.toml", "[project]\nname='x'\n");
    expect(detectVerifyCmd(dir)).toBe("pytest");
  });

  it("Python · pytest.ini → pytest", () => {
    const dir = mkEmpty();
    touch(dir, "pytest.ini", "[pytest]\n");
    expect(detectVerifyCmd(dir)).toBe("pytest");
  });

  it("Rust · Cargo.toml → cargo test", () => {
    const dir = mkEmpty();
    touch(dir, "Cargo.toml", "[package]\nname='x'\n");
    expect(detectVerifyCmd(dir)).toBe("cargo test");
  });

  it("Go · go.mod → go test ./...", () => {
    const dir = mkEmpty();
    touch(dir, "go.mod", "module example.com/x\n");
    expect(detectVerifyCmd(dir)).toBe("go test ./...");
  });

  it("空目录 → null", () => {
    expect(detectVerifyCmd(mkEmpty())).toBeNull();
  });

  // ───── 优先级测试（polyglot 仓库）─────

  it("优先级：npm > pytest（同时存在 package.json 与 pyproject.toml）", () => {
    const dir = mkEmpty();
    touch(dir, "package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    touch(dir, "pyproject.toml", "[project]\n");
    expect(detectVerifyCmd(dir)).toBe("npm test");
  });

  it("优先级：pytest > cargo（pyproject.toml 与 Cargo.toml 共存）", () => {
    const dir = mkEmpty();
    touch(dir, "pyproject.toml", "[project]\n");
    touch(dir, "Cargo.toml", "[package]\n");
    expect(detectVerifyCmd(dir)).toBe("pytest");
  });

  it("优先级：cargo > go（Cargo.toml 与 go.mod 共存）", () => {
    const dir = mkEmpty();
    touch(dir, "Cargo.toml", "[package]\n");
    touch(dir, "go.mod", "module x\n");
    expect(detectVerifyCmd(dir)).toBe("cargo test");
  });

  it("npm placeholder 不阻塞 fallback：placeholder 时让 pytest 接手", () => {
    const dir = mkEmpty();
    touch(
      dir,
      "package.json",
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })
    );
    touch(dir, "pyproject.toml", "[project]\n");
    expect(detectVerifyCmd(dir)).toBe("pytest");
  });
});
