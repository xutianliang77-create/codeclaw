/**
 * `/memory` · 记忆 / 总结概况
 */

import { defineCommand, reply } from "../registry";

interface MemoryHolder {
  buildMemoryReply(): string;
}

function isHolder(x: unknown): x is MemoryHolder {
  return !!x && typeof (x as MemoryHolder).buildMemoryReply === "function";
}

export default defineCommand({
  name: "/memory",
  category: "memory",
  risk: "low",
  summary: "Show compaction summary count and recent compaction state.",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("memory command unavailable: runtime missing buildMemoryReply");
    }
    return reply(ctx.queryEngine.buildMemoryReply());
  },
});
