/**
 * `/web` · Web SPA 启动指引（v0.7.2 不再随 CLI 自启）
 *
 * v0.7.2 起 CLI 默认不再后台拉起 Web Server。本命令只是提示用户用 `codeclaw web`
 * 在独立进程中启动（推荐独立进程：便于诊断和单独退出）。后续可扩展为 CLI 同进程
 * 内启 web，但需要注入 mcpManager / settings / cron 等依赖（暂不做）。
 */

import { defineCommand, reply } from "../registry";

export default defineCommand({
  name: "/web",
  category: "integration",
  risk: "low",
  summary: "Web UI: how to start the local Web SPA.",
  summaryZh: "Web UI：如何启动本地 Web SPA",
  helpDetail:
    "Usage:\n" +
    "  /web              show how to start Web · 显示启动方法\n" +
    "\n" +
    "v0.7.2 起 CLI 不再自动启动 Web。请在另一个终端运行：\n" +
    "  codeclaw web\n" +
    "或带端口：\n" +
    "  codeclaw web --port=7180 --host=127.0.0.1\n" +
    "首次会自动生成并保存 token 到 ~/.codeclaw/web-auth.json (mode 0600)。",
  handler() {
    return reply(
      [
        "Web 不再随 CLI 自启（v0.7.2）。在另一个终端运行：",
        "  codeclaw web",
        "或：",
        "  codeclaw web --port=7180 --host=127.0.0.1",
        "首次启动会生成 token 并写入 ~/.codeclaw/web-auth.json（mode 0600）。",
      ].join("\n")
    );
  },
});
