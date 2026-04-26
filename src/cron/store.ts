/**
 * Cron 任务持久化（#116 step C.1）
 *
 * 文件：~/.codeclaw/cron.json
 *
 * Schema：CronStoreShape（见 types.ts）
 *
 * 行为：
 *   - 加载：文件不存在 / 解析失败均回退空 store；解析失败时把文件改名为 .bak.<ts>
 *   - 写回：原子写（先 .tmp 再 rename）
 *   - 任务运行历史：~/.codeclaw/cron-runs/<task-id>/<YYYY-MM-DD>.jsonl
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

import type { CronRun, CronStoreShape, CronTask } from "./types";

export interface CronPaths {
  storeFile: string;
  runsDir: string;
}

export function defaultCronPaths(homeDir: string = os.homedir()): CronPaths {
  const root = path.join(homeDir, ".codeclaw");
  return {
    storeFile: path.join(root, "cron.json"),
    runsDir: path.join(root, "cron-runs"),
  };
}

export function loadCronStore(paths: CronPaths = defaultCronPaths()): CronStoreShape {
  if (!existsSync(paths.storeFile)) return { tasks: {} };
  let text: string;
  try {
    text = readFileSync(paths.storeFile, "utf8");
  } catch {
    return { tasks: {} };
  }
  try {
    return parseCronStore(text);
  } catch {
    // 损坏文件备份后回退空 store，避免阻塞启动
    try {
      const bak = `${paths.storeFile}.bak.${Date.now()}`;
      renameSync(paths.storeFile, bak);
    } catch {
      // 备份失败也吞，store.json 保留原状由用户手工清理
    }
    return { tasks: {} };
  }
}

export function parseCronStore(text: string): CronStoreShape {
  const trimmed = text.trim();
  if (!trimmed) return { tasks: {} };
  const raw = JSON.parse(trimmed) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cron store root must be object");
  }
  const tasksRaw = (raw as { tasks?: unknown }).tasks;
  if (tasksRaw === undefined) return { tasks: {} };
  if (!tasksRaw || typeof tasksRaw !== "object" || Array.isArray(tasksRaw)) {
    throw new Error("cron store 'tasks' must be object");
  }
  const out: Record<string, CronTask> = {};
  for (const [id, t] of Object.entries(tasksRaw as Record<string, unknown>)) {
    if (!t || typeof t !== "object") throw new Error(`task ${id} must be object`);
    const task = coerceTask(id, t as Record<string, unknown>);
    out[task.id] = task;
  }
  return { tasks: out };
}

function coerceTask(id: string, t: Record<string, unknown>): CronTask {
  const required = (k: string, want: string) => {
    const v = t[k];
    if (typeof v !== want || (want === "string" && !v)) {
      throw new Error(`task ${id}.${k} must be non-empty ${want}`);
    }
  };
  required("name", "string");
  required("schedule", "string");
  required("kind", "string");
  required("payload", "string");
  required("enabled", "boolean");
  required("createdAt", "number");

  const kind = t.kind as string;
  if (kind !== "slash" && kind !== "prompt" && kind !== "shell") {
    throw new Error(`task ${id}.kind invalid: ${kind}`);
  }

  const notify = t.notifyChannels;
  let notifyChannels: CronTask["notifyChannels"];
  if (notify !== undefined) {
    if (!Array.isArray(notify)) throw new Error(`task ${id}.notifyChannels must be array`);
    const allowed = new Set(["cli", "wechat", "web"]);
    notifyChannels = [];
    for (const ch of notify) {
      if (typeof ch !== "string" || !allowed.has(ch)) {
        throw new Error(`task ${id}.notifyChannels has invalid channel: ${String(ch)}`);
      }
      notifyChannels.push(ch as "cli" | "wechat" | "web");
    }
  }

  const lastRunStatus = t.lastRunStatus;
  if (
    lastRunStatus !== undefined &&
    lastRunStatus !== "ok" &&
    lastRunStatus !== "error" &&
    lastRunStatus !== "timeout"
  ) {
    throw new Error(`task ${id}.lastRunStatus invalid`);
  }

  return {
    id: typeof t.id === "string" && t.id ? t.id : id,
    name: t.name as string,
    schedule: t.schedule as string,
    kind: kind as CronTask["kind"],
    payload: t.payload as string,
    enabled: t.enabled as boolean,
    ...(notifyChannels ? { notifyChannels } : {}),
    ...(typeof t.timeoutMs === "number" ? { timeoutMs: t.timeoutMs } : {}),
    ...(typeof t.workspace === "string" ? { workspace: t.workspace } : {}),
    createdAt: t.createdAt as number,
    ...(typeof t.lastRunAt === "number" ? { lastRunAt: t.lastRunAt } : {}),
    ...(lastRunStatus ? { lastRunStatus: lastRunStatus as CronTask["lastRunStatus"] } : {}),
    ...(typeof t.lastRunError === "string" ? { lastRunError: t.lastRunError } : {}),
  };
}

export function saveCronStore(store: CronStoreShape, paths: CronPaths = defaultCronPaths()): void {
  ensureDir(path.dirname(paths.storeFile));
  const tmp = `${paths.storeFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, paths.storeFile);
}

export function appendRunLog(
  taskId: string,
  run: CronRun,
  paths: CronPaths = defaultCronPaths()
): string {
  const dir = path.join(paths.runsDir, sanitizeId(taskId));
  ensureDir(dir);
  const day = formatDay(new Date(run.endedAt));
  const file = path.join(dir, `${day}.jsonl`);
  appendFileSync(file, `${JSON.stringify(run)}\n`, "utf8");
  return file;
}

export function readRecentRuns(
  taskId: string,
  limit: number,
  paths: CronPaths = defaultCronPaths()
): CronRun[] {
  const dir = path.join(paths.runsDir, sanitizeId(taskId));
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse();
  const out: CronRun[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const lines = readFileSync(path.join(dir, f), "utf8").trim().split("\n").reverse();
    for (const line of lines) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as CronRun);
      } catch {
        // 跳过损坏行
      }
      if (out.length >= limit) break;
    }
  }
  return out;
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function formatDay(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, "0");
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}
