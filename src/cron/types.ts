/**
 * 定时任务类型（#116 阶段 🅐）
 *
 * Spec: doc/specs/cron-tasks.md §3.1
 */

export type CronTaskKind = "slash" | "prompt" | "shell";

export type CronNotifyChannel = "cli" | "wechat" | "web";

export type CronRunStatus = "ok" | "error" | "timeout";

export interface CronTask {
  id: string;
  name: string;
  schedule: string;
  kind: CronTaskKind;
  payload: string;
  enabled: boolean;
  notifyChannels?: CronNotifyChannel[];
  timeoutMs?: number;
  workspace?: string;
  createdAt: number;
  lastRunAt?: number;
  lastRunStatus?: CronRunStatus;
  lastRunError?: string;
}

export interface CronRun {
  taskId: string;
  startedAt: number;
  endedAt: number;
  status: CronRunStatus;
  output: string;
  error?: string;
}

export interface CronStoreShape {
  tasks: Record<string, CronTask>;
}

export const DEFAULT_TIMEOUT_MS: Record<CronTaskKind, number> = {
  slash: 5 * 60 * 1000,
  prompt: 5 * 60 * 1000,
  shell: 60 * 1000,
};
