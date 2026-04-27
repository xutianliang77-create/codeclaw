/**
 * `/end` · 结束当前会话，把对话压成摘要存入 L2 Memory
 *
 * 触发：跑 LLM 摘要 → 写 memory_digest 表。下次同 (channel, userId) 启动时
 * 自动 recall 注入 system message，让 LLM 有跨 session 上下文。
 *
 * 不会自动 destroy session 或退出进程——仅持久化摘要；用户可继续对话或退出。
 */

import { defineCommand, reply } from "../registry";

interface EndHolder {
  runEndCommand(): Promise<string>;
}

function isHolder(x: unknown): x is EndHolder {
  return !!x && typeof (x as EndHolder).runEndCommand === "function";
}

export default defineCommand({
  name: "/end",
  category: "session",
  risk: "low",
  summary: "End session and persist a digest into L2 Memory.",
  summaryZh: "结束会话并把摘要持久化到 L2 Memory",
  helpDetail:
    "Runs LLM summarization on the current conversation and stores the digest\n" +
    "into ~/.codeclaw/data.db. The next session for the same (channel, userId)\n" +
    "will recall the most recent 5 digests and inject them as system context.\n" +
    "Usage:\n" +
    "  /end          summarize + persist; you can keep talking or exit",
  async handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("end command unavailable: runtime missing runEndCommand");
    }
    return reply(await ctx.queryEngine.runEndCommand());
  },
});
