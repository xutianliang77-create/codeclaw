/**
 * `/session` · 当前 session 概况
 */

import { defineCommand, reply } from "../registry";

interface SessionHolder {
  buildSessionReply(): string;
}

function isHolder(x: unknown): x is SessionHolder {
  return !!x && typeof (x as SessionHolder).buildSessionReply === "function";
}

export default defineCommand({
  name: "/session",
  category: "session",
  risk: "low",
  summary: "Show session id, message count, last assistant snippet.",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("session command unavailable: runtime missing buildSessionReply");
    }
    return reply(ctx.queryEngine.buildSessionReply());
  },
});
