/**
 * cron 表达式解析单测（#116 step C.1）
 */

import { describe, expect, it } from "vitest";

import { cronMatches, parseCronExpr } from "../../../src/cron/parser";

describe("parseCronExpr 标准 5 字段", () => {
  it("全 *", () => {
    const p = parseCronExpr("* * * * *");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.minute.length).toBe(60);
    expect(p.hour.length).toBe(24);
    expect(p.day.length).toBe(31);
    expect(p.month.length).toBe(12);
    expect(p.weekday).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("具体值 0 2 * * *", () => {
    const p = parseCronExpr("0 2 * * *");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.minute).toEqual([0]);
    expect(p.hour).toEqual([2]);
  });

  it("列表 0,15,30,45 * * * *", () => {
    const p = parseCronExpr("0,15,30,45 * * * *");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.minute).toEqual([0, 15, 30, 45]);
  });

  it("范围 1-5 * * * *", () => {
    const p = parseCronExpr("1-5 * * * *");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.minute).toEqual([1, 2, 3, 4, 5]);
  });

  it("步长 */15 * * * *", () => {
    const p = parseCronExpr("*/15 * * * *");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.minute).toEqual([0, 15, 30, 45]);
  });

  it("范围 + 步长 0-30/10 * * * *", () => {
    const p = parseCronExpr("0-30/10 * * * *");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.minute).toEqual([0, 10, 20, 30]);
  });

  it("混合列表/范围 1,3,5-7 * * * *", () => {
    const p = parseCronExpr("1,3,5-7 * * * *");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.minute).toEqual([1, 3, 5, 6, 7]);
  });

  it("weekday 7 视为周日 0", () => {
    const p = parseCronExpr("0 0 * * 7");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.weekday).toEqual([0]);
  });

  it("weekday 范围 1-5", () => {
    const p = parseCronExpr("0 0 * * 1-5");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.weekday).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("parseCronExpr 别名", () => {
  it("@hourly", () => {
    const p = parseCronExpr("@hourly");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.minute).toEqual([0]);
    expect(p.hour.length).toBe(24);
  });

  it("@daily 即每天 0:00", () => {
    const p = parseCronExpr("@daily");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.minute).toEqual([0]);
    expect(p.hour).toEqual([0]);
  });

  it("@weekly 即周日 0:00", () => {
    const p = parseCronExpr("@weekly");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.weekday).toEqual([0]);
  });

  it("@monthly 即每月 1 号 0:00", () => {
    const p = parseCronExpr("@monthly");
    if (p.kind !== "fields") throw new Error("kind");
    expect(p.day).toEqual([1]);
  });
});

describe("parseCronExpr @every 区间", () => {
  it("@every 30s → 30 000 ms", () => {
    const p = parseCronExpr("@every 30s");
    if (p.kind !== "every") throw new Error("kind");
    expect(p.intervalMs).toBe(30_000);
  });

  it("@every 5m → 300 000 ms", () => {
    const p = parseCronExpr("@every 5m");
    if (p.kind !== "every") throw new Error("kind");
    expect(p.intervalMs).toBe(300_000);
  });

  it("@every 1h → 3 600 000 ms", () => {
    const p = parseCronExpr("@every 1h");
    if (p.kind !== "every") throw new Error("kind");
    expect(p.intervalMs).toBe(3_600_000);
  });
});

describe("parseCronExpr 非法表达式", () => {
  it("空字符串", () => {
    expect(() => parseCronExpr("")).toThrow();
  });

  it("字段不足", () => {
    expect(() => parseCronExpr("* * *")).toThrow();
  });

  it("分钟超界", () => {
    expect(() => parseCronExpr("60 * * * *")).toThrow();
  });

  it("步长 0", () => {
    expect(() => parseCronExpr("*/0 * * * *")).toThrow();
  });

  it("非数字", () => {
    expect(() => parseCronExpr("abc * * * *")).toThrow();
  });

  it("@every 单位错", () => {
    expect(() => parseCronExpr("@every 5x")).toThrow();
  });

  it("@every 0", () => {
    expect(() => parseCronExpr("@every 0s")).toThrow();
  });
});

describe("cronMatches", () => {
  function ts(year: number, m: number, d: number, h: number, min: number): number {
    return new Date(year, m - 1, d, h, min, 0, 0).getTime();
  }

  it("2:00 daily 在 1:59→2:01 区间触发", () => {
    const p = parseCronExpr("0 2 * * *");
    expect(cronMatches(p, ts(2026, 4, 26, 1, 59), ts(2026, 4, 26, 2, 1))).toBe(true);
  });

  it("2:00 daily 在 3:00→3:30 不触发", () => {
    const p = parseCronExpr("0 2 * * *");
    expect(cronMatches(p, ts(2026, 4, 26, 3, 0), ts(2026, 4, 26, 3, 30))).toBe(false);
  });

  it("*/5 在 5 分钟内必触发", () => {
    const p = parseCronExpr("*/5 * * * *");
    const start = ts(2026, 4, 26, 10, 1);
    expect(cronMatches(p, start, start + 5 * 60_000 + 1)).toBe(true);
  });

  it("@every 30s 在 30s 区间内触发", () => {
    const p = parseCronExpr("@every 30s");
    // 选择一个 30s 边界：1_700_000_010_000 = 30000 * 56666667
    const boundary = 1_700_000_010_000;
    expect(cronMatches(p, boundary - 1, boundary)).toBe(true);
  });

  it("@every 30s 不跨边界 → false", () => {
    const p = parseCronExpr("@every 30s");
    const boundary = 1_700_000_010_000;
    expect(cronMatches(p, boundary + 1, boundary + 29_999)).toBe(false);
  });

  it("now <= since 永远 false", () => {
    const p = parseCronExpr("* * * * *");
    expect(cronMatches(p, 100, 100)).toBe(false);
    expect(cronMatches(p, 200, 100)).toBe(false);
  });

  it("day & weekday 联合：任一匹配触发（OR 语义）", () => {
    // 每月 1 号 OR 周日 0:00
    const p = parseCronExpr("0 0 1 * 0");
    // 2026-04-26 是周日，非 1 号 → 应触发
    const sunNonFirst = ts(2026, 4, 26, 0, 0);
    expect(cronMatches(p, sunNonFirst - 60_001, sunNonFirst)).toBe(true);
    // 2026-04-01 是周三，是 1 号 → 应触发
    const firstNonSun = ts(2026, 4, 1, 0, 0);
    expect(cronMatches(p, firstNonSun - 60_001, firstNonSun)).toBe(true);
    // 2026-04-15 是周三，非 1 号 → 不触发
    const neither = ts(2026, 4, 15, 0, 0);
    expect(cronMatches(p, neither - 60_001, neither)).toBe(false);
  });

  it("day & weekday 都通配 → 时间到即触发", () => {
    const p = parseCronExpr("0 12 * * *");
    const noon = ts(2026, 4, 26, 12, 0);
    expect(cronMatches(p, noon - 60_001, noon)).toBe(true);
  });
});
