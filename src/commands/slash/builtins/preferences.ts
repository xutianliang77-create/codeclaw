/**
 * `/preferences` · 操作 CODECLAW.md（项目级 / 用户级）
 *
 * 用法：
 *   /preferences show              查看两层当前内容
 *   /preferences add <text>        往 <cwd>/CODECLAW.md 追加一行
 *   /preferences user-add <text>   往 ~/.codeclaw/CODECLAW.md 追加一行
 *
 * 设计：
 *   - 文本不带 markdown bullet 前缀时自动加 "- "
 *   - 64KB 上限（与 buildSystemPrompt 加载侧一致）
 *   - 不存在文件时自动创建（含 "# CodeClaw Preferences\n\n" 头）
 *   - $EDITOR 编辑模式留 M3+（跨平台 / TTY 复杂）
 */

import { defineCommand, reply } from "../registry";

interface PreferencesHolder {
  runPreferencesCommand(argsRaw: string): string;
}

function isHolder(x: unknown): x is PreferencesHolder {
  return !!x && typeof (x as PreferencesHolder).runPreferencesCommand === "function";
}

export default defineCommand({
  name: "/preferences",
  aliases: ["/prefs"],
  category: "memory",
  risk: "low",
  summary: "Show or append to CODECLAW.md (project + user level).",
  helpDetail:
    "Read or append entries to CODECLAW.md, which is auto-injected as User Preferences /\n" +
    "Project Conventions sections in the system prompt every turn.\n" +
    "Subcommands:\n" +
    "  /preferences show              dump project + user CODECLAW.md\n" +
    "  /preferences add <text>        append a bullet to <cwd>/CODECLAW.md\n" +
    "  /preferences user-add <text>   append a bullet to ~/.codeclaw/CODECLAW.md",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("preferences command unavailable: runtime missing runPreferencesCommand");
    }
    return reply(ctx.queryEngine.runPreferencesCommand(ctx.argsRaw));
  },
});
