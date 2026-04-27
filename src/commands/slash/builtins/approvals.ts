/**
 * `/approvals` · 列出 pending approvals (tool + orchestration)
 */

import { defineCommand, reply } from "../registry";

interface ApprovalsHolder {
  buildApprovalsReply(): string;
}

function isHolder(x: unknown): x is ApprovalsHolder {
  return !!x && typeof (x as ApprovalsHolder).buildApprovalsReply === "function";
}

export default defineCommand({
  name: "/approvals",
  category: "permission",
  risk: "low",
  summary: "List pending tool / orchestration approvals.",
  summaryZh: "列出待审批的工具 / 编排请求",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("approvals command unavailable: runtime missing buildApprovalsReply");
    }
    return reply(ctx.queryEngine.buildApprovalsReply());
  },
});
