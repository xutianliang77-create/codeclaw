/**
 * P0-W1-10 / W1-11 · observationRepo / l1MemoryRepo 单测
 * 附带 sessionRepo / taskRepo / stepRepo 的最小覆盖
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { migrateIfNeeded } from "../../../src/storage/migrate";
import { upsertActiveSession } from "../../../src/storage/repositories/sessionRepo";
import { insertTask } from "../../../src/storage/repositories/taskRepo";
import { insertStep } from "../../../src/storage/repositories/stepRepo";
import {
  OBSERVATION_OVERFLOW_THRESHOLD,
  ObservationRepo,
} from "../../../src/storage/repositories/observationRepo";
import { L1MemoryRepo } from "../../../src/storage/repositories/l1MemoryRepo";

let tmpRoot: string;
let db: Database.Database;
let sessionsDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "codeclaw-repo-"));
  sessionsDir = path.join(tmpRoot, "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  db = new Database(path.join(tmpRoot, "data.db"));
  db.pragma("foreign_keys = ON");
  migrateIfNeeded(db, "data");
});

afterEach(() => {
  try {
    db.close();
  } catch { /* noop */ }
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function seedSessionTaskStep(opts: {
  sessionId?: string;
  traceId?: string;
  stepId?: string;
} = {}): { sessionId: string; traceId: string; stepId: string } {
  const sessionId = opts.sessionId ?? "sess-1";
  const traceId = opts.traceId ?? "trace-1";
  const stepId = opts.stepId ?? "step-1";
  upsertActiveSession(db, { sessionId, channel: "cli", userId: "u" });
  insertTask(db, { traceId, sessionId, goal: "do something", state: "executing" });
  insertStep(db, { stepId, traceId, stepNo: 1, actionType: "inspect-file", status: "invoking" });
  return { sessionId, traceId, stepId };
}

// —— sessionRepo ———————————————————————————————————————————————————————

describe("sessionRepo.upsertActiveSession", () => {
  it("inserts new active session", () => {
    upsertActiveSession(db, { sessionId: "sess-A", channel: "cli", userId: "alice" });
    const row = db.prepare("SELECT * FROM sessions").get() as { state: string };
    expect(row.state).toBe("active");
  });

  it("updates existing (channel,user,active) row without UNIQUE conflict", () => {
    upsertActiveSession(db, { sessionId: "sess-A", channel: "cli", userId: "alice" });
    upsertActiveSession(db, {
      sessionId: "sess-B",
      channel: "cli",
      userId: "alice",
      workspace: "/ws",
    });
    const rows = db.prepare("SELECT * FROM sessions").all() as Array<{
      session_id: string;
      workspace: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe("sess-B");
    expect(rows[0]!.workspace).toBe("/ws");
  });
});

// —— observationRepo ——————————————————————————————————————————————————

describe("ObservationRepo.record · inline path (body ≤ 100KB)", () => {
  it("writes to observations.jsonl and inserts meta row", () => {
    const { sessionId, traceId, stepId } = seedSessionTaskStep();
    const repo = new ObservationRepo(db, sessionsDir);
    const rec = repo.record({
      observationId: "obs-1",
      traceId,
      stepId,
      sessionId,
      status: "completed",
      summary: "read ok",
      body: "short body",
      latencyMs: 42,
      tokenCost: 10,
    });
    expect(rec.bodyInline).toBe(true);
    expect(rec.bodyPath).toBe("observations.jsonl");

    const file = path.join(sessionsDir, sessionId, "observations.jsonl");
    expect(existsSync(file)).toBe(true);
    const line = readFileSync(file, "utf8").trim();
    expect(JSON.parse(line)).toMatchObject({
      observationId: "obs-1",
      body: "short body",
      status: "completed",
    });

    const dbRow = db.prepare("SELECT * FROM observations").get() as {
      status: string;
      body_inline: number;
      body_path: string;
      summary: string;
      latency_ms: number;
      token_cost: number;
    };
    expect(dbRow.status).toBe("completed");
    expect(dbRow.body_inline).toBe(1);
    expect(dbRow.body_path).toBe("observations.jsonl");
    expect(dbRow.summary).toBe("read ok");
    expect(dbRow.latency_ms).toBe(42);
    expect(dbRow.token_cost).toBe(10);
  });

  it("appends multiple observations to the same jsonl preserving order", () => {
    const { sessionId, traceId } = seedSessionTaskStep();
    const repo = new ObservationRepo(db, sessionsDir);
    // 额外再建 3 个 step（seed 已有 step-1，这里用 step-100/101/102 避开 PK 冲突）
    for (let i = 0; i < 3; i++) {
      const stepId = `step-${100 + i}`;
      insertStep(db, {
        stepId,
        traceId,
        stepNo: 100 + i,
        actionType: "inspect-file",
        status: "invoking",
      });
      repo.record({
        observationId: `obs-${i}`,
        traceId,
        stepId,
        sessionId,
        status: "completed",
        body: `line-${i}`,
      });
    }
    const file = path.join(sessionsDir, sessionId, "observations.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).observationId).toBe("obs-0");
    expect(JSON.parse(lines[2]!).observationId).toBe("obs-2");

    const listed = repo.listByTrace(traceId);
    expect(listed.map((r) => r.observationId)).toEqual(["obs-0", "obs-1", "obs-2"]);
  });
});

describe("ObservationRepo.record · overflow path (body > 100KB)", () => {
  it("writes to observations/{stepId}.jsonl and marks body_inline=0", () => {
    const { sessionId, traceId, stepId } = seedSessionTaskStep();
    const repo = new ObservationRepo(db, sessionsDir);
    const big = "x".repeat(OBSERVATION_OVERFLOW_THRESHOLD + 1024);
    const rec = repo.record({
      observationId: "obs-big",
      traceId,
      stepId,
      sessionId,
      status: "completed",
      body: big,
    });
    expect(rec.bodyInline).toBe(false);
    expect(rec.bodyPath).toBe(path.join("observations", `${stepId}.jsonl`));

    const overflowFile = path.join(sessionsDir, sessionId, rec.bodyPath);
    expect(existsSync(overflowFile)).toBe(true);
    const payload = JSON.parse(readFileSync(overflowFile, "utf8").trim()) as {
      body: string;
    };
    expect(payload.body.length).toBe(big.length);

    // 合并 jsonl 不应含此条
    const inlineFile = path.join(sessionsDir, sessionId, "observations.jsonl");
    expect(existsSync(inlineFile)).toBe(false);
  });
});

describe("ObservationRepo.get / listByTrace", () => {
  it("get returns meta by id", () => {
    const { sessionId, traceId, stepId } = seedSessionTaskStep();
    const repo = new ObservationRepo(db, sessionsDir);
    repo.record({
      observationId: "obs-1",
      traceId,
      stepId,
      sessionId,
      status: "completed",
      body: "hi",
    });
    const got = repo.get("obs-1");
    expect(got?.status).toBe("completed");
    expect(got?.bodyInline).toBe(true);
    expect(repo.get("nonexistent")).toBeNull();
  });
});

// —— l1MemoryRepo ————————————————————————————————————————————————————

describe("L1MemoryRepo.record", () => {
  it("appends to transcript.jsonl and inserts meta row", () => {
    const { sessionId } = seedSessionTaskStep();
    const repo = new L1MemoryRepo(db, sessionsDir);

    repo.record({
      messageId: "msg-1",
      sessionId,
      seq: 1,
      role: "user",
      source: "user",
      body: "hello",
      importance: 2,
      tokenCost: 3,
    });
    repo.record({
      messageId: "msg-2",
      sessionId,
      seq: 2,
      role: "assistant",
      source: "model",
      body: "hi there",
    });

    const file = path.join(sessionsDir, sessionId, "transcript.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).body).toBe("hello");
    expect(JSON.parse(lines[1]!).role).toBe("assistant");

    const metas = repo.listBySession(sessionId);
    expect(metas).toHaveLength(2);
    expect(metas[0]!.seq).toBe(1);
    expect(metas[0]!.importance).toBe(2);
    expect(metas[0]!.tokenCost).toBe(3);
    expect(metas[0]!.bodyMissing).toBe(false);
    expect(metas[1]!.role).toBe("assistant");
    expect(metas[1]!.source).toBe("model");
  });

  it("listBySession sinceSeq filter works", () => {
    const { sessionId } = seedSessionTaskStep();
    const repo = new L1MemoryRepo(db, sessionsDir);
    for (let i = 1; i <= 5; i++) {
      repo.record({ messageId: `m-${i}`, sessionId, seq: i, role: "user", body: `${i}` });
    }
    expect(repo.countBySession(sessionId)).toBe(5);
    const later = repo.listBySession(sessionId, { sinceSeq: 3 });
    expect(later.map((m) => m.seq)).toEqual([4, 5]);
  });

  it("PRIMARY KEY prevents duplicate insert of same message_id", () => {
    const { sessionId } = seedSessionTaskStep();
    const repo = new L1MemoryRepo(db, sessionsDir);
    repo.record({ messageId: "m-1", sessionId, seq: 1, role: "user", body: "once" });
    expect(() =>
      repo.record({ messageId: "m-1", sessionId, seq: 2, role: "user", body: "again" })
    ).toThrow();
  });

  it("markBodyMissing flips body_missing flag", () => {
    const { sessionId } = seedSessionTaskStep();
    const repo = new L1MemoryRepo(db, sessionsDir);
    repo.record({ messageId: "m-1", sessionId, seq: 1, role: "user", body: "x" });
    repo.markBodyMissing("m-1");
    const meta = repo.listBySession(sessionId)[0]!;
    expect(meta.bodyMissing).toBe(true);
  });
});
