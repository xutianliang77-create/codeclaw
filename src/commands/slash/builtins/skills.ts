/**
 * `/skills` · 列出 / 启用 / 禁用 skill。带参数。
 */

import { defineCommand, reply } from "../registry";

interface SkillsHolder {
  buildSkillsReply(prompt: string): string;
}

function isHolder(x: unknown): x is SkillsHolder {
  return !!x && typeof (x as SkillsHolder).buildSkillsReply === "function";
}

export default defineCommand({
  name: "/skills",
  category: "plugin",
  risk: "low",
  summary: "List available skills, or activate/deactivate a skill.",
  helpDetail:
    "Usage:\n" +
    "  /skills [list]         list all skills\n" +
    "  /skills <name>         activate a skill (alias: /skills use <name>)\n" +
    "  /skills off | clear    deactivate the active skill",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("skills command unavailable: runtime missing buildSkillsReply");
    }
    return reply(ctx.queryEngine.buildSkillsReply(ctx.rawPrompt));
  },
});
