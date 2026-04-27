/**
 * `/resume` · 恢复中断会话（提示 pending approval / 当前 session 概况）
 */

import { defineCommand, reply } from "../registry";

interface ResumeHolder {
  buildResumeReply(): string;
}

function isHolder(x: unknown): x is ResumeHolder {
  return !!x && typeof (x as ResumeHolder).buildResumeReply === "function";
}

export default defineCommand({
  name: "/resume",
  category: "session",
  risk: "low",
  summary: "Resume after interruption — show pending approvals or session summary.",
  summaryZh: "中断后恢复——显示待审批或会话摘要",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("resume command unavailable: runtime missing buildResumeReply");
    }
    return reply(ctx.queryEngine.buildResumeReply());
  },
});
