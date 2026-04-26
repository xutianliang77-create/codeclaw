/**
 * cron historyStore (sqlite) 单测（#116 阶段 🅑）
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendRunRow,
  listRunsByTask,
  purgeOlderThan,
  summarizeRecent,
} from "../../../src/cron/historyStore";
import type { CronRun, CronTask } from "../../../src/cron/types";

let db: Database.Database;
let tmp: string;

const SCHEMA = path.join(
  process.cwd(),
  "src/storage/migrations/data/003_cron_runs.sql"
);

beforeEach(() => {
  tmp = path.join(os.tmpdir(), `cron-hist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  db = new Database(path.join(tmp, "test.db"));
  db.exec(readFileSync(SCHEMA, "utf8"));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  rmSync(tmp, { recursive: true, force: true });
});

const TASK: CronTask = {
  id: "T1",
  name: "daily-rag",
  schedule: "0 2 * * *",
  kind: "slash",
  payload: "/rag index",
  enabled: true,
  createdAt: 0,
};

function run(over: Partial<CronRun> = {}): CronRun {
  return {
    taskId: "T1",
    startedAt: 1000,
    endedAt: 1500,
    status: "ok",
    output: "",
    ...over,
  };
}

describe("appendRunRow + listRunsByTask", () => {
  it("写一条 → 读出", () => {
    appendRunRow(db, TASK, run({ output: "indexed 12 files" }));
    const rows = listRunsByTask(db, "T1");
    expect(rows.length).toBe(1);
    expect(rows[0].taskName).toBe("daily-rag");
    expect(rows[0].output).toContain("indexed");
  });

  it("按 ended_at DESC 排序", () => {
    appendRunRow(db, TASK, run({ endedAt: 1000 }));
    appendRunRow(db, TASK, run({ endedAt: 3000 }));
    appendRunRow(db, TASK, run({ endedAt: 2000 }));
    const rows = listRunsByTask(db, "T1");
    expect(rows.map((r) => r.endedAt)).toEqual([3000, 2000, 1000]);
  });

  it("limit 截断", () => {
    for (let i = 0; i < 5; i++) appendRunRow(db, TASK, run({ endedAt: i * 1000 }));
    expect(listRunsByTask(db, "T1", 2).length).toBe(2);
  });

  it("error 状态保留 error 字段", () => {
    appendRunRow(db, TASK, run({ status: "error", error: "boom" }));
    const r = listRunsByTask(db, "T1")[0];
    expect(r.status).toBe("error");
    expect(r.error).toBe("boom");
  });
});

describe("summarizeRecent", () => {
  it("聚合统计 total / byStatus / byTask", () => {
    appendRunRow(db, TASK, run({ status: "ok", endedAt: 5000 }));
    appendRunRow(db, TASK, run({ status: "error", error: "x", endedAt: 6000 }));
    appendRunRow(db, { ...TASK, id: "T2", name: "audit" }, run({ taskId: "T2", endedAt: 7000 }));

    const s = summarizeRecent(db, 0);
    expect(s.total).toBe(3);
    expect(s.byStatus.ok).toBe(2);
    expect(s.byStatus.error).toBe(1);
    expect(s.byTask.length).toBe(2);
    const t1 = s.byTask.find((t) => t.taskId === "T1");
    expect(t1?.total).toBe(2);
  });
});

describe("purgeOlderThan", () => {
  it("删早于 cutoff 的记录", () => {
    appendRunRow(db, TASK, run({ endedAt: 1000 }));
    appendRunRow(db, TASK, run({ endedAt: 5000 }));
    appendRunRow(db, TASK, run({ endedAt: 9000 }));
    const removed = purgeOlderThan(db, 4000);
    expect(removed).toBe(1);
    expect(listRunsByTask(db, "T1").length).toBe(2);
  });
});
