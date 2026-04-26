/**
 * `/cron` · 定时任务 CRUD（#116 step C.4）
 */

import { defineCommand, reply } from "../registry";

interface CronHolder {
  runCronCommand(argsRaw: string): Promise<string>;
}

function isHolder(x: unknown): x is CronHolder {
  return !!x && typeof (x as CronHolder).runCronCommand === "function";
}

export default defineCommand({
  name: "/cron",
  category: "workflow",
  risk: "medium",
  summary: "Schedule slash / prompt / shell tasks (codeclaw-foreground only).",
  helpDetail:
    "Usage:\n" +
    "  /cron                                              list tasks\n" +
    "  /cron add <name> <schedule> <kind>:<payload>       add (kind = slash | prompt | shell)\n" +
    "  /cron remove|enable|disable|run-now <id-or-name>   manage existing tasks\n" +
    "  /cron logs <id-or-name> [--tail=N]                 show recent run history\n" +
    "Add flags:\n" +
    "  --notify=cli[,wechat,web]    publish run results (default: log only)\n" +
    "  --timeout=Nms|Ns|Nm|Nh       override default timeout\n" +
    "Schedules:\n" +
    "  5-field cron (\"0 2 * * *\") | @hourly @daily @weekly @monthly | @every 30s|5m|1h\n" +
    "Notes:\n" +
    "  - Tasks fire only while codeclaw is running (no daemon).\n" +
    "  - For 24x7 schedules use OS cron + scripts/nightly.mjs.\n" +
    "  - Disable globally with env CODECLAW_CRON=false.",
  async handler(ctx) {
    if (!isHolder(ctx.queryEngine)) {
      return reply("cron command unavailable: runtime missing runCronCommand");
    }
    return reply(await ctx.queryEngine.runCronCommand(ctx.argsRaw));
  },
});
