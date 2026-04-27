/**
 * `/doctor` · 诊断环境健康
 *
 * 实现沿用 `src/commands/doctor.ts:runDoctor`；这里只包装成 SlashCommand。
 */

import { defineCommand, reply } from "../registry";
import { runDoctor } from "../../doctor";

export default defineCommand({
  name: "/doctor",
  aliases: ["/diag"],
  category: "observability",
  risk: "low",
  summary: "Check storage / runtime / libs / tokenFile health.",
  summaryZh: "体检：存储 / 运行时 / 依赖 / token 文件",
  helpDetail:
    "Runs a read-only health check across SQLite databases, Node/OS runtime info, " +
    "critical library versions, and the WeChat token file. Safe to call anytime.",
  async handler() {
    const text = await runDoctor();
    return reply(text);
  },
});
