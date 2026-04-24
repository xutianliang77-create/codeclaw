/**
 * P0-W1-08 · SessionManager 持久化单测
 *
 * 覆盖：
 *   - 纯内存模式（无 db）：API 行为同旧实现
 *   - 持久化模式（带 db）：bind/touch/destroy 同步写 db
 *   - boot() 恢复：新 SessionManager 从同一 db load active
 *   - UNIQUE (channel, user_id, state) 约束不违反（bind 重复调用）
 *   - destroy 标 archived 而非物理删
 *   - workspace / meta 持久化
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { SessionManager } from "../../../src/ingress/sessionManager";
import { migrateIfNeeded } from "../../../src/storage/migrate";

let tmpDir: string;

function freshDb(): Database.Database {
  const db = new Database(path.join(tmpDir, `sessions-${Date.now()}-${Math.random()}.db`));
  db.pragma("foreign_keys = ON");
  migrateIfNeeded(db, "data");
  return db;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-session-"));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("SessionManager · in-memory mode (backward compatible)", () => {
  it("bind returns new SessionInfo; list shows it", () => {
    const sm = new SessionManager();
    const info = sm.bind("cli", "alice", "sess-1");
    expect(info.sessionId).toBe("sess-1");
    expect(info.channel).toBe("cli");
    expect(info.userId).toBe("alice");
    expect(sm.list()).toHaveLength(1);
  });

  it("bind twice for same (channel,user) updates session_id", () => {
    const sm = new SessionManager();
    sm.bind("cli", "alice", "sess-1");
    const info2 = sm.bind("cli", "alice", "sess-2");
    expect(info2.sessionId).toBe("sess-2");
    expect(sm.list()).toHaveLength(1);
  });

  it("touch updates lastSeenAt; destroy removes entry", async () => {
    const sm = new SessionManager();
    const a = sm.bind("cli", "alice", "sess-1");
    await new Promise((r) => setTimeout(r, 5));
    sm.touch("sess-1");
    const b = sm.list()[0]!;
    expect(b.lastSeenAt).toBeGreaterThan(a.lastSeenAt);
    sm.destroy("sess-1");
    expect(sm.list()).toHaveLength(0);
  });

  it("resolve is an alias for bind", () => {
    const sm = new SessionManager();
    const info = sm.resolve("wechat", "bob", "fallback-id");
    expect(info.sessionId).toBe("fallback-id");
    expect(info.channel).toBe("wechat");
  });
});

describe("SessionManager · persistent mode", () => {
  it("bind writes INSERT row with state='active'", () => {
    const db = freshDb();
    const sm = new SessionManager({ db });
    sm.bind("cli", "alice", "sess-1", { workspace: "/workspace/a" });
    const rows = db.prepare("SELECT * FROM sessions").all() as Array<{
      session_id: string;
      state: string;
      workspace: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe("sess-1");
    expect(rows[0]!.state).toBe("active");
    expect(rows[0]!.workspace).toBe("/workspace/a");
    db.close();
  });

  it("bind twice for same (channel,user,active) UPDATES row (no UNIQUE conflict)", () => {
    const db = freshDb();
    const sm = new SessionManager({ db });
    sm.bind("cli", "alice", "sess-1");
    sm.bind("cli", "alice", "sess-2", { workspace: "/workspace/b" });
    const rows = db
      .prepare("SELECT session_id, workspace FROM sessions WHERE channel='cli' AND user_id='alice' AND state='active'")
      .all() as Array<{ session_id: string; workspace: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe("sess-2");
    expect(rows[0]!.workspace).toBe("/workspace/b");
    db.close();
  });

  it("touch updates last_seen_at in db", async () => {
    const db = freshDb();
    const sm = new SessionManager({ db });
    sm.bind("cli", "alice", "sess-1");
    const before = (db.prepare("SELECT last_seen_at FROM sessions WHERE session_id=?").get("sess-1") as { last_seen_at: number }).last_seen_at;
    await new Promise((r) => setTimeout(r, 5));
    sm.touch("sess-1");
    const after = (db.prepare("SELECT last_seen_at FROM sessions WHERE session_id=?").get("sess-1") as { last_seen_at: number }).last_seen_at;
    expect(after).toBeGreaterThan(before);
    db.close();
  });

  it("destroy marks state='archived' (does not delete)", () => {
    const db = freshDb();
    const sm = new SessionManager({ db });
    sm.bind("cli", "alice", "sess-1");
    sm.destroy("sess-1");
    expect(sm.list()).toHaveLength(0);
    const row = db.prepare("SELECT state FROM sessions WHERE session_id=?").get("sess-1") as { state: string };
    expect(row.state).toBe("archived");
    db.close();
  });
});

describe("SessionManager · boot() reconstruction", () => {
  it("loads state='active' rows into memory map", () => {
    const db = freshDb();
    const sm1 = new SessionManager({ db });
    sm1.bind("cli", "alice", "sess-A", { workspace: "/a" });
    sm1.bind("wechat", "bob", "sess-B");

    // 新 manager 共享同一 db（模拟进程重启）
    const sm2 = new SessionManager({ db });
    const list = sm2.list();
    expect(list).toHaveLength(2);

    const cliSession = list.find((s) => s.channel === "cli")!;
    expect(cliSession.sessionId).toBe("sess-A");
    expect(cliSession.workspace).toBe("/a");

    const wechatSession = list.find((s) => s.channel === "wechat")!;
    expect(wechatSession.sessionId).toBe("sess-B");
    expect(wechatSession.userId).toBe("bob");

    db.close();
  });

  it("does not load archived sessions", () => {
    const db = freshDb();
    const sm1 = new SessionManager({ db });
    sm1.bind("cli", "alice", "sess-A");
    sm1.destroy("sess-A");

    const sm2 = new SessionManager({ db });
    expect(sm2.list()).toHaveLength(0);
    db.close();
  });

  it("meta round-trips via JSON serialization", () => {
    const db = freshDb();
    const sm1 = new SessionManager({ db });
    sm1.bind("cli", "alice", "sess-A", { meta: { deviceId: "laptop-1", locale: "zh-CN" } });

    const sm2 = new SessionManager({ db });
    const loaded = sm2.list()[0]!;
    expect(loaded.meta).toEqual({ deviceId: "laptop-1", locale: "zh-CN" });
    db.close();
  });

  it("autoBoot=false delays boot", () => {
    const db = freshDb();
    const sm1 = new SessionManager({ db });
    sm1.bind("cli", "alice", "sess-A");

    const sm2 = new SessionManager({ db, autoBoot: false });
    expect(sm2.list()).toHaveLength(0);
    sm2.boot();
    expect(sm2.list()).toHaveLength(1);
    db.close();
  });
});
