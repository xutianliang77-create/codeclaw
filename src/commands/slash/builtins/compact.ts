/**
 * `/compact` · 主动触发 context 压缩
 *
 * 可选参数：保留最近多少条消息（数值），不传走默认。
 */

import { defineCommand, reply } from "../registry";

interface CompactHolder {
  handleCompactCommand(prompt: string): string;
}

function isHolder(x: unknown): x is CompactHolder {
  return !!x && typeof (x as CompactHolder).handleCompactCommand === "function";
}

export default defineCommand({
  name: "/compact",
  category: "memory",
  risk: "low",
  summary: "Compact older messages into a summary, keep recent ones.",
  summaryZh: "压缩旧消息成摘要，保留近期对话",
  helpDetail:
    "Usage:\n" +
    "  /compact                          use default keep-recent\n" +
    "  /compact <N>                      keep the most recent N messages\n" +
    "  /compact focus on <X>             hint summary to retain focus on X (v0.8.2)\n" +
    "  /compact <N> focus on <X>         combine both",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("compact command unavailable: runtime missing handleCompactCommand");
    }
    return reply(ctx.queryEngine.handleCompactCommand(ctx.rawPrompt));
  },
});
