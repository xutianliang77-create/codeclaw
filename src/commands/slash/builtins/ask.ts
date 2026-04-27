/**
 * `/ask` · read-only Q&A 模式（一次性 plan-mode 装弹）
 *
 * v2 语义（task #57 + W2-12 升级）：
 *   /ask                  → 切到 plan mode，下一轮非 /ask 跑完后 restore 原 mode（v1 行为）
 *   /ask <question>       → 同时切到 plan mode 并**自动把 <question> 作为本轮 prompt 注入**
 *                            到 LLM 路径（rewrite SlashResult）。无需用户重新输入。
 *
 * 不变量：
 *   - 已装弹时再次 /ask 不重复保存原 mode（避免把 plan 自身当"原 mode"卡死）。
 *   - rewrite 后 submitMessage 用 newPrompt 走 builtin/tool/LLM 分发，但**不再**
 *     二次进 slash registry（防递归）。
 */

import { defineCommand, reply } from "../registry";
import type { SlashResult } from "../types";

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
  summary: "Arm one-shot plan mode for a read-only Q&A turn (auto-injects inline question).",
  summaryZh: "装弹一次性 plan 模式做只读问答（自动注入内联问题）",
  helpDetail:
    "Switches permission mode to `plan` for the next non-/ask turn. After that turn\n" +
    "completes, the previous mode is restored automatically.\n" +
    "Usage:\n" +
    "  /ask                    arm plan mode; type your question on the next line\n" +
    "  /ask <question>         arm plan mode AND auto-submit <question> in the same turn",
  handler(ctx): SlashResult {
    if (!isHolder(ctx.queryEngine)) {
      return reply("ask command unavailable: runtime missing runAskCommand");
    }
    // 调一次 runAskCommand 触发 askMode 装弹（plan mode 切换 + askModePending 标记）
    ctx.queryEngine.runAskCommand(ctx.rawPrompt);

    // 解析 inline question；存在则 rewrite 让 LLM 同 turn 接管
    const question = ctx.argsRaw.trim();
    if (question) {
      return { kind: "rewrite", newPrompt: question };
    }
    // 无 inline → v1 行为：返回提示让用户在下一行输入
    return reply(
      [
        "Plan mode armed for read-only Q&A. Type your question on the next line.",
        "(Mode will restore to your previous setting after the next answer.)",
      ].join("\n")
    );
  },
});
