/**
 * Golden Set Runner —— 类型定义
 *
 * 参见 doc/specs/golden-set.md §3.1
 */

export type AskCategory =
  | "code-understanding"
  | "debug"
  | "architecture"
  | "tool-choice"
  | "cli-usage"
  | "snippet"
  | "refusal";

export type Difficulty = "easy" | "medium" | "hard";

/** 单题定义（加载自 test/golden/ask/{id}.yaml） */
export interface AskQuestion {
  id: string;
  version: number;
  category: AskCategory;
  difficulty: Difficulty;
  requires: {
    workspace?: string; // tarball id 指向 test/golden/workspaces/
    tools?: string[];
  };
  prompt: string;
  expected: {
    must_mention?: string[];
    must_not_mention?: string[];
    rubric?: string;
    answer_key?: string;
  };
  deprecated?: boolean;
}

/** Scorer 输出 */
export interface ScoreResult {
  pass: boolean;
  matched: string[]; // must_mention 命中的片段
  missed: string[]; // must_mention 未命中的
  triggered: string[]; // must_not_mention 被命中的（违规）
  score: number; // matched.length - triggered.length
  maxScore: number; // must_mention.length
  reason: string;
}

/** 一次运行的结果记录 */
export interface AskRunRecord {
  id: string;
  version: number;
  category: AskCategory;
  difficulty: Difficulty;
  provider?: string;
  modelId?: string;
  promptChars: number;
  answerChars: number;
  answerExcerpt: string; // 截断到 300 字
  latencyMs: number;
  score: ScoreResult;
  timestamp: number;
}

/** 运行配置 */
export interface RunnerConfig {
  ids?: string[]; // 限制跑哪几题；空 = 全量
  since?: string; // 仅跑自 git ref 后改动相关的题目（通过 $GIT_DIFF 匹配 workspace）
  dryRun?: boolean; // 只加载 + 校验，不真调 LLM
  verbose?: boolean;
  reportPath?: string; // 报告输出 jsonl；默认 test/golden/reports/{date}-ask.jsonl
  provider?: string; // provider id（覆盖默认）
  useMock?: boolean; // 强制 mock provider
  categoryFilter?: AskCategory[];
  difficultyFilter?: Difficulty[];
}

/** 报告汇总 */
export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  byCategory: Record<AskCategory, { total: number; passed: number; rate: number }>;
  refusalRate: number; // refusal 类的通过率，必须 1.0
  overallRate: number;
  meetsGate: boolean; // 总通过率 ≥ 0.85 && refusalRate === 1 && 每类 ≥ 0.7
  startedAt: number;
  durationMs: number;
}
