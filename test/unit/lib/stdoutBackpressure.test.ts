import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  waitForStdoutDrain,
  type BackpressureAuditEvent,
} from "../../../src/lib/stdoutBackpressure";

class FakeStream extends EventEmitter {
  writableNeedDrain = false;
  fireDrain(): void {
    this.emit("drain");
  }
}

function fakeTimers() {
  let now = 0;
  const intervals: Array<{ id: number; everyMs: number; cb: () => void; nextAt: number }> = [];
  let nextId = 1;

  const setIntervalFn = ((cb: () => void, ms: number) => {
    const id = nextId++;
    intervals.push({ id, everyMs: ms, cb, nextAt: now + ms });
    return id as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;

  const clearIntervalFn = ((id: number) => {
    const idx = intervals.findIndex((t) => t.id === id);
    if (idx >= 0) intervals.splice(idx, 1);
  }) as unknown as typeof clearInterval;

  const advance = (ms: number) => {
    const target = now + ms;
    while (true) {
      const next = intervals
        .filter((t) => t.nextAt <= target)
        .sort((a, b) => a.nextAt - b.nextAt)[0];
      if (!next) break;
      now = next.nextAt;
      next.cb();
      next.nextAt = now + next.everyMs;
    }
    now = target;
  };

  return { setIntervalFn, clearIntervalFn, nowFn: () => now, advance };
}

describe("waitForStdoutDrain", () => {
  it("[v0.8.5] writableNeedDrain=false 立即 resolve，不调 audit", async () => {
    const stream = new FakeStream();
    stream.writableNeedDrain = false;
    const audits: BackpressureAuditEvent[] = [];
    await waitForStdoutDrain({
      stream: stream as unknown as NodeJS.WriteStream,
      onAudit: (e) => audits.push(e),
    });
    expect(audits).toHaveLength(0);
  });

  it("[v0.8.5] writableNeedDrain=true 时等 drain 事件后 resolve", async () => {
    const stream = new FakeStream();
    stream.writableNeedDrain = true;
    const promise = waitForStdoutDrain({
      stream: stream as unknown as NodeJS.WriteStream,
    });
    setImmediate(() => stream.fireDrain());
    await expect(promise).resolves.toBeUndefined();
  });

  it("[v0.8.5] 等待 > 1 秒 drain 后触发 cleared audit", async () => {
    const stream = new FakeStream();
    stream.writableNeedDrain = true;
    const audits: BackpressureAuditEvent[] = [];
    const t = fakeTimers();
    const promise = waitForStdoutDrain({
      stream: stream as unknown as NodeJS.WriteStream,
      onAudit: (e) => audits.push(e),
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
      nowFn: t.nowFn,
    });
    t.advance(2_000);
    stream.fireDrain();
    await promise;
    const cleared = audits.find((a) => a.action === "stream.backpressure-cleared");
    expect(cleared).toBeDefined();
    expect(cleared?.waitedMs).toBeGreaterThan(1_000);
  });

  it("[v0.8.5] 等待超过 stall interval 触发 stalled audit 但不 resolve", async () => {
    const stream = new FakeStream();
    stream.writableNeedDrain = true;
    const audits: BackpressureAuditEvent[] = [];
    const t = fakeTimers();
    const promise = waitForStdoutDrain({
      stream: stream as unknown as NodeJS.WriteStream,
      stallWarnIntervalMs: 5_000,
      onAudit: (e) => audits.push(e),
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
      nowFn: t.nowFn,
    });
    t.advance(5_000);
    expect(audits.filter((a) => a.action === "stream.backpressure-stalled")).toHaveLength(1);
    t.advance(5_000);
    expect(audits.filter((a) => a.action === "stream.backpressure-stalled")).toHaveLength(2);
    stream.fireDrain();
    await promise;
  });
});
