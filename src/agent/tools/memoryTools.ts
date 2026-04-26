/**
 * Memory Tools（M2-02）
 *
 * 把 projectMemory store 的 CRUD 暴露给 LLM 用 native tool_use 调用：
 *   - memory_write：保存 fact / 偏好 / 项目知识到长期记忆
 *   - memory_remove：按 name 删除某条记忆
 *
 * 注：
 *   - LLM 应"惜墨如金"调 memory_write，只存非显然 / 跨会话有价值的信息
 *   - 写入路径自动 redact secrets（store 层）
 *   - workspace 由 ToolInvokeContext 提供；不同项目自动隔离
 */

import type { ToolDefinition, ToolRegistry } from "./registry";
import { removeMemory, writeMemory, type MemoryType } from "../../memory/projectMemory/store";

interface MemoryWriteArgs {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

interface MemoryRemoveArgs {
  name: string;
}

function memoryWriteDef(): ToolDefinition {
  return {
    name: "memory_write",
    description:
      "Save a fact / preference / project knowledge to long-term memory (~/.codeclaw/projects/<hash>/memory/). " +
      "Use sparingly: only for non-obvious info worth recalling in future sessions.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "short slug, e.g., 'user_role' or 'pkg_layout'" },
        description: { type: "string", description: "one-line summary, ≤80 chars; shown in MEMORY.md index" },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description:
            "user: about the human. feedback: user-given guidance. project: tech facts. reference: pointer to external resources.",
        },
        body: { type: "string", description: "markdown content; ≤8KB after redaction" },
      },
      required: ["name", "description", "type", "body"],
    },
    async invoke(args, ctx) {
      const a = (args ?? {}) as Partial<MemoryWriteArgs>;
      if (typeof a.name !== "string" || typeof a.description !== "string" || typeof a.body !== "string") {
        return {
          ok: false,
          content: "[memory_write] name / description / body must be strings",
          isError: true,
          errorCode: "invalid_args",
        };
      }
      try {
        const entry = writeMemory(ctx.workspace, {
          name: a.name,
          description: a.description,
          type: (a.type ?? "project") as MemoryType,
          body: a.body,
        });
        return {
          ok: true,
          content: `Saved memory: ${entry.name} (${entry.type}) → ${entry.filePath}`,
        };
      } catch (err) {
        return {
          ok: false,
          content: `[memory_write] ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
          errorCode: "write_failed",
        };
      }
    },
  };
}

function memoryRemoveDef(): ToolDefinition {
  return {
    name: "memory_remove",
    description: "Remove a previously saved long-term memory by its name (slug).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "memory slug to remove" },
      },
      required: ["name"],
    },
    async invoke(args, ctx) {
      const a = (args ?? {}) as Partial<MemoryRemoveArgs>;
      if (typeof a.name !== "string") {
        return { ok: false, content: "[memory_remove] name must be a string", isError: true };
      }
      const removed = removeMemory(ctx.workspace, a.name);
      return {
        ok: removed,
        content: removed ? `Removed memory: ${a.name}` : `Memory not found: ${a.name}`,
      };
    },
  };
}

export const MEMORY_TOOL_NAMES = ["memory_write", "memory_remove"] as const;

export function registerMemoryTools(registry: ToolRegistry): void {
  registry.register(memoryWriteDef());
  registry.register(memoryRemoveDef());
}
