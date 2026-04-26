/**
 * Token 预算估算单测（M1-D）
 *
 * 覆盖：
 *   - estimateMessageTokens 空数组 / 文本 / toolCalls 累加
 *   - estimateToolsSchemaTokens 空 / 多 tool 累加
 *   - inferContextWindow 模型名命中 / explicit override / fallback
 *   - checkTokenBudget 三段阈值（<70 / 70-95 / ≥95）
 *   - warnIfBudgetExceeded ≥70% 写 stderr，<70% 不写
 */

import { describe, expect, it, vi } from "vitest";
import {
  checkTokenBudget,
  estimateMessageTokens,
  estimateToolsSchemaTokens,
  inferContextWindow,
  warnIfBudgetExceeded,
} from "../../../src/agent/tokenBudget";
import type { EngineMessage } from "../../../src/agent/types";
import type { ProviderStatus } from "../../../src/provider/types";

const provider = (model: string, override?: number): ProviderStatus =>
  ({
    type: "openai",
    displayName: "x",
    kind: "cloud",
    enabled: true,
    requiresApiKey: false,
    baseUrl: "x",
    model,
    timeoutMs: 1000,
    envVars: [],
    fileConfig: {} as ProviderStatus["fileConfig"],
    configured: true,
    available: true,
    reason: "",
    ...(override ? { contextWindow: override } : {}),
  } as ProviderStatus);

const msg = (role: "user" | "assistant" | "system" | "tool", text: string): EngineMessage => ({
  id: "x",
  role,
  text,
  source: "user",
});

describe("estimateMessageTokens", () => {
  it("空数组 → 0", () => {
    expect(estimateMessageTokens([])).toBe(0);
  });

  it("随文本长度线性增长", () => {
    const short = estimateMessageTokens([msg("user", "hi")]);
    const long = estimateMessageTokens([msg("user", "hi ".repeat(100))]);
    expect(long).toBeGreaterThan(short * 5);
  });

  it("toolCalls 的 args + name 计入 token 数", () => {
    const base = estimateMessageTokens([msg("assistant", "")]);
    const withTool = estimateMessageTokens([
      {
        id: "a",
        role: "assistant",
        text: "",
        source: "model",
        toolCalls: [{ id: "c1", name: "read", args: { file_path: "very-long-path.ts" } }],
      },
    ]);
    expect(withTool).toBeGreaterThan(base);
  });
});

describe("estimateToolsSchemaTokens", () => {
  it("空数组 → 0", () => {
    expect(estimateToolsSchemaTokens([])).toBe(0);
  });

  it("多 tool 累加", () => {
    const tokens = estimateToolsSchemaTokens([
      { name: "read", description: "read a file from workspace", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
      { name: "bash", description: "execute shell command", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
    ]);
    expect(tokens).toBeGreaterThan(15);
  });
});

describe("inferContextWindow", () => {
  it("explicit override 优先", () => {
    expect(inferContextWindow(provider("gpt-4", 99_999))).toBe(99_999);
  });

  it("gpt-4.1 → 1M", () => {
    expect(inferContextWindow(provider("gpt-4.1-mini"))).toBe(1_000_000);
  });

  it("gpt-4o → 128k", () => {
    expect(inferContextWindow(provider("gpt-4o"))).toBe(128_000);
  });

  it("claude-3-5-sonnet → 200k", () => {
    expect(inferContextWindow(provider("claude-3-5-sonnet-20241022"))).toBe(200_000);
  });

  it("qwen3 → 32k", () => {
    expect(inferContextWindow(provider("qwen/qwen3.6-35b-a3b"))).toBe(32_768);
  });

  it("未知模型 → fallback 32k", () => {
    expect(inferContextWindow(provider("unknown-llm-7b"))).toBe(32_768);
  });
});

describe("checkTokenBudget", () => {
  it("<70% → ok（无 warn / 无 hardCut）", () => {
    const r = checkTokenBudget([msg("user", "hi")], provider("gpt-4o"));
    expect(r.shouldWarn).toBe(false);
    expect(r.shouldHardCut).toBe(false);
    expect(r.utilizationRatio).toBeLessThan(0.01);
  });

  it("70-95% → warn 不 hardCut", () => {
    // 'a '.repeat(75) ≈ 76 tokens + 4 overhead = 80 tokens; ctx=100 → 80% utilization
    const r = checkTokenBudget([msg("user", "a ".repeat(75))], provider("gpt-4", 100));
    expect(r.shouldWarn).toBe(true);
    expect(r.shouldHardCut).toBe(false);
  });

  it("≥95% → warn + hardCut", () => {
    // 'a '.repeat(95) ≈ 96 tokens + 4 = 100 tokens; ctx=100 → 100% utilization
    const r = checkTokenBudget([msg("user", "a ".repeat(95))], provider("gpt-4", 100));
    expect(r.shouldWarn).toBe(true);
    expect(r.shouldHardCut).toBe(true);
  });

  it("toolsSchemaTokens 加到总用量", () => {
    const noTools = checkTokenBudget([msg("user", "hi")], provider("gpt-4", 100));
    const withTools = checkTokenBudget([msg("user", "hi")], provider("gpt-4", 100), 50);
    expect(withTools.estimatedTokens).toBe(noTools.estimatedTokens + 50);
  });
});

describe("warnIfBudgetExceeded", () => {
  it("<70% 不写 stderr", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    warnIfBudgetExceeded({ estimatedTokens: 10, contextWindow: 1000, utilizationRatio: 0.01, shouldWarn: false, shouldHardCut: false });
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("≥70% 写 stderr 含 utilization 百分比", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    warnIfBudgetExceeded({ estimatedTokens: 800, contextWindow: 1000, utilizationRatio: 0.8, shouldWarn: true, shouldHardCut: false });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("80.0%"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("[token-budget]"));
    stderr.mockRestore();
  });

  it("≥95% 写 stderr 含 'near limit' 标记", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    warnIfBudgetExceeded({ estimatedTokens: 970, contextWindow: 1000, utilizationRatio: 0.97, shouldWarn: true, shouldHardCut: true });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("near limit"));
    stderr.mockRestore();
  });
});
