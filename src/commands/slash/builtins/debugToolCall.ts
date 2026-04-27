/**
 * `/debug-tool-call` · 打印最近一次工具调用的上下文
 */

import { defineCommand, reply } from "../registry";

interface DebugHolder {
  buildDebugToolCallReply(prompt: string): string;
}

function isHolder(x: unknown): x is DebugHolder {
  return !!x && typeof (x as DebugHolder).buildDebugToolCallReply === "function";
}

export default defineCommand({
  name: "/debug-tool-call",
  category: "observability",
  risk: "low",
  summary: "Inspect the most recent tool invocation (input/output/error).",
  summaryZh: "查看最近一次工具调用详情（输入 / 输出 / 错误）",
  helpDetail:
    "Usage:\n" +
    "  /debug-tool-call            show the latest tool call\n" +
    "  /debug-tool-call <toolName> filter by a specific tool name",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply(
        "debug-tool-call command unavailable: runtime missing buildDebugToolCallReply"
      );
    }
    return reply(ctx.queryEngine.buildDebugToolCallReply(ctx.rawPrompt));
  },
});
