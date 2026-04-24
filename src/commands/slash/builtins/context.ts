/**
 * `/context` · 当前上下文使用情况
 */

import { defineCommand, reply } from "../registry";

interface ContextHolder {
  buildContextReply(): string;
}

function isHolder(x: unknown): x is ContextHolder {
  return !!x && typeof (x as ContextHolder).buildContextReply === "function";
}

export default defineCommand({
  name: "/context",
  category: "observability",
  risk: "low",
  summary: "Show turn count, message count, char count, estimated tokens.",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("context command unavailable: runtime missing buildContextReply");
    }
    return reply(ctx.queryEngine.buildContextReply());
  },
});
