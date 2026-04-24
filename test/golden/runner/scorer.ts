/**
 * Golden Set Scorer —— 打分逻辑
 *
 * 对齐 doc/specs/golden-set.md §3.4：
 *   score = matched(must_mention) - penalty(must_not_mention)
 *   pass  = score ≥ must_mention.length * 0.8 且 penalty === 0
 *
 * 特性：
 *   - must_mention 里的字符串支持"A 或 B 或 C"用 "或" / "or" 分隔的多选一
 *   - must_not_mention 一旦命中 penalty += 1 且 pass = false
 *   - 空 must_mention 视为"无必提及"，只要无 must_not_mention 命中即 pass
 */

import type { AskQuestion, ScoreResult } from "./types";
import { matchesAny, matchesSubstring } from "./normalize";

const PASS_THRESHOLD = 0.8;

/** "A 或 B" → ["A","B"]；"A or B" → ["A","B"]；单个保留为 [s] */
function splitAlternatives(needle: string): string[] {
  return needle
    .split(/\s*(?:或|\/|or|\|)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function score(question: AskQuestion, answer: string): ScoreResult {
  const mustMention = question.expected.must_mention ?? [];
  const mustNotMention = question.expected.must_not_mention ?? [];

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
    // must_not_mention 中"或" 语义上也是"任一命中即违规"
    if (alts.some((n) => matchesSubstring(answer, n))) {
      triggered.push(item);
    }
  }

  const scoreValue = matched.length - triggered.length;
  const maxScore = Math.max(1, mustMention.length); // 避免 0 分母
  const threshold = mustMention.length === 0 ? 0 : mustMention.length * PASS_THRESHOLD;

  const pass = scoreValue >= threshold && triggered.length === 0;

  const parts: string[] = [];
  if (matched.length > 0) parts.push(`matched=${matched.length}/${mustMention.length}`);
  if (missed.length > 0) parts.push(`missed=[${missed.slice(0, 3).join(",")}${missed.length > 3 ? "..." : ""}]`);
  if (triggered.length > 0) parts.push(`triggered=[${triggered.join(",")}]`);
  if (parts.length === 0) parts.push("nothing to score");

  return {
    pass,
    matched,
    missed,
    triggered,
    score: scoreValue,
    maxScore,
    reason: parts.join(" "),
  };
}
