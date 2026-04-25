/**
 * Cost budget · 双阈值 + 行为矩阵 · #86
 *
 * 配置：
 *   sessionUsd / todayUsd / sessionTokens / todayTokens 任一可设
 *   warnAt: 接近阈值的比例（默认 0.8 = 80%）
 *   onExceeded: 'warn' | 'block'  — 超阈值的行为
 *     warn：仅日志/消息提示，不阻塞调用
 *     block：拒绝下次 LLM 调用（yield [budget exceeded] message 后中止）
 *
 * 检查时机：queryEngine 在 chain 调用前调 evaluateBudget()；
 *           三态 ok/warn/exceeded 决定后续行为。
 */

import type { CallSummary } from "./costTracker";
import { formatUsd } from "./costTracker";

export type BudgetStatus = "ok" | "warn" | "exceeded";
export type OnExceededAction = "warn" | "block";

export interface BudgetConfig {
  /** 单 session USD 上限（不传 → 不检查） */
  sessionUsd?: number;
  /** 当日跨 session USD 上限 */
  todayUsd?: number;
  /** 单 session token 上限（input + output） */
  sessionTokens?: number;
  /** 当日 token 上限 */
  todayTokens?: number;
  /** 接近阈值警告比例；默认 0.8 */
  warnAt?: number;
  /** 超阈值行为；默认 'warn' */
  onExceeded?: OnExceededAction;
}

export interface BudgetVerdict {
  status: BudgetStatus;
  /** 命中的具体阈值名 + 当前值 + 上限 */
  detail: string;
  /** 是否应阻塞下次调用（onExceeded='block' 且 status='exceeded'） */
  shouldBlock: boolean;
}

/**
 * 评估当前 session/today summary 是否超阈值。
 * 任一阈值超过 → exceeded；任一 ≥ warnAt 比例 → warn；否则 ok。
 */
export function evaluateBudget(args: {
  config: BudgetConfig;
  session: CallSummary;
  today: CallSummary;
}): BudgetVerdict {
  const { config, session, today } = args;
  const warnAt = config.warnAt ?? 0.8;
  const action = config.onExceeded ?? "warn";

  const sessionTokens = session.totalInputTokens + session.totalOutputTokens;
  const todayTokens = today.totalInputTokens + today.totalOutputTokens;

  type Check = { name: string; current: number; limit: number; format: (n: number) => string };
  const checks: Check[] = [];
  if (config.sessionUsd !== undefined) {
    checks.push({ name: "session USD", current: session.totalUsdCost, limit: config.sessionUsd, format: formatUsd });
  }
  if (config.todayUsd !== undefined) {
    checks.push({ name: "today USD", current: today.totalUsdCost, limit: config.todayUsd, format: formatUsd });
  }
  if (config.sessionTokens !== undefined) {
    checks.push({ name: "session tokens", current: sessionTokens, limit: config.sessionTokens, format: (n) => String(n) });
  }
  if (config.todayTokens !== undefined) {
    checks.push({ name: "today tokens", current: todayTokens, limit: config.todayTokens, format: (n) => String(n) });
  }

  if (checks.length === 0) {
    return { status: "ok", detail: "no budget configured", shouldBlock: false };
  }

  // 优先级：exceeded > warn > ok
  let highest: BudgetStatus = "ok";
  let detailLine = "all under budget";
  for (const check of checks) {
    if (check.current >= check.limit) {
      highest = "exceeded";
      detailLine = `${check.name} ${check.format(check.current)} >= limit ${check.format(check.limit)}`;
      break; // 一旦 exceeded 立刻返
    }
    if (check.current >= check.limit * warnAt) {
      // 此分支前的 exceeded 已 break 出循环；此处只可能升级 ok→warn
      highest = "warn";
      detailLine = `${check.name} ${check.format(check.current)} >= ${(warnAt * 100).toFixed(0)}% of ${check.format(check.limit)}`;
    }
  }

  return {
    status: highest,
    detail: detailLine,
    shouldBlock: highest === "exceeded" && action === "block",
  };
}

/** 把 BudgetConfig 渲染成多行可读字符串（/cost 命令用） */
export function formatBudgetConfig(config: BudgetConfig): string {
  if (Object.keys(config).length === 0) return "budget: not configured";
  const parts: string[] = [];
  if (config.sessionUsd !== undefined) parts.push(`session-USD-limit: ${formatUsd(config.sessionUsd)}`);
  if (config.todayUsd !== undefined) parts.push(`today-USD-limit: ${formatUsd(config.todayUsd)}`);
  if (config.sessionTokens !== undefined) parts.push(`session-tokens-limit: ${config.sessionTokens}`);
  if (config.todayTokens !== undefined) parts.push(`today-tokens-limit: ${config.todayTokens}`);
  parts.push(`warn-at: ${((config.warnAt ?? 0.8) * 100).toFixed(0)}%`);
  parts.push(`on-exceeded: ${config.onExceeded ?? "warn"}`);
  return parts.join("\n");
}

/** 从 env 读 budget（用户最简易设置方式） */
export function readBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetConfig {
  const cfg: BudgetConfig = {};
  const sessionUsd = parseFloat(env.CODECLAW_BUDGET_SESSION_USD ?? "");
  if (Number.isFinite(sessionUsd) && sessionUsd > 0) cfg.sessionUsd = sessionUsd;
  const todayUsd = parseFloat(env.CODECLAW_BUDGET_TODAY_USD ?? "");
  if (Number.isFinite(todayUsd) && todayUsd > 0) cfg.todayUsd = todayUsd;
  const sessionTokens = parseInt(env.CODECLAW_BUDGET_SESSION_TOKENS ?? "", 10);
  if (Number.isFinite(sessionTokens) && sessionTokens > 0) cfg.sessionTokens = sessionTokens;
  const todayTokens = parseInt(env.CODECLAW_BUDGET_TODAY_TOKENS ?? "", 10);
  if (Number.isFinite(todayTokens) && todayTokens > 0) cfg.todayTokens = todayTokens;
  const action = env.CODECLAW_BUDGET_ON_EXCEEDED?.toLowerCase();
  if (action === "warn" || action === "block") cfg.onExceeded = action;
  const warnAt = parseFloat(env.CODECLAW_BUDGET_WARN_AT ?? "");
  if (Number.isFinite(warnAt) && warnAt > 0 && warnAt <= 1) cfg.warnAt = warnAt;
  return cfg;
}
