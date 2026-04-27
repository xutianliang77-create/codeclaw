/**
 * `/reload-plugins` · 重载 skills / hooks 注册表
 */

import { defineCommand, reply } from "../registry";

interface ReloadHolder {
  buildReloadPluginsReply(): string;
}

function isHolder(x: unknown): x is ReloadHolder {
  return !!x && typeof (x as ReloadHolder).buildReloadPluginsReply === "function";
}

export default defineCommand({
  name: "/reload-plugins",
  category: "plugin",
  risk: "low",
  summary: "Reload skills / hooks registry from disk.",
  summaryZh: "从磁盘重载 skills / hooks 注册表",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply(
        "reload-plugins command unavailable: runtime missing buildReloadPluginsReply"
      );
    }
    return reply(ctx.queryEngine.buildReloadPluginsReply());
  },
});
