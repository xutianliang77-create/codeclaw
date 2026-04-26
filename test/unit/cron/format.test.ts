/**
 * /cron 命令分发与格式化单测（#116 step C.4）
 *
 * 验 dispatchCronCmd 把 add / list / run-now / logs / disable 串起来。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CronManager } from "../../../src/cron/manager";
import { dispatchCronCmd, formatRunSummary } from "../../../src/cron/format";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = path.join(
    os.tmpdir(),
    `cron-format-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

const fakeFactory = (() => ({
  async *submitMessage() {
    yield { type: "message-complete", messageId: "x", text: "ran" };
  },
}) as never) as never;

function newManager() {
  return new CronManager({ paths: paths(), engineFactory: fakeFactory });
}

describe("dispatchCronCmd 闭环", () => {
  it("空命令 → list 表头", async () => {
    const m = newManager();
    const r = await dispatchCronCmd(m, "");
    expect(r).toContain("no tasks");
  });

  it("add → list → 出现新任务", async () => {
    const m = newManager();
    const addOut = await dispatchCronCmd(
      m,
      'add my-task "0 2 * * *" slash:/foo --notify=cli'
    );
    expect(addOut).toContain("added: my-task");
    const listOut = await dispatchCronCmd(m, "");
    expect(listOut).toContain("my-task");
    expect(listOut).toContain("0 2 * * *");
  });

  it("run-now 后产出 [Cron · ...] 摘要", async () => {
    const m = newManager();
    await dispatchCronCmd(m, 'add t1 "@daily" slash:/foo');
    const r = await dispatchCronCmd(m, "run-now t1");
    expect(r).toContain("[Cron · t1 · ok");
    expect(r).toContain("ran");
  });

  it("logs 显示最近运行", async () => {
    const m = newManager();
    await dispatchCronCmd(m, 'add t2 "@daily" slash:/foo');
    await dispatchCronCmd(m, "run-now t2");
    const logs = await dispatchCronCmd(m, "logs t2");
    expect(logs).toContain("logs for t2");
    expect(logs).toContain("ok");
  });

  it("disable 后 list 显示 off", async () => {
    const m = newManager();
    await dispatchCronCmd(m, 'add t3 "@daily" slash:/foo');
    await dispatchCronCmd(m, "disable t3");
    const list = await dispatchCronCmd(m, "");
    expect(list).toContain("off");
  });

  it("remove 不存在的任务 → 友好提示", async () => {
    const m = newManager();
    const r = await dispatchCronCmd(m, "remove nope");
    expect(r).toContain("no such task");
  });

  it("非法 schedule 抛错被捕捉为友好回复", async () => {
    const m = newManager();
    const r = await dispatchCronCmd(m, 'add bad "bogus" slash:/x');
    expect(r).toContain("add failed");
  });

  it("非法子命令 → 提示 + 帮助", async () => {
    const m = newManager();
    const r = await dispatchCronCmd(m, "bogus subcommand");
    expect(r).toContain("unknown");
    expect(r).toContain("Usage:");
  });
});

describe("formatRunSummary", () => {
  it("ok 状态包含名字 + 状态 + 输出", () => {
    const text = formatRunSummary(
      {
        id: "1",
        name: "x",
        schedule: "@daily",
        kind: "shell",
        payload: "echo",
        enabled: true,
        createdAt: 0,
      },
      {
        taskId: "1",
        startedAt: 100,
        endedAt: 200,
        status: "ok",
        output: "hello",
      }
    );
    expect(text).toContain("[Cron · x · ok · 100ms]");
    expect(text).toContain("hello");
  });

  it("error 状态附 error 字段", () => {
    const text = formatRunSummary(
      {
        id: "1",
        name: "x",
        schedule: "@daily",
        kind: "shell",
        payload: "false",
        enabled: true,
        createdAt: 0,
      },
      {
        taskId: "1",
        startedAt: 0,
        endedAt: 50,
        status: "error",
        output: "",
        error: "boom",
      }
    );
    expect(text).toContain("error");
    expect(text).toContain("boom");
  });
});
