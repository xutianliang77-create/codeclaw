/**
 * `/forget` · 从 L2 Memory 删除摘要
 *
 * 用法：
 *   /forget --all                  全清（保留 audit 链/sessions 表，仅清 memory_digest）
 *   /forget --session <id>         按 sessionId 清
 *   /forget --since <ms>           created_at < <ms> 的全清（毫秒时间戳）
 *
 * 不传任何 flag 给提示并不删除（防误操作）。
 *
 * 边界：本命令只清 memory_digest。完整"被遗忘权"实现需要联动 audit / sessions /
 * transcript jsonl，留 P1 W3-16 完整版做。
 */

import { defineCommand, reply } from "../registry";
import type { ForgetOptions } from "../../../memory/sessionMemory/store";

interface ForgetHolder {
  runForgetCommand(opts: ForgetOptions): string;
}

function isHolder(x: unknown): x is ForgetHolder {
  return !!x && typeof (x as ForgetHolder).runForgetCommand === "function";
}

/**
 * 解析 /forget 后面的参数：
 *   --all                        → { all: true }
 *   --session <id>               → { sessionId: id }
 *   --since <ms>                 → { since: ms }
 *   不识别 / 缺参数               → null
 */
export function parseForgetArgs(rest: string): ForgetOptions | null {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  if (tokens[0] === "--all") return { all: true };

  if (tokens[0] === "--session" && tokens[1]) {
    return { sessionId: tokens[1] };
  }

  if (tokens[0] === "--since" && tokens[1]) {
    const n = Number(tokens[1]);
    return Number.isFinite(n) && n > 0 ? { since: n } : null;
  }

  return null;
}

export default defineCommand({
  name: "/forget",
  category: "session",
  risk: "high",
  summary: "Delete L2 Memory digests by all / session / since.",
  helpDetail:
    "Deletes saved session digests from ~/.codeclaw/data.db memory_digest table.\n" +
    "Audit log and sessions table are NOT affected (use separate cleanup tools).\n" +
    "Usage:\n" +
    "  /forget --all                 clear every digest\n" +
    "  /forget --session <id>        clear digests of one session\n" +
    "  /forget --since <ms>          clear digests with created_at < <ms>",
  async handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("forget command unavailable: runtime missing runForgetCommand");
    }
    const rest = ctx.rawPrompt.replace(/^\/forget\s*/, "");
    const opts = parseForgetArgs(rest);
    if (!opts) {
      return reply(
        "Usage: /forget --all | --session <id> | --since <ms>"
      );
    }
    return reply(ctx.queryEngine.runForgetCommand(opts));
  },
});
