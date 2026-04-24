/**
 * `/mcp` · 列出 / 调用 MCP servers / tools / resources
 */

import { defineCommand, reply } from "../registry";

interface McpHolder {
  handleMcpCommand(prompt: string): Promise<string>;
}

function isHolder(x: unknown): x is McpHolder {
  return !!x && typeof (x as McpHolder).handleMcpCommand === "function";
}

export default defineCommand({
  name: "/mcp",
  category: "integration",
  risk: "medium",
  summary: "List MCP servers / tools / resources, or call an MCP tool.",
  helpDetail:
    "Usage:\n" +
    "  /mcp servers                  list configured servers\n" +
    "  /mcp tools                    list available tools across servers\n" +
    "  /mcp resources                list resources\n" +
    "  /mcp call <server>:<tool> ... invoke a tool (subject to approval)",
  async handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("mcp command unavailable: runtime missing handleMcpCommand");
    }
    return reply(await ctx.queryEngine.handleMcpCommand(ctx.rawPrompt));
  },
});
