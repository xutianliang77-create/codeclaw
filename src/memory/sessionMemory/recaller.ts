/**
 * L2 Session Memory · 召回层
 *
 * 新会话启动时调用 `recallRecent` 拉最近 N 条摘要，拼成一段 system message
 * 注入到 messages 头部，让 LLM 在新会话有"上次说什么"的上下文。
 *
 * 设计：
 *   - 默认 limit=5：覆盖最近 5 个 session 的简要历史，token 预算可控
 *   - 摘要按时间倒序拉（最新在最前），但 system message 里**正序**显示
 *     （让 LLM 按时间线理解上下文进展）
 *   - 空数据返回 systemMessage=null，调用方应跳过注入
 */

import type Database from "better-sqlite3";
import type { ChannelType } from "../../channels/channelAdapter";
import type { EngineMessage } from "../../agent/types";
import { loadRecentDigests, type MemoryDigest } from "./store";

export interface RecallResult {
  digests: MemoryDigest[];
  /** 已构造好的 system message，可直接 prepend 到 engine messages 头部 */
  systemMessage: EngineMessage | null;
}

/** 把毫秒时间戳格式化为本地易读串（YYYY-MM-DD HH:MM）*/
function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildRecallSystemMessage(digests: MemoryDigest[]): EngineMessage | null {
  if (digests.length === 0) return null;
  // 倒序拉的（最新在前），systemMessage 里反过来按时间线正序显示
  const sorted = [...digests].sort((a, b) => a.createdAt - b.createdAt);
  const lines = [
    "你和该用户的近期对话摘要（用于上下文连续性，按时间从早到晚）：",
    ...sorted.map(
      (d, i) => `${i + 1}. [${formatTimestamp(d.createdAt)}] ${d.summary}`
    ),
    "",
    "请在回答时参考以上历史，但优先回应当前用户输入。如历史与当前问题无关可忽略。",
  ];
  return {
    id: `recall-${digests[0].digestId}`,
    role: "system",
    text: lines.join("\n"),
    source: "model",
  };
}

/**
 * 主入口：拉最近 N 条 digest 并构造 system message。
 * @param limit 默认 5；过多会膨胀 input tokens，过少又记不住事
 */
export function recallRecent(
  db: Database.Database,
  channel: ChannelType,
  userId: string,
  limit = 5
): RecallResult {
  const digests = loadRecentDigests(db, channel, userId, limit);
  return {
    digests,
    systemMessage: buildRecallSystemMessage(digests),
  };
}
