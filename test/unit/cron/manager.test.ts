/**
 * CronManager 单测（#116 step C.4）
 *
 * 覆盖：add / remove / setEnabled / runNow / readLogs / 持久化
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CronManager } from "../../../src/cron/manager";
import type { CronTask } from "../../../src/cron/types";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = path.join(
    os.tmpdir(),
    `cron-mgr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function paths() {
  return {
    storeFile: path.join(tmpRoot, "cron.json"),
    runsDir: path.join(tmpRoot, "cron-runs"),
  };
}

function fakeEngine(text: string) {
  return {
    async *submitMessage() {
      yield { type: "message-complete", messageId: "x", text };
    },
  };
}

const noopFactory = (() => fakeEngine("ok") as never) as never;

describe("CronManager.add", () => {
  it("成功：写盘 + 返回带 id 的 task", () => {
    const m = new CronManager({ paths: paths(), engineFactory: noopFactory });
    const t = m.add({
      name: "rag-daily",
      schedule: "0 2 * * *",
      kind: "slash",
      payload: "/rag index",
      notifyChannels: ["cli"],
    });
    expect(t.id).toMatch(/[A-Z0-9]+/);
    expect(t.enabled).toBe(true);
    // 落盘
    expect(existsSync(paths().storeFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(paths().storeFile, "utf8"));
    expect(persisted.tasks[t.id].name).toBe("rag-daily");
  });

  it("非法 schedule 抛错", () => {
    const m = new CronManager({ paths: paths(), engineFactory: noopFactory });
    expect(() =>
      m.add({ name: "x", schedule: "bogus", kind: "shell", payload: "echo" })
    ).toThrow();
  });

  it("重名抛错", () => {
    const m = new CronManager({ paths: paths(), engineFactory: noopFactory });
    m.add({ name: "dup", schedule: "@daily", kind: "shell", payload: "echo" });
    expect(() =>
      m.add({ name: "dup", schedule: "@daily", kind: "shell", payload: "echo" })
    ).toThrow(/already exists/);
  });

  it("payload 必填", () => {
    const m = new CronManager({ paths: paths(), engineFactory: noopFactory });
    expect(() =>
      m.add({ name: "x", schedule: "@daily", kind: "shell", payload: "" })
    ).toThrow();
  });
});

describe("CronManager get / list / remove / setEnabled", () => {
  it("按 id 与 name 查找", () => {
    const m = new CronManager({ paths: paths(), engineFactory: noopFactory });
    const t = m.add({ name: "abc", schedule: "@hourly", kind: "shell", payload: "echo" });
    expect(m.get(t.id)?.name).toBe("abc");
    expect(m.get("abc")?.id).toBe(t.id);
    expect(m.get("nope")).toBe(null);
  });

  it("list 按 createdAt 排序", () => {
    const m = new CronManager({ paths: paths(), engineFactory: noopFactory });
    const a = m.add({ name: "a", schedule: "@daily", kind: "shell", payload: "echo" });
    const b = m.add({ name: "b", schedule: "@daily", kind: "shell", payload: "echo" });
    expect(m.list().map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("remove 删除并落盘", () => {
    const m = new CronManager({ paths: paths(), engineFactory: noopFactory });
    const t = m.add({ name: "rm", schedule: "@daily", kind: "shell", payload: "echo" });
    expect(m.remove("rm")?.id).toBe(t.id);
    expect(m.get(t.id)).toBe(null);
    const persisted = JSON.parse(readFileSync(paths().storeFile, "utf8"));
    expect(Object.keys(persisted.tasks)).toEqual([]);
  });

  it("setEnabled 切换 + 落盘", () => {
    const m = new CronManager({ paths: paths(), engineFactory: noopFactory });
    const t = m.add({ name: "e", schedule: "@daily", kind: "shell", payload: "echo" });
    m.setEnabled("e", false);
    expect(m.get(t.id)?.enabled).toBe(false);
    const persisted = JSON.parse(readFileSync(paths().storeFile, "utf8"));
    expect(persisted.tasks[t.id].enabled).toBe(false);
  });
});

describe("CronManager.runNow", () => {
  it("调 runner.runOnce + 写日志 + 更新 lastRunStatus", async () => {
    const m = new CronManager({
      paths: paths(),
      engineFactory: (() => fakeEngine("hello-now") as never) as never,
    });
    const t: CronTask = m.add({
      name: "now1",
      schedule: "@daily",
      kind: "slash",
      payload: "/x",
    });
    const run = await m.runNow("now1");
    expect(run?.status).toBe("ok");
    expect(run?.output).toContain("hello-now");
    // task lastRunAt 已更新
    const fresh = m.get(t.id)!;
    expect(fresh.lastRunStatus).toBe("ok");
    expect(typeof fresh.lastRunAt).toBe("number");
    // 日志可读
    const logs = m.readLogs("now1", 5);
    expect(logs?.runs.length).toBe(1);
  });

  it("不存在的任务 → null", async () => {
    const m = new CronManager({ paths: paths(), engineFactory: noopFactory });
    expect(await m.runNow("nope")).toBe(null);
  });
});

describe("CronManager 持久化恢复", () => {
  it("第二次构造能读回任务", () => {
    const p = paths();
    const m1 = new CronManager({ paths: p, engineFactory: noopFactory });
    m1.add({ name: "persist", schedule: "@daily", kind: "shell", payload: "echo" });
    const m2 = new CronManager({ paths: p, engineFactory: noopFactory });
    expect(m2.get("persist")?.name).toBe("persist");
  });
});
