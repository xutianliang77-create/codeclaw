/**
 * cron 任务模板（#116 阶段 🅑）
 *
 * 内建模板让用户一句 `/cron template add daily-rag` 即可加预设任务，无需记 cron 表达式。
 */

import type { CronNotifyChannel, CronTaskKind } from "./types";

export interface CronTaskTemplate {
  /** 模板键，唯一 */
  key: string;
  /** 一行说明 */
  description: string;
  /** 默认任务名（用户可在 add 时覆盖） */
  defaultName: string;
  schedule: string;
  kind: CronTaskKind;
  payload: string;
  notifyChannels: CronNotifyChannel[];
  /** 默认超时；省略走 kind 的全局默认 */
  timeoutMs?: number;
}

export const CRON_TEMPLATES: CronTaskTemplate[] = [
  {
    key: "daily-rag",
    description: "每天凌晨 2 点跑 /rag index 增量重建索引",
    defaultName: "daily-rag",
    schedule: "0 2 * * *",
    kind: "slash",
    payload: "/rag index",
    notifyChannels: ["cli"],
  },
  {
    key: "weekly-review",
    description: "每周一 9 点让 LLM 审本周 commits + 写技术债报告",
    defaultName: "weekly-review",
    schedule: "0 9 * * 1",
    kind: "prompt",
    payload:
      "Review the commits added to this repo in the past 7 days. Identify technical debt, risky changes, and suggest follow-up work. Output a concise markdown report.",
    notifyChannels: ["cli"],
    timeoutMs: 10 * 60 * 1000,
  },
  {
    key: "hourly-audit",
    description: "每小时跑 npm audit（仅 production deps）",
    defaultName: "hourly-audit",
    schedule: "@hourly",
    kind: "shell",
    payload: "npm audit --production",
    notifyChannels: ["cli"],
  },
  {
    key: "graph-rebuild",
    description: "每天凌晨 3 点重建 CodebaseGraph（rebuild from scratch）",
    defaultName: "daily-graph",
    schedule: "0 3 * * *",
    kind: "slash",
    payload: "/graph build",
    notifyChannels: ["cli"],
  },
  {
    key: "session-summary",
    description: "每 6 小时让 LLM 总结当前 session，写入项目 memory",
    defaultName: "session-summary",
    schedule: "0 */6 * * *",
    kind: "prompt",
    payload:
      "Summarize the work completed since the previous summary. Note open questions and risks. Save salient facts via /remember.",
    notifyChannels: ["cli"],
    timeoutMs: 5 * 60 * 1000,
  },
];

export function listTemplates(): CronTaskTemplate[] {
  return [...CRON_TEMPLATES];
}

export function getTemplate(key: string): CronTaskTemplate | null {
  return CRON_TEMPLATES.find((t) => t.key === key) ?? null;
}

export function formatTemplateList(): string {
  if (CRON_TEMPLATES.length === 0) return "(no templates)";
  const rows: string[][] = [["key", "schedule", "kind", "description"]];
  for (const t of CRON_TEMPLATES) {
    rows.push([t.key, t.schedule, t.kind, t.description]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd())
    .join("\n");
}
