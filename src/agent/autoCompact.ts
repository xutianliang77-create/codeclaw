/**
 * autoCompact —— M2-01：超阈值时把旧 turn 摘要为一条 assistant message（M2-01）
 *
 * 触发：tokenBudget.shouldHardCut（≥95%）。M1-D 只 warn 不动 messages，由本模块真压缩。
 *
 * 与现网 performCompact（queryEngine.ts:2675）的区别 / 互斥：
 *   - performCompact 走 DEFAULT_AUTO_COMPACT_THRESHOLD = 167_000 tokens 触发，
 *     是 reactive compact（provider 报 transient err 时重试前压一把）
 *   - autoCompact 走 tokenBudget.shouldHardCut（≥95% × ctxWindow），是 multi-turn
 *     循环里 stream 前的 proactive 压缩
 *   - 二者不冲突：performCompact 仍保留作为 provider error 恢复路径；
 *     autoCompact 接 multi-turn 长对话主流程
 *
 * 关键不变量（保 OpenAI / Anthropic 协议合法）：
 *   - 不允许把 assistant(toolCalls) 与其后续 tool_result 拆开到 oldMessages / retained 两边；
 *     完整 turn 块要么全压缩、要么全保留（splitForCompact 做边界对齐）
 *   - summary message 用 role:"assistant", source:"summary" —— 沿用 performCompact
 *     的现网约定，可被 getProviderMessages filter 通过（spec patch B1 修了这点）
 *   - saveMemoryDigest 因 FK 约束可能落库失败（session 行未 INSERT 时），try/catch 兜底
 *     不阻塞 compact 主流程（spec patch B3）
 */

import { summarizeSession, type SummarizeInvoker } from "../memory/sessionMemory/summarizer";
import { saveMemoryDigest } from "../memory/sessionMemory/store";
import { checkTokenBudget } from "./tokenBudget";
import type { EngineMessage } from "./types";
import type { ProviderStatus } from "../provider/types";
import type { ChannelType } from "../channels/channelAdapter";
import type Database from "better-sqlite3";

export interface AutoCompactOptions {
  /** 保留最近 N 个 user-assistant turn；默认 5 */
  keepRecentTurns?: number;
  /** summary 后仍 ≥95% 时启用滑窗硬截兜底；默认 true */
  hardCutFallback?: boolean;
  /** 调摘要 LLM 的 invoker；通常 createProviderSummarizer(provider) */
  invoker: SummarizeInvoker;
  sessionId: string;
  /** MemoryDigest 表 NOT NULL 字段 */
  channel: ChannelType;
  userId: string;
  /** null → 仅生成 summary 消息，不落库（runner / 测试用） */
  dataDb: Database.Database | null;
  abortSignal?: AbortSignal;
}

export interface AutoCompactResult {
  messages: EngineMessage[];
  compacted: boolean;
  /** 被压缩掉的旧消息数（compacted=true 时有值） */
  compactedTurnCount?: number;
}

export async function autoCompactIfNeeded(
  messages: EngineMessage[],
  provider: ProviderStatus,
  opts: AutoCompactOptions
): Promise<AutoCompactResult> {
  const report = checkTokenBudget(messages, provider);
  if (!report.shouldHardCut) return { messages, compacted: false };

  const keep = opts.keepRecentTurns ?? 5;
  const { oldMessages, retained } = splitForCompact(messages, keep);
  if (oldMessages.length < 2) {
    // 候选太少不值得压；让滑窗兜底处理或留给上层
    return { messages, compacted: false };
  }

  const digest = await summarizeSession(
    opts.invoker,
    oldMessages,
    {
      sessionId: opts.sessionId,
      channel: opts.channel,
      userId: opts.userId,
    },
    opts.abortSignal
  );

  if (opts.dataDb) {
    try {
      saveMemoryDigest(opts.dataDb, digest);
    } catch (err) {
      // FK violation（session 行未落库）/ 磁盘错都不阻塞主流程
      process.stderr.write(
        `[auto-compact] saveMemoryDigest skipped: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  const summaryMessage: EngineMessage = {
    id: `compact-${digest.digestId}`,
    role: "assistant",
    text: `[auto-compact #${digest.digestId.slice(0, 8)}]\n${digest.summary}\n\n(${oldMessages.length} messages compacted)`,
    source: "summary",
  };

  let compactedMessages: EngineMessage[] = [summaryMessage, ...retained];

  // 二次 budget check；仍 ≥95% 启用滑窗硬截
  const recheck = checkTokenBudget(compactedMessages, provider);
  if (recheck.shouldHardCut && (opts.hardCutFallback ?? true)) {
    compactedMessages = slidingWindowHardCut(compactedMessages, provider);
  }

  return {
    messages: compactedMessages,
    compacted: true,
    compactedTurnCount: oldMessages.length,
  };
}

/**
 * 反向数最近 keep 个 user 消息为 turn 起点；不准把 assistant(toolCalls) 与其
 * tool_result 拆两边（边界对齐到下一个 user 的索引）。
 *
 * 边界规则：
 *   - 起点必须是 user role（不是 tool / assistant / system）
 *   - 若 retained[0] 落在 tool / assistant(toolCalls)，回退 cutoffIndex 到上一个 user
 */
export function splitForCompact(
  messages: EngineMessage[],
  keep: number
): { oldMessages: EngineMessage[]; retained: EngineMessage[] } {
  // 反向找：第 (keep+1) 个 user 后面的位置 = cutoff
  let userCount = 0;
  let cutoffIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount += 1;
      if (userCount > keep) {
        // 这个 user 不保留；retained 从下一个 user 起
        cutoffIndex = i + 1;
        break;
      }
    }
  }

  // 边界对齐：retained[0] 不能是 tool 也不能是 orphan assistant(toolCalls)；
  // 安全做法：cutoffIndex 必须落在 user role 上（如果不是，前进到下一个 user）
  while (
    cutoffIndex < messages.length &&
    messages[cutoffIndex].role !== "user" &&
    messages[cutoffIndex].source !== "summary"
  ) {
    cutoffIndex += 1;
  }

  return {
    oldMessages: messages.slice(0, cutoffIndex),
    retained: messages.slice(cutoffIndex),
  };
}

/**
 * 兜底：summary 后仍超 95% 时反向移除最旧的非 summary 消息直到 <95%。
 * 永远保留：source:"summary"；移除时维持完整 tool_call_id 链（不留 orphan tool）
 */
export function slidingWindowHardCut(
  messages: EngineMessage[],
  provider: ProviderStatus
): EngineMessage[] {
  const cur: EngineMessage[] = [...messages];
  while (cur.length > 1) {
    const report = checkTokenBudget(cur, provider);
    if (!report.shouldHardCut) break;

    const removableIdx = cur.findIndex((m) => m.source !== "summary");
    if (removableIdx < 0) break;
    cur.splice(removableIdx, 1);

    // 清理 orphan tool message：若头部紧跟 tool 但其引用的 assistant.toolCalls 已被砍
    while (cur.length > 0 && cur[0].role === "tool") cur.shift();
  }
  return cur;
}
