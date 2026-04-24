/**
 * `/model` · 切换或查看当前 model
 */

import { defineCommand, reply } from "../registry";

interface ModelHolder {
  handleModelCommand(prompt: string): string;
}

function isHolder(x: unknown): x is ModelHolder {
  return !!x && typeof (x as ModelHolder).handleModelCommand === "function";
}

export default defineCommand({
  name: "/model",
  category: "provider",
  risk: "medium",
  summary: "Show or switch the active model id.",
  helpDetail:
    "Usage:\n" +
    "  /model                show current model\n" +
    "  /model <id>           switch to <id> (must exist in provider chain)",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("model command unavailable: runtime missing handleModelCommand");
    }
    return reply(ctx.queryEngine.handleModelCommand(ctx.rawPrompt));
  },
});
