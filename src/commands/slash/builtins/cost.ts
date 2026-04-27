/**
 * `/cost` · 当前会话活动 / token 估算快照
 *
 * 当前只反映本地估算（字符/4）；真实 provider usage 跟 P0 W3 落地。
 */

import { defineCommand, reply } from "../registry";

interface CostHolder {
  runCostCommand(): string;
}

function isHolder(x: unknown): x is CostHolder {
  return !!x && typeof (x as CostHolder).runCostCommand === "function";
}

export default defineCommand({
  name: "/cost",
  category: "observability",
  risk: "low",
  summary: "Show session activity snapshot (messages, tokens, files, approvals).",
  summaryZh: "显示会话活动快照（消息 / token / 文件 / 审批）",
  helpDetail:
    "Shows current-session counters. Real input/output token usage from the provider\n" +
    "is not yet wired (planned for P0 W3); the token figure here is a local heuristic.",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("cost command unavailable: runtime missing runCostCommand");
    }
    return reply(ctx.queryEngine.runCostCommand());
  },
});
