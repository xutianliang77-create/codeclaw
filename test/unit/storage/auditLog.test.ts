/**
 * P0-W1-05 · Audit Chain 单测
 *
 * 覆盖：
 *   - 首条 prev_hash = GENESIS_HASH
 *   - 连续 append 形成链：第 n 条 prev_hash = 第 n-1 条 event_hash
 *   - verify 对诚实链 ok
 *   - verify 检测篡改：event_hash / prev_hash / timestamp / resource
 *   - list / export 过滤
 *   - 1000 条 append + verify 性能基线
 */

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { migrateIfNeeded } from "../../../src/storage/migrate";
import {
  AuditLog,
  GENESIS_HASH,
  computeEventHash,
  type AuditEventInput,
} from "../../../src/storage/auditLog";

let tmpDir: string | null = null;

function openFreshAuditDb(): Database.Database {
  if (!tmpDir) tmpDir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-audit-"));
  const db = new Database(path.join(tmpDir, `audit-${Date.now()}-${Math.random()}.db`));
  migrateIfNeeded(db, "audit");
  return db;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function makeInput(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    traceId: "01HX1234567890TRACEIDABCDE",
    sessionId: "01HX1234567890SESSIDABCDEF",
    actor: "tool",
    action: "tool.read",
    resource: "/tmp/demo.txt",
    decision: "allow",
    timestamp: 1777000000000,
    ...overrides,
  };
}

describe("AuditLog.append", () => {
  it("first event: prev_hash = GENESIS_HASH, event_hash is deterministic", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);
    const e = log.append(makeInput());
    expect(e.prevHash).toBe(GENESIS_HASH);

    const expected = computeEventHash({
      prevHash: GENESIS_HASH,
      eventId: e.eventId,
      actor: e.actor,
      action: e.action,
      resource: e.resource,
      decision: e.decision,
      timestamp: e.timestamp,
    });
    expect(e.eventHash).toBe(expected);
    expect(log.count()).toBe(1);
    db.close();
  });

  it("chains: each event's prev_hash == previous event's event_hash", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);
    const a = log.append(makeInput({ action: "tool.read" }));
    const b = log.append(makeInput({ action: "tool.bash", resource: "git status" }));
    const c = log.append(makeInput({ action: "skill.run", resource: "review" }));

    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.eventHash);
    expect(c.prevHash).toBe(b.eventHash);
    expect(log.latestHash()).toBe(c.eventHash);
    db.close();
  });

  it("persists all fields including details_json", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);
    const e = log.append(
      makeInput({
        details: { command: "git status", exitCode: 0, output_bytes: 42 },
        mode: "default",
        reason: "low risk",
      })
    );
    const listed = log.list({ traceId: e.traceId });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.details).toEqual({ command: "git status", exitCode: 0, output_bytes: 42 });
    expect(listed[0]!.mode).toBe("default");
    expect(listed[0]!.reason).toBe("low risk");
    db.close();
  });

  it("W3-02 timestamp monotonic: incoming earlier than latest is bumped to latest+1", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);

    // 第一条用一个固定较大的 timestamp
    const e1 = log.append({
      traceId: "t1",
      actor: "user",
      action: "tool.bash",
      decision: "allow",
      timestamp: 10_000,
    });
    expect(e1.timestamp).toBe(10_000);

    // 第二条 incoming 比 latest 还早 → 应被强制 bump 到 latest+1
    const e2 = log.append({
      traceId: "t1",
      actor: "user",
      action: "tool.bash",
      decision: "allow",
      timestamp: 5_000, // 比 e1 早 5000ms
    });
    expect(e2.timestamp).toBe(10_001);

    // 第三条 incoming 与 latest 相等 → 也得 bump
    const e3 = log.append({
      traceId: "t1",
      actor: "user",
      action: "tool.bash",
      decision: "allow",
      timestamp: 10_001,
    });
    expect(e3.timestamp).toBe(10_002);

    // 第四条 incoming 远超 latest → 直接用 incoming
    const e4 = log.append({
      traceId: "t1",
      actor: "user",
      action: "tool.bash",
      decision: "allow",
      timestamp: 99_999,
    });
    expect(e4.timestamp).toBe(99_999);

    // 链 verify 仍 pass（这就是 W3-02 的核心：乱序写入后链不断）
    const result = log.verify();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.checkedCount).toBe(4);
    db.close();
  });

  it("W3-02 timestamp monotonic: defaulted Date.now() also bumped if late by clock-skew", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);

    // 第一条人为给"未来"timestamp（模拟时钟回拨前的写入）
    const future = Date.now() + 60 * 60 * 1000; // +1 hour
    const e1 = log.append({
      traceId: "t1",
      actor: "user",
      action: "tool.bash",
      decision: "allow",
      timestamp: future,
    });
    expect(e1.timestamp).toBe(future);

    // 第二条没传 timestamp → Date.now() 取当前；当前 < future → 应 bump 到 future+1
    const e2 = log.append({
      traceId: "t1",
      actor: "user",
      action: "tool.bash",
      decision: "allow",
    });
    expect(e2.timestamp).toBe(future + 1);

    expect(log.verify().ok).toBe(true);
    db.close();
  });
});

describe("AuditLog.verify", () => {
  it("accepts an honest chain", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);
    for (let i = 0; i < 20; i++) {
      log.append(makeInput({ action: `tool.read.${i}`, resource: `/tmp/${i}.txt`, timestamp: 1777000000000 + i }));
    }
    const r = log.verify();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.checkedCount).toBe(20);
    db.close();
  });

  it("detects tampered event_hash", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);
    log.append(makeInput());
    const second = log.append(makeInput({ action: "tool.bash", timestamp: 1777000000100 }));

    // 篡改第二条的 event_hash
    db.prepare("UPDATE audit_events SET event_hash = ? WHERE event_id = ?").run(
      "00".repeat(32),
      second.eventId
    );
    const r = log.verify();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.brokenAt).toBe(second.eventId);
      expect(r.reason).toMatch(/event_hash mismatch/);
    }
    db.close();
  });

  it("detects tampered prev_hash", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);
    log.append(makeInput());
    const second = log.append(makeInput({ timestamp: 1777000000100 }));
    db.prepare("UPDATE audit_events SET prev_hash = ? WHERE event_id = ?").run(
      "00".repeat(32),
      second.eventId
    );
    const r = log.verify();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.brokenAt).toBe(second.eventId);
      expect(r.reason).toMatch(/prev_hash mismatch/);
    }
    db.close();
  });

  it("detects tampered timestamp (event_hash covers timestamp)", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);
    const e = log.append(makeInput({ timestamp: 1777000000000 }));
    db.prepare("UPDATE audit_events SET timestamp = ? WHERE event_id = ?").run(
      1777000999999,
      e.eventId
    );
    const r = log.verify();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/event_hash mismatch/);
    db.close();
  });

  it("detects tampered resource", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);
    const e = log.append(makeInput({ resource: "/etc/passwd", decision: "deny" }));
    db.prepare("UPDATE audit_events SET resource = ? WHERE event_id = ?").run(
      "/tmp/harmless.txt",
      e.eventId
    );
    const r = log.verify();
    expect(r.ok).toBe(false);
    db.close();
  });

  it("empty DB verifies as ok with 0 events", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);
    const r = log.verify();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.checkedCount).toBe(0);
    db.close();
  });
});

describe("AuditLog.list / export", () => {
  it("list applies filters", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);
    log.append(makeInput({ actor: "tool", action: "tool.read", timestamp: 1777000000000 }));
    log.append(makeInput({ actor: "tool", action: "tool.bash", timestamp: 1777000000100 }));
    log.append(makeInput({ actor: "skill", action: "skill.run", timestamp: 1777000000200 }));
    log.append(makeInput({ actor: "user", action: "cli.input", decision: "allow", timestamp: 1777000000300 }));

    expect(log.list({ actor: "tool" })).toHaveLength(2);
    expect(log.list({ action: "skill.run" })).toHaveLength(1);
    expect(log.list({ from: 1777000000150 })).toHaveLength(2);
    expect(log.list({ limit: 1 })).toHaveLength(1);
    expect(log.list({ orderBy: "desc" })[0]!.action).toBe("cli.input");
    db.close();
  });

  it("export jsonl is line-delimited JSON", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);
    log.append(makeInput({ timestamp: 1777000000000 }));
    log.append(makeInput({ action: "skill.run", timestamp: 1777000000100 }));
    const out = log.export({}, "jsonl");
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toHaveProperty("eventId");
    expect(first).toHaveProperty("eventHash");
    db.close();
  });

  it("export csv header + rows", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);
    log.append(makeInput({ reason: "contains, comma and \"quote\"" }));
    const out = log.export({}, "csv");
    const lines = out.trim().split("\n");
    expect(lines[0]).toContain("event_id,trace_id");
    expect(lines[1]).toContain('"contains, comma and ""quote"""'); // 正确转义
    db.close();
  });
});

describe("AuditLog performance", () => {
  it("append 1000 + verify < 500 ms on local dev", () => {
    const db = openFreshAuditDb();
    const log = new AuditLog(db);

    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      log.append(makeInput({ action: `tool.read.${i % 5}`, timestamp: 1777000000000 + i }));
    }
    const appendMs = Date.now() - t0;
    expect(log.count()).toBe(1000);
    // 宽松上限：本机单跑 < 200ms；并行 test 环境下可能 1~3s，再留余量
    expect(appendMs).toBeLessThan(5000);

    const r = log.verify();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.checkedCount).toBe(1000);
      expect(r.durationMs).toBeLessThan(500);
    }
    db.close();
  });
});
