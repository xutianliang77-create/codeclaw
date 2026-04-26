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
import type { ToolDefinition, ToolInvokeContext, ToolInvokeResult, ToolRegistry } from "./registry";

interface ReadArgs { file_path: string; offset?: number; limit?: number }
interface BashArgs { command: string }
interface GlobArgs { pattern: string }
interface SymbolArgs { query: string }
interface DefinitionArgs { query: string }
interface ReferencesArgs { query: string }
interface WriteArgs { file_path: string; content: string }
interface AppendArgs { file_path: string; content: string }
interface ReplaceArgs { file_path: string; find: string; replace: string }

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

function readDef(): ToolDefinition {
  return {
    name: "read",
    description: "读取 workspace 内文件全文（默认前 12000 字符）。仅支持单文件路径。",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "absolute or workspace-relative path" },
      },
      required: ["file_path"],
    },
    async invoke(args, ctx) {
      const { file_path } = args as ReadArgs;
      const p = asString(file_path, "file_path");
      return runViaLocal(`/read ${p}`, ctx);
    },
  };
}

function bashDef(): ToolDefinition {
  return {
    name: "bash",
    description: "在 workspace 执行 bash 命令；输出截断 12000 字符。受 PermissionManager 审批。",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "shell command" },
      },
      required: ["command"],
    },
    async invoke(args, ctx) {
      const { command } = args as BashArgs;
      return runViaLocal(`/bash ${asString(command, "command")}`, ctx);
    },
  };
}

function globDef(): ToolDefinition {
  return {
    name: "glob",
    description: "按 glob 模式搜索 workspace 文件（最多 200 条）。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob pattern, e.g. **/*.ts" },
      },
      required: ["pattern"],
    },
    async invoke(args, ctx) {
      const { pattern } = args as GlobArgs;
      return runViaLocal(`/glob ${asString(pattern, "pattern")}`, ctx);
    },
  };
}

function symbolDef(): ToolDefinition {
  return {
    name: "symbol",
    description: "在 workspace 内查询符号（function/class/var）。支持模糊匹配。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "symbol name or fragment" },
      },
      required: ["query"],
    },
    async invoke(args, ctx) {
      const { query } = args as SymbolArgs;
      return runViaLocal(`/symbol ${asString(query, "query")}`, ctx);
    },
  };
}

function definitionDef(): ToolDefinition {
  return {
    name: "definition",
    description: "查询某符号的定义位置（LSP go-to-definition）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "symbol name" },
      },
      required: ["query"],
    },
    async invoke(args, ctx) {
      const { query } = args as DefinitionArgs;
      return runViaLocal(`/definition ${asString(query, "query")}`, ctx);
    },
  };
}

function referencesDef(): ToolDefinition {
  return {
    name: "references",
    description: "查询某符号的所有引用位置（LSP find-references）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "symbol name" },
      },
      required: ["query"],
    },
    async invoke(args, ctx) {
      const { query } = args as ReferencesArgs;
      return runViaLocal(`/references ${asString(query, "query")}`, ctx);
    },
  };
}

function writeDef(): ToolDefinition {
  return {
    name: "write",
    description: "覆写文件全文（先备份）。受 PermissionManager 审批。",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
      },
      required: ["file_path", "content"],
    },
    async invoke(args, ctx) {
      const { file_path, content } = args as WriteArgs;
      const p = asString(file_path, "file_path");
      const c = asString(content, "content");
      return runViaLocal(`/write ${p} :: ${c}`, ctx);
    },
  };
}

function appendDef(): ToolDefinition {
  return {
    name: "append",
    description: "在文件尾追加内容。受 PermissionManager 审批。",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
      },
      required: ["file_path", "content"],
    },
    async invoke(args, ctx) {
      const { file_path, content } = args as AppendArgs;
      const p = asString(file_path, "file_path");
      const c = asString(content, "content");
      return runViaLocal(`/append ${p} :: ${c}`, ctx);
    },
  };
}

function replaceDef(): ToolDefinition {
  return {
    name: "replace",
    description: "在文件内做精确字符串替换。受 PermissionManager 审批。",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        find: { type: "string", description: "exact text to match" },
        replace: { type: "string", description: "replacement text" },
      },
      required: ["file_path", "find", "replace"],
    },
    async invoke(args, ctx) {
      const { file_path, find, replace } = args as ReplaceArgs;
      const p = asString(file_path, "file_path");
      const f = asString(find, "find");
      const r = asString(replace, "replace");
      return runViaLocal(`/replace ${p} :: ${f} :: ${r}`, ctx);
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
] as const;

export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(readDef());
  registry.register(bashDef());
  registry.register(globDef());
  registry.register(symbolDef());
  registry.register(definitionDef());
  registry.register(referencesDef());
  registry.register(writeDef());
  registry.register(appendDef());
  registry.register(replaceDef());
}
