/**
 * `/plan` · 只产计划，不执行（dry-run）
 */

import { defineCommand, reply } from "../registry";

interface PlanHolder {
  runPlanCommand(prompt: string): string;
}

function isHolder(x: unknown): x is PlanHolder {
  return !!x && typeof (x as PlanHolder).runPlanCommand === "function";
}

export default defineCommand({
  name: "/plan",
  category: "workflow",
  risk: "low",
  summary: "Build an orchestration plan from a goal (no side effects).",
  summaryZh: "给目标产出 orchestration 计划（不写）",
  helpDetail:
    "Usage:\n" +
    "  /plan <goal>            generate plan steps for <goal>",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("plan command unavailable: runtime missing runPlanCommand");
    }
    return reply(ctx.queryEngine.runPlanCommand(ctx.rawPrompt));
  },
});
