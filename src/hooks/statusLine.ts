/**
 * Status line 数据层（M3-04 step 4+5）
 *
 * 默认 status line：纯函数 buildDefaultStatusLine，从 bootInfo + 运行时数据拼字符串
 *   形如：openai/gpt-4.1-mini · default · ctx 1234/8000 (15%) · cwd:CodeClaw
 *
 * 自定义 status line：startCustomStatusLine 启 spawn polling，每 intervalMs 跑用户配
 *   的 command，stdout trim 后回调；超时 / 失败按降级文案处理（不抛异常）。
 *
 * ink 集成在 src/app/App.tsx；本文件不依赖 ink，单测可纯 node 环境跑。
 *
 * 不变量：
 *   - intervalMs 最小 500ms（避免炒鸡瀑布 spawn）
 *   - timeoutMs 默认 1500ms（status line 应轻量；超时不影响 UI）
 *   - command 失败时调 onError 但 polling 继续（不要因为一次失败停整个状态栏）
 *   - stop() 后下一次 tick 不再 schedule，已 spawn 的子进程会被 SIGKILL
 */

import { spawn } from "node:child_process";
import path from "node:path";

export interface DefaultStatusLineInput {
  providerLabel?: string;
  modelLabel?: string;
  permissionMode?: string;
  workspace?: string;
  contextUsed?: number;
  contextLimit?: number;
}

const MIN_INTERVAL_MS = 500;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_FALLBACK_TEXT = "[status line unavailable]";

export function buildDefaultStatusLine(input: DefaultStatusLineInput): string {
  const parts: string[] = [];

  const provider = (input.providerLabel ?? "").trim();
  const model = (input.modelLabel ?? "").trim();
  if (provider || model) {
    parts.push(`${provider || "?"}/${model || "?"}`);
  }

  if (input.permissionMode) {
    parts.push(input.permissionMode);
  }

  if (typeof input.contextUsed === "number" && input.contextLimit && input.contextLimit > 0) {
    const pct = Math.round((input.contextUsed / input.contextLimit) * 100);
    parts.push(`ctx ${input.contextUsed}/${input.contextLimit} (${pct}%)`);
  } else if (typeof input.contextUsed === "number") {
    parts.push(`ctx ${input.contextUsed}`);
  }

  if (input.workspace) {
    parts.push(`cwd:${path.basename(input.workspace) || input.workspace}`);
  }

  return parts.length > 0 ? parts.join(" · ") : "(no status)";
}

export interface CustomStatusLineOptions {
  command: string;
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate(text: string): void;
  /** 可选错误回调（spawn 失败 / 非 0 exit / timeout） */
  onError?(err: Error): void;
  /** 可选 fallback 文本（出错时显示）；不传则保留上次成功的文本 */
  fallbackText?: string;
}

export interface CustomStatusLineHandle {
  stop(): void;
}

export function startCustomStatusLine(opts: CustomStatusLineOptions): CustomStatusLineHandle {
  const interval = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let stopped = false;
  let scheduled: NodeJS.Timeout | null = null;

  const tick = (): void => {
    if (stopped) return;
    const child = spawn(process.env.SHELL ?? "bash", ["-lc", opts.command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killTimer: NodeJS.Timeout | null = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      killTimer = null;
      handleEnd(null, null, stderr, err);
    });
    child.on("exit", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      killTimer = null;
      handleEnd(code, signal, stderr);
    });

    const handleEnd = (
      code: number | null,
      signal: NodeJS.Signals | null,
      err: string,
      spawnErr?: Error
    ): void => {
      if (stopped) return;
      const trimmed = stdout.trim();
      if (spawnErr) {
        opts.onError?.(spawnErr);
        if (opts.fallbackText !== undefined) opts.onUpdate(opts.fallbackText);
      } else if (signal === "SIGKILL") {
        opts.onError?.(new Error(`status line timeout (${timeoutMs}ms)`));
        if (opts.fallbackText !== undefined) opts.onUpdate(opts.fallbackText);
      } else if (code === 0) {
        opts.onUpdate(trimmed || (opts.fallbackText ?? DEFAULT_FALLBACK_TEXT));
      } else {
        opts.onError?.(new Error(`status line exit ${code}: ${err.trim().slice(0, 200)}`));
        if (opts.fallbackText !== undefined) opts.onUpdate(opts.fallbackText);
      }
      // 调度下一次（即使本次失败）
      scheduled = setTimeout(tick, interval);
    };
  };

  // 立即跑一次（不等 interval）
  tick();

  return {
    stop(): void {
      stopped = true;
      if (scheduled) {
        clearTimeout(scheduled);
        scheduled = null;
      }
    },
  };
}
