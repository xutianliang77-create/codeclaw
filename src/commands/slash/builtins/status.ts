/**
 * `/status` · 查看会话状态
 */

import { defineCommand, reply } from "../registry";

interface StatusHolder {
  buildStatusReply(): string;
}

function isHolder(x: unknown): x is StatusHolder {
  return !!x && typeof (x as StatusHolder).buildStatusReply === "function";
}

export default defineCommand({
  name: "/status",
  category: "session",
  risk: "low",
  summary: "Show current session / provider / model / pending approval status.",
  summaryZh: "显示会话 / provider / model / 审批 状态",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("status command unavailable: runtime missing buildStatusReply");
    }
    return reply(ctx.queryEngine.buildStatusReply());
  },
});
