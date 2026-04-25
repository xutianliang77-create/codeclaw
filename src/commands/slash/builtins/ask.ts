/**
 * `/ask` · read-only Q&A 模式（一次性 plan-mode 装弹）
 *
 * 语义（v1，task #57 minimum-viable）：
 *   /ask                  → 切到 plan mode，下一轮非 /ask 跑完后 restore 原 mode
 *   /ask <question>       → 同上，并把问题回显给用户便于复制提交
 *
 * 限制：
 *   - v1 不自动把 <question> 注入下一轮 prompt；用户需在下一行重新输入。
 *     注入需要 SlashResult 加 "rewrite" 变体或 queryEngine 加 queuedPrompt 机制，
 *     比当前侵入面大，留 v2。
 *   - 已装弹时再次 /ask 不会反复保存原 mode（避免把 plan 自身当"原 mode"卡死）。
 */

import { defineCommand, reply } from "../registry";

interface AskHolder {
  runAskCommand(prompt: string): string;
}

function isHolder(x: unknown): x is AskHolder {
  return !!x && typeof (x as AskHolder).runAskCommand === "function";
}

export default defineCommand({
  name: "/ask",
  category: "session",
  risk: "low",
  summary: "Arm one-shot plan mode for a read-only Q&A turn.",
  helpDetail:
    "Switches permission mode to `plan` for the next non-/ask turn. After that turn\n" +
    "completes, the previous mode is restored automatically.\n" +
    "Usage:\n" +
    "  /ask                    arm plan mode; type your question on the next line\n" +
    "  /ask <question>         same, with the question echoed back for copy/paste",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("ask command unavailable: runtime missing runAskCommand");
    }
    return reply(ctx.queryEngine.runAskCommand(ctx.rawPrompt));
  },
});
