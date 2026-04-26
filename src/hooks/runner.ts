/**
 * Hooks runner（M3-04 step 2）
 *
 * 在 5 个 lifecycle 时点执行用户配置的 hook command。
 *
 * 协议（参考 Claude Code）：
 *   - spawn shell -lc "<command>"，stdio = pipe / pipe / pipe
 *   - 把 event payload JSON 写到子进程 stdin 后立即 end
 *   - 收 stdout 全文（≤64KB 截断）+ stderr + exit code
 *   - 超时强 kill SIGKILL，返回 timeout 标记
 *
 * 阻塞语义（按事件类型）：
 *   - PreToolUse: exit code !== 0 → 阻塞 tool 调用，stderr 给 LLM 当 tool result
 *   - UserPromptSubmit: exit code !== 0 → 阻塞用户消息派发
 *   - PostToolUse / Stop / SessionStart: 仅副作用，exit code 不影响主流程
 *
 * 错误隔离：
 *   - hook spawn 失败 / timeout → 记 stderr，不抛回主流程；返回 ok:false
 *   - 阻塞型事件下 spawn 失败按"放行"处理（fail-open，避免 hook 故障锁死所有 IO）
 *
 * matcher：
 *   - 仅 PreToolUse / PostToolUse 用，匹配 tool 名（regex 字符串编译；非法 regex 视为不匹配）
 *   - 省略 matcher = 匹配所有 tool
 *   - 其他事件类型忽略 matcher 字段
 */

import { spawn } from "node:child_process";
import type { HookCommand, HookEventType, HookMatcher, HookSettings } from "./settings";

const DEFAULT_TIMEOUT_MS: Record<HookEventType, number> = {
  PreToolUse: 5_000,
  PostToolUse: 5_000,
  UserPromptSubmit: 200, // 严格：阻塞 IO，必须快
  Stop: 5_000,
  SessionStart: 5_000,
};

const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;

export interface BaseEventPayload {
  sessionId?: string;
  workspace?: string;
  permissionMode?: string;
}

export interface PreToolUsePayload extends BaseEventPayload {
  toolName: string;
  toolArgs: unknown;
}

export interface PostToolUsePayload extends PreToolUsePayload {
  result: { ok: boolean; content: string; isError?: boolean };
}

export interface UserPromptSubmitPayload extends BaseEventPayload {
  prompt: string;
}

export interface StopPayload extends BaseEventPayload {
  /** message-complete 时的最终 assistant text */
  finalText: string;
}

export interface SessionStartPayload extends BaseEventPayload {
  startedAt: number;
}

export type HookEventPayload =
  | { type: "PreToolUse"; data: PreToolUsePayload }
  | { type: "PostToolUse"; data: PostToolUsePayload }
  | { type: "UserPromptSubmit"; data: UserPromptSubmitPayload }
  | { type: "Stop"; data: StopPayload }
  | { type: "SessionStart"; data: SessionStartPayload };

export interface HookExecution {
  command: string;
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunHooksResult {
  /** 阻塞型事件时是否被某个 hook 阻断 */
  blocked: boolean;
  /** 阻塞 hook 的 stderr（用作 tool result / 用户提示） */
  blockReason?: string;
  /** 全部执行的 hook 详情（含 fail-open 的） */
  executions: HookExecution[];
}

export async function runHooks(
  event: HookEventPayload,
  hooksConfig: HookSettings
): Promise<RunHooksResult> {
  const matchers = hooksConfig[event.type] ?? [];
  if (matchers.length === 0) {
    return { blocked: false, executions: [] };
  }

  const toolName = event.type === "PreToolUse" || event.type === "PostToolUse"
    ? (event.data as PreToolUsePayload).toolName
    : null;

  const isBlockingEvent = event.type === "PreToolUse" || event.type === "UserPromptSubmit";
  const executions: HookExecution[] = [];

  for (const matcher of matchers) {
    if (!matchesTool(matcher, toolName)) continue;
    for (const cmd of matcher.hooks) {
      const exec = await runSingleHook(cmd, event);
      executions.push(exec);
      if (isBlockingEvent && !exec.ok && !exec.timedOut && exec.exitCode !== null && exec.exitCode !== 0) {
        // 阻塞性事件 + 子进程返回非 0（不是 spawn 错也不是 timeout）→ 真阻塞
        return {
          blocked: true,
          blockReason: exec.stderr.trim() || `${event.type} hook exited ${exec.exitCode}`,
          executions,
        };
      }
    }
  }

  return { blocked: false, executions };
}

function matchesTool(matcher: HookMatcher, toolName: string | null): boolean {
  if (!matcher.matcher) return true;
  if (toolName === null) return true; // 非 tool 类事件忽略 matcher
  try {
    const re = new RegExp(matcher.matcher);
    return re.test(toolName);
  } catch {
    return false; // 非法 regex 视为不匹配
  }
}

function runSingleHook(cmd: HookCommand, event: HookEventPayload): Promise<HookExecution> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timeoutMs = cmd.timeout ?? DEFAULT_TIMEOUT_MS[event.type];
    const child = spawn(process.env.SHELL ?? "bash", ["-lc", cmd.command], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let resolved = false;

    const finish = (
      ok: boolean,
      exitCode: number | null,
      signal: NodeJS.Signals | null
    ): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        command: cmd.command,
        ok,
        exitCode,
        signal,
        stdout: clip(stdout),
        stderr: clip(stderr),
        timedOut,
        durationMs: Date.now() - start,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(false, null, "SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_HOOK_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_HOOK_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += `\n[hook spawn error] ${err.message}`;
      finish(false, null, null);
    });
    child.on("exit", (code, signal) => {
      finish(code === 0, code, signal);
    });

    try {
      const payload = JSON.stringify(event);
      child.stdin?.end(payload);
    } catch (err) {
      stderr += `\n[hook stdin error] ${err instanceof Error ? err.message : String(err)}`;
      try {
        child.kill("SIGKILL");
      } catch {
        /* swallow */
      }
      finish(false, null, null);
    }
  });
}

function clip(s: string): string {
  if (s.length <= MAX_HOOK_OUTPUT_BYTES) return s;
  return `${s.slice(0, MAX_HOOK_OUTPUT_BYTES)}\n[truncated]`;
}
