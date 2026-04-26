/**
 * Cron runner 单测（#116 step C.3）
 *
 * 三类 task：slash / prompt / shell；超时 / 失败 / 通知
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CronRunner } from "../../../src/cron/runner";
import { readRecentRuns } from "../../../src/cron/store";
import type { CronTask, CronRun } from "../../../src/cron/types";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = path.join(
    os.tmpdir(),
    `cron-runner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

function fakeEngine(textChunks: string[], opts: { delayMs?: number } = {}) {
  return {
    async *submitMessage() {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      for (const t of textChunks) {
        yield { type: "message-complete", messageId: "x", text: t };
      }
    },
  };
}

function task(over: Partial<CronTask>): CronTask {
  return {
    id: "T",
    name: "t",
    schedule: "* * * * *",
    kind: "slash",
    payload: "/x",
    enabled: true,
    createdAt: 0,
    ...over,
  };
}

describe("CronRunner — engine path（slash / prompt）", () => {
  it("slash 收集 message-complete 文本拼接", async () => {
    const runner = new CronRunner({
      engineFactory: () => fakeEngine(["hello", "world"]) as never,
      paths: paths(),
    });
    const run = await runner.runOnce(task({ id: "A", kind: "slash", payload: "/foo" }));
    expect(run.status).toBe("ok");
    expect(run.output).toContain("hello");
    expect(run.output).toContain("world");
  });

  it("prompt 走同一 engine path", async () => {
    const runner = new CronRunner({
      engineFactory: () => fakeEngine(["report"]) as never,
      paths: paths(),
    });
    const run = await runner.runOnce(task({ id: "B", kind: "prompt", payload: "review" }));
    expect(run.status).toBe("ok");
    expect(run.output).toBe("report");
  });

  it("超时 → status=timeout", async () => {
    const runner = new CronRunner({
      engineFactory: () => fakeEngine(["x"], { delayMs: 200 }) as never,
      paths: paths(),
    });
    const run = await runner.runOnce(
      task({ id: "C", kind: "slash", timeoutMs: 50 })
    );
    expect(run.status).toBe("timeout");
    expect(run.error).toContain("50ms");
  });

  it("engine 抛错 → status=error", async () => {
    const runner = new CronRunner({
      engineFactory: () => ({
        // eslint-disable-next-line require-yield
        async *submitMessage() {
          throw new Error("provider down");
        },
      }) as never,
      paths: paths(),
    });
    const run = await runner.runOnce(task({ id: "D", kind: "slash" }));
    expect(run.status).toBe("error");
    expect(run.error).toContain("provider down");
  });
});

describe("CronRunner — shell path", () => {
  it("成功 exit 0 → status=ok + 输出捕获", async () => {
    const runner = new CronRunner({
      engineFactory: () => fakeEngine([]) as never,
      paths: paths(),
    });
    const run = await runner.runOnce(
      task({ id: "S1", kind: "shell", payload: "echo hello-cron" })
    );
    expect(run.status).toBe("ok");
    expect(run.output).toContain("hello-cron");
  });

  it("失败 exit !=0 → status=error + stderr 进 error 字段", async () => {
    const runner = new CronRunner({
      engineFactory: () => fakeEngine([]) as never,
      paths: paths(),
    });
    const run = await runner.runOnce(
      task({ id: "S2", kind: "shell", payload: "echo oops 1>&2; exit 3" })
    );
    expect(run.status).toBe("error");
    expect(run.error).toContain("shell exit 3");
  });
});

describe("CronRunner — 持久化 + 通知", () => {
  it("成功后写入 jsonl 日志", async () => {
    const p = paths();
    const runner = new CronRunner({
      engineFactory: () => fakeEngine(["ok"]) as never,
      paths: p,
    });
    await runner.runOnce(task({ id: "L1", kind: "slash" }));
    const recent = readRecentRuns("L1", 5, p);
    expect(recent.length).toBe(1);
    expect(recent[0].status).toBe("ok");
  });

  it("notifyChannels 触发回调", async () => {
    const got: { channels: string[]; status: string }[] = [];
    const runner = new CronRunner({
      engineFactory: () => fakeEngine(["ok"]) as never,
      paths: paths(),
      notify: (chans, _task, run: CronRun) => {
        got.push({ channels: [...chans], status: run.status });
      },
    });
    await runner.runOnce(
      task({ id: "N1", kind: "slash", notifyChannels: ["cli", "web"] })
    );
    expect(got.length).toBe(1);
    expect(got[0].channels).toEqual(["cli", "web"]);
  });

  it("notify 抛错不影响 run 完成", async () => {
    const runner = new CronRunner({
      engineFactory: () => fakeEngine(["ok"]) as never,
      paths: paths(),
      notify: () => {
        throw new Error("notify down");
      },
    });
    const run = await runner.runOnce(
      task({ id: "N2", kind: "slash", notifyChannels: ["cli"] })
    );
    expect(run.status).toBe("ok");
  });

  it("updateTaskMeta 被调用，传入 task 与 run", async () => {
    const calls: { taskId: string; status: string }[] = [];
    const runner = new CronRunner({
      engineFactory: () => fakeEngine(["ok"]) as never,
      paths: paths(),
      updateTaskMeta: (t, r) => {
        calls.push({ taskId: t.id, status: r.status });
      },
    });
    await runner.runOnce(task({ id: "M1", kind: "slash" }));
    expect(calls).toEqual([{ taskId: "M1", status: "ok" }]);
  });
});

describe("CronRunner — output 截断 / sanitize", () => {
  it("超长输出被截断", async () => {
    const big = "x".repeat(20 * 1024);
    const runner = new CronRunner({
      engineFactory: () => fakeEngine([big]) as never,
      paths: paths(),
    });
    const run = await runner.runOnce(task({ id: "B1", kind: "slash" }));
    expect(run.output.length).toBeLessThan(big.length);
    expect(run.output).toContain("[truncated]");
  });

  it("ANSI 控制序列在 error 中被剥离", async () => {
    const runner = new CronRunner({
      engineFactory: () => ({
        // eslint-disable-next-line require-yield
        async *submitMessage() {
          throw new Error("\x1b[31mred error\x1b[0m\x07");
        },
      }) as never,
      paths: paths(),
    });
    const run = await runner.runOnce(task({ id: "E1", kind: "slash" }));
    expect(run.status).toBe("error");
    expect(run.error).not.toContain("\x1b");
    expect(run.error).toContain("red error");
  });
});
