/**
 * Subagent runner（M3-02 step b）
 *
 * 派生轻量子 QueryEngine 跑一个隔离任务，返最终 message-complete text 给父 turn。
 *
 * 隔离边界：
 *   - 独立 sessionId（createQueryEngine 自动生成）
 *   - audit/data db disable（auditDbPath: null, dataDbPath: null）
 *   - 不召回 L2 memory（不传 channel/userId）
 *   - approvalsDir 沿用父（pending approval 在父子间共享是合理的：用户审批的是这台机的所有 spawn）
 *   - tool registry 按 role.allowedTools 过滤；Task 自己不注册（防递归）
 *
 * 输入：
 *   - role 名（必须在 BUILTIN_ROLES）
 *   - prompt（子 agent 要解决的具体任务）
 *
 * 输出：
 *   - finalText：子 agent 最后一个非空 message-complete 的 text
 *   - toolCallCount / durationMs（用于父 audit）
 */

import { createQueryEngine } from "../queryEngine";
import { getRole } from "./roles";
import type { ProviderStatus } from "../../provider/types";
import type { McpManager } from "../../mcp/manager";
import type { CodeclawSettings } from "../../hooks/settings";
import type { EngineEvent } from "../types";

const SUBAGENT_MAX_DURATION_MS = 5 * 60 * 1000;

export interface RunSubagentInput {
  role: string;
  prompt: string;
}

export interface RunSubagentDeps {
  currentProvider: ProviderStatus | null;
  fallbackProvider: ProviderStatus | null;
  workspace: string;
  approvalsDir?: string;
  mcpManager?: McpManager;
  /** 父 settings：子 agent 不跑 hooks（避免双重副作用）；这里仅占位以备后续扩展 */
  settings?: CodeclawSettings;
  /** 测试注入 mock provider stream；生产忽略走默认 fetch */
  fetchImpl?: typeof fetch;
  /** 父 turn 的 abort signal；用户 Ctrl-C 时让子 engine 立即停 */
  abortSignal?: AbortSignal;
}

export interface RunSubagentOutput {
  ok: boolean;
  finalText: string;
  toolCallCount: number;
  durationMs: number;
  error?: string;
}

export async function runSubagent(
  input: RunSubagentInput,
  deps: RunSubagentDeps
): Promise<RunSubagentOutput> {
  const role = getRole(input.role);
  if (!role) {
    return {
      ok: false,
      finalText: "",
      toolCallCount: 0,
      durationMs: 0,
      error: `unknown subagent role: ${input.role}`,
    };
  }
  if (!input.prompt || !input.prompt.trim()) {
    return {
      ok: false,
      finalText: "",
      toolCallCount: 0,
      durationMs: 0,
      error: "subagent prompt is empty",
    };
  }

  const startedAt = Date.now();

  const engine = createQueryEngine({
    currentProvider: deps.currentProvider,
    fallbackProvider: deps.fallbackProvider,
    permissionMode: role.permissionMode ?? "default",
    workspace: deps.workspace,
    auditDbPath: null,
    dataDbPath: null,
    ...(deps.approvalsDir ? { approvalsDir: deps.approvalsDir } : {}),
    ...(deps.mcpManager ? { mcpManager: deps.mcpManager } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    // settings 故意不透传：子 agent 不跑 hooks
  });

  // 工具集过滤：role.allowedTools 之外的全部 unregister
  // Task 工具本身也要 unregister 防止子 agent 递归创建子 agent
  // B2: readonly 类 role（plan mode）的 allowedTools 没显式列 memory_write/memory_remove，
  //     但 queryEngine constructor 默认会注册它们（CODECLAW_PROJECT_MEMORY 控制）。
  //     allowedTools 限定 path 自动剔除；全集 role path 这里要主动剔除 memory 写工具，
  //     避免 readonly subagent 误改父项目 memory。Plan/Explore/code-reviewer/deep-reviewer
  //     等 role 因为 allowedTools 限定，自动落入第一条 path，无需额外处理。
  const reg = (engine as unknown as {
    toolRegistry?: { list(): Array<{ name: string }>; unregister(name: string): boolean };
  }).toolRegistry;
  if (role.allowedTools !== undefined) {
    const allowed = new Set<string>(role.allowedTools);
    if (reg) {
      for (const t of reg.list()) {
        if (!allowed.has(t.name)) reg.unregister(t.name);
      }
    }
  } else {
    // 全集 role 也要砍 Task（防递归）
    reg?.unregister("Task");
    // plan mode 全集 role（理论上不存在，但保护）→ 砍 memory write
    if (role.permissionMode === "plan") {
      reg?.unregister("memory_write");
      reg?.unregister("memory_remove");
    }
  }

  // 拼最终 prompt：role.instructions 作为前缀（轻量；不重复 buildSystemPrompt 内容）
  const finalPrompt = role.instructions
    ? `${role.instructions}\n\n---\n\n${input.prompt.trim()}`
    : input.prompt.trim();

  let lastNonEmptyText = "";
  let toolCallCount = 0;
  let aborted = false;
  let abortError: string | undefined;

  const abortTimer = setTimeout(() => {
    aborted = true;
  }, SUBAGENT_MAX_DURATION_MS);

  // 父 abort 信号同步级联
  let parentAbortListener: (() => void) | null = null;
  if (deps.abortSignal) {
    if (deps.abortSignal.aborted) {
      aborted = true;
      abortError = "parent turn aborted before subagent started";
    } else {
      parentAbortListener = () => {
        aborted = true;
        if (!abortError) abortError = "parent turn aborted";
      };
      deps.abortSignal.addEventListener("abort", parentAbortListener);
    }
  }

  try {
    for await (const ev of engine.submitMessage(finalPrompt) as AsyncGenerator<EngineEvent>) {
      if (aborted) {
        if (!abortError) abortError = `subagent exceeded ${SUBAGENT_MAX_DURATION_MS}ms wall clock`;
        break;
      }
      if (ev.type === "tool-start") toolCallCount += 1;
      if (ev.type === "message-complete") {
        const t = (ev as { text: string }).text;
        if (t.trim()) lastNonEmptyText = t;
      }
    }
  } catch (err) {
    abortError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(abortTimer);
    if (parentAbortListener && deps.abortSignal) {
      deps.abortSignal.removeEventListener("abort", parentAbortListener);
    }
  }

  return {
    ok: !!lastNonEmptyText && !abortError,
    finalText: lastNonEmptyText || "[no content produced]",
    toolCallCount,
    durationMs: Date.now() - startedAt,
    ...(abortError ? { error: abortError } : {}),
  };
}
