/**
 * Dremio Golden Suite · 打分
 *
 * 双维度判分：
 *   1. must_mention / must_not_mention（沿用 ASK suite 的字符串匹配 normalize.ts）
 *   2. tool_calls.must_invoke / must_not_invoke（看 LLM 实际调了哪些 tool）
 *
 * pass 条件：两个维度都不违规且 must_mention/must_invoke 命中 ≥ 80%。
 */

import { matchesAny, matchesSubstring } from "./normalize";
import type { DremioQuestion, DremioScoreResult } from "./dremio-types";

const PASS_THRESHOLD = 0.8;

function splitAlternatives(needle: string): string[] {
  return needle
    .split(/\s*(?:或|\/|\bor\b|\|)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function scoreDremio(
  question: DremioQuestion,
  answer: string,
  toolsInvoked: string[]
): DremioScoreResult {
  const mustMention = question.expected.must_mention ?? [];
  const mustNotMention = question.expected.must_not_mention ?? [];
  const toolSpec = question.expected.tool_calls;

  const matched: string[] = [];
  const missed: string[] = [];
  const triggered: string[] = [];

  for (const item of mustMention) {
    const alts = splitAlternatives(item);
    if (matchesAny(answer, alts)) {
      matched.push(item);
    } else {
      missed.push(item);
    }
  }

  for (const item of mustNotMention) {
    const alts = splitAlternatives(item);
    if (alts.some((n) => matchesSubstring(answer, n))) {
      triggered.push(item);
    }
  }

  // tool_calls 维度
  const invokedOk: string[] = [];
  const invokedMissing: string[] = [];
  const invokedForbidden: string[] = [];

  if (toolSpec?.must_invoke) {
    for (const item of toolSpec.must_invoke) {
      const alts = splitAlternatives(item);
      // 命中条件：toolsInvoked 里任一工具名 substring 包含 alts 里任一项（或反向）
      const hit = toolsInvoked.some((t) =>
        alts.some((a) => t.includes(a) || a.includes(t))
      );
      if (hit) invokedOk.push(item);
      else invokedMissing.push(item);
    }
  }
  if (toolSpec?.must_not_invoke) {
    for (const forbidden of toolSpec.must_not_invoke) {
      const alts = splitAlternatives(forbidden);
      const hit = toolsInvoked.some((t) =>
        alts.some((a) => t.includes(a) || a.includes(t))
      );
      if (hit) invokedForbidden.push(forbidden);
    }
  }

  // pass 判定
  const mentionThreshold = mustMention.length === 0 ? 0 : mustMention.length * PASS_THRESHOLD;
  const invokeThreshold = (toolSpec?.must_invoke?.length ?? 0) * PASS_THRESHOLD;
  const mentionOk = matched.length >= mentionThreshold && triggered.length === 0;
  const invokeOk = invokedOk.length >= invokeThreshold && invokedForbidden.length === 0;
  const pass = mentionOk && invokeOk;

  const parts: string[] = [];
  if (mustMention.length > 0) parts.push(`mention=${matched.length}/${mustMention.length}`);
  if (toolSpec?.must_invoke?.length) parts.push(`tool=${invokedOk.length}/${toolSpec.must_invoke.length}`);
  if (missed.length > 0) parts.push(`missed=[${missed.slice(0, 3).join(",")}${missed.length > 3 ? "..." : ""}]`);
  if (invokedMissing.length > 0) parts.push(`tool-missing=[${invokedMissing.join(",")}]`);
  if (triggered.length > 0) parts.push(`triggered=[${triggered.join(",")}]`);
  if (invokedForbidden.length > 0) parts.push(`tool-forbidden=[${invokedForbidden.join(",")}]`);
  if (parts.length === 0) parts.push("nothing to score");

  return {
    pass,
    matched,
    missed,
    triggered,
    invokedOk,
    invokedMissing,
    invokedForbidden,
    reason: parts.join(" "),
  };
}
