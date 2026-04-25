/**
 * CostTracker + rates 单测
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";

import { openDataDb } from "../../../src/storage/db";
import { computeCost, lookupRate } from "../../../src/provider/rates";
import {
  formatUsd,
  recordCall,
  summarizeBySession,
  summarizeToday,
} from "../../../src/provider/costTracker";

const tempDirs: string[] = [];
let db: Database.Database;

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-cost-"));
  tempDirs.push(dir);
  db = openDataDb({ path: path.join(dir, "data.db"), singleton: false }).db;
  db.pragma("foreign_keys = OFF"); // llm_calls_raw 无 FK 但保险
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("rates · lookupRate", () => {
  it("OpenAI gpt-4o-mini 命中", () => {
    expect(lookupRate("openai", "gpt-4o-mini")).toEqual({ input: 0.00015, output: 0.0006 });
  });

  it("Anthropic claude-haiku-4-5 命中", () => {
    expect(lookupRate("anthropic", "claude-haiku-4-5-20251001")).toEqual({
      input: 0.0008,
      output: 0.004,
    });
  });

  it("本地模型零成本", () => {
    expect(lookupRate("ollama", "llama3.1")).toEqual({ input: 0, output: 0 });
    expect(lookupRate("lmstudio", "qwen3.6-27b")).toEqual({ input: 0, output: 0 });
  });

  it("未知 provider/model 返回零费率（不报错）", () => {
    expect(lookupRate("unknown", "x")).toEqual({ input: 0, output: 0 });
    expect(lookupRate("openai", "unknown-future-model")).toEqual({ input: 0, output: 0 });
  });

  it("modelId null/undefined 不抛", () => {
    expect(lookupRate("openai", null)).toEqual({ input: 0, output: 0 });
    expect(lookupRate("openai", undefined)).toEqual({ input: 0, output: 0 });
  });
});

describe("rates · computeCost", () => {
  it("按 1K tokens 计算", () => {
    // 1K input @ 0.001 + 1K output @ 0.005 = 0.001 + 0.005 = 0.006
    expect(computeCost({ input: 0.001, output: 0.005 }, 1000, 1000)).toBeCloseTo(0.006);
  });

  it("零费率永远 0", () => {
    expect(computeCost({ input: 0, output: 0 }, 9999, 9999)).toBe(0);
  });
});

describe("recordCall + summarize", () => {
  it("写 call → summarize 命中", () => {
    const r = recordCall(db, {
      traceId: "t1",
      sessionId: "s1",
      provider: "openai",
      modelId: "gpt-4o-mini",
      inputTokens: 1000,
      outputTokens: 500,
      latencyMs: 200,
    });
    expect(r).not.toBeNull();
    expect(r!.usdCost).toBeCloseTo(1000 * 0.00015 / 1000 + 500 * 0.0006 / 1000);

    const s = summarizeBySession(db, "s1");
    expect(s.callCount).toBe(1);
    expect(s.totalInputTokens).toBe(1000);
    expect(s.totalOutputTokens).toBe(500);
    expect(s.totalUsdCost).toBeGreaterThan(0);
  });

  it("db=null → noop 返回 null", () => {
    expect(recordCall(null, {
      traceId: "t1", sessionId: "s1", provider: "openai", modelId: "gpt-4o",
      inputTokens: 1, outputTokens: 1, latencyMs: 1,
    })).toBeNull();
  });

  it("summarizeBySession · 无数据返回 0", () => {
    const s = summarizeBySession(db, "no-such");
    expect(s.callCount).toBe(0);
    expect(s.totalUsdCost).toBe(0);
  });

  it("summarizeBySession · 跨 session 隔离", () => {
    recordCall(db, { traceId: "ta", sessionId: "s1", provider: "openai", modelId: "gpt-4o-mini", inputTokens: 100, outputTokens: 100, latencyMs: 1 });
    recordCall(db, { traceId: "tb", sessionId: "s2", provider: "openai", modelId: "gpt-4o-mini", inputTokens: 200, outputTokens: 200, latencyMs: 1 });
    expect(summarizeBySession(db, "s1").totalInputTokens).toBe(100);
    expect(summarizeBySession(db, "s2").totalInputTokens).toBe(200);
  });

  it("summarizeToday · 仅算今日（本地凌晨起）", () => {
    // 写一条今天的
    recordCall(db, { traceId: "today", sessionId: "s1", provider: "openai", modelId: "gpt-4o-mini", inputTokens: 100, outputTokens: 100, latencyMs: 1 });
    // 直接 SQL 写一条昨天的（绕过 recordCall 用真 Date.now()）
    const yesterday = Date.now() - 24 * 3600_000 - 1000;
    db.prepare(
      `INSERT INTO llm_calls_raw(call_id, trace_id, session_id, provider_id, model_id,
        input_tokens, output_tokens, usd_cost, latency_ms, created_at)
       VALUES ('y1','y','s1','openai','gpt-4o-mini',999,999,0.5,1, ?)`
    ).run(yesterday);

    const today = summarizeToday(db);
    expect(today.callCount).toBe(1); // 只今天那条
    expect(today.totalInputTokens).toBe(100);
  });

  it("本地模型零成本仍记 token", () => {
    const r = recordCall(db, {
      traceId: "t1", sessionId: "s-local", provider: "lmstudio", modelId: "qwen3.6",
      inputTokens: 5000, outputTokens: 2000, latencyMs: 41000,
    });
    expect(r!.usdCost).toBe(0);
    const s = summarizeBySession(db, "s-local");
    expect(s.totalInputTokens).toBe(5000);
    expect(s.totalUsdCost).toBe(0);
  });
});

describe("formatUsd", () => {
  it("零 → '$0'", () => expect(formatUsd(0)).toBe("$0"));
  it("超小 → '< $0.0001'", () => expect(formatUsd(0.00001)).toBe("< $0.0001"));
  it("正常 → 4 位小数", () => expect(formatUsd(0.1234567)).toBe("$0.1235"));
  it("整数美元 → 4 位小数", () => expect(formatUsd(1.5)).toBe("$1.5000"));
});
