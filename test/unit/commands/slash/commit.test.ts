/**
 * /commit (read-only preview) 单测
 *
 * 在临时 git repo 里建一些变更，跑 builtin handler，检查输出。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import commitCommand from "../../../../src/commands/slash/builtins/commit";

let tmpRoot: string;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).toString();
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "codeclaw-commit-test-"));
  // init repo
  git(["init", "-q", "--initial-branch=main"], tmpRoot);
  git(["config", "user.email", "test@example.com"], tmpRoot);
  git(["config", "user.name", "Test User"], tmpRoot);
  writeFileSync(path.join(tmpRoot, "README.md"), "# initial\n");
  git(["add", "."], tmpRoot);
  git(["commit", "-q", "-m", "initial"], tmpRoot);
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("/commit · clean working tree", () => {
  it("reports nothing-to-commit", async () => {
    const result = await commitCommand.handler({
      rawPrompt: "/commit",
      commandName: "/commit",
      argsRaw: "",
      argv: [],
      queryEngine: { getWorkspaceRoot: () => tmpRoot },
    });
    if (result.kind !== "reply") throw new Error("expected reply");
    expect(result.text).toContain("working tree clean");
    expect(result.text).toContain("branch:");
  });
});

describe("/commit · with pending changes", () => {
  it("shows status entries and diff stat", async () => {
    writeFileSync(path.join(tmpRoot, "new-file.ts"), "export const x = 1;\n");
    writeFileSync(path.join(tmpRoot, "README.md"), "# changed\n");

    const result = await commitCommand.handler({
      rawPrompt: "/commit",
      commandName: "/commit",
      argsRaw: "",
      argv: [],
      queryEngine: { getWorkspaceRoot: () => tmpRoot },
    });
    if (result.kind !== "reply") throw new Error("expected reply");
    expect(result.text).toContain("Commit preview");
    expect(result.text).toContain("git status --porcelain");
    expect(result.text).toContain("README.md");
    expect(result.text).toContain("new-file.ts");
  });
});

describe("/commit · not a git repo", () => {
  it("returns a clear unavailable message", async () => {
    const nonRepo = mkdtempSync(path.join(os.tmpdir(), "codeclaw-no-git-"));
    try {
      const result = await commitCommand.handler({
        rawPrompt: "/commit",
        commandName: "/commit",
        argsRaw: "",
        argv: [],
        queryEngine: { getWorkspaceRoot: () => nonRepo },
      });
      if (result.kind !== "reply") throw new Error("expected reply");
      expect(result.text).toContain("commit preview unavailable");
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("/commit metadata", () => {
  it("declares low risk and workflow category", () => {
    expect(commitCommand.category).toBe("workflow");
    expect(commitCommand.risk).toBe("low");
    expect(commitCommand.helpDetail).toContain("Read-only preview");
  });
});
