/**
 * Cron 任务高层 API（#116 step C.4）
 *
 * 给 slash 命令 / queryEngine / Web UI 提供：
 *   - listTasks / addTask / removeTask / setEnabled / runNow / readLogs
 *   - 内部维护 store + scheduler + runner；写后即 saveCronStore
 *
 * 一个 codeclaw 进程只应该有 1 个 CronManager 实例（在主 cli engine 里 init）。
 */

import { ulid } from "ulid";

import { parseCronExpr } from "./parser";
import {
  appendRunLog,
  defaultCronPaths,
  loadCronStore,
  readRecentRuns,
  saveCronStore,
  type CronPaths,
} from "./store";
import { CronRunner, type CronEngineFactory, type CronNotifyFn } from "./runner";
import { CronScheduler } from "./scheduler";
import type {
  CronNotifyChannel,
  CronRun,
  CronStoreShape,
  CronTask,
  CronTaskKind,
} from "./types";

export interface CronManagerOptions {
  paths?: CronPaths;
  engineFactory: CronEngineFactory;
  notify?: CronNotifyFn;
  /** scheduler tick 间隔（默认 30s）；测试可注入更短值 */
  tickMs?: number;
  driftMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  now?: () => number;
  onError?: (taskId: string, err: unknown) => void;
}

export class CronManager {
  private readonly store: CronStoreShape;
  private readonly runner: CronRunner;
  private readonly scheduler: CronScheduler;
  private readonly paths: CronPaths;

  constructor(opts: CronManagerOptions) {
    this.paths = opts.paths ?? defaultCronPaths();
    this.store = loadCronStore(this.paths);
    this.runner = new CronRunner({
      engineFactory: opts.engineFactory,
      ...(opts.notify ? { notify: opts.notify } : {}),
      paths: this.paths,
      updateTaskMeta: (task, run) => {
        const live = this.store.tasks[task.id];
        if (!live) return;
        live.lastRunAt = run.endedAt;
        live.lastRunStatus = run.status;
        if (run.error) live.lastRunError = run.error;
        else delete live.lastRunError;
        this.persist();
      },
    });
    this.scheduler = new CronScheduler(this.store, this.runner, {
      ...(opts.tickMs !== undefined ? { tickMs: opts.tickMs } : {}),
      ...(opts.driftMs !== undefined ? { driftMs: opts.driftMs } : {}),
      ...(opts.setInterval ? { setInterval: opts.setInterval } : {}),
      ...(opts.clearInterval ? { clearInterval: opts.clearInterval } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.onError ? { onError: opts.onError } : {}),
    });
  }

  start(): void {
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  list(): CronTask[] {
    return Object.values(this.store.tasks).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(idOrName: string): CronTask | null {
    const direct = this.store.tasks[idOrName];
    if (direct) return direct;
    for (const t of Object.values(this.store.tasks)) {
      if (t.name === idOrName) return t;
    }
    return null;
  }

  add(input: {
    name: string;
    schedule: string;
    kind: CronTaskKind;
    payload: string;
    notifyChannels?: CronNotifyChannel[];
    timeoutMs?: number;
    workspace?: string;
    enabled?: boolean;
  }): CronTask {
    if (!input.name) throw new Error("task name is required");
    if (this.findByName(input.name)) {
      throw new Error(`task name '${input.name}' already exists`);
    }
    parseCronExpr(input.schedule); // throws on invalid
    if (!input.payload) throw new Error("task payload is required");
    const task: CronTask = {
      id: ulid(),
      name: input.name,
      schedule: input.schedule,
      kind: input.kind,
      payload: input.payload,
      enabled: input.enabled ?? true,
      ...(input.notifyChannels?.length ? { notifyChannels: [...input.notifyChannels] } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {}),
      createdAt: Date.now(),
    };
    this.store.tasks[task.id] = task;
    this.persist();
    return task;
  }

  remove(idOrName: string): CronTask | null {
    const t = this.get(idOrName);
    if (!t) return null;
    delete this.store.tasks[t.id];
    this.persist();
    return t;
  }

  setEnabled(idOrName: string, enabled: boolean): CronTask | null {
    const t = this.get(idOrName);
    if (!t) return null;
    t.enabled = enabled;
    this.persist();
    return t;
  }

  async runNow(idOrName: string): Promise<CronRun | null> {
    const t = this.get(idOrName);
    if (!t) return null;
    return this.runner.runOnce(t);
  }

  readLogs(idOrName: string, limit = 20): { task: CronTask; runs: CronRun[] } | null {
    const t = this.get(idOrName);
    if (!t) return null;
    return { task: t, runs: readRecentRuns(t.id, limit, this.paths) };
  }

  /** 测试用：手动触发一次 tick 检查（绕开 setInterval） */
  triggerTickForTests(): void {
    this.scheduler.runTick();
  }

  /** 给 runner 之外的人记一次"外部 cron run"（如 web/wechat 路径派生 task） */
  appendExternalRunLog(run: CronRun): void {
    appendRunLog(run.taskId, run, this.paths);
  }

  private findByName(name: string): CronTask | null {
    for (const t of Object.values(this.store.tasks)) {
      if (t.name === name) return t;
    }
    return null;
  }

  private persist(): void {
    saveCronStore(this.store, this.paths);
  }
}
