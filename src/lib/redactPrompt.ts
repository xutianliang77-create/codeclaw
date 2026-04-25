/**
 * Prompt redaction · #92 T8
 *
 * 发请求给云端 LLM 前，对 messages 内容跑 secretScan，命中的敏感片段替换为
 * [REDACTED:<rule-name>]，避免 API key / token 等通过 prompt 二次泄露。
 *
 * 默认开启；env CODECLAW_NO_PROMPT_REDACT=1 关闭（罕用，需用户显式同意）。
 *
 * 设计：
 *   - 仅 high 严重度规则触发 redact（medium 仅 doctor / commit 用，避免误杀正常文本）
 *   - 由后向前替换避免 offset 漂移
 *   - 不修改原 messages 引用（返回新数组）
 */

import type { EngineMessage } from "../agent/types";
import { scanForSecrets, DEFAULT_RULES, type SecretFinding } from "./secretScan";

export interface RedactPromptOptions {
  /** true 禁用（覆盖 env）；用于测试 */
  disabled?: boolean;
  /** 自定义规则；不传走 DEFAULT_RULES 的 high 子集 */
  rules?: typeof DEFAULT_RULES;
}

export function isPromptRedactEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CODECLAW_NO_PROMPT_REDACT?.trim().toLowerCase();
  return v !== "1" && v !== "true" && v !== "yes";
}

export function redactSecretsInText(input: string, opts: RedactPromptOptions = {}): {
  output: string;
  findings: SecretFinding[];
} {
  if (opts.disabled) return { output: input, findings: [] };
  const rules = opts.rules ?? DEFAULT_RULES.filter((r) => r.severity === "high");
  const findings = scanForSecrets(input, rules);
  if (findings.length === 0) return { output: input, findings: [] };

  // 由后向前 splice，避免 index 漂移
  const sorted = [...findings].sort((a, b) => b.index - a.index);
  let out = input;
  for (const f of sorted) {
    const end = f.index + f.match.length;
    out = out.slice(0, f.index) + `[REDACTED:${f.rule}]` + out.slice(end);
  }
  return { output: out, findings };
}

/**
 * 对 messages 数组逐条 redact。返回新数组（不修改原引用）。
 * 命中数 totalFindings 供 caller 决定是否记 audit / 警告。
 */
export function redactSecretsInMessages(
  messages: EngineMessage[],
  opts: RedactPromptOptions = {}
): { messages: EngineMessage[]; totalFindings: number } {
  if (opts.disabled || !isPromptRedactEnabled()) {
    return { messages, totalFindings: 0 };
  }
  let totalFindings = 0;
  const out: EngineMessage[] = messages.map((m) => {
    const r = redactSecretsInText(m.text, opts);
    if (r.findings.length === 0) return m;
    totalFindings += r.findings.length;
    return { ...m, text: r.output };
  });
  return { messages: out, totalFindings };
}
