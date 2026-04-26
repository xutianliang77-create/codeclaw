/**
 * Task tool · 父 agent 派生 subagent 的 native tool（M3-02 step c）
 *
 * LLM 输入：{ role: "<one-of-builtin>", prompt: "<task description>" }
 * 调用：runSubagent → 返回子 agent 最终 text 给父 turn 当 tool result
 *
 * 防递归：runner 内部已 unregister 子 engine 的 Task tool；本工具仅注册到父 engine。
 *
 * Permission：Task 不走 evaluate gate（子 engine 内部各 tool 仍受 role.permissionMode
 * 与父 PermissionManager 拦截）；父 LLM 调 Task 不需额外审批。
 */

import { BUILTIN_ROLES, listRoleNames } from "../subagents/roles";
import { runSubagent, type RunSubagentDeps } from "../subagents/runner";
import type { SubagentRegistry } from "../subagents/registry";
import type { ToolDefinition, ToolRegistry } from "./registry";

export interface RegisterTaskToolDeps extends RunSubagentDeps {
  /** 工具描述前缀；默认列出所有 builtin role */
  descriptionPrefix?: string;
  /** B.8：父 engine 的 SubagentRegistry；不传则不追踪 */
  subagentRegistry?: SubagentRegistry;
}

export function registerTaskTool(registry: ToolRegistry, deps: RegisterTaskToolDeps): void {
  if (registry.has("Task")) return; // 重入注册无害
  registry.register(buildTaskToolDefinition(deps));
}

function buildTaskToolDefinition(deps: RegisterTaskToolDeps): ToolDefinition {
  const roleSummary = Object.values(BUILTIN_ROLES)
    .map((r) => `${r.name}: ${r.description}`)
    .join("\n");
  const description =
    (deps.descriptionPrefix ??
      "Spawn a subagent to handle a focused task with isolated tool access. ") +
    "\nAvailable roles:\n" +
    roleSummary;

  return {
    name: "Task",
    description,
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: listRoleNames(),
          description: "Which builtin subagent role to spawn",
        },
        prompt: {
          type: "string",
          description: "What the subagent should do; be specific and self-contained",
        },
      },
      required: ["role", "prompt"],
      additionalProperties: false,
    },
    async invoke(args, ctx) {
      const { role, prompt } = parseArgs(args);
      if (!role) {
        return {
          ok: false,
          content: "[Task] missing or invalid 'role'; choose one of: " + listRoleNames().join(", "),
          isError: true,
          errorCode: "invalid_args",
        };
      }
      if (!prompt) {
        return {
          ok: false,
          content: "[Task] missing or empty 'prompt'",
          isError: true,
          errorCode: "invalid_args",
        };
      }

      const rec = deps.subagentRegistry?.start({ role, prompt });
      // C2: 父 abortSignal 透传到子 runner，父 Ctrl-C 时子 engine 立即停
      const result = await runSubagent(
        { role, prompt },
        { ...deps, ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}) }
      );
      if (rec) {
        deps.subagentRegistry?.finish(rec.id, {
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
          toolCallCount: result.toolCallCount,
          durationMs: result.durationMs,
          resultText: result.finalText,
        });
      }
      const header = `[Task ${role}] ${result.toolCallCount} tool call(s), ${result.durationMs}ms`;
      const body = result.error ? `error: ${result.error}\n\n${result.finalText}` : result.finalText;
      return {
        ok: result.ok,
        content: `${header}\n\n${body}`,
        ...(result.ok ? {} : { isError: true, errorCode: "subagent_failed" }),
      };
    },
  };
}

function parseArgs(args: unknown): { role?: string; prompt?: string } {
  if (!args || typeof args !== "object") return {};
  const a = args as Record<string, unknown>;
  return {
    role: typeof a.role === "string" ? a.role : undefined,
    prompt: typeof a.prompt === "string" ? a.prompt : undefined,
  };
}
