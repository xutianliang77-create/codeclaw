/**
 * `/init` · 初始化诊断（依赖、目录、provider、tokenFile 等）
 */

import { defineCommand, reply } from "../registry";

interface InitHolder {
  buildInitReply(): string;
}

function isHolder(x: unknown): x is InitHolder {
  return !!x && typeof (x as InitHolder).buildInitReply === "function";
}

export default defineCommand({
  name: "/init",
  category: "session",
  risk: "low",
  summary: "Run init self-check (deps / dirs / provider / tokenFile).",
  summaryZh: "跑初始化自检（依赖 / 目录 / provider / token 文件）",
  handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("init command unavailable: runtime missing buildInitReply");
    }
    return reply(ctx.queryEngine.buildInitReply());
  },
});
