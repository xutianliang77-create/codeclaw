/**
 * Cron 任务执行器（#116 step C.3）
 *
 * 执行三类任务：
 *   - slash：调子 engine 的 submitMessage（命中内置 slash 直接处理；否则进入 LLM）
 *   - prompt：与 slash 同 path（前面无 / → LLM 自由回答）
 *   - shell：spawn shell 子进程
 *
 * 严格 timeout；fail-soft：不向上抛错，输出/错误都写入 CronRun
 *
 * Spec: doc/specs/cron-tasks.md §3.5
 */

import { spawn } from "node:child_process";

import type Database from "better-sqlite3";
import type { EngineEvent, QueryEngine } from "../agent/types";
import { appendRunLog, defaultCronPaths, type CronPaths } from "./store";
import { appendRunRow } from "./historyStore";
import {
  DEFAULT_TIMEOUT_MS,
  type CronNotifyChannel,
  type CronRun,
  type CronRunStatus,
  type CronTask,
} from "./types";

const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;

export type CronEngineFactory = (task: CronTask) => QueryEngine | Promise<QueryEngine>;

export type CronNotifyFn = (
  channels: CronNotifyChannel[],
  task: CronTask,
  run: CronRun
) => Promise<void> | void;

export interface CronRunnerOptions {
  engineFactory: CronEngineFactory;
  notify?: CronNotifyFn;
  paths?: CronPaths;
  /** 写回 task.lastRunAt / lastRunStatus / lastRunError；省略则不更新 */
  updateTaskMeta?: (task: CronTask, run: CronRun) => void;
  /** shell 启动器：测试可注入 */
  spawnShell?: typeof spawn;
  /** 阶段 🅑：data.db 句柄；提供时除 jsonl 外也写 cron_runs 表 */
  dataDb?: Database.Database;
}

export class CronRunner {
  constructor(private readonly opts: CronRunnerOptions) {}

  async runOnce(task: CronTask): Promise<CronRun> {
    const startedAt = Date.now();
    const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS[task.kind];
    let output = "";
    let status: CronRunStatus = "ok";
    let error: string | undefined;

    try {
      output = await runWithTimeout(() => this.executeByKind(task), timeoutMs);
    } catch (err) {
      if ((err as Error).message === "TIMEOUT") {
        status = "timeout";
        error = `task exceeded ${timeoutMs}ms`;
      } else {
        status = "error";
        error = sanitize((err as Error).message ?? String(err), MAX_ERROR_BYTES);
      }
    }

    const run: CronRun = {
      taskId: task.id,
      startedAt,
      endedAt: Date.now(),
      status,
      output: clip(output, MAX_OUTPUT_BYTES),
      ...(error ? { error } : {}),
    };

    try {
      appendRunLog(task.id, run, this.opts.paths ?? defaultCronPaths());
    } catch {
      // 日志写失败不影响主流程
    }
    if (this.opts.dataDb) {
      try {
        appendRunRow(this.opts.dataDb, task, run);
      } catch {
        // sqlite 写失败不影响主流程；jsonl 仍可用
      }
    }

    this.opts.updateTaskMeta?.(task, run);

    if (task.notifyChannels?.length) {
      try {
        await this.opts.notify?.(task.notifyChannels, task, run);
      } catch {
        // 通知失败不影响 run 本身
      }
    }
    return run;
  }

  private async executeByKind(task: CronTask): Promise<string> {
    if (task.kind === "shell") {
      return this.executeShell(task.payload, task.workspace);
    }
    return this.executeViaEngine(task);
  }

  private async executeViaEngine(task: CronTask): Promise<string> {
    const engine = await this.opts.engineFactory(task);
    const chunks: string[] = [];
    for await (const ev of engine.submitMessage(task.payload) as AsyncGenerator<EngineEvent>) {
      if (ev.type === "message-complete") chunks.push(ev.text);
    }
    return chunks.join("\n---\n");
  }

  private executeShell(cmd: string, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const spawnFn = this.opts.spawnShell ?? spawn;
      const shell = process.env.SHELL ?? "bash";
      const child = spawnFn(shell, ["-lc", cmd], {
        stdio: ["ignore", "pipe", "pipe"],
        ...(cwd ? { cwd } : {}),
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      child.on("error", (err) => reject(err));
      child.on("exit", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          const tail = stderr.slice(-MAX_ERROR_BYTES) || stdout.slice(-MAX_ERROR_BYTES);
          reject(new Error(`shell exit ${code}\n${tail}`));
        }
      });
    });
  }
}

function runWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("TIMEOUT"));
    }, ms);
    fn().then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function clip(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  // 字节级截断后再修复 utf-8（截尾如有半字符直接丢）
  const buf = Buffer.from(s, "utf8").subarray(0, maxBytes);
  return `${buf.toString("utf8")}\n...[truncated]`;
}

function sanitize(s: string, maxBytes: number): string {
  // 去 ANSI/CSI/控制字符，避免污染 jsonl/通知文本
  /* eslint-disable no-control-regex */
  const cleaned = s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  /* eslint-enable no-control-regex */
  return clip(cleaned, maxBytes);
}
