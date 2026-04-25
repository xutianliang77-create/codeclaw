/**
 * Golden Set · /fix runner 类型定义
 */

export type FixDifficulty = "easy" | "medium" | "hard";
export type FixLanguage = "ts" | "js" | "py" | "go" | "rs" | string;

export interface FixDiffScope {
  allow_paths: string[];
  max_files: number;
  max_lines: number;
}

export interface FixSetup {
  install: string;
  /** verify_broken 退出 0 = 初始 bug 存在 */
  verify_broken: string;
}

export interface FixExpected {
  post_verify: string;
  diff_scope: FixDiffScope;
  forbidden_changes: string[];
  time_budget_sec: number;
  token_budget_usd: number;
}

export interface FixTask {
  id: string;
  version: number;
  language: FixLanguage;
  workspace: string;
  setup: FixSetup;
  prompt: string;
  expected: FixExpected;
  category: string;
  difficulty: FixDifficulty;
  /** loader 注入的绝对路径，loader.ts 之外只读 */
  absoluteWorkspace?: string;
  taskFile?: string;
}

export interface FixRunRecord {
  id: string;
  version: number;
  language: string;
  category: string;
  difficulty: FixDifficulty;
  setupOk: boolean;
  setupDetail?: string;
  brokenOk: boolean;
  brokenDetail?: string;
  postVerifyOk: boolean;
  postVerifyDetail?: string;
  diffOk: boolean;
  diffDetail?: string;
  changedFiles: number;
  changedLines: number;
  forbiddenHit: string[];
  durationMs: number;
  pass: boolean;
  reason: string;
  timestamp: number;
}

export interface FixSummary {
  total: number;
  passed: number;
  failed: number;
  /** loader / shell 异常 */
  errored: number;
  totalDurationMs: number;
  startedAt: number;
}

export interface FixRunnerConfig {
  ids?: string[];
  difficultyFilter?: FixDifficulty[];
  /** 默认 false；true 时跳过 setup.install（依赖已预装） */
  skipInstall?: boolean;
  /** 仅跑到 verify_broken 步：用于验证 fixture 初始 bug 仍存在 */
  verifyBrokenOnly?: boolean;
  /** dry-run：仅加载 + 校验 */
  dryRun?: boolean;
  verbose?: boolean;
  reportPath?: string;
}
