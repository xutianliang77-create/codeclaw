/**
 * Web Channel · HTTP handlers
 *
 * 路由分发 + Bearer 鉴权 + JSON / SSE 响应。
 * 每个 handler 是 (req, res) => Promise<void>，独立可测。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionStore } from "./sessionStore";
import { validateBearer, type WebAuthConfig } from "./auth";
import { checkAndRegister, recordDelivery } from "../../ingress/dedupStore";
import { summarizeBySession, summarizeToday, formatUsd } from "../../provider/costTracker";
import type { ProviderStatus } from "../../provider/types";

/** 解析 dataUrl → 写入 tmpdir 拿到本地路径，让 queryEngine 像 wechat 路径一样消费 */
function persistDataUrlAttachment(
  dataUrl: string,
  fileName?: string
): { localPath: string; mimeType?: string; sizeBytes: number; fileName: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const mimeType = m[1];
  const buf = Buffer.from(m[2], "base64");
  if (buf.length === 0) return null;
  const dir = path.join(os.tmpdir(), "codeclaw-web-uploads");
  mkdirSync(dir, { recursive: true });
  const ext = (mimeType.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "");
  const safeName = fileName ?? `upload-${randomBytes(4).toString("hex")}.${ext}`;
  const finalName = `${Date.now()}-${randomBytes(4).toString("hex")}-${safeName}`;
  const localPath = path.join(dir, finalName);
  writeFileSync(localPath, buf);
  return { localPath, mimeType, sizeBytes: buf.length, fileName: safeName };
}

export interface HandlerDeps {
  store: SessionStore;
  auth: WebAuthConfig;
  /** Bearer token → 派生的稳定 userId。默认拿 token 前 8 字符。 */
  deriveUserId?: (token: string) => string;
  /**
   * 共享 data.db 句柄（singleton 同 QueryEngine 内部）。
   * 不注入则相关功能（ingress dedup / cost dashboard）静默禁用。
   */
  dataDb?: Database.Database;
  /** server 启动时快照的 provider 配置（设置中心只读视图） */
  providers?: {
    current: ProviderStatus | null;
    fallback: ProviderStatus | null;
  };
  /** A2：workspace 路径，给 RAG / Graph / hooks reload handler 用 */
  workspace?: string;
  /** A2：MCP manager；不注入 → MCP 端点返 503 service-unavailable */
  mcpManager?: import("../../mcp/manager").McpManager;
  /** A2：hooks 当前配置取值器；reload 后由 cli SIGHUP 触发更新此引用所返值 */
  hooksConfigRef?: () => import("../../hooks/settings").HookSettings | undefined;
  /** A2：触发 hooks 配置热重载并广播给所有 session engine */
  reloadHooks?: () => import("../../hooks/settings").CodeclawSettings;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function unauthorized(res: ServerResponse, msg = "unauthorized"): void {
  res.statusCode = 401;
  res.setHeader("www-authenticate", "Bearer realm=\"codeclaw\"");
  res.end(msg);
}

function defaultDeriveUserId(token: string): string {
  // token 前 8 字符够稳定区分；同 token = 同 user
  return `web-${token.slice(0, 8)}`;
}

/**
 * 校验 Authorization 头并解出 userId；失败时调 unauthorized 并返回 null。
 *
 * #115 SSE 适配：浏览器 EventSource 无法设 header → 同时接受 `?token=` query
 * 作为 fallback。注意 query token 会进 access log；前端只在 SSE / 静态深链路径用。
 */
function authenticate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): { userId: string; token: string } | null {
  const authHeader = req.headers["authorization"];
  let token: string | null = null;
  if (typeof authHeader === "string" && validateBearer(authHeader, deps.auth.bearerToken)) {
    token = authHeader.replace(/^Bearer\s+/i, "").trim();
  } else if (req.url) {
    try {
      const url = new URL(req.url, "http://internal");
      const q = url.searchParams.get("token");
      if (q && validateBearer(`Bearer ${q}`, deps.auth.bearerToken)) {
        token = q;
      }
    } catch {
      // URL parse 失败 → 走 401
    }
  }
  if (!token) {
    unauthorized(res);
    return null;
  }
  const userId = (deps.deriveUserId ?? defaultDeriveUserId)(token);
  return { userId, token };
}

async function readJsonBody<T = unknown>(req: IncomingMessage, maxBytes = 1024 * 64): Promise<T> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// POST /v1/web/sessions
export async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  const auth = authenticate(req, res, deps);
  if (!auth) return;
  const meta = deps.store.create(auth.userId);
  jsonResponse(res, 201, meta);
}

// GET /v1/web/sessions
export async function handleListSessions(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  const auth = authenticate(req, res, deps);
  if (!auth) return;
  jsonResponse(res, 200, { sessions: deps.store.list(auth.userId) });
}

// DELETE /v1/web/sessions/<id>
export async function handleDeleteSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  sessionId: string
): Promise<void> {
  const auth = authenticate(req, res, deps);
  if (!auth) return;
  const ok = deps.store.destroy(sessionId, auth.userId);
  jsonResponse(res, ok ? 200 : 404, { ok });
}

// POST /v1/web/messages   body: { sessionId, input, clientId?, attachments? }
//   attachments: [{ kind: "image", dataUrl: "data:image/png;base64,...", fileName?, mimeType? }]
export async function handleMessage(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  const auth = authenticate(req, res, deps);
  if (!auth) return;
  let body: {
    sessionId?: string;
    input?: string;
    clientId?: string;
    attachments?: Array<{ kind?: string; dataUrl?: string; fileName?: string; mimeType?: string }>;
  };
  try {
    body = await readJsonBody(req, /* maxBytes 含 dataUrl */ 8 * 1024 * 1024);
  } catch (err) {
    jsonResponse(res, 400, { error: "bad request", detail: String(err) });
    return;
  }
  if (!body.sessionId || !body.input) {
    jsonResponse(res, 400, { error: "missing sessionId or input" });
    return;
  }
  const session = deps.store.get(body.sessionId, auth.userId);
  if (!session) {
    jsonResponse(res, 404, { error: "session not found" });
    return;
  }

  // #70-D 附件：第一张 image 走 channelSpecific.image（同 wechat 路径约定）
  let channelSpecific: Record<string, unknown> | undefined;
  if (Array.isArray(body.attachments) && body.attachments.length > 0) {
    const firstImage = body.attachments.find((a) => a?.kind === "image" && typeof a.dataUrl === "string");
    if (firstImage?.dataUrl) {
      const persisted = persistDataUrlAttachment(firstImage.dataUrl, firstImage.fileName);
      if (persisted) {
        channelSpecific = {
          image: {
            localPath: persisted.localPath,
            mimeType: firstImage.mimeType ?? persisted.mimeType,
            fileName: persisted.fileName,
            sizeBytes: persisted.sizeBytes,
          },
        };
      }
    }
  }
  // dedup：仅当 client 明确传 clientId 且 deps.dataDb 注入时启用
  // ttl 内同 (channel,user,client_id) 重复请求 → 短路，复用上次 delivery
  if (body.clientId && deps.dataDb) {
    const r = checkAndRegister(deps.dataDb, {
      clientId: body.clientId,
      channel: "http",
      userId: auth.userId,
    });
    if (r.isDuplicate) {
      jsonResponse(res, 202, {
        accepted: true,
        deduplicated: true,
        lastDelivery: r.lastDelivery ?? null,
      });
      return;
    }
  }
  // fire-and-forget；events 通过 SSE 推给前端
  void deps.store.runSubmit(body.sessionId, auth.userId, body.input, channelSpecific);
  // 异步回填 last_delivery（ack 维度，不等 LLM）让 dedup 重试有迹可循
  if (body.clientId && deps.dataDb) {
    recordDelivery(deps.dataDb, body.clientId, {
      sessionId: body.sessionId,
      acceptedAt: Date.now(),
    });
  }
  jsonResponse(res, 202, { accepted: true });
}

// GET /v1/web/providers   #70-B 设置中心只读快照
export async function handleProviders(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  const auth = authenticate(req, res, deps);
  if (!auth) return;
  const sanitize = (p: ProviderStatus | null): Record<string, unknown> | null =>
    p
      ? {
          type: p.type,
          displayName: p.displayName,
          kind: p.kind,
          model: p.model,
          baseUrl: p.baseUrl,
          available: p.available,
          reason: p.reason,
          // 故意不返 apiKey / envVars / fileConfig（避免泄露）
        }
      : null;
  jsonResponse(res, 200, {
    current: sanitize(deps.providers?.current ?? null),
    fallback: sanitize(deps.providers?.fallback ?? null),
  });
}

// PATCH /v1/web/providers/<type>   #94 写操作
//   body: { enabled?, baseUrl?, model?, timeoutMs?, apiKeyEnvVar? }
//   apiKey 不通过 web 设（避免明文落盘 / 表单泄漏）；用户必须自设 env
export async function handlePatchProvider(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  providerType: string
): Promise<void> {
  const auth = authenticate(req, res, deps);
  if (!auth) return;

  const ALLOWED_TYPES = ["openai", "anthropic", "ollama", "lmstudio"];
  if (!ALLOWED_TYPES.includes(providerType)) {
    jsonResponse(res, 400, { error: `unknown provider type: ${providerType}` });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(req);
  } catch (err) {
    jsonResponse(res, 400, { error: "bad request", detail: String(err) });
    return;
  }

  if ("apiKey" in body) {
    jsonResponse(res, 400, {
      error: "apiKey must be set via env var (CODECLAW_*_API_KEY), not via web settings",
    });
    return;
  }

  // 类型校验 + 白名单字段
  const filtered: Record<string, unknown> = {};
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") {
      jsonResponse(res, 400, { error: "enabled must be boolean" });
      return;
    }
    filtered.enabled = body.enabled;
  }
  if ("baseUrl" in body) {
    if (typeof body.baseUrl !== "string" || !/^https?:\/\//i.test(body.baseUrl)) {
      jsonResponse(res, 400, { error: "baseUrl must be http(s):// URL" });
      return;
    }
    filtered.baseUrl = body.baseUrl;
  }
  if ("model" in body) {
    if (typeof body.model !== "string" || !body.model.trim()) {
      jsonResponse(res, 400, { error: "model must be non-empty string" });
      return;
    }
    filtered.model = body.model;
  }
  if ("timeoutMs" in body) {
    if (typeof body.timeoutMs !== "number" || body.timeoutMs <= 0) {
      jsonResponse(res, 400, { error: "timeoutMs must be positive number" });
      return;
    }
    filtered.timeoutMs = body.timeoutMs;
  }
  if ("apiKeyEnvVar" in body) {
    if (typeof body.apiKeyEnvVar !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(body.apiKeyEnvVar)) {
      jsonResponse(res, 400, {
        error: "apiKeyEnvVar must match /^[A-Z][A-Z0-9_]*$/ (env var name)",
      });
      return;
    }
    filtered.apiKeyEnvVar = body.apiKeyEnvVar;
  }

  if (Object.keys(filtered).length === 0) {
    jsonResponse(res, 400, { error: "no valid fields to update" });
    return;
  }

  // 复用 src/lib/config 的 read/write
  const { readProvidersFile, writeProvidersFile, resolveConfigPaths } = await import("../../lib/config");
  const paths = resolveConfigPaths();
  const existing = (await readProvidersFile(paths)) ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (existing as any)[providerType] = {
    ...((existing as Record<string, unknown>)[providerType] ?? {}),
    ...filtered,
  };
  try {
    await writeProvidersFile(existing, paths);
  } catch (err) {
    jsonResponse(res, 500, { error: "write failed", detail: String(err) });
    return;
  }

  jsonResponse(res, 200, {
    ok: true,
    message: "Saved. Restart codeclaw web for changes to take effect.",
    path: paths.providersFile,
  });
}

// GET /v1/web/cost?sessionId=<id>   #70-A
export async function handleCost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  sessionId: string
): Promise<void> {
  const auth = authenticate(req, res, deps);
  if (!auth) return;
  if (!deps.dataDb) {
    jsonResponse(res, 200, {
      enabled: false,
      message: "cost tracking disabled (no data.db)",
    });
    return;
  }
  const session = deps.store.get(sessionId, auth.userId);
  if (!session) {
    jsonResponse(res, 404, { error: "session not found" });
    return;
  }
  const bySession = summarizeBySession(deps.dataDb, sessionId);
  const today = summarizeToday(deps.dataDb);
  jsonResponse(res, 200, {
    enabled: true,
    session: {
      ...bySession,
      totalUsdCostFormatted: formatUsd(bySession.totalUsdCost),
    },
    today: {
      ...today,
      totalUsdCostFormatted: formatUsd(today.totalUsdCost),
    },
  });
}

// GET /v1/web/stream?sessionId=<id>   SSE
export async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  sessionId: string
): Promise<void> {
  const auth = authenticate(req, res, deps);
  if (!auth) return;
  const session = deps.store.get(sessionId, auth.userId);
  if (!session) {
    jsonResponse(res, 404, { error: "session not found" });
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-store");
  res.setHeader("connection", "keep-alive");
  // 立刻 flush headers
  res.flushHeaders?.();
  // 心跳注释帧（每 20s 一次）防中间代理超时
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 20_000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const onEvent = (ev: unknown): void => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  const onClose = (): void => {
    res.end();
  };
  session.emitter.on("event", onEvent);
  session.emitter.once("close", onClose);

  req.on("close", () => {
    clearInterval(heartbeat);
    session.emitter.off("event", onEvent);
    session.emitter.off("close", onClose);
  });
}

/* =====================================================================
 * #114 阶段 A · M3 + RAG + Graph 端点（13 个 handler）
 *
 * 统一行为：
 *   - 全部 Bearer 鉴权（authenticate 复用）
 *   - 错误统一格式 `{error:{code,message}}` 4xx/5xx
 *   - workspace / mcpManager / hooksConfigRef 来自 deps（startWebServer 注入）
 * ===================================================================== */

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

// GET /v1/web/mcp/servers
export async function handleMcpListServers(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  if (!deps.mcpManager) {
    jsonResponse(res, 503, errorBody("mcp-disabled", "mcp manager not wired in this build"));
    return;
  }
  jsonResponse(res, 200, { servers: deps.mcpManager.listServers() });
}

// GET /v1/web/mcp/tools?server=<name>
export async function handleMcpListTools(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  serverName: string | null
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  if (!deps.mcpManager) {
    jsonResponse(res, 503, errorBody("mcp-disabled", "mcp manager not wired in this build"));
    return;
  }
  const all = deps.mcpManager.listAllTools();
  const filtered = serverName ? all.filter((x) => x.server === serverName) : all;
  jsonResponse(res, 200, {
    tools: filtered.map((x) => ({
      server: x.server,
      name: x.tool.name,
      description: x.tool.description,
      inputSchema: x.tool.inputSchema,
    })),
  });
}

// POST /v1/web/mcp/call   body: { server, tool, args }
export async function handleMcpCall(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  if (!deps.mcpManager) {
    jsonResponse(res, 503, errorBody("mcp-disabled", "mcp manager not wired in this build"));
    return;
  }
  let body: { server?: string; tool?: string; args?: unknown };
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonResponse(res, 400, errorBody("bad-json", String(err)));
    return;
  }
  if (!body.server || !body.tool) {
    jsonResponse(res, 400, errorBody("missing-fields", "server and tool are required"));
    return;
  }
  try {
    const result = await deps.mcpManager.callTool(body.server, body.tool, body.args ?? {});
    jsonResponse(res, 200, { ok: true, ...result });
  } catch (err) {
    jsonResponse(res, 502, errorBody("mcp-call-failed", err instanceof Error ? err.message : String(err)));
  }
}

// GET /v1/web/hooks
export async function handleHooksGet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  const hooks = deps.hooksConfigRef?.() ?? {};
  jsonResponse(res, 200, { events: hooks });
}

// POST /v1/web/hooks/reload
export async function handleHooksReload(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  if (!deps.reloadHooks) {
    jsonResponse(res, 503, errorBody("reload-disabled", "hooks reload not wired"));
    return;
  }
  try {
    const next = deps.reloadHooks();
    jsonResponse(res, 200, { ok: true, events: next.hooks ?? {} });
  } catch (err) {
    jsonResponse(res, 500, errorBody("reload-failed", err instanceof Error ? err.message : String(err)));
  }
}

// GET /v1/web/rag/status
export async function handleRagStatus(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  if (!deps.workspace) {
    jsonResponse(res, 500, errorBody("no-workspace", "workspace path not configured"));
    return;
  }
  try {
    const { runStatus } = await import("../../rag/api");
    jsonResponse(res, 200, runStatus(deps.workspace));
  } catch (err) {
    jsonResponse(res, 500, errorBody("rag-status-failed", err instanceof Error ? err.message : String(err)));
  }
}

// POST /v1/web/rag/index
export async function handleRagIndex(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  if (!deps.workspace) {
    jsonResponse(res, 500, errorBody("no-workspace", "workspace path not configured"));
    return;
  }
  try {
    const { runIndex } = await import("../../rag/api");
    jsonResponse(res, 200, runIndex(deps.workspace));
  } catch (err) {
    jsonResponse(res, 500, errorBody("rag-index-failed", err instanceof Error ? err.message : String(err)));
  }
}

// POST /v1/web/rag/embed   body: { maxChunks?, batch? }
export async function handleRagEmbed(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  if (!deps.workspace) {
    jsonResponse(res, 500, errorBody("no-workspace", "workspace path not configured"));
    return;
  }
  let body: { maxChunks?: number; batch?: number } = {};
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }
  const provider = deps.providers?.current ?? null;
  const baseUrl = process.env.CODECLAW_RAG_EMBED_BASE_URL ?? provider?.baseUrl;
  const model = process.env.CODECLAW_RAG_EMBED_MODEL ?? "bge-m3";
  if (!baseUrl) {
    jsonResponse(res, 503, errorBody("embed-not-configured", "no provider baseUrl + CODECLAW_RAG_EMBED_BASE_URL"));
    return;
  }
  try {
    const { runEmbed } = await import("../../rag/api");
    const opts: { maxChunks?: number; batch?: number } = {};
    if (body.maxChunks !== undefined) opts.maxChunks = body.maxChunks;
    if (body.batch !== undefined) opts.batch = body.batch;
    const r = await runEmbed(
      deps.workspace,
      { baseUrl, model, ...(provider?.apiKey ? { apiKey: provider.apiKey } : {}) },
      opts
    );
    jsonResponse(res, 200, r);
  } catch (err) {
    jsonResponse(res, 500, errorBody("rag-embed-failed", err instanceof Error ? err.message : String(err)));
  }
}

// POST /v1/web/rag/search   body: { query, topK? }
export async function handleRagSearch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  if (!deps.workspace) {
    jsonResponse(res, 500, errorBody("no-workspace", "workspace path not configured"));
    return;
  }
  let body: { query?: string; topK?: number };
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonResponse(res, 400, errorBody("bad-json", String(err)));
    return;
  }
  if (!body.query || typeof body.query !== "string") {
    jsonResponse(res, 400, errorBody("missing-query", "query is required"));
    return;
  }
  const topK = body.topK ?? 8;
  try {
    const { runSearch, runStatus, runHybridSearch } = await import("../../rag/api");
    const status = runStatus(deps.workspace);
    const provider = deps.providers?.current ?? null;
    const baseUrl = process.env.CODECLAW_RAG_EMBED_BASE_URL ?? provider?.baseUrl;
    const model = process.env.CODECLAW_RAG_EMBED_MODEL ?? "bge-m3";
    if (status.embeddedCount > 0 && baseUrl) {
      try {
        const r = await runHybridSearch(
          deps.workspace,
          body.query,
          { baseUrl, model, ...(provider?.apiKey ? { apiKey: provider.apiKey } : {}) },
          topK
        );
        jsonResponse(res, 200, { mode: "hybrid", hits: r.hits });
        return;
      } catch {
        // fall through to BM25
      }
    }
    const r = runSearch(deps.workspace, body.query, topK);
    jsonResponse(res, 200, { mode: "bm25", hits: r.hits });
  } catch (err) {
    jsonResponse(res, 500, errorBody("rag-search-failed", err instanceof Error ? err.message : String(err)));
  }
}

// GET /v1/web/graph/status
export async function handleGraphStatus(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  if (!deps.workspace) {
    jsonResponse(res, 500, errorBody("no-workspace", "workspace path not configured"));
    return;
  }
  try {
    const { runStatus } = await import("../../graph/api");
    jsonResponse(res, 200, runStatus(deps.workspace));
  } catch (err) {
    jsonResponse(res, 500, errorBody("graph-status-failed", err instanceof Error ? err.message : String(err)));
  }
}

// POST /v1/web/graph/build
export async function handleGraphBuild(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  if (!deps.workspace) {
    jsonResponse(res, 500, errorBody("no-workspace", "workspace path not configured"));
    return;
  }
  try {
    const { runBuild } = await import("../../graph/api");
    jsonResponse(res, 200, runBuild(deps.workspace));
  } catch (err) {
    jsonResponse(res, 500, errorBody("graph-build-failed", err instanceof Error ? err.message : String(err)));
  }
}

// POST /v1/web/graph/query   body: { type, arg, arg2? }
export async function handleGraphQuery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  if (!deps.workspace) {
    jsonResponse(res, 500, errorBody("no-workspace", "workspace path not configured"));
    return;
  }
  let body: { type?: string; arg?: string; arg2?: string };
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonResponse(res, 400, errorBody("bad-json", String(err)));
    return;
  }
  const ALLOWED = ["callers", "callees", "dependents", "dependencies", "symbol"] as const;
  type GraphQueryType = (typeof ALLOWED)[number];
  if (!body.type || !ALLOWED.includes(body.type as GraphQueryType)) {
    jsonResponse(res, 400, errorBody("bad-type", `type must be one of ${ALLOWED.join("|")}`));
    return;
  }
  if (!body.arg) {
    jsonResponse(res, 400, errorBody("missing-arg", "arg is required"));
    return;
  }
  try {
    const { runQuery } = await import("../../graph/api");
    const result = runQuery(deps.workspace, body.type as GraphQueryType, body.arg, body.arg2);
    jsonResponse(res, 200, { result });
  } catch (err) {
    jsonResponse(res, 500, errorBody("graph-query-failed", err instanceof Error ? err.message : String(err)));
  }
}

// GET /v1/web/status-line
export async function handleStatusLine(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  if (!authenticate(req, res, deps)) {
    return;
  }
  const provider = deps.providers?.current ?? null;
  // 阶段 A：构造一行 default status；不跑 statusLine.command（命令行执行更适合 cli）
  const text = [
    provider?.displayName ?? "no-provider",
    provider?.model ?? "no-model",
    `sessions=${deps.store.size()}`,
  ]
    .filter(Boolean)
    .join(" · ");
  jsonResponse(res, 200, {
    text,
    kind: "default" as const,
    lastUpdate: Date.now(),
  });
}

// GET /v1/web/sessions/<id>/subagents
export async function handleSubagents(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  sessionId: string
): Promise<void> {
  const auth = authenticate(req, res, deps);
  if (!auth) return;
  const session = deps.store.get(sessionId, auth.userId);
  if (!session) {
    jsonResponse(res, 404, errorBody("session-not-found", `unknown session: ${sessionId}`));
    return;
  }
  // B.8：从 engine 的 SubagentRegistry 读真实记录；轮询 ~3s 客户端可见
  const engine = session.engine as unknown as {
    getSubagentRecords?: () => unknown[];
  };
  const records = engine.getSubagentRecords?.() ?? [];
  jsonResponse(res, 200, {
    subagents: records,
    note:
      records.length === 0
        ? "no subagents invoked yet in this session"
        : undefined,
  });
}
