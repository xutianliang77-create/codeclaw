/**
 * Token 预算估算 + 阈值警告（M1-D）
 *
 * 用 gpt-tokenizer 的 cl100k_base 估算（OpenAI gpt-4 / gpt-4o / gpt-4.1 等准确；
 * 对 Anthropic / qwen 是粗估，误差 ±20%，足够做超限警告）。
 *
 * 当前不动 messages（不截断、不摘要）；只 stderr 警告 + 留 hook：
 *   - shouldWarn  ≥ 70% utilization
 *   - shouldHardCut ≥ 95%（M2-01 在这里挂 auto-compact）
 *
 * provider.contextWindow 优先走 explicit override（M2 加配置字段）；fallback 查模型名表。
 */

import { encode } from "gpt-tokenizer";
import type { EngineMessage } from "./types";
import type { ProviderStatus } from "../provider/types";

const PER_MESSAGE_OVERHEAD = 4;

/** 常见模型 ctx window 查表；模型名小写后 includes 匹配，命中即用 */
const DEFAULT_CONTEXT_WINDOW: Array<[string, number]> = [
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4.1-mini", 1_000_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4", 8192],
  ["gpt-3.5", 16_385],
  ["claude-3-5-sonnet", 200_000],
  ["claude-3-7", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-opus-4", 200_000],
  ["claude-haiku-4", 200_000],
  ["claude-3", 200_000],
  ["qwen3", 32_768],
  ["qwen2", 32_768],
  ["qwen", 32_768],
  ["deepseek", 65_536],
  ["llama-3", 128_000],
  ["llama-2", 4096],
  ["mistral", 32_768],
];
const FALLBACK_CONTEXT_WINDOW = 32_768;
const WARN_RATIO = 0.7;
const HARD_CUT_RATIO = 0.95;

export interface TokenBudgetReport {
  estimatedTokens: number;
  contextWindow: number;
  utilizationRatio: number;
  shouldWarn: boolean;
  shouldHardCut: boolean;
}

export function estimateMessageTokens(messages: EngineMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (m.text) total += encode(m.text).length;
    total += PER_MESSAGE_OVERHEAD;
    if (m.toolCalls) {
      for (const c of m.toolCalls) {
        const argText = JSON.stringify(c.args ?? {});
        total += encode(argText).length;
        total += encode(c.name).length;
      }
    }
  }
  return total;
}

/** 估算 tools schema 的 token 数（descriptions + JSON schema serialization） */
export function estimateToolsSchemaTokens(
  tools: Array<{ name: string; description: string; inputSchema: unknown }>
): number {
  if (!tools || tools.length === 0) return 0;
  const text = tools
    .map((t) => `${t.name} ${t.description} ${JSON.stringify(t.inputSchema)}`)
    .join("\n");
  return encode(text).length;
}

export function inferContextWindow(provider: ProviderStatus): number {
  const explicit = (provider as { contextWindow?: unknown }).contextWindow;
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const model = (provider.model ?? "").toLowerCase();
  for (const [key, val] of DEFAULT_CONTEXT_WINDOW) {
    if (model.includes(key)) return val;
  }
  return FALLBACK_CONTEXT_WINDOW;
}

export function checkTokenBudget(
  messages: EngineMessage[],
  provider: ProviderStatus,
  toolsSchemaTokens: number = 0
): TokenBudgetReport {
  const window = inferContextWindow(provider);
  const used = estimateMessageTokens(messages) + toolsSchemaTokens;
  const ratio = used / window;
  return {
    estimatedTokens: used,
    contextWindow: window,
    utilizationRatio: ratio,
    shouldWarn: ratio >= WARN_RATIO,
    shouldHardCut: ratio >= HARD_CUT_RATIO,
  };
}

/** 给 queryEngine 在 streamProviderResponse 前用：超阈值时 stderr 警告 */
export function warnIfBudgetExceeded(report: TokenBudgetReport): void {
  if (!report.shouldWarn) return;
  const pct = (report.utilizationRatio * 100).toFixed(1);
  const tail = report.shouldHardCut ? " ⚠️ near limit" : "";
  process.stderr.write(
    `[token-budget] ${report.estimatedTokens}/${report.contextWindow} (${pct}%)${tail}\n`
  );
}
