/**
 * `/fix` · 修 bug 编排（v1，task #58）
 *
 * v1 = "/orchestrate" 加 fix 意图前缀 + optional fix skill。
 * 不依赖 Golden FIX runner 的验证机制；那个是 v2。
 */

import { defineCommand, reply } from "../registry";

interface FixHolder {
  runFixCommand(prompt: string): Promise<string>;
}

function isHolder(x: unknown): x is FixHolder {
  return !!x && typeof (x as FixHolder).runFixCommand === "function";
}

export default defineCommand({
  name: "/fix",
  category: "workflow",
  risk: "high",
  summary: "Plan + execute a bug fix attempt for a described issue.",
  helpDetail:
    "Runs orchestration with a 'fix' intent and (if registered) a 'fix' skill\n" +
    "to constrain which tools the agent uses. Risky steps go through pending\n" +
    "approvals (see /approvals or /approve).\n" +
    "Usage:\n" +
    "  /fix <bug description>\n" +
    "  /fix <failing test name>\n" +
    "v1 limit: does NOT auto-run npm test before/after; treat /fix as 'a focused\n" +
    "/orchestrate'. v2 will add Golden FIX runner-style verify_broken/post_verify.",
  async handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("fix command unavailable: runtime missing runFixCommand");
    }
    return reply(await ctx.queryEngine.runFixCommand(ctx.rawPrompt));
  },
});
