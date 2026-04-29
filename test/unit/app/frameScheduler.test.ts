import { describe, expect, it } from "vitest";
import { FrameScheduler } from "../../../src/app/frameScheduler";

// 注入可控 setTimeout / nowFn，避免真实时间依赖让单测脆弱
function createTestScheduler(intervalMs: number) {
  let now = 0;
  const timers: Array<{ id: number; fireAt: number; cb: () => void }> = [];
  let nextId = 1;

  const setTimeoutFn = ((cb: () => void, delay: number) => {
    const id = nextId++;
    timers.push({ id, fireAt: now + delay, cb });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  const clearTimeoutFn = ((id: number) => {
    const idx = timers.findIndex((t) => t.id === id);
    if (idx >= 0) timers.splice(idx, 1);
  }) as unknown as typeof clearTimeout;

  const advance = (ms: number) => {
    now += ms;
    while (timers.length > 0 && timers[0].fireAt <= now) {
      const t = timers.shift()!;
      t.cb();
    }
  };

  const scheduler = new FrameScheduler(
    intervalMs,
    setTimeoutFn,
    clearTimeoutFn,
    () => now
  );
  return { scheduler, advance, timers };
}

describe("FrameScheduler", () => {
  it("[v0.8.4] 同 key 多次 schedule 后到的覆盖前者，flushNow 仅执行一次", () => {
    const { scheduler } = createTestScheduler(50);
    const seen: number[] = [];
    for (let i = 0; i < 30; i++) {
      scheduler.schedule("k", () => seen.push(i));
    }
    expect(scheduler.pendingCount()).toBe(1); // 30 次 schedule 合并为 1 个 pending
    scheduler.flushNow();
    expect(seen).toEqual([29]); // 最后一次的 action 胜出
  });

  it("[v0.8.4] 不同 key 在同一帧合并为一次 timer fire", () => {
    const { scheduler, advance } = createTestScheduler(50);
    const seen: string[] = [];
    scheduler.schedule("a", () => seen.push("a"));
    scheduler.schedule("b", () => seen.push("b"));
    scheduler.schedule("c", () => seen.push("c"));

    expect(seen).toEqual([]); // 还没到 50ms
    advance(49);
    expect(seen).toEqual([]);
    advance(1);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("[v0.8.4] 50ms 间隔保护：第二次 schedule 距离第一次不足 minInterval 时被推迟", () => {
    const { scheduler, advance } = createTestScheduler(50);
    const fired: number[] = [];
    scheduler.schedule("k", () => fired.push(0));
    advance(50);
    expect(fired).toEqual([0]);

    // 紧接着第二次（距离 lastEmittedAt 仅 0ms）
    scheduler.schedule("k", () => fired.push(1));
    advance(49);
    expect(fired).toEqual([0]); // 还没到 50ms 后
    advance(1);
    expect(fired).toEqual([0, 1]);
  });

  it("[v0.8.4] action 抛错不影响后续 action 执行", () => {
    const { scheduler } = createTestScheduler(50);
    const seen: string[] = [];
    scheduler.schedule("a", () => {
      throw new Error("boom");
    });
    scheduler.schedule("b", () => seen.push("b"));
    scheduler.flushNow();
    expect(seen).toEqual(["b"]);
  });

});
