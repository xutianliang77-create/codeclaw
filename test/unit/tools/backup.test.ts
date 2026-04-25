/**
 * T16 write 备份 · #93 单测
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { backupFileIfExists, defaultBackupRoot, resetBackupBatch } from "../../../src/tools/backup";

const tempDirs: string[] = [];

beforeEach(() => {
  resetBackupBatch();
});

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function setupWorkspace(): { workspace: string; backupRoot: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeclaw-backup-"));
  tempDirs.push(root);
  const workspace = path.join(root, "ws");
  const backupRoot = path.join(root, "backups");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(backupRoot, { recursive: true });
  return { workspace, backupRoot };
}

describe("backupFileIfExists", () => {
  it("文件不存在 → 返回 null（write 是新建语义）", () => {
    const { workspace, backupRoot } = setupWorkspace();
    const target = path.join(workspace, "no-such.txt");
    expect(backupFileIfExists(target, workspace, { backupRoot })).toBeNull();
  });

  it("文件存在 → 拷到 backupRoot/<batch>/<rel>", () => {
    const { workspace, backupRoot } = setupWorkspace();
    const target = path.join(workspace, "code.ts");
    writeFileSync(target, "const x = 1;");
    const dest = backupFileIfExists(target, workspace, { backupRoot });
    expect(dest).not.toBeNull();
    expect(existsSync(dest!)).toBe(true);
    expect(readFileSync(dest!, "utf8")).toBe("const x = 1;");
    expect(dest!.startsWith(backupRoot)).toBe(true);
    expect(dest!).toContain("code.ts");
  });

  it("子目录文件 → backup 路径保留相对结构", () => {
    const { workspace, backupRoot } = setupWorkspace();
    mkdirSync(path.join(workspace, "src", "agent"), { recursive: true });
    const target = path.join(workspace, "src", "agent", "engine.ts");
    writeFileSync(target, "// content");
    const dest = backupFileIfExists(target, workspace, { backupRoot });
    expect(dest).toContain("src/agent/engine.ts");
  });

  it("同 batch 内多次 write 共用同一目录", () => {
    const { workspace, backupRoot } = setupWorkspace();
    const a = path.join(workspace, "a.ts");
    const b = path.join(workspace, "b.ts");
    writeFileSync(a, "A");
    writeFileSync(b, "B");
    const destA = backupFileIfExists(a, workspace, { backupRoot });
    const destB = backupFileIfExists(b, workspace, { backupRoot });
    expect(destA).not.toBeNull();
    expect(destB).not.toBeNull();
    expect(path.dirname(destA!)).toBe(path.dirname(destB!));
  });

  it("resetBackupBatch 后下次 write → 新 batch 目录", () => {
    const { workspace, backupRoot } = setupWorkspace();
    const target = path.join(workspace, "x.ts");
    writeFileSync(target, "x");
    const dest1 = backupFileIfExists(target, workspace, { backupRoot });
    resetBackupBatch();
    // 模拟下一个 batch（用不同 now）
    const dest2 = backupFileIfExists(target, workspace, { backupRoot, now: new Date(Date.now() + 60_000) });
    expect(path.dirname(dest1!)).not.toBe(path.dirname(dest2!));
  });

  it("workspace 外的目标 → backup 路径加 _outside_/ 前缀", () => {
    const { workspace, backupRoot } = setupWorkspace();
    const outside = mkdtempSync(path.join(os.tmpdir(), "codeclaw-outside-"));
    tempDirs.push(outside);
    const target = path.join(outside, "stray.ts");
    writeFileSync(target, "stray");
    const dest = backupFileIfExists(target, workspace, { backupRoot });
    expect(dest).toContain("_outside_");
  });

  it("defaultBackupRoot 指向 ~/.codeclaw/backups", () => {
    const root = defaultBackupRoot();
    expect(root.endsWith(path.join(".codeclaw", "backups"))).toBe(true);
  });
});
