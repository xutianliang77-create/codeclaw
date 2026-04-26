/**
 * /forget 跨表 + 跨文件清理单测 · W3-16
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";

import { openDataDb } from "../../../src/storage/db";
import { forgetAllSessions, forgetSession } from "../../../src/storage/forget";
import { saveMemoryDigest } from "../../../src/memory/sessionMemory/store";

const tempDirs: string[] = [];
let dbPath: string;
let sessionsDir: string;
let db: Database.Database;

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-forget-"));
  tempDirs.push(dir);
  dbPath = path.join(dir, "data.db");
  sessionsDir = path.join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  db = openDataDb({ path: dbPath, singleton: false }).db;
  db.pragma("foreign_keys = OFF"); // 测试方便，跨表插入不必先建 sessions
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function seedSession(sessionId: string): void {
  // sessions 表（UNIQUE(channel,user_id,state) → 用 sessionId 派生 user_id 避冲突）
  db.prepare(
    `INSERT INTO sessions(session_id, channel, user_id, created_at, last_seen_at, state)
     VALUES (?, 'cli', ?, ?, ?, 'active')`
  ).run(sessionId, `user-${sessionId}`, Date.now(), Date.now());
  // approvals
  db.prepare(
    `INSERT INTO approvals(approval_id, session_id, prompt, tool_name, detail, reason, status, created_at)
     VALUES (?, ?, '/bash x', 'bash', 'x', 'medium', 'pending', ?)`
  ).run(`a-${sessionId}`, sessionId, Date.now());
  // tasks
  db.prepare(
    `INSERT INTO tasks(trace_id, session_id, goal, state, started_at)
     VALUES (?, ?, 'g', 'completed', ?)`
  ).run(`t-${sessionId}`, sessionId, Date.now());
  // l1_memory（真实 schema：message_id/session_id/seq/role/created_at...）
  db.prepare(
    `INSERT INTO l1_memory(message_id, session_id, seq, role, created_at)
     VALUES (?, ?, 1, 'user', ?)`
  ).run(`m-${sessionId}`, sessionId, Date.now());
  // observations
  db.prepare(
    `INSERT INTO observations(observation_id, trace_id, step_id, status, body_inline, body_path, created_at)
     VALUES (?, ?, ?, 'completed', 1, 'observations.jsonl', ?)`
  ).run(`o-${sessionId}`, `t-${sessionId}`, `s-${sessionId}`, Date.now());
  // llm_calls_raw
  db.prepare(
    `INSERT INTO llm_calls_raw(call_id, trace_id, session_id, provider_id, model_id,
      input_tokens, output_tokens, usd_cost, latency_ms, created_at)
     VALUES (?, ?, ?, 'openai', 'gpt-4o', 100, 100, 0.01, 200, ?)`
  ).run(`l-${sessionId}`, `t-${sessionId}`, sessionId, Date.now());
  // memory_digest
  saveMemoryDigest(db, {
    digestId: `d-${sessionId}`,
    sessionId,
    channel: "cli",
    userId: "alice",
    summary: "test",
    messageCount: 1,
    tokenEstimate: 10,
    createdAt: Date.now(),
  });
  // 文件目录
  const sd = path.join(sessionsDir, sessionId);
  mkdirSync(sd, { recursive: true });
  writeFileSync(path.join(sd, "transcript.jsonl"), '{"role":"user","text":"hi"}\n');
  writeFileSync(path.join(sd, "observations.jsonl"), '{"observationId":"x"}\n');
}

function _countSession(sessionId: string): number {
  return [
    "sessions", "approvals", "tasks", "l1_memory",
    "observations", "llm_calls_raw", "memory_digest",
  ].reduce((sum, table) => {
    try {
      const col = table === "observations" || table === "llm_calls_raw" ? "trace_id" : "session_id";
      // observations / llm_calls_raw 实际有 session_id 列；但 observations 用 trace_id 查更稳
      const filterCol = table === "observations" ? "trace_id" : table === "llm_calls_raw" ? "session_id" : col;
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${filterCol} LIKE ?`)
        .get(`%${sessionId}%`) as { n: number };
      return sum + r.n;
    } catch {
      return sum;
    }
  }, 0);
}

describe("forgetSession", () => {
  it("清单 session 跨表 + 文件目录", () => {
    seedSession("s1");
    seedSession("s2");

    const r = forgetSession(db, null, sessionsDir, "s1");

    // 各表至少有 1 行被删
    expect(r.tableRowsDeleted.sessions).toBe(1);
    expect(r.tableRowsDeleted.approvals).toBe(1);
    expect(r.tableRowsDeleted.tasks).toBe(1);
    expect(r.tableRowsDeleted.l1_memory).toBe(1);
    expect(r.tableRowsDeleted.observations).toBe(1);
    expect(r.tableRowsDeleted.llm_calls_raw).toBe(1);
    expect(r.tableRowsDeleted.memory_digest).toBe(1);

    // 文件目录被删
    expect(r.fileRemoved).toBe(true);
    expect(existsSync(path.join(sessionsDir, "s1"))).toBe(false);

    // s2 的数据完整保留
    expect(existsSync(path.join(sessionsDir, "s2"))).toBe(true);
    const s2Rows = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id='s2'").get();
    expect((s2Rows as { n: number }).n).toBe(1);
  });

  it("session 不存在 → 各表 0 行删除，fileRemoved=false", () => {
    const r = forgetSession(db, null, sessionsDir, "nonexistent");
    expect(r.tableRowsDeleted.sessions).toBe(0);
    expect(r.fileRemoved).toBe(false);
  });

  it("文件目录不存在但 db 有数据 → 仍删 db 行", () => {
    seedSession("s-nofile");
    rmSync(path.join(sessionsDir, "s-nofile"), { recursive: true, force: true });

    const r = forgetSession(db, null, sessionsDir, "s-nofile");
    expect(r.tableRowsDeleted.sessions).toBe(1);
    expect(r.fileRemoved).toBe(false);
  });

  it("多次 forget 同一 session 幂等（第二次都是 0）", () => {
    seedSession("s-once");
    forgetSession(db, null, sessionsDir, "s-once");
    const r2 = forgetSession(db, null, sessionsDir, "s-once");
    expect(r2.tableRowsDeleted.sessions).toBe(0);
    expect(r2.fileRemoved).toBe(false);
  });
});

describe("forgetAllSessions", () => {
  it("全清三个 session", () => {
    seedSession("a");
    seedSession("b");
    seedSession("c");

    const result = forgetAllSessions(db, null, sessionsDir);
    expect(result.totalSessions).toBe(3);
    expect(result.results).toHaveLength(3);

    // 三个文件目录都没了
    expect(existsSync(path.join(sessionsDir, "a"))).toBe(false);
    expect(existsSync(path.join(sessionsDir, "b"))).toBe(false);
    expect(existsSync(path.join(sessionsDir, "c"))).toBe(false);

    // sessions 表空
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n
    ).toBe(0);
  });

  it("空 sessions 表 → totalSessions=0", () => {
    const result = forgetAllSessions(db, null, sessionsDir);
    expect(result.totalSessions).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("memory_digest 中的孤儿 session（sessions 表里没有但 memory_digest 有）也清", () => {
    saveMemoryDigest(db, {
      digestId: "d-orphan",
      sessionId: "orphan-session",
      channel: "cli",
      userId: "alice",
      summary: "orphan",
      messageCount: 1,
      tokenEstimate: 10,
      createdAt: Date.now(),
    });
    const result = forgetAllSessions(db, null, sessionsDir);
    expect(result.totalSessions).toBe(1); // orphan 被纳入
    // memory_digest 全清
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM memory_digest").get() as { n: number }).n
    ).toBe(0);
  });
});
