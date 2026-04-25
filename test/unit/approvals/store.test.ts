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
  it("W3-03：同 root 共享 data.db 时，传 sessionId 后两 session 完全隔离", () => {
    // approvalsDir 不同但同 root → 物理上仍共享 data.db；W3-03 的修法是按 sessionId 过滤，
    // 让它们逻辑上隔离不互相覆盖。
    const dirA = makeApprovalsDir("approvals-A");
    const dirB = makeApprovalsDir("approvals-B");
    savePendingApprovals(
      dirA,
      [sampleApproval({ id: "from-A", sessionId: "sess-A" })],
      { sessionId: "sess-A" }
    );
    savePendingApprovals(
      dirB,
      [sampleApproval({ id: "from-B", sessionId: "sess-B" })],
      { sessionId: "sess-B" }
    );

    // sess-A 视角：只看到自己那条；sess-B 同理
    expect(loadPendingApprovals(dirA, { sessionId: "sess-A" }).map((a) => a.id)).toEqual([
      "from-A",
    ]);
    expect(loadPendingApprovals(dirB, { sessionId: "sess-B" }).map((a) => a.id)).toEqual([
      "from-B",
    ]);
    // 不传 sessionId 看全集：两条都能看到（共用 db 的物理事实，未变）
    expect(loadPendingApprovals(dirA).map((a) => a.id).sort()).toEqual(["from-A", "from-B"]);
  });

  it("W3-03：sessionId 自动从 list 推断（list 内全部同 session 时）", () => {
    const dirA = makeApprovalsDir("approvals-A");
    const dirB = makeApprovalsDir("approvals-B");
    // 没显式传 options.sessionId，但 list 里所有 approvals 都 sessionId='auto-A' → 自动按它过滤
    savePendingApprovals(dirA, [
      sampleApproval({ id: "auto-A-1", sessionId: "auto-A" }),
      sampleApproval({ id: "auto-A-2", sessionId: "auto-A" }),
    ]);
    savePendingApprovals(dirB, [sampleApproval({ id: "auto-B-1", sessionId: "auto-B" })]);

    expect(loadPendingApprovals(dirA, { sessionId: "auto-A" }).map((a) => a.id)).toEqual([
      "auto-A-1",
      "auto-A-2",
    ]);
    expect(loadPendingApprovals(dirB, { sessionId: "auto-B" }).map((a) => a.id)).toEqual([
      "auto-B-1",
    ]);
  });

  it("W3-03：clearPendingApprovals 按 sessionId 只清自己的", () => {
    const dir = makeApprovalsDir("approvals");
    savePendingApprovals(
      dir,
      [sampleApproval({ id: "A-keep", sessionId: "sess-A" })],
      { sessionId: "sess-A" }
    );
    savePendingApprovals(
      dir,
      [sampleApproval({ id: "B-clear", sessionId: "sess-B" })],
      { sessionId: "sess-B" }
    );
    clearPendingApprovals(dir, { sessionId: "sess-B" });

    expect(loadPendingApprovals(dir).map((a) => a.id)).toEqual(["A-keep"]);
  });

  it("不传 sessionId 时退回老行为（全删 / 全 load）", () => {
    const dir = makeApprovalsDir("approvals");
    savePendingApprovals(dir, [sampleApproval({ id: "X", sessionId: "sess-A" })], {
      sessionId: "sess-A",
    });
    savePendingApprovals(dir, [sampleApproval({ id: "Y", sessionId: "sess-B" })], {
      sessionId: "sess-B",
    });
    // 现在 db 里有两条
    expect(loadPendingApprovals(dir)).toHaveLength(2);
    // 不传 sessionId 的 clear → 全删
    clearPendingApprovals(dir);
    expect(loadPendingApprovals(dir)).toHaveLength(0);
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
