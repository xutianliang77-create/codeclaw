/**
 * MCP → ToolRegistry 桥接（M3-01 step c）
 *
 * 把 McpManager.listAllTools() 暴露的 { server, tool } 映射成 codeclaw 的
 * ToolDefinition，注册进 ToolRegistry，让 LLM 在 native tool_use 时能直接调。
 *
 * 命名空间：mcp__<server>__<tool>
 *   - 用双下划线分隔；与 Anthropic / Claude Code 的 mcp prefix 习惯一致
 *   - 与 codeclaw builtin（read/glob/bash/...）天然不冲突
 *   - 不同 server 暴露同名 tool 也不冲突（server 名是 namespace 一部分）
 *
 * inputSchema 转换：
 *   - MCP 规范允许 inputSchema 是任意 JSONSchema；codeclaw 收紧到 type=="object"+properties
 *   - 不符合（如顶层 type=="string" 之类）→ 降级为空 {type:"object", properties:{}}
 *
 * invoke 转换：
 *   - manager.callTool(server, tool, args) → McpToolResult
 *   - content[] 只摘 type==="text" 的 text 字段拼接（多媒体留 future）
 *   - isError === true → 标 ToolInvokeResult.isError
 *
 * 不做：
 *   - permission gate（permissions/manager.ts 不识别 mcp__ 前缀；step d 桥接审批）
 *   - 重新同步（server crash + restart 后若 tool schema 变化，需要外层调 unregister + 重新 bridge）
 */

import type { McpManager } from "./manager";
import type { McpToolDescriptor } from "./client";
import type {
  ToolDefinition,
  ToolInputSchema,
  ToolInvokeContext,
  ToolInvokeResult,
  ToolRegistry,
} from "../agent/tools/registry";

const EMPTY_SCHEMA: ToolInputSchema = { type: "object", properties: {} };

export interface BridgeReport {
  registered: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export function bridgeMcpTools(
  manager: McpManager,
  registry: ToolRegistry,
  options: { namespace?: string } = {}
): BridgeReport {
  const namespace = options.namespace ?? "mcp";
  const report: BridgeReport = { registered: [], skipped: [] };

  for (const { server, tool } of manager.listAllTools()) {
    const name = mcpToolName(namespace, server, tool.name);
    if (registry.has(name)) {
      report.skipped.push({ name, reason: "already registered" });
      continue;
    }
    try {
      registry.register(buildToolDefinition(manager, name, server, tool));
      report.registered.push(name);
    } catch (err) {
      report.skipped.push({
        name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}

/** 反向操作：把先前 bridge 进去的 mcp__* 工具从 registry 摘掉（用于 reload）。 */
export function unbridgeMcpTools(registry: ToolRegistry, namespace: string = "mcp"): number {
  const prefix = `${namespace}__`;
  let removed = 0;
  for (const t of registry.list()) {
    if (t.name.startsWith(prefix)) {
      if (registry.unregister(t.name)) removed += 1;
    }
  }
  return removed;
}

function mcpToolName(namespace: string, server: string, tool: string): string {
  return `${namespace}__${sanitize(server)}__${sanitize(tool)}`;
}

/** OpenAI / Anthropic 工具名要求 [a-zA-Z0-9_-]，把空格 / 冒号等替换成下划线 */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buildToolDefinition(
  manager: McpManager,
  registeredName: string,
  serverName: string,
  tool: McpToolDescriptor
): ToolDefinition {
  return {
    name: registeredName,
    description: tool.description ?? `MCP tool ${tool.name} from server ${serverName}`,
    inputSchema: coerceInputSchema(tool.inputSchema),
    async invoke(args: unknown, _ctx: ToolInvokeContext): Promise<ToolInvokeResult> {
      try {
        const result = await manager.callTool(serverName, tool.name, args ?? {});
        const text = extractTextContent(result.content);
        return {
          ok: !result.isError,
          content: text || (result.isError ? "[mcp tool error: empty content]" : ""),
          ...(result.isError ? { isError: true, errorCode: "mcp_tool_error" } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          content: `[mcp invoke failed] ${msg}`,
          isError: true,
          errorCode: "mcp_invoke_failed",
        };
      }
    },
  };
}

function coerceInputSchema(raw: unknown): ToolInputSchema {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_SCHEMA;
  const obj = raw as Record<string, unknown>;
  if (obj.type !== "object") return EMPTY_SCHEMA;
  const properties =
    obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)
      ? (obj.properties as Record<string, unknown>)
      : {};
  const out: ToolInputSchema = { type: "object", properties };
  if (Array.isArray(obj.required)) {
    out.required = obj.required.filter((x): x is string => typeof x === "string");
  }
  if (typeof obj.additionalProperties === "boolean") {
    out.additionalProperties = obj.additionalProperties;
  }
  return out;
}

function extractTextContent(content: Array<{ type: string; text?: string; [k: string]: unknown }>): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}
