/**
 * `/remember` · 把后面的文本作 user-type 长期记忆落盘到当前项目（M2-02）
 *
 * 用法：
 *   /remember user is data scientist focused on observability
 *   /remember <free text>
 *
 * 落盘到 ~/.codeclaw/projects/<sha256(realpath(workspace)):16>/memory/user_note_<ts>.md
 * 写入前过 redactSecretsInText（防误存 API key）。
 *
 * 同 LLM 调 memory_write tool 等价，但走 slash 让用户显式控制。
 */

import { defineCommand, reply } from "../registry";

interface RememberHolder {
  rememberQuickNote(text: string): string;
}

function isHolder(x: unknown): x is RememberHolder {
  return !!x && typeof (x as RememberHolder).rememberQuickNote === "function";
}

export default defineCommand({
  name: "/remember",
  category: "memory",
  risk: "low",
  summary: "Save a fact / preference to long-term project memory.",
  helpDetail:
    "Saves the rest of the line as a user-type memory entry, persisted under\n" +
    "  ~/.codeclaw/projects/<hash>/memory/user_note_<ts>.md\n" +
    "and listed in the system prompt as Project Memory in future sessions.\n" +
    "Usage: /remember <text>",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("remember command unavailable: runtime missing rememberQuickNote");
    }
    return reply(ctx.queryEngine.rememberQuickNote(ctx.argsRaw));
  },
});
