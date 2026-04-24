/**
 * `/orchestrate` · 完整 plan→execute→reflect 流（受 active skill 工具白名单约束）
 *
 * 注：当前实现里 reflector decision = "replan" 时不会自动二轮，
 * 这是 W2 已知半成品，跟踪在 task #56 / 后续 W2-03。
 */

import { defineCommand, reply } from "../registry";

interface OrchestrateHolder {
  runOrchestrateCommand(prompt: string): Promise<string>;
}

function isHolder(x: unknown): x is OrchestrateHolder {
  return !!x && typeof (x as OrchestrateHolder).runOrchestrateCommand === "function";
}

export default defineCommand({
  name: "/orchestrate",
  category: "workflow",
  risk: "high",
  summary: "Plan + execute + reflect for a goal (may request user approvals).",
  helpDetail:
    "Usage:\n" +
    "  /orchestrate <goal>     full Planner→Executor→Reflector cycle for <goal>\n" +
    "Side effects: may write files, run tools; risky steps go through pending\n" +
    "approvals (see /approvals or /approve).",
  async handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply(
        "orchestrate command unavailable: runtime missing runOrchestrateCommand"
      );
    }
    return reply(await ctx.queryEngine.runOrchestrateCommand(ctx.rawPrompt));
  },
});
