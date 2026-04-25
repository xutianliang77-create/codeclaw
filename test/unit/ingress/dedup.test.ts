/**
 * Ingress dedup · W4-08 / T19 单测
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";

import { openDataDb } from "../../../src/storage/db";
import {
  checkAndRegister,
  purgeExpired,
  recordDelivery,
} from "../../../src/ingress/dedupStore";

const tempDirs: string[] = [];
let db: Database.Database;

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-dedup-"));
  tempDirs.push(dir);
  db = openDataDb({ path: path.join(dir, "data.db"), singleton: false }).db;
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("checkAndRegister", () => {
  it("首次 client_id → isDuplicate=false 并落表", () => {
    const r = checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    expect(r.isDuplicate).toBe(false);
    const row = db.prepare("SELECT client_id FROM ingress_dedup").get();
    expect(row).toBeDefined();
  });

  it("同 client_id ttl 内二次 → isDuplicate=true", () => {
    checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    const r = checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    expect(r.isDuplicate).toBe(true);
  });

  it("二次时返回上次 recordDelivery 的内容", () => {
    checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    recordDelivery(db, "c1", { reply: "hello", id: "msg-1" });
    const r = checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    expect(r.isDuplicate).toBe(true);
    expect(r.lastDelivery).toEqual({ reply: "hello", id: "msg-1" });
  });

  it("ttl 过期 → 视作新（覆盖原行）", () => {
    const t0 = 1_000_000_000;
    checkAndRegister(db, {
      clientId: "c1",
      channel: "wechat",
      userId: "alice",
      ttlMs: 1000,
      now: t0,
    });
    // 模拟 ttl 之外
    const r = checkAndRegister(db, {
      clientId: "c1",
      channel: "wechat",
      userId: "alice",
      ttlMs: 1000,
      now: t0 + 5000,
    });
    expect(r.isDuplicate).toBe(false);
  });

  it("跨 channel 同 client_id 视为新（覆盖）", () => {
    checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    const r = checkAndRegister(db, { clientId: "c1", channel: "http", userId: "alice" });
    expect(r.isDuplicate).toBe(false);
  });

  it("跨 user 同 client_id 视为新（保险）", () => {
    checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    const r = checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "bob" });
    expect(r.isDuplicate).toBe(false);
  });

  it("不同 client_id 互不影响", () => {
    checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    const r = checkAndRegister(db, { clientId: "c2", channel: "wechat", userId: "alice" });
    expect(r.isDuplicate).toBe(false);
  });

  it("last_delivery 是非法 JSON 时容错（不抛）", () => {
    checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    db.prepare("UPDATE ingress_dedup SET last_delivery = ? WHERE client_id = ?")
      .run("not-json{{", "c1");
    const r = checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    expect(r.isDuplicate).toBe(true);
    expect(r.lastDelivery).toBeUndefined();
  });
});

describe("recordDelivery", () => {
  it("回填后再 check 能拿到", () => {
    checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    recordDelivery(db, "c1", { x: 1 });
    const r = checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    expect(r.lastDelivery).toEqual({ x: 1 });
  });

  it("不存在的 client_id 不抛（noop）", () => {
    expect(() => recordDelivery(db, "nonexistent", { x: 1 })).not.toThrow();
  });

  it("覆盖式更新（多次 record 取最后一次）", () => {
    checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    recordDelivery(db, "c1", { v: 1 });
    recordDelivery(db, "c1", { v: 2 });
    const r = checkAndRegister(db, { clientId: "c1", channel: "wechat", userId: "alice" });
    expect(r.lastDelivery).toEqual({ v: 2 });
  });
});

describe("purgeExpired", () => {
  it("清理 first_seen_at + ttl < now 的行", () => {
    const t0 = 1_000_000_000;
    checkAndRegister(db, {
      clientId: "c-old",
      channel: "wechat",
      userId: "alice",
      ttlMs: 1000,
      now: t0,
    });
    checkAndRegister(db, {
      clientId: "c-new",
      channel: "wechat",
      userId: "alice",
      ttlMs: 10_000, // 长 ttl 让 purge 时仍 valid
      now: t0 + 500,
    });
    const removed = purgeExpired(db, t0 + 2000);
    expect(removed).toBe(1);
    // 仅 c-new 留下
    const ids = db
      .prepare("SELECT client_id FROM ingress_dedup")
      .all()
      .map((r) => (r as { client_id: string }).client_id);
    expect(ids).toEqual(["c-new"]);
  });

  it("空表 → 返回 0", () => {
    expect(purgeExpired(db, Date.now())).toBe(0);
  });
});
