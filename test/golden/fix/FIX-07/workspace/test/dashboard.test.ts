import { describe, it, expect } from "vitest";
import { loadDashboard } from "../src/dashboard";

describe("loadDashboard · 性能 + 正确性", () => {
  it("returns combined data", async () => {
    const d = await loadDashboard("u1");
    expect(d.user.id).toBe("u1");
    expect(d.user.name).toBe("user-u1");
    expect(d.orders.length).toBeGreaterThan(0);
    expect(d.notifications.length).toBeGreaterThan(0);
  });

  it("loads three sources in parallel (total < 200ms)", async () => {
    // 三段每段 80ms。串行 ≈ 240ms；并行 ≈ 80-100ms。
    // 给 200ms 上限确保确定区分两种实现。
    const start = Date.now();
    await loadDashboard("u2");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
