/**
 * `/export` · 导出会话到文件
 */

import { defineCommand, reply } from "../registry";

interface ExportHolder {
  handleExportCommand(prompt: string): Promise<string>;
}

function isHolder(x: unknown): x is ExportHolder {
  return !!x && typeof (x as ExportHolder).handleExportCommand === "function";
}

export default defineCommand({
  name: "/export",
  category: "session",
  risk: "low",
  summary: "Export current session (transcript + metadata) to a file.",
  summaryZh: "导出当前会话（对话 + 元数据）到文件",
  helpDetail:
    "Usage:\n" +
    "  /export                 use default path under ~/.codeclaw/sessions\n" +
    "  /export <path>          write to a specific file",
  async handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("export command unavailable: runtime missing handleExportCommand");
    }
    return reply(await ctx.queryEngine.handleExportCommand(ctx.rawPrompt));
  },
});
