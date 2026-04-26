/**
 * CostTracker · LLM 调用记账（W3-17 部分）
 *
 * 把每次 LLM 流式调用的 token usage + latency 记到 llm_calls_raw 表，
 * 供 /cost 和未来 dashboard 查询累计成本。
 *
 * 不阻塞主流程：写库失败只 console.warn，不抛。
 *
 * 完整 Provider chain（fallback 自动跳）留 P1。
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";

import { computeCost, lookupRate } from "./rates";

export interface CallRecord {
  traceId: string;
  sessionId: string;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface CallSummary {
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalUsdCost: number;
}

const EMPTY_SUMMARY: CallSummary = {
  callCount: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalUsdCost: 0,
};

/** 写一条 llm_calls_raw；usd 由费率表自动算。db 为 null 时 noop。 */
export function recordCall(
  db: Database.Database | null,
  args: CallRecord
): { callId: string; usdCost: number } | null {
  if (!db) return null;
  const rate = lookupRate(args.provider, args.modelId);
  const usdCost = computeCost(rate, args.inputTokens, args.outputTokens);
  const callId = ulid();
  try {
    db.prepare(
      `INSERT INTO llm_calls_raw(
        call_id, trace_id, session_id, provider_id, model_id,
        input_tokens, output_tokens, usd_cost, latency_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      callId,
      args.traceId,
      args.sessionId,
      args.provider,
      args.modelId,
      args.inputTokens,
      args.outputTokens,
      usdCost,
      args.latencyMs,
      Date.now()
    );
    return { callId, usdCost };
  } catch (err) {
     
    console.warn("[costTracker] record failed:", err);
    return null;
  }
}

interface SummaryRow {
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_usd_cost: number;
}

/** 当前 sessionId 下的累计成本 */
export function summarizeBySession(
  db: Database.Database,
  sessionId: string
): CallSummary {
  const row = db
    .prepare<unknown[], SummaryRow>(
      `SELECT
         COUNT(*) AS call_count,
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(usd_cost), 0) AS total_usd_cost
       FROM llm_calls_raw
       WHERE session_id = ?`
    )
    .get(sessionId);
  return row
    ? {
        callCount: Number(row.call_count),
        totalInputTokens: Number(row.total_input_tokens),
        totalOutputTokens: Number(row.total_output_tokens),
        totalUsdCost: Number(row.total_usd_cost),
      }
    : EMPTY_SUMMARY;
}

/** 今日（本地凌晨起）跨 session 累计 */
export function summarizeToday(
  db: Database.Database,
  now: number = Date.now()
): CallSummary {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();

  const row = db
    .prepare<unknown[], SummaryRow>(
      `SELECT
         COUNT(*) AS call_count,
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(usd_cost), 0) AS total_usd_cost
       FROM llm_calls_raw
       WHERE created_at >= ?`
    )
    .get(startMs);
  return row
    ? {
        callCount: Number(row.call_count),
        totalInputTokens: Number(row.total_input_tokens),
        totalOutputTokens: Number(row.total_output_tokens),
        totalUsdCost: Number(row.total_usd_cost),
      }
    : EMPTY_SUMMARY;
}

/** 把 USD cost 渲染成 4 位小数；< $0.0001 显示 < $0.0001 */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "< $0.0001";
  return `$${usd.toFixed(4)}`;
}
