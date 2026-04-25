/**
 * fix-scorer 单测
 *   - globMatch 各 case
 *   - runShell 退出码 / stdout 捕获
 *   - inspectDiffScope 在临时 git repo 上构造改动验证
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { globMatch, runShell, inspectDiffScope } from "./fix-scorer";
import type { FixTask } from "./fix-types";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("globMatch", () => {
  it("精确匹配", () => {
    expect(globMatch("app.py", "app.py")).toBe(true);
    expect(globMatch("src/app.py", "app.py")).toBe(false);
  });
  it("* 不跨目录", () => {
    expect(globMatch("foo.json", "*.json")).toBe(true);
    expect(globMatch("a/b.json", "*.json")).toBe(false);
  });
  it("** 跨目录", () => {
    expect(globMatch("src/router.ts", "src/**/*.ts")).toBe(true);
    expect(globMatch("src/lib/foo/bar.ts", "src/**/*.ts")).toBe(true);
    expect(globMatch("test/x.ts", "src/**/*.ts")).toBe(false);
  });
  it("test/** 全子树", () => {
    expect(globMatch("test/a.ts", "test/**")).toBe(true);
    expect(globMatch("test/a/b.ts", "test/**")).toBe(true);
    expect(globMatch("src/test.ts", "test/**")).toBe(false);
  });
  it("test_*.py 顶层", () => {
    expect(globMatch("test_foo.py", "test_*.py")).toBe(true);
    expect(globMatch("a/test_foo.py", "test_*.py")).toBe(false);
  });
});

describe("runShell", () => {
  it("echo → exit 0 + stdout", () => {
    const r = runShell("echo hello", os.tmpdir());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
  });
  it("非零退出码", () => {
    const r = runShell("exit 7", os.tmpdir());
    expect(r.exitCode).toBe(7);
  });
});

function mkGitRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fix-diff-"));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  // 初始结构
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "router.ts"), "const a = 1;\n");
  writeFileSync(path.join(dir, "package.json"), '{"name":"x"}\n');
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function buildTask(overrides?: Partial<FixTask["expected"]>): FixTask {
  return {
    id: "FIX-test",
    version: 1,
    language: "ts",
    workspace: "x",
    setup: { install: "true", verify_broken: "true" },
    prompt: "p",
    expected: {
      post_verify: "true",
      diff_scope: { allow_paths: ["src/**/*.ts"], max_files: 1, max_lines: 10 },
      forbidden_changes: ["package.json", "test/**"],
      time_budget_sec: 60,
      token_budget_usd: 0.1,
      ...overrides,
    },
    category: "test",
    difficulty: "easy",
  } as FixTask;
}

describe("inspectDiffScope", () => {
  it("没改动 → ok=true changedFiles=0", () => {
    const repo = mkGitRepo();
    const task = buildTask();
    const r = inspectDiffScope(task, repo);
    expect(r.ok).toBe(true);
    expect(r.changedFiles).toBe(0);
  });

  it("改 src/router.ts 在 allow_paths 内且行数不超 → ok=true", () => {
    const repo = mkGitRepo();
    writeFileSync(path.join(repo, "src", "router.ts"), "const a = 2;\nconst b = 3;\n");
    const task = buildTask();
    const r = inspectDiffScope(task, repo);
    expect(r.ok).toBe(true);
    expect(r.changedFiles).toBe(1);
    expect(r.changedLines).toBeGreaterThan(0);
  });

  it("改 package.json → forbiddenHit", () => {
    const repo = mkGitRepo();
    writeFileSync(path.join(repo, "package.json"), '{"name":"x","version":"1"}\n');
    const task = buildTask();
    const r = inspectDiffScope(task, repo);
    expect(r.ok).toBe(false);
    expect(r.forbiddenHit).toContain("package.json");
  });

  it("改 docs/x.md（不在 allow_paths）→ outsideAllowed", () => {
    const repo = mkGitRepo();
    mkdirSync(path.join(repo, "docs"), { recursive: true });
    writeFileSync(path.join(repo, "docs", "x.md"), "hi\n");
    spawnSync("git", ["add", "."], { cwd: repo });
    const task = buildTask();
    const r = inspectDiffScope(task, repo);
    expect(r.ok).toBe(false);
    expect(r.outsideAllowed).toContain("docs/x.md");
  });

  it("超 max_lines → exceedMaxLines=true", () => {
    const repo = mkGitRepo();
    const big = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n";
    writeFileSync(path.join(repo, "src", "router.ts"), big);
    const task = buildTask({ diff_scope: { allow_paths: ["src/**/*.ts"], max_files: 1, max_lines: 5 } });
    const r = inspectDiffScope(task, repo);
    expect(r.ok).toBe(false);
    expect(r.exceedMaxLines).toBe(true);
  });

  it("超 max_files → exceedMaxFiles=true", () => {
    const repo = mkGitRepo();
    writeFileSync(path.join(repo, "src", "router.ts"), "const a = 2;\n");
    writeFileSync(path.join(repo, "src", "router2.ts"), "const b = 3;\n");
    spawnSync("git", ["add", "."], { cwd: repo });
    const task = buildTask({ diff_scope: { allow_paths: ["src/**/*.ts"], max_files: 1, max_lines: 100 } });
    const r = inspectDiffScope(task, repo);
    expect(r.ok).toBe(false);
    expect(r.exceedMaxFiles).toBe(true);
  });
});
