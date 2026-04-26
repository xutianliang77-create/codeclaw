/**
 * cron scheduler 单测（#116 step C.2）
 *
 * 用 fake setInterval + 注入 now() 控制时间。
 */

import { describe, expect, it } from "vitest";

import { CronScheduler } from "../../../src/cron/scheduler";
import type { CronStoreShape, CronTask, CronRun } from "../../../src/cron/types";

interface RunCall {
  taskId: string;
  at: number;
}

function makeRunner() {
  const calls: RunCall[] = [];
  const runner = {
    async runOnce(task: CronTask): Promise<CronRun> {
      calls.push({ taskId: task.id, at: Date.now() });
      return {
        taskId: task.id,
        startedAt: 0,
        endedAt: 0,
        status: "ok",
        output: "",
      };
    },
  };
  return { calls, runner };
}

function fakeTimers() {
  const handlers: { fn: () => void; ms: number }[] = [];
  return {
    setIntervalFn: ((fn: () => void, ms: number) => {
      handlers.push({ fn, ms });
      return handlers.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: ((id: number) => {
      handlers.splice((id as unknown as number) - 1, 1);
    }) as unknown as typeof clearInterval,
    fireAll: () => {
      for (const h of handlers) h.fn();
    },
  };
}

function task(over: Partial<CronTask>): CronTask {
  return {
    id: "T",
    name: "t",
    schedule: "* * * * *",
    kind: "shell",
    payload: "echo",
    enabled: true,
    createdAt: 0,
    ...over,
  };
}

describe("CronScheduler", () => {
  it("start 后定时 tick；disabled 任务不触发", () => {
    const { calls, runner } = makeRunner();
    const timers = fakeTimers();
    let now = 1_700_000_000_000;
    const store: CronStoreShape = {
      tasks: {
        a: task({ id: "a", schedule: "* * * * *", enabled: true }),
        b: task({ id: "b", schedule: "* * * * *", enabled: false }),
      },
    };
    const sched = new CronScheduler(store, runner, {
      tickMs: 30_000,
      driftMs: 60_000,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now: () => now,
    });
    sched.start();
    // 推进 60s（跨过分钟边界）
    now += 60_000;
    timers.fireAll();
    expect(calls.map((c) => c.taskId)).toEqual(["a"]);
    sched.stop();
  });

  it("同任务 1 分钟内不重复触发", () => {
    const { calls, runner } = makeRunner();
    const timers = fakeTimers();
    let now = 1_700_000_000_000;
    const store: CronStoreShape = {
      tasks: { a: task({ id: "a", schedule: "* * * * *" }) },
    };
    const sched = new CronScheduler(store, runner, {
      tickMs: 30_000,
      driftMs: 60_000,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now: () => now,
    });
    sched.start();
    now += 60_000;
    timers.fireAll();
    expect(calls.length).toBe(1);
    // 30s 内再 tick：不应再触发（dedupe）
    now += 30_000;
    timers.fireAll();
    expect(calls.length).toBe(1);
    // 90s 后 (跨 dedupe + 跨下一分钟) 应再触发
    now += 90_000;
    timers.fireAll();
    expect(calls.length).toBe(2);
  });

  it("非法 schedule 不抛错；其它任务继续", () => {
    const { calls, runner } = makeRunner();
    const timers = fakeTimers();
    let now = 1_700_000_000_000;
    const store: CronStoreShape = {
      tasks: {
        bad: task({ id: "bad", schedule: "totally invalid" }),
        good: task({ id: "good", schedule: "* * * * *" }),
      },
    };
    const sched = new CronScheduler(store, runner, {
      tickMs: 30_000,
      driftMs: 60_000,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now: () => now,
    });
    sched.start();
    now += 60_000;
    timers.fireAll();
    expect(calls.map((c) => c.taskId)).toEqual(["good"]);
  });

  it("漂移补偿：错过 1 个 tick 仍补跑（窗口扩到 since-drift）", () => {
    const { calls, runner } = makeRunner();
    const timers = fakeTimers();
    let now = 1_700_000_000_000;
    const store: CronStoreShape = {
      tasks: { a: task({ id: "a", schedule: "*/5 * * * *" }) },
    };
    const sched = new CronScheduler(store, runner, {
      tickMs: 30_000,
      driftMs: 60_000,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now: () => now,
    });
    sched.start();
    // 推进 30s tick；如果不触发，再推进 90s 再 tick；窗口含 5 分钟边界则补跑
    now += 5 * 60_000 + 1_000;
    timers.fireAll();
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("runner 异常被吞，不阻塞下次 tick", async () => {
    const errors: { id: string; err: unknown }[] = [];
    const failingRunner = {
      async runOnce() {
        throw new Error("kaboom");
      },
    };
    const timers = fakeTimers();
    let now = 1_700_000_000_000;
    const store: CronStoreShape = {
      tasks: { a: task({ id: "a", schedule: "* * * * *" }) },
    };
    const sched = new CronScheduler(store, failingRunner, {
      tickMs: 30_000,
      driftMs: 60_000,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now: () => now,
      onError: (id, err) => errors.push({ id, err }),
    });
    sched.start();
    now += 60_000;
    timers.fireAll();
    // microtask flush
    await new Promise((r) => setImmediate(r));
    expect(errors.length).toBe(1);
    expect(errors[0].id).toBe("a");
  });

  it("stop 后不再 fire", () => {
    const { calls, runner } = makeRunner();
    const timers = fakeTimers();
    let now = 1_700_000_000_000;
    const store: CronStoreShape = {
      tasks: { a: task({ id: "a", schedule: "* * * * *" }) },
    };
    const sched = new CronScheduler(store, runner, {
      tickMs: 30_000,
      driftMs: 60_000,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      now: () => now,
    });
    sched.start();
    sched.stop();
    now += 120_000;
    timers.fireAll(); // handlers 已清空
    expect(calls.length).toBe(0);
  });
});
