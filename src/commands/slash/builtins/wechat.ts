/**
 * `/wechat` · 微信 iLink 集成（登录 / 状态 / 推送）
 */

import { defineCommand, reply } from "../registry";

interface WechatHolder {
  handleWechatCommand(prompt: string): Promise<string>;
}

function isHolder(x: unknown): x is WechatHolder {
  return !!x && typeof (x as WechatHolder).handleWechatCommand === "function";
}

export default defineCommand({
  name: "/wechat",
  category: "integration",
  risk: "medium",
  summary: "WeChat iLink: login / status / send / config.",
  summaryZh: "微信 iLink：登录 / 状态 / 发送 / 配置",
  helpDetail:
    "Usage:\n" +
    "  /wechat status            show current iLink token state\n" +
    "  /wechat login             start QR login flow\n" +
    "  /wechat refresh           regenerate QR code\n" +
    "  /wechat worker            start the long-poll message worker (v0.7.2 不再自动启动)\n" +
    "  /wechat send <to> <text>  send a message via iLink",
  async handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("wechat command unavailable: runtime missing handleWechatCommand");
    }
    return reply(await ctx.queryEngine.handleWechatCommand(ctx.rawPrompt));
  },
});
