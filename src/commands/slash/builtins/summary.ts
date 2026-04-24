/**
 * `/summary` · 显示当前 compaction summary
 */

import { defineCommand, reply } from "../registry";

interface SummaryHolder {
  buildSummaryReply(): string;
}

function isHolder(x: unknown): x is SummaryHolder {
  return !!x && typeof (x as SummaryHolder).buildSummaryReply === "function";
}

export default defineCommand({
  name: "/summary",
  category: "memory",
  risk: "low",
  summary: "Show the latest compaction summary, if any.",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("summary command unavailable: runtime missing buildSummaryReply");
    }
    return reply(ctx.queryEngine.buildSummaryReply());
  },
});
