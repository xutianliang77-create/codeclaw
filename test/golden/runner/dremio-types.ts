/**
 * Golden Set · Dremio MCP suite —— 类型定义
 *
 * 与 ASK suite 不同维度：
 *   - layer = L1 (direct MCP) | L2 (natural language) | E (boundary)
 *   - L1 题：runner 直接 callTool(server, tool, args)，不经 LLM；scorer 看返回 JSON 文本
 *   - L2 题：runner 走 QueryEngine + 真 LLM；scorer 看 (a) tool_calls (b) must_mention
 *   - E 题：边界场景，可能只看 must_mention（如 401 处理）或挂 directMcpCall + must_mention
 */

export type DremioLayer = "L1" | "L2" | "E";

export interface DremioDirectCall {
  server: string;        // 默认 "dremio"
  tool: string;          // 例如 "GetUsefulSystemTableNames"
  args: Record<string, unknown>;
  /** 是否预期 isError=true（如 L1-07 故意错的 SQL） */
  expectError?: boolean;
  /** override server callTool 超时（默认 30s） */
  timeoutMs?: number;
}

export interface DremioToolCallSpec {
  /** 名字数组任一命中即算调过；元素支持 "A 或 B" 多选一（沿用 scorer.normalize 语义） */
  must_invoke?: string[];
  /** 不允许调用的工具，命中即 fail */
  must_not_invoke?: string[];
}

export interface DremioQuestion {
  id: string;                       // DRM-001
  version: number;
  layer: DremioLayer;
  description?: string;
  /** L1 必填 mcp，prompt 可空；L2/E 走 LLM 时必填 prompt */
  prompt: string;
  mcp?: DremioDirectCall;
  expected: {
    must_mention?: string[];
    must_not_mention?: string[];
    tool_calls?: DremioToolCallSpec;
    rubric?: string;
  };
  deprecated?: boolean;
}

export interface DremioScoreResult {
  pass: boolean;
  /** must_mention 命中片段 */
  matched: string[];
  missed: string[];
  triggered: string[];           // must_not_mention 违规
  /** tool_calls 维度 */
  invokedOk: string[];           // 命中的 must_invoke 项
  invokedMissing: string[];
  invokedForbidden: string[];    // 命中 must_not_invoke 的工具名
  reason: string;
}

export interface DremioRunRecord {
  id: string;
  version: number;
  layer: DremioLayer;
  provider?: string;
  modelId?: string;
  promptChars: number;
  answerChars: number;
  answerExcerpt: string;          // 截 300 字
  toolsInvoked: string[];         // L2 走 LLM 时填；L1 = [mcp.tool]
  latencyMs: number;
  score: DremioScoreResult;
  timestamp: number;
}

export interface DremioRunSummary {
  total: number;
  passed: number;
  failed: number;
  byLayer: Record<DremioLayer, { total: number; passed: number; rate: number }>;
  overallRate: number;
  meetsGate: boolean;             // L1 100% & L2 ≥80% & E ≥66%
  startedAt: number;
  durationMs: number;
}

export interface DremioRunnerConfig {
  ids?: string[];
  layerFilter?: DremioLayer[];
  dryRun?: boolean;
  verbose?: boolean;
  reportPath?: string;
  /** 强制把 L2 也用 mock（不调 LLM、不调 MCP），骨架自测用 */
  useMock?: boolean;
  judgeMode?: "string" | "llm";
}
