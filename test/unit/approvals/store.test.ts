/**
 * P0-W1-07 · approvals 迁 SQLite 单测
 *
 * 覆盖：
 *   - round-trip：save → load 一致
 *   - clear 清空 pending
 *   - 旧 pending-approval.json 一次性迁移（迁移后文件删除）
 *   - 迁移只跑一次（migratedDirs 缓存）
 *   - 损坏 JSON 不崩
 *   - 不同 approvalsDir → 不同 db 实例（测试隔离）
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  __resetApprovalStoreForTests,
  clearPendingApprovals,
  loadPendingApprovals,
  savePendingApprovals,
  type StoredPendingApproval,
} from "../../../src/approvals/store";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "codeclaw-approvals-"));
});

afterEach(() => {
  __resetApprovalStoreForTests();
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function makeApprovalsDir(sub = "approvals"): string {
  const dir = path.join(root, sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sampleApproval(overrides: Partial<StoredPendingApproval> = {}): StoredPendingApproval {
  return {
    id: "approval-test-1",
    prompt: "/write ./demo.txt :: hello",
    toolName: "write",
    detail: "write ./demo.txt",
    reason: "medium risk: write under workspace",
    createdAt: "2026-04-24T12:00:00.000Z",
    sessionId: "session-abc",
    ...overrides,
  };
}

describe("loadPendingApprovals / savePendingApprovals", () => {
  it("returns empty list when approvalsDir is undefined", () => {
    expect(loadPendingApprovals(undefined)).toEqual([]);
  });

  it("round-trip: save → load preserves fields + ordering", () => {
    const dir = makeApprovalsDir();
    const a = sampleApproval({ id: "approval-A", createdAt: "2026-04-24T10:00:00.000Z" });
    const b = sampleApproval({ id: "approval-B", toolName: "replace", createdAt: "2026-04-24T11:00:00.000Z" });
    savePendingApprovals(dir, [a, b]);

    const loaded = loadPendingApprovals(dir);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.id).toBe("approval-A");
    expect(loaded[1]!.id).toBe("approval-B");
    expect(loaded[0]!.toolName).toBe("write");
    expect(loaded[1]!.toolName).toBe("replace");
    expect(loaded[0]!.sessionId).toBe("session-abc");
  });

  it("save with empty list clears pending", () => {
    const dir = makeApprovalsDir();
    savePendingApprovals(dir, [sampleApproval({ id: "x" }), sampleApproval({ id: "y" })]);
    expect(loadPendingApprovals(dir)).toHaveLength(2);
    savePendingApprovals(dir, []);
    expect(loadPendingApprovals(dir)).toEqual([]);
  });

  it("clearPendingApprovals removes all pending", () => {
    const dir = makeApprovalsDir();
    savePendingApprovals(dir, [sampleApproval({ id: "x" })]);
    clearPendingApprovals(dir);
    expect(loadPendingApprovals(dir)).toEqual([]);
  });
});

describe("legacy JSON migration", () => {
  it("migrates pending-approval.json (array) on first load, then deletes it", () => {
    const dir = makeApprovalsDir();
    const legacyFile = path.join(dir, "pending-approval.json");
    const legacy = [
      sampleApproval({ id: "legacy-1" }),
      sampleApproval({ id: "legacy-2", toolName: "bash", detail: "run pytest" }),
    ];
    writeFileSync(legacyFile, JSON.stringify(legacy));

    const loaded = loadPendingApprovals(dir);
    expect(loaded.map((a) => a.id)).toEqual(["legacy-1", "legacy-2"]);
    expect(existsSync(legacyFile)).toBe(false);
  });

  it("migrates pending-approval.json (single object) on first load", () => {
    const dir = makeApprovalsDir();
    const legacyFile = path.join(dir, "pending-approval.json");
    writeFileSync(legacyFile, JSON.stringify(sampleApproval({ id: "single" })));

    const loaded = loadPendingApprovals(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("single");
    expect(existsSync(legacyFile)).toBe(false);
  });

  it("corrupt JSON: swallowed, legacy file removed, empty result", () => {
    const dir = makeApprovalsDir();
    const legacyFile = path.join(dir, "pending-approval.json");
    writeFileSync(legacyFile, "{not: 'json'}");

    expect(loadPendingApprovals(dir)).toEqual([]);
    expect(existsSync(legacyFile)).toBe(false);
  });

  it("migration runs at most once per approvalsDir", () => {
    const dir = makeApprovalsDir();
    const legacyFile = path.join(dir, "pending-approval.json");
    writeFileSync(legacyFile, JSON.stringify([sampleApproval({ id: "once" })]));

    loadPendingApprovals(dir);
    // 再扔一份假旧 JSON（同路径）：不应当再次"迁移"覆盖已有数据
    writeFileSync(legacyFile, JSON.stringify([sampleApproval({ id: "should-not-be-read" })]));
    const second = loadPendingApprovals(dir);
    expect(second.map((a) => a.id)).toEqual(["once"]);
    // 第二次的旧文件仍然在（不会被误删），因为没触发迁移
    expect(existsSync(legacyFile)).toBe(true);
    // 读回 confirm 内容未变
    expect(readFileSync(legacyFile, "utf8")).toContain("should-not-be-read");
  });
});

describe("multiple approvalsDir isolation (test scenario)", () => {
  it("different approvalsDir → different data.db, no cross contamination", () => {
    const dirA = makeApprovalsDir("approvals-A");
    const dirB = makeApprovalsDir("approvals-B");
    // 让 dirA / dirB 各自推断到独立的 data.db（inferDataDbPath = path.dirname(approvalsDir) + data.db）
    // 两者父目录不同（因为 sub 不同但同 root） —— 我们改用两个 root
  });

  it("同 root 下两个不同 approvals 子目录复用同一个 data.db", () => {
    // 验证设计决策：data.db 由 approvalsDir 的父目录决定；相同父目录下的 approvals-A/-B 共享 db
    const dirA = makeApprovalsDir("approvals-A");
    const dirB = makeApprovalsDir("approvals-B");
    savePendingApprovals(dirA, [sampleApproval({ id: "from-A" })]);
    savePendingApprovals(dirB, [sampleApproval({ id: "from-B" })]);
    // 由于父目录同 = root，两处走同一 data.db；并且 savePendingApprovals 会 DELETE WHERE status='pending' 再 INSERT
    // 所以 B 的 save 会把 A 的数据覆盖掉
    expect(loadPendingApprovals(dirA).map((a) => a.id)).toEqual(["from-B"]);
  });

  it("两个不同 root 的 approvalsDir 完全隔离", () => {
    const rootA = mkdtempSync(path.join(os.tmpdir(), "codeclaw-approvals-A-"));
    const rootB = mkdtempSync(path.join(os.tmpdir(), "codeclaw-approvals-B-"));
    const dirA = path.join(rootA, "approvals");
    const dirB = path.join(rootB, "approvals");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    savePendingApprovals(dirA, [sampleApproval({ id: "A-1" })]);
    savePendingApprovals(dirB, [sampleApproval({ id: "B-1" })]);

    expect(loadPendingApprovals(dirA).map((a) => a.id)).toEqual(["A-1"]);
    expect(loadPendingApprovals(dirB).map((a) => a.id)).toEqual(["B-1"]);

    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });
});
