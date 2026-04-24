/**
 * `/diff` · 列出本会话改动过的文件
 */

import { defineCommand, reply } from "../registry";

interface DiffHolder {
  buildDiffReply(): string;
}

function isHolder(x: unknown): x is DiffHolder {
  return !!x && typeof (x as DiffHolder).buildDiffReply === "function";
}

export default defineCommand({
  name: "/diff",
  category: "observability",
  risk: "low",
  summary: "List files this session has modified or created.",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("diff command unavailable: runtime missing buildDiffReply");
    }
    return reply(ctx.queryEngine.buildDiffReply());
  },
});
