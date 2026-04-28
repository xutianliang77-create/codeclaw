/**
 * Native tool_use 9 个 builtin 注册（M1-B）
 *
 * 复用 src/tools/local.ts:runLocalTool 的内部 runner 路径：
 *   每个 ToolDefinition.invoke() 把结构化 args 重新格式化为 `/foo arg1 [:: arg2]` prompt，
 *   再交给 runLocalTool。这样不必改 local.ts 的内部实现，runner 改动会自动生效。
 *
 * 与 LocalTool 的关系：
 *   - LocalTool 是用户 typed `/read foo` 的检测路径；保留不动
 *   - 这里的 wrappers 是 LLM tool_use 的执行入口，结构化 args → prompt → runLocalTool
 *
 * 注意：
 *   - 这里不做 approval / permission 检查；queryEngine multi-turn 循环在调用 invoke 前应做
 *     PermissionManager 检查（M2-04 完整接入 deny 反馈）
 *   - bash command / write content 中的 `::` 因 local.ts 用 split + slice(1).join(" :: ")
 *     重组，可保留原文
 */

import { runLocalTool } from "../../tools/local";
import { isHandledToolExecutionOutcome } from "../../tools/types";
import { readArtifact } from "./artifact";
import type {
  ToolDefinition,
  ToolInputSchema,
  ToolInvokeContext,
  ToolInvokeResult,
  ToolRegistry,
} from "./registry";

function asString(v: unknown, name: string): string {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  return v;
}

async function runViaLocal(
  prompt: string,
  ctx: ToolInvokeContext
): Promise<ToolInvokeResult> {
  const outcome = await runLocalTool(prompt, ctx.workspace);
  if (!isHandledToolExecutionOutcome(outcome)) {
    return { ok: false, content: "[tool error] not handled by local runner", isError: true };
  }
  if (outcome.kind === "error") {
    return {
      ok: false,
      content: outcome.output,
      isError: true,
      errorCode: outcome.errorCode,
    };
  }
  return { ok: true, content: outcome.output };
}

/**
 * 把若干必填 string 字段拼成 `/<slash> <v1> [:: <v2> :: ...]` 后交给 runLocalTool。
 * 单字段 → `/cmd <v>`；多字段 → `/cmd <v1> :: <v2> :: ...`（与原 inline 实现等价）。
 */
function defineSimpleTool(spec: {
  name: string;
  description: string;
  slash: string;
  fields: Array<{ key: string; description?: string }>;
}): ToolDefinition {
  const properties: Record<string, unknown> = {};
  for (const f of spec.fields) {
    properties[f.key] = f.description
      ? { type: "string", description: f.description }
      : { type: "string" };
  }
  const inputSchema: ToolInputSchema = {
    type: "object",
    properties,
    required: spec.fields.map((f) => f.key),
  };
  return {
    name: spec.name,
    description: spec.description,
    inputSchema,
    async invoke(args, ctx) {
      const obj = (args ?? {}) as Record<string, unknown>;
      const values = spec.fields.map((f) => asString(obj[f.key], f.key));
      const prompt =
        values.length === 1
          ? `${spec.slash} ${values[0]}`
          : `${spec.slash} ${values.join(" :: ")}`;
      return runViaLocal(prompt, ctx);
    },
  };
}

export const BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "glob",
  "symbol",
  "definition",
  "references",
  "write",
  "append",
  "replace",
  "read_artifact",
] as const;

/** v0.8.1 #3：当工具结果超 4KB 落盘后，LLM 可调用本工具按 offset/limit 取段读全文。 */
function defineReadArtifactTool(): ToolDefinition {
  const inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "artifact path returned by a previous tool result hint",
      },
      offset: {
        type: "number",
        description: "byte offset to start reading (default 0)",
      },
      limit: {
        type: "number",
        description: "max chars to return (default 16384)",
      },
    },
    required: ["path"],
  };
  return {
    name: "read_artifact",
    description:
      "读取之前工具结果保存的全量 artifact（~/.codeclaw/artifacts/<session>/<callId>.txt 下）。" +
      "用 offset+limit 取任意段；只能读 artifacts 目录内的文件。",
    inputSchema,
    async invoke(args) {
      const obj = (args ?? {}) as Record<string, unknown>;
      const p = asString(obj.path, "path");
      const offset = typeof obj.offset === "number" ? obj.offset : undefined;
      const limit = typeof obj.limit === "number" ? obj.limit : undefined;
      try {
        const content = readArtifact(p, {
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return { ok: true, content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: `[read_artifact failed] ${msg}`, isError: true };
      }
    },
  };
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(
    defineSimpleTool({
      name: "read",
      description: "读取 workspace 内文件全文（默认前 12000 字符）。仅支持单文件路径。",
      slash: "/read",
      fields: [{ key: "file_path", description: "absolute or workspace-relative path" }],
    })
  );
  registry.register(
    defineSimpleTool({
      name: "bash",
      description: "在 workspace 执行 bash 命令；输出截断 12000 字符。受 PermissionManager 审批。",
      slash: "/bash",
      fields: [{ key: "command", description: "shell command" }],
    })
  );
  registry.register(
    defineSimpleTool({
      name: "glob",
      description: "按 glob 模式搜索 workspace 文件（最多 200 条）。",
      slash: "/glob",
      fields: [{ key: "pattern", description: "glob pattern, e.g. **/*.ts" }],
    })
  );
  registry.register(
    defineSimpleTool({
      name: "symbol",
      description: "在 workspace 内查询符号（function/class/var）。支持模糊匹配。",
      slash: "/symbol",
      fields: [{ key: "query", description: "symbol name or fragment" }],
    })
  );
  registry.register(
    defineSimpleTool({
      name: "definition",
      description: "查询某符号的定义位置（LSP go-to-definition）。",
      slash: "/definition",
      fields: [{ key: "query", description: "symbol name" }],
    })
  );
  registry.register(
    defineSimpleTool({
      name: "references",
      description: "查询某符号的所有引用位置（LSP find-references）。",
      slash: "/references",
      fields: [{ key: "query", description: "symbol name" }],
    })
  );
  registry.register(
    defineSimpleTool({
      name: "write",
      description: "覆写文件全文（先备份）。受 PermissionManager 审批。",
      slash: "/write",
      fields: [{ key: "file_path" }, { key: "content" }],
    })
  );
  registry.register(
    defineSimpleTool({
      name: "append",
      description: "在文件尾追加内容。受 PermissionManager 审批。",
      slash: "/append",
      fields: [{ key: "file_path" }, { key: "content" }],
    })
  );
  registry.register(
    defineSimpleTool({
      name: "replace",
      description: "在文件内做精确字符串替换。受 PermissionManager 审批。",
      slash: "/replace",
      fields: [
        { key: "file_path" },
        { key: "find", description: "exact text to match" },
        { key: "replace", description: "replacement text" },
      ],
    })
  );
  registry.register(defineReadArtifactTool());
}
