/**
 * `/providers` · 当前 provider 链
 */

import { defineCommand, reply } from "../registry";

interface ProvidersHolder {
  buildProvidersReply(): string;
}

function isHolder(x: unknown): x is ProvidersHolder {
  return !!x && typeof (x as ProvidersHolder).buildProvidersReply === "function";
}

export default defineCommand({
  name: "/providers",
  category: "provider",
  risk: "low",
  summary: "Show current and fallback provider/model.",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("providers command unavailable: runtime missing buildProvidersReply");
    }
    return reply(ctx.queryEngine.buildProvidersReply());
  },
});
