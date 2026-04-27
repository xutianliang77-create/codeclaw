/**
 * `/hooks` · 列出已注册 hooks
 */

import { defineCommand, reply } from "../registry";

interface HooksHolder {
  buildHooksReply(): string;
}

function isHolder(x: unknown): x is HooksHolder {
  return !!x && typeof (x as HooksHolder).buildHooksReply === "function";
}

export default defineCommand({
  name: "/hooks",
  category: "plugin",
  risk: "low",
  summary: "List registered lifecycle / tool hooks.",
  summaryZh: "列出已注册的生命周期 / 工具 hook",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("hooks command unavailable: runtime missing buildHooksReply");
    }
    return reply(ctx.queryEngine.buildHooksReply());
  },
});
