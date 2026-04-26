/**
 * 后端 endpoint 类型化封装（B.2）
 *
 * 与 src/channels/web/handlers.ts 的契约一一对应。
 * 类型故意保留 `unknown` / 宽松，避免双仓库 schema 漂移。
 */

import { api } from "./client";

export interface SessionMeta {
  sessionId: string;
  userId: string;
  channel: "http";
  createdAt: number;
  lastSeenAt: number;
}

export interface RagStatus {
  chunkCount: number;
  embeddedCount: number;
  lastIndexedAt: number | null;
  workspaceMeta: string | null;
}

export interface RagHit {
  relPath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  score?: number;
  rrfScore?: number;
  source?: string;
  hits?: string[];
}

export interface GraphStatus {
  symbols: number;
  imports: number;
  calls: number;
}

export type GraphQueryType = "callers" | "callees" | "dependents" | "dependencies" | "symbol";

export interface McpServerSnapshot {
  name: string;
  status: string;
  toolCount: number;
  restartCount: number;
  lastError?: string;
}

export interface McpToolDescriptor {
  server: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface StatusLine {
  text: string;
  kind: "default" | "custom";
  lastUpdate: number;
}

// ===== sessions =====

export const listSessions = () => api<{ sessions: SessionMeta[] }>("GET", "/v1/web/sessions");
export const createSession = () => api<SessionMeta>("POST", "/v1/web/sessions");
export const deleteSession = (sessionId: string) =>
  api<{ ok: boolean }>("DELETE", `/v1/web/sessions/${encodeURIComponent(sessionId)}`);
export const getSubagents = (sessionId: string) =>
  api<{ subagents: unknown[]; note?: string }>(
    "GET",
    `/v1/web/sessions/${encodeURIComponent(sessionId)}/subagents`
  );

// ===== messages =====

export const sendMessage = (sessionId: string, input: string) =>
  api<{ accepted: boolean }>("POST", "/v1/web/messages", { sessionId, input });

// ===== providers / cost =====

export const getProviders = () =>
  api<{ current: unknown; fallback: unknown }>("GET", "/v1/web/providers");
export const getCost = (sessionId: string) =>
  api<{ enabled: boolean; session?: unknown; today?: unknown }>(
    "GET",
    `/v1/web/cost?sessionId=${encodeURIComponent(sessionId)}`
  );

// ===== MCP =====

export const listMcpServers = () =>
  api<{ servers: McpServerSnapshot[] }>("GET", "/v1/web/mcp/servers");
export const listMcpTools = (server?: string) =>
  api<{ tools: McpToolDescriptor[] }>(
    "GET",
    server ? `/v1/web/mcp/tools?server=${encodeURIComponent(server)}` : "/v1/web/mcp/tools"
  );
export const callMcpTool = (server: string, tool: string, args: unknown) =>
  api<{ ok: boolean; content?: unknown; isError?: boolean }>("POST", "/v1/web/mcp/call", {
    server,
    tool,
    args,
  });

// ===== Hooks =====

export const getHooks = () =>
  api<{ events: Record<string, unknown> }>("GET", "/v1/web/hooks");
export const reloadHooks = () =>
  api<{ ok: boolean; events: Record<string, unknown> }>("POST", "/v1/web/hooks/reload");

// ===== RAG =====

export const ragStatus = () => api<RagStatus>("GET", "/v1/web/rag/status");
export const ragIndex = () =>
  api<{ summary: string; progress: unknown }>("POST", "/v1/web/rag/index");
export const ragEmbed = (opts: { maxChunks?: number; batch?: number } = {}) =>
  api<{ embeddedNow: number; embeddedTotal: number; remaining: number; durationMs: number }>(
    "POST",
    "/v1/web/rag/embed",
    opts
  );
export const ragSearch = (query: string, topK = 8) =>
  api<{ mode: "hybrid" | "bm25"; hits: RagHit[] }>("POST", "/v1/web/rag/search", {
    query,
    topK,
  });

// ===== Graph =====

export const graphStatus = () => api<GraphStatus>("GET", "/v1/web/graph/status");
export const graphBuild = () =>
  api<{ summary: string; progress: unknown }>("POST", "/v1/web/graph/build");
export const graphQuery = (type: GraphQueryType, arg: string, arg2?: string) =>
  api<{ result: unknown }>("POST", "/v1/web/graph/query", {
    type,
    arg,
    ...(arg2 ? { arg2 } : {}),
  });

// ===== status line =====

export const getStatusLine = () => api<StatusLine>("GET", "/v1/web/status-line");
