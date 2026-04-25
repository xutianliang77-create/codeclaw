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
    "  /fix <bug> -- verify \"<test cmd>\"\n" +
    "v2: pre/post verify_broken/verify_fixed via the cmd, plus git diff --stat.\n" +
    "v3 diff_scope: if the resulting diff exceeds 5 files OR 300 lines, the\n" +
    "    reply ends with 'diff-scope: ABORT' (no auto-rollback; you decide).\n" +
    "v3 auto-verify: when --verify is omitted, scripts.test from package.json\n" +
    "    is auto-detected (npm placeholder is skipped).",
  async handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("fix command unavailable: runtime missing runFixCommand");
    }
    return reply(await ctx.queryEngine.runFixCommand(ctx.rawPrompt));
  },
});
