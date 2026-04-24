/**
 * `/help` · 列出注册表里所有命令（按 category 分组）
 *
 * 实现：拿 registry 自身的 generateHelp。
 * 由于 SlashContext 不直接暴露 registry，约定 queryEngine 上挂一个
 * getSlashRegistry() 即可（duck-type）。
 */

import { defineCommand, reply } from "../registry";
import type { SlashRegistry } from "../registry";

interface HelpHolder {
  getSlashRegistry(): SlashRegistry;
}

function isHolder(x: unknown): x is HelpHolder {
  return !!x && typeof (x as HelpHolder).getSlashRegistry === "function";
}

export default defineCommand({
  name: "/help",
  category: "help",
  risk: "low",
  summary: "List all available slash commands grouped by category.",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply(
        "help command unavailable: runtime missing getSlashRegistry()"
      );
    }
    return reply(ctx.queryEngine.getSlashRegistry().generateHelp());
  },
});
