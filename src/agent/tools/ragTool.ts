/**
 * rag_search native tool（M4-#75 step e）
 *
 * 注册到 ToolRegistry 让 LLM 能用关键字找相关代码（BM25 召回）。
 * 自动从 ctx.workspace 取 workspace 解析 rag.db。
 *
 * 设计：
 *   - 仅 search（不暴露 index / clear；这俩走 /rag slash 命令由用户触发）
 *   - 默认 topK=8（保守，避免 context 爆）
 *   - 未索引时返提示让用户先跑 /rag index（防 LLM 反复重试）
 */

import { runSearch, runStatus } from "../../rag/api";
import type { ToolDefinition, ToolRegistry } from "./registry";

export interface RegisterRagToolDeps {
  workspace: string;
}

export function registerRagSearchTool(
  registry: ToolRegistry,
  deps: RegisterRagToolDeps
): void {
  if (registry.has("rag_search")) return;
  registry.register(buildToolDefinition(deps));
}

function buildToolDefinition(deps: RegisterRagToolDeps): ToolDefinition {
  return {
    name: "rag_search",
    description:
      "Search the workspace's RAG index for code chunks relevant to a query. " +
      "Uses BM25 keyword matching (semantic embedding hybrid is upcoming). " +
      "Returns top-K chunks with file:line references and content excerpts. " +
      "Index must be built first via /rag index.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text query; tokens are matched case-insensitively",
        },
        topK: {
          type: "number",
          description: "Max results to return (default 8, max 20)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async invoke(args, _ctx) {
      const { query, topK } = parseArgs(args);
      if (!query) {
        return {
          ok: false,
          content: "[rag_search] missing 'query'",
          isError: true,
          errorCode: "invalid_args",
        };
      }
      const status = runStatus(deps.workspace);
      if (status.chunkCount === 0) {
        return {
          ok: false,
          content:
            "[rag_search] index is empty. Run `/rag index` first to build the workspace index.",
          isError: true,
          errorCode: "index_empty",
        };
      }
      const k = Math.min(20, Math.max(1, topK ?? 8));
      const result = runSearch(deps.workspace, query, k);
      return {
        ok: true,
        content: result.text,
      };
    },
  };
}

function parseArgs(args: unknown): { query?: string; topK?: number } {
  if (!args || typeof args !== "object") return {};
  const a = args as Record<string, unknown>;
  return {
    query: typeof a.query === "string" ? a.query.trim() : undefined,
    topK: typeof a.topK === "number" ? a.topK : undefined,
  };
}
