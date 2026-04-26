/**
 * Cron 任务展示格式化（#116 step C.4）
 *
 * 与 manager 解耦，便于测试。
 */

import type { CronManager } from "./manager";
import type { CronRun, CronTask } from "./types";

export function formatTaskList(tasks: CronTask[]): string {
  if (tasks.length === 0) {
    return "no tasks. use '/cron add <name> <schedule> <kind>:<payload>' to add one.";
  }
  const rows: string[][] = [
    ["id", "name", "schedule", "kind", "enabled", "last-run", "status"],
  ];
  for (const t of tasks) {
    rows.push([
      shortenId(t.id),
      t.name,
      t.schedule,
      t.kind,
      t.enabled ? "on" : "off",
      t.lastRunAt ? new Date(t.lastRunAt).toISOString() : "-",
      t.lastRunStatus ?? "-",
    ]);
  }
  return formatTable(rows);
}

export function formatTaskDetail(task: CronTask): string {
  const lines: string[] = [
    `id: ${task.id}`,
    `name: ${task.name}`,
    `schedule: ${task.schedule}`,
    `kind: ${task.kind}`,
    `payload: ${task.payload}`,
    `enabled: ${task.enabled}`,
    `created: ${new Date(task.createdAt).toISOString()}`,
  ];
  if (task.notifyChannels?.length) lines.push(`notify: ${task.notifyChannels.join(",")}`);
  if (task.timeoutMs !== undefined) lines.push(`timeout-ms: ${task.timeoutMs}`);
  if (task.workspace) lines.push(`workspace: ${task.workspace}`);
  if (task.lastRunAt) lines.push(`last-run: ${new Date(task.lastRunAt).toISOString()}`);
  if (task.lastRunStatus) lines.push(`last-status: ${task.lastRunStatus}`);
  if (task.lastRunError) lines.push(`last-error: ${task.lastRunError.slice(0, 256)}`);
  return lines.join("\n");
}

export function formatRunSummary(task: CronTask, run: CronRun): string {
  const elapsed = run.endedAt - run.startedAt;
  const lines: string[] = [
    `[Cron · ${task.name} · ${run.status} · ${elapsed}ms]`,
  ];
  if (run.output) {
    lines.push(run.output.slice(0, 1024));
  }
  if (run.error) {
    lines.push(`error: ${run.error.slice(0, 512)}`);
  }
  return lines.join("\n");
}

export function formatLogs(task: CronTask, runs: CronRun[]): string {
  if (runs.length === 0) return `no runs for '${task.name}' yet.`;
  const out: string[] = [`# logs for ${task.name} (id=${task.id})`];
  for (const r of runs) {
    const ts = new Date(r.endedAt).toISOString();
    const elapsed = r.endedAt - r.startedAt;
    out.push(`${ts}  ${r.status.padEnd(7)}  ${String(elapsed).padStart(6)}ms`);
    const tail = (r.error ?? r.output).split("\n").slice(0, 3).join(" | ").slice(0, 240);
    if (tail) out.push(`  ${tail}`);
  }
  return out.join("\n");
}

export function formatCronHelp(): string {
  return [
    "Usage:",
    "  /cron                                                   list all tasks (alias of /cron list)",
    "  /cron add <name> <schedule> <kind>:<payload> [flags]    create a task",
    "  /cron remove <id-or-name>                               delete a task",
    "  /cron enable <id-or-name>                               enable",
    "  /cron disable <id-or-name>                              disable",
    "  /cron run-now <id-or-name>                              fire immediately (off-schedule)",
    "  /cron logs <id-or-name> [--tail=N]                      show recent runs",
    "",
    "Add flags:",
    "  --notify=cli[,wechat[,web]]    where to publish results (default: log only)",
    "  --timeout=Nms|Ns|Nm|Nh         override default timeout",
    "",
    "Schedules:",
    "  Standard 5-field cron (\"0 2 * * *\")",
    "  Aliases: @hourly @daily @weekly @monthly",
    "  Interval: @every 30s | @every 5m | @every 1h",
    "",
    "Examples:",
    "  /cron add rag-daily \"0 2 * * *\" slash:/rag\\ index --notify=cli",
    "  /cron add weekly-review \"0 9 * * 1\" prompt:\"review this week's commits\" --notify=wechat",
    "  /cron add audit \"@hourly\" \"shell:npm audit --production\"",
  ].join("\n");
}

function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function formatTable(rows: string[][]): string {
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((r) => (r[col] ?? "").length))
  );
  return rows
    .map((r) =>
      r.map((cell, i) => (cell ?? "").padEnd(widths[i])).join("  ").trimEnd()
    )
    .join("\n");
}

/** 给 manager 实例 + parsed args 拼最终回复（除 list 路径直接调 list） */
export type CronCmdResult = string;

export async function dispatchCronCmd(
  manager: CronManager,
  raw: string
): Promise<CronCmdResult> {
  const { parseCronArgs } = await import("./cliParse");
  let parsed: ReturnType<typeof parseCronArgs>;
  try {
    parsed = parseCronArgs(raw);
  } catch (err) {
    return `${(err as Error).message}\n\n${formatCronHelp()}`;
  }

  switch (parsed.kind) {
    case "list":
      return formatTaskList(manager.list());
    case "help":
      return formatCronHelp();
    case "add": {
      try {
        const t = manager.add({
          name: parsed.name,
          schedule: parsed.schedule,
          kind: parsed.taskKind,
          payload: parsed.payload,
          notifyChannels: parsed.notify,
          ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
        });
        return `added: ${t.name} (${t.id})\n${formatTaskDetail(t)}`;
      } catch (err) {
        return `add failed: ${(err as Error).message}`;
      }
    }
    case "remove": {
      const t = manager.remove(parsed.target);
      return t ? `removed: ${t.name}` : `no such task: ${parsed.target}`;
    }
    case "enable": {
      const t = manager.setEnabled(parsed.target, true);
      return t ? `enabled: ${t.name}` : `no such task: ${parsed.target}`;
    }
    case "disable": {
      const t = manager.setEnabled(parsed.target, false);
      return t ? `disabled: ${t.name}` : `no such task: ${parsed.target}`;
    }
    case "run-now": {
      const run = await manager.runNow(parsed.target);
      if (!run) return `no such task: ${parsed.target}`;
      const t = manager.get(parsed.target);
      return t ? formatRunSummary(t, run) : `[run-now] task missing after run: ${parsed.target}`;
    }
    case "logs": {
      const r = manager.readLogs(parsed.target, parsed.tail);
      if (!r) return `no such task: ${parsed.target}`;
      return formatLogs(r.task, r.runs);
    }
  }
}
