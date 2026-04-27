/**
 * `/review` · 用 review skill 做 read-only 审查（仍走 plan→execute→reflect）
 */

import { defineCommand, reply } from "../registry";

interface ReviewHolder {
  runReviewCommand(prompt: string): Promise<string>;
}

function isHolder(x: unknown): x is ReviewHolder {
  return !!x && typeof (x as ReviewHolder).runReviewCommand === "function";
}

export default defineCommand({
  name: "/review",
  category: "workflow",
  risk: "medium",
  summary: "Run a review (read-only orchestration) on a goal.",
  summaryZh: "对目标做 review（只读 orchestration）",
  helpDetail:
    "Usage:\n" +
    "  /review <goal>          plan + execute under the review skill, no edits\n" +
    "Will populate pending orchestration approvals if execution proposed risky steps.",
  async handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("review command unavailable: runtime missing runReviewCommand");
    }
    return reply(await ctx.queryEngine.runReviewCommand(ctx.rawPrompt));
  },
});
