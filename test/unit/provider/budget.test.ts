/**
 * Budget · 双阈值 + 行为矩阵 · #86 单测
 */

import { describe, expect, it } from "vitest";
import { evaluateBudget, formatBudgetConfig, readBudgetFromEnv } from "../../../src/provider/budget";
import type { CallSummary } from "../../../src/provider/costTracker";

const empty: CallSummary = {
  callCount: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalUsdCost: 0,
};

function summary(usd: number, tokens = 0): CallSummary {
  return {
    callCount: 1,
    totalInputTokens: Math.floor(tokens / 2),
    totalOutputTokens: Math.ceil(tokens / 2),
    totalUsdCost: usd,
  };
}

describe("evaluateBudget", () => {
  it("无配置 → ok", () => {
    const v = evaluateBudget({ config: {}, session: empty, today: empty });
    expect(v.status).toBe("ok");
    expect(v.shouldBlock).toBe(false);
  });

  it("session USD 在阈值之下 → ok", () => {
    const v = evaluateBudget({
      config: { sessionUsd: 1.0 },
      session: summary(0.5),
      today: empty,
    });
    expect(v.status).toBe("ok");
  });

  it("session USD ≥ 80% (默认 warnAt) → warn", () => {
    const v = evaluateBudget({
      config: { sessionUsd: 1.0 },
      session: summary(0.85),
      today: empty,
    });
    expect(v.status).toBe("warn");
    expect(v.detail).toContain("80%");
    expect(v.shouldBlock).toBe(false);
  });

  it("session USD ≥ limit → exceeded", () => {
    const v = evaluateBudget({
      config: { sessionUsd: 1.0 },
      session: summary(1.5),
      today: empty,
    });
    expect(v.status).toBe("exceeded");
    expect(v.detail).toContain("session USD");
    expect(v.detail).toContain(">= limit");
  });

  it("onExceeded='block' + exceeded → shouldBlock=true", () => {
    const v = evaluateBudget({
      config: { sessionUsd: 1.0, onExceeded: "block" },
      session: summary(2.0),
      today: empty,
    });
    expect(v.shouldBlock).toBe(true);
  });

  it("onExceeded='warn' + exceeded → shouldBlock=false", () => {
    const v = evaluateBudget({
      config: { sessionUsd: 1.0, onExceeded: "warn" },
      session: summary(2.0),
      today: empty,
    });
    expect(v.status).toBe("exceeded");
    expect(v.shouldBlock).toBe(false);
  });

  it("today USD 命中（session 干净）→ exceeded", () => {
    const v = evaluateBudget({
      config: { todayUsd: 5.0, onExceeded: "block" },
      session: summary(0.1),
      today: summary(6.0),
    });
    expect(v.status).toBe("exceeded");
    expect(v.shouldBlock).toBe(true);
    expect(v.detail).toContain("today USD");
  });

  it("session token 命中 → exceeded", () => {
    const v = evaluateBudget({
      config: { sessionTokens: 1000 },
      session: summary(0, 2000),
      today: empty,
    });
    expect(v.status).toBe("exceeded");
    expect(v.detail).toContain("session tokens");
  });

  it("warnAt 自定义 0.5 → 0.5 * limit 命中 warn", () => {
    const v = evaluateBudget({
      config: { sessionUsd: 1.0, warnAt: 0.5 },
      session: summary(0.55),
      today: empty,
    });
    expect(v.status).toBe("warn");
    expect(v.detail).toContain("50%");
  });

  it("session 与 today 同时配置：session exceeded 优先返回（短路）", () => {
    const v = evaluateBudget({
      config: { sessionUsd: 1.0, todayUsd: 10.0, onExceeded: "block" },
      session: summary(2.0),
      today: summary(5.0), // today 50% warn 但 session 已 exceeded
    });
    expect(v.status).toBe("exceeded");
    expect(v.detail).toContain("session USD");
  });
});

describe("formatBudgetConfig", () => {
  it("空配置 → 'not configured'", () => {
    expect(formatBudgetConfig({})).toMatch(/not configured/);
  });

  it("含字段 → 多行渲染", () => {
    const s = formatBudgetConfig({
      sessionUsd: 0.5,
      todayUsd: 10,
      onExceeded: "block",
      warnAt: 0.7,
    });
    expect(s).toContain("session-USD-limit");
    expect(s).toContain("$0.5000");
    expect(s).toContain("today-USD-limit");
    expect(s).toContain("on-exceeded: block");
    expect(s).toContain("warn-at: 70%");
  });
});

describe("readBudgetFromEnv", () => {
  it("空 env → 空 config", () => {
    expect(readBudgetFromEnv({})).toEqual({});
  });

  it("USD/tokens/onExceeded/warnAt 全字段被读取", () => {
    const cfg = readBudgetFromEnv({
      CODECLAW_BUDGET_SESSION_USD: "0.5",
      CODECLAW_BUDGET_TODAY_USD: "10",
      CODECLAW_BUDGET_SESSION_TOKENS: "5000",
      CODECLAW_BUDGET_TODAY_TOKENS: "100000",
      CODECLAW_BUDGET_ON_EXCEEDED: "block",
      CODECLAW_BUDGET_WARN_AT: "0.7",
    });
    expect(cfg.sessionUsd).toBe(0.5);
    expect(cfg.todayUsd).toBe(10);
    expect(cfg.sessionTokens).toBe(5000);
    expect(cfg.todayTokens).toBe(100000);
    expect(cfg.onExceeded).toBe("block");
    expect(cfg.warnAt).toBe(0.7);
  });

  it("非法值忽略（非数字 / 负数 / warnAt > 1）", () => {
    const cfg = readBudgetFromEnv({
      CODECLAW_BUDGET_SESSION_USD: "not-a-number",
      CODECLAW_BUDGET_TODAY_USD: "-5",
      CODECLAW_BUDGET_WARN_AT: "1.5",
      CODECLAW_BUDGET_ON_EXCEEDED: "kill", // 无效行为
    });
    expect(cfg.sessionUsd).toBeUndefined();
    expect(cfg.todayUsd).toBeUndefined();
    expect(cfg.warnAt).toBeUndefined();
    expect(cfg.onExceeded).toBeUndefined();
  });
});
