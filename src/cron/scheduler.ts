/**
 * Cron 调度器（#116 step C.2）
 *
 * - 30s tick + ±60s 漂移补偿（spec §3.4）
 * - 同任务 1 分钟内最多 1 次触发（防 30s tick 的边界 race，spec §C-9）
 * - fire-and-forget：单任务异常不影响其它任务
 */

import { cronMatches, parseCronExpr, type ParsedCron } from "./parser";
import type { CronTask, CronStoreShape, CronRun } from "./types";

export interface SchedulerOptions {
  tickMs?: number;
  driftMs?: number;
  /** 注入 setInterval / clearInterval / now，方便测试 */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  now?: () => number;
  onError?: (taskId: string, err: unknown) => void;
}

export interface RunnerLike {
  runOnce(task: CronTask): Promise<CronRun>;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_DRIFT_MS = 60_000;
const DEDUPE_MS = 60_000;

export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private lastFireAt = new Map<string, number>();
  private cache = new Map<string, ParsedCron>();
  private readonly tickMs: number;
  private readonly driftMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly now: () => number;
  private readonly onError: (taskId: string, err: unknown) => void;

  constructor(
    private readonly store: CronStoreShape,
    private readonly runner: RunnerLike,
    opts: SchedulerOptions = {}
  ) {
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.driftMs = opts.driftMs ?? DEFAULT_DRIFT_MS;
    this.setIntervalFn = opts.setInterval ?? setInterval;
    this.clearIntervalFn = opts.clearInterval ?? clearInterval;
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? (() => undefined);
  }

  start(): void {
    if (this.timer) return;
    this.lastTickAt = this.now();
    this.timer = this.setIntervalFn(() => this.runTick(), this.tickMs);
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  /** 测试 / 手动驱动用：执行一次 tick 检查 */
  runTick(): void {
    const now = this.now();
    const since = this.lastTickAt;
    this.lastTickAt = now;

    for (const task of Object.values(this.store.tasks)) {
      if (!task.enabled) continue;
      try {
        if (this.shouldFire(task, since, now)) {
          this.lastFireAt.set(task.id, now);
          void this.runner
            .runOnce(task)
            .catch((err) => this.onError(task.id, err));
        }
      } catch (err) {
        this.onError(task.id, err);
      }
    }
  }

  private shouldFire(task: CronTask, since: number, now: number): boolean {
    const dedupeAt = this.lastFireAt.get(task.id) ?? task.lastRunAt ?? 0;
    if (now - dedupeAt < DEDUPE_MS) return false;
    const parsed = this.parseCached(task.schedule);
    if (!parsed) return false;
    const windowStart = since - this.driftMs;
    return cronMatches(parsed, windowStart, now);
  }

  private parseCached(expr: string): ParsedCron | null {
    const cached = this.cache.get(expr);
    if (cached) return cached;
    try {
      const parsed = parseCronExpr(expr);
      this.cache.set(expr, parsed);
      return parsed;
    } catch {
      return null;
    }
  }
}
