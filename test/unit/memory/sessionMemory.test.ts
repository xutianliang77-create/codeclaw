/**
 * L2 Session Memory · store + recaller 单测
 *
 * 阶段 A 覆盖：纯数据层，不接 LLM。
 * 用临时 mkdtemp + 真实 sqlite + migrations 跑过 002_session_memory，
 * 验证 save / load / forget / recall 全闭环。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";

import { openDataDb } from "../../../src/storage/db";
import {
  forgetMemoryDigests,
  loadDigestsBySession,
  loadRecentDigests,
  saveMemoryDigest,
  type MemoryDigest,
} from "../../../src/memory/sessionMemory/store";
import {
  buildRecallSystemMessage,
  recallRecent,
} from "../../../src/memory/sessionMemory/recaller";

const tempDirs: string[] = [];
let db: Database.Database;
let dbPath: string;

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-sessmem-"));
  tempDirs.push(dir);
  dbPath = path.join(dir, "data.db");
  db = openDataDb({ path: dbPath, singleton: false }).db;
  // 单测只验 store/recaller 行为，关闭 FK 让 sessionId 不必先建 sessions 行
  db.pragma("foreign_keys = OFF");
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeDigest(overrides: Partial<MemoryDigest> = {}): MemoryDigest {
  return {
    digestId: `d-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "s-test",
    channel: "cli",
    userId: "alice",
    summary: "测试摘要内容",
    messageCount: 10,
    tokenEstimate: 100,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("store · saveMemoryDigest / loadRecentDigests", () => {
  it("save → load 单条", () => {
    const d = makeDigest({ summary: "用户讨论了 audit 链问题" });
    saveMemoryDigest(db, d);
    const loaded = loadRecentDigests(db, "cli", "alice");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].summary).toBe("用户讨论了 audit 链问题");
    expect(loaded[0].digestId).toBe(d.digestId);
  });

  it("空表返回空数组", () => {
    expect(loadRecentDigests(db, "cli", "nobody")).toEqual([]);
  });

  it("按 created_at 倒序", () => {
    saveMemoryDigest(db, makeDigest({ digestId: "d1", summary: "old", createdAt: 1000 }));
    saveMemoryDigest(db, makeDigest({ digestId: "d2", summary: "new", createdAt: 3000 }));
    saveMemoryDigest(db, makeDigest({ digestId: "d3", summary: "mid", createdAt: 2000 }));
    const loaded = loadRecentDigests(db, "cli", "alice");
    expect(loaded.map((d) => d.summary)).toEqual(["new", "mid", "old"]);
  });

  it("limit 参数生效", () => {
    for (let i = 0; i < 8; i++) {
      saveMemoryDigest(db, makeDigest({ digestId: `d${i}`, createdAt: i * 1000 }));
    }
    expect(loadRecentDigests(db, "cli", "alice", 3)).toHaveLength(3);
    expect(loadRecentDigests(db, "cli", "alice", 100)).toHaveLength(8);
  });

  it("跨用户隔离", () => {
    saveMemoryDigest(db, makeDigest({ digestId: "a1", userId: "alice", summary: "alice" }));
    saveMemoryDigest(db, makeDigest({ digestId: "b1", userId: "bob", summary: "bob" }));
    expect(loadRecentDigests(db, "cli", "alice").map((d) => d.summary)).toEqual(["alice"]);
    expect(loadRecentDigests(db, "cli", "bob").map((d) => d.summary)).toEqual(["bob"]);
  });

  it("跨 channel 隔离（同 user 不同 channel）", () => {
    saveMemoryDigest(db, makeDigest({ digestId: "c1", channel: "cli", summary: "cli msg" }));
    saveMemoryDigest(db, makeDigest({ digestId: "w1", channel: "wechat", summary: "wechat msg" }));
    expect(loadRecentDigests(db, "cli", "alice").map((d) => d.summary)).toEqual(["cli msg"]);
    expect(loadRecentDigests(db, "wechat", "alice").map((d) => d.summary)).toEqual(["wechat msg"]);
  });

  it("INSERT OR REPLACE：同 digestId 覆盖", () => {
    saveMemoryDigest(db, makeDigest({ digestId: "same", summary: "old" }));
    saveMemoryDigest(db, makeDigest({ digestId: "same", summary: "new" }));
    const loaded = loadRecentDigests(db, "cli", "alice");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].summary).toBe("new");
  });
});

describe("store · loadDigestsBySession", () => {
  it("按 session_id 拉所有摘要", () => {
    saveMemoryDigest(db, makeDigest({ digestId: "x1", sessionId: "s1", createdAt: 1000 }));
    saveMemoryDigest(db, makeDigest({ digestId: "x2", sessionId: "s1", createdAt: 2000 }));
    saveMemoryDigest(db, makeDigest({ digestId: "x3", sessionId: "s2", createdAt: 1500 }));
    expect(loadDigestsBySession(db, "s1")).toHaveLength(2);
    expect(loadDigestsBySession(db, "s2")).toHaveLength(1);
    expect(loadDigestsBySession(db, "nonexistent")).toEqual([]);
  });
});

describe("store · forgetMemoryDigests", () => {
  beforeEach(() => {
    saveMemoryDigest(db, makeDigest({ digestId: "d1", sessionId: "s1", createdAt: 1000 }));
    saveMemoryDigest(db, makeDigest({ digestId: "d2", sessionId: "s1", createdAt: 2000 }));
    saveMemoryDigest(db, makeDigest({ digestId: "d3", sessionId: "s2", createdAt: 3000 }));
    saveMemoryDigest(db, makeDigest({ digestId: "d4", sessionId: "s3", createdAt: 4000 }));
  });

  it("--all 全清", () => {
    expect(forgetMemoryDigests(db, { all: true })).toBe(4);
    expect(loadRecentDigests(db, "cli", "alice")).toEqual([]);
  });

  it("--sessionId 只清指定 session", () => {
    expect(forgetMemoryDigests(db, { sessionId: "s1" })).toBe(2);
    expect(loadRecentDigests(db, "cli", "alice")).toHaveLength(2);
  });

  it("--since 删除 created_at < 阈值的", () => {
    expect(forgetMemoryDigests(db, { since: 2500 })).toBe(2); // d1=1000, d2=2000
    const remaining = loadRecentDigests(db, "cli", "alice");
    expect(remaining.map((d) => d.digestId).sort()).toEqual(["d3", "d4"]);
  });

  it("空 opts 不删任何", () => {
    expect(forgetMemoryDigests(db, {})).toBe(0);
    expect(loadRecentDigests(db, "cli", "alice")).toHaveLength(4);
  });

  it("优先级：all > sessionId > since", () => {
    // 三者都给时取 all
    expect(
      forgetMemoryDigests(db, { all: true, sessionId: "s1", since: 100 })
    ).toBe(4);
  });
});

describe("recaller · buildRecallSystemMessage", () => {
  it("空数组返回 null", () => {
    expect(buildRecallSystemMessage([])).toBeNull();
  });

  it("生成 system message 含每条摘要", () => {
    const digests: MemoryDigest[] = [
      makeDigest({ digestId: "d1", summary: "讨论 audit 链", createdAt: 1700000000000 }),
      makeDigest({ digestId: "d2", summary: "调试 Golden Set", createdAt: 1700001000000 }),
    ];
    const msg = buildRecallSystemMessage(digests);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe("system");
    expect(msg!.text).toContain("近期对话摘要");
    expect(msg!.text).toContain("讨论 audit 链");
    expect(msg!.text).toContain("调试 Golden Set");
  });

  it("按时间正序排列（即使输入是倒序）", () => {
    const digests: MemoryDigest[] = [
      makeDigest({ digestId: "new", summary: "B", createdAt: 2000 }),
      makeDigest({ digestId: "old", summary: "A", createdAt: 1000 }),
    ];
    const msg = buildRecallSystemMessage(digests);
    const aIdx = msg!.text.indexOf("A");
    const bIdx = msg!.text.indexOf("B");
    expect(aIdx).toBeGreaterThan(0);
    expect(aIdx).toBeLessThan(bIdx); // A 在 B 之前
  });
});

describe("recaller · recallRecent end-to-end", () => {
  it("空 db 返回 systemMessage=null", () => {
    const r = recallRecent(db, "cli", "alice");
    expect(r.digests).toEqual([]);
    expect(r.systemMessage).toBeNull();
  });

  it("有数据时返回 system message + digests", () => {
    saveMemoryDigest(db, makeDigest({ digestId: "d1", summary: "first", createdAt: 1000 }));
    saveMemoryDigest(db, makeDigest({ digestId: "d2", summary: "second", createdAt: 2000 }));
    const r = recallRecent(db, "cli", "alice");
    expect(r.digests).toHaveLength(2);
    expect(r.systemMessage).not.toBeNull();
    expect(r.systemMessage!.text).toContain("first");
    expect(r.systemMessage!.text).toContain("second");
  });

  it("limit 透传到 store 层", () => {
    for (let i = 0; i < 10; i++) {
      saveMemoryDigest(db, makeDigest({ digestId: `d${i}`, createdAt: i * 1000 }));
    }
    expect(recallRecent(db, "cli", "alice", 3).digests).toHaveLength(3);
  });
});
