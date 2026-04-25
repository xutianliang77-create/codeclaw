/**
 * Python sandbox · runPython · #83
 *
 * 给 user skill / 内置 data_insight 一个统一 spawn python 子进程的工具函数。
 *
 * 设计取舍（个人版）：
 *   - 用 child_process.spawn 直接起 python3；不强制 bubblewrap / firejail（留 P2 增强）
 *   - timeout 默认 30s；超时 SIGTERM；3s 后再 SIGKILL
 *   - mem 限制：通过 ulimit 由 shell wrapper 实现（不强制；用户需要时显式开）
 *   - 走 CODECLAW_PYTHON env 覆盖 python binary 路径（默认 'python3'）
 *
 * 不做：
 *   - 资源限制内核级强隔离 → P2
 *   - chroot / unshare → P2
 */

import { spawn } from "node:child_process";

export interface RunPythonOptions {
  /** 直接传源码（互斥 scriptPath）；用 -c 喂 python */
  code?: string;
  /** 或传脚本路径（互斥 code）；用 file 模式跑 */
  scriptPath?: string;
  /** 子进程 cwd；不传走 process.cwd() */
  cwd?: string;
  /** 超时 ms；默认 30_000 */
  timeoutMs?: number;
  /** 额外 env（合并到 process.env） */
  env?: NodeJS.ProcessEnv;
  /** stdin 输入；不传则关闭 stdin（注意：mem 限制路径会占用 stdin） */
  stdin?: string;
  /** python binary；默认 env.CODECLAW_PYTHON ?? 'python3' */
  pythonBin?: string;
  /** abort 信号；触发后立刻 SIGKILL */
  abortSignal?: AbortSignal;
  /**
   * 进程虚拟内存上限（MB）；默认 256；设 0 关闭。
   * 通过 bash wrapper + ulimit -v 实现（Linux/macOS）；Windows 自动忽略。
   * code 模式：mem 限制时 code 走 stdin（user stdin 不可同时使用）。
   * scriptPath 模式：仅 mem 限制非 0 时也走 wrapper。
   */
  maxMemoryMb?: number;
}

export interface RunPythonResult {
  exitCode: number;
  /** 'timeout' / 'aborted' / null */
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SIGKILL_GRACE_MS = 3_000;
const DEFAULT_MAX_MEMORY_MB = 256;

/** shell-quote 单参（POSIX 风格）：包 ' 并转义内部 ' */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\"'\"'")}'`;
}

export function resolvePythonBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODECLAW_PYTHON?.trim() || "python3";
}

export async function runPython(opts: RunPythonOptions): Promise<RunPythonResult> {
  if (!opts.code && !opts.scriptPath) {
    throw new Error("runPython: need code or scriptPath");
  }
  if (opts.code && opts.scriptPath) {
    throw new Error("runPython: cannot pass both code and scriptPath");
  }

  const pythonBin = opts.pythonBin ?? resolvePythonBin(opts.env ?? process.env);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memMb = opts.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB;
  const useMemLimit = memMb > 0 && process.platform !== "win32";

  // mem 限制时走 bash + ulimit -v wrapper；code 模式把代码喂 stdin（避免 shell escape）
  // 注：useMemLimit + opts.stdin 同时存在 → stdin 被代码占用，user stdin 被忽略（warn）
  let bin: string;
  let args: string[];
  let codeViaStdin: string | undefined;
  if (useMemLimit) {
    const memKb = memMb * 1024;
    bin = "bash";
    if (opts.code) {
      args = ["-c", `ulimit -v ${memKb}; exec ${shQuote(pythonBin)} -`];
      codeViaStdin = opts.code;
    } else {
      args = ["-c", `ulimit -v ${memKb}; exec ${shQuote(pythonBin)} ${shQuote(opts.scriptPath as string)}`];
    }
  } else {
    bin = pythonBin;
    args = opts.code ? ["-c", opts.code] : [opts.scriptPath as string];
  }

  return new Promise<RunPythonResult>((resolve) => {
    const start = Date.now();
    // codeViaStdin 路径必须 stdin=pipe；user stdin 路径同理
    const wantsStdin = codeViaStdin !== undefined || opts.stdin !== undefined;
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: [wantsStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    const onAbort = (): void => {
      killed = true;
      child.kill("SIGKILL");
    };
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) onAbort();
      else opts.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    if (child.stdin) {
      // 监听 stdin error（spawn 失败时 stdin 已 destroyed，避免 EPIPE 抛错）
      child.stdin.on("error", () => { /* swallow; child.on('error') 会处理结果 */ });
      try {
        if (codeViaStdin !== undefined) {
          child.stdin.write(codeViaStdin);
          child.stdin.end();
        } else if (opts.stdin !== undefined) {
          child.stdin.write(opts.stdin);
          child.stdin.end();
        }
      } catch {
        // child 已 dead；error 事件会触发 resolve
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        signal: "spawn-error",
        stdout,
        stderr: stderr + (err instanceof Error ? err.message : String(err)),
        durationMs: Date.now() - start,
        timedOut: false,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (opts.abortSignal) opts.abortSignal.removeEventListener("abort", onAbort);
      const finalSignal = timedOut ? "timeout" : killed && opts.abortSignal?.aborted ? "aborted" : signal;
      resolve({
        exitCode: code ?? -1,
        signal: finalSignal as string | null,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}
