/**
 * graph_query native tool（M4-#76 step e）
 *
 * 让 LLM 通过 native tool_use 查 callers / callees / dependents / dependencies / symbol。
 * 走 src/graph/api.ts 高层接口。索引为空时返提示让 LLM 不要重试（建议先 /graph build）。
 */

import { runQuery, runStatus, formatQueryResult } from "../../graph/api";
import type { ToolDefinition, ToolRegistry } from "./registry";

export interface RegisterGraphToolDeps {
  workspace: string;
}

export function registerGraphQueryTool(
  registry: ToolRegistry,
  deps: RegisterGraphToolDeps
): void {
  if (registry.has("graph_query")) return;
  registry.register(buildToolDefinition(deps));
}

function buildToolDefinition(deps: RegisterGraphToolDeps): ToolDefinition {
  return {
    name: "graph_query",
    description:
      "Query the workspace CodebaseGraph: callers / callees / import dependents / dependencies / symbol lookup. " +
      "Useful for impact analysis ('who calls X?'), import tracing, exploring large codebases. " +
      "Index must be built first via /graph build (currently TS/JS only).",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["callers", "callees", "dependents", "dependencies", "symbol"],
          description:
            "Query type:\n" +
            " - callers: who calls a symbol name (with optional path scope)\n" +
            " - callees: what does a file call (give file path)\n" +
            " - dependents: which files import this path\n" +
            " - dependencies: what does this file import\n" +
            " - symbol: look up symbol declarations by name (or list a file's symbols when arg contains slash)",
        },
        arg: {
          type: "string",
          description:
            "Primary argument. For callers/symbol: the name (or file path for symbol). For callees/dependents/dependencies: the relative path.",
        },
        arg2: {
          type: "string",
          description:
            "Optional secondary argument. For callers: scope to a specific callee path (rel_path).",
        },
      },
      required: ["type", "arg"],
      additionalProperties: false,
    },
    async invoke(args, _ctx) {
      const { type, arg, arg2 } = parseArgs(args);
      if (!type || !arg) {
        return {
          ok: false,
          content: "[graph_query] missing 'type' or 'arg'",
          isError: true,
          errorCode: "invalid_args",
        };
      }
      const status = runStatus(deps.workspace);
      if (status.symbols === 0 && status.imports === 0 && status.calls === 0) {
        return {
          ok: false,
          content:
            "[graph_query] graph is empty. Run `/graph build` first to index the workspace (TS/JS only).",
          isError: true,
          errorCode: "graph_empty",
        };
      }
      const result = runQuery(deps.workspace, type, arg, arg2);
      return { ok: true, content: formatQueryResult(result) };
    },
  };
}

function parseArgs(args: unknown): {
  type?: "callers" | "callees" | "dependents" | "dependencies" | "symbol";
  arg?: string;
  arg2?: string;
} {
  if (!args || typeof args !== "object") return {};
  const a = args as Record<string, unknown>;
  const type = a.type;
  if (
    type !== "callers" &&
    type !== "callees" &&
    type !== "dependents" &&
    type !== "dependencies" &&
    type !== "symbol"
  ) {
    return {};
  }
  return {
    type,
    arg: typeof a.arg === "string" ? a.arg.trim() : undefined,
    arg2: typeof a.arg2 === "string" ? a.arg2.trim() : undefined,
  };
}
