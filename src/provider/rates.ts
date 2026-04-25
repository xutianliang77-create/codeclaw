/**
 * Provider 费率表 · 用于 CostTracker 计算 USD 成本
 *
 * 数据来源：各 provider 公开定价（截止 2026-04-25）。**保守估算**——
 * 真实账单以官网 invoice 为准。模型不在表里返回 0（不报错）。
 *
 * 单位：USD per 1K tokens（input / output 分开计）。
 */

export interface RateTable {
  /** input price USD per 1K tokens */
  input: number;
  /** output price USD per 1K tokens */
  output: number;
}

interface RateRule {
  /** 完整 provider type，如 "openai" / "anthropic" / "ollama" / "lmstudio" */
  provider: string;
  /** 模型匹配：精确串 或 regex（^/$ 隐式加） */
  modelMatch: string | RegExp;
  rate: RateTable;
}

const RATE_TABLE: RateRule[] = [
  // ─── OpenAI ───
  { provider: "openai", modelMatch: /^gpt-4o-mini.*$/i, rate: { input: 0.00015, output: 0.0006 } },
  { provider: "openai", modelMatch: /^gpt-4o.*$/i,      rate: { input: 0.0025,  output: 0.01   } },
  { provider: "openai", modelMatch: /^gpt-4\.1-mini.*$/i, rate: { input: 0.0004, output: 0.0016 } },
  { provider: "openai", modelMatch: /^gpt-4\.1.*$/i,    rate: { input: 0.002,   output: 0.008  } },
  { provider: "openai", modelMatch: /^gpt-3\.5.*$/i,    rate: { input: 0.0005,  output: 0.0015 } },

  // ─── Anthropic ───
  { provider: "anthropic", modelMatch: /^claude-3-5-haiku.*$/i,  rate: { input: 0.001,  output: 0.005  } },
  { provider: "anthropic", modelMatch: /^claude-haiku-4.*$/i,    rate: { input: 0.0008, output: 0.004  } },
  { provider: "anthropic", modelMatch: /^claude-3-5-sonnet.*$/i, rate: { input: 0.003,  output: 0.015  } },
  { provider: "anthropic", modelMatch: /^claude-sonnet-4.*$/i,   rate: { input: 0.003,  output: 0.015  } },
  { provider: "anthropic", modelMatch: /^claude-3-opus.*$/i,     rate: { input: 0.015,  output: 0.075  } },
  { provider: "anthropic", modelMatch: /^claude-opus-4.*$/i,     rate: { input: 0.015,  output: 0.075  } },

  // ─── 本地 / 自托管 ───
  // 本地推理零边际成本——但保留电费/算力的保守估值（GPU 使用约 50w，按 0.1$/kWh
  // 估 4096 token / 30s 约 0.0001$ 吃 GPU；这里按 0 简化，需要时调）
  { provider: "ollama",   modelMatch: /.*/, rate: { input: 0, output: 0 } },
  { provider: "lmstudio", modelMatch: /.*/, rate: { input: 0, output: 0 } },
];

/** 查找 provider+model 的费率；找不到返回 0 费率（不报错，让下游计算 cost=0）*/
export function lookupRate(provider: string, modelId: string | undefined | null): RateTable {
  if (!modelId) return { input: 0, output: 0 };
  for (const rule of RATE_TABLE) {
    if (rule.provider !== provider) continue;
    const matched =
      typeof rule.modelMatch === "string"
        ? rule.modelMatch === modelId
        : rule.modelMatch.test(modelId);
    if (matched) return rule.rate;
  }
  return { input: 0, output: 0 };
}

/** 计算单次调用的 USD 成本（per 1K tokens） */
export function computeCost(
  rate: RateTable,
  inputTokens: number,
  outputTokens: number
): number {
  return (inputTokens * rate.input + outputTokens * rate.output) / 1000;
}
