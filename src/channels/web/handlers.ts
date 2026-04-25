/**
 * Web Channel · HTTP handlers
 *
 * 路由分发 + Bearer 鉴权 + JSON / SSE 响应。
 * 每个 handler 是 (req, res) => Promise<void>，独立可测。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type { SessionStore } from "./sessionStore";
import { validateBearer, type WebAuthConfig } from "./auth";
import { checkAndRegister, recordDelivery } from "../../ingress/dedupStore";
import { summarizeBySession, summarizeToday, formatUsd } from "../../provider/costTracker";
import type { ProviderStatus } from "../../provider/types";

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

/** 校验 Authorization 头并解出 userId；失败时调 unauthorized 并返回 null */
function authenticate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): { userId: string; token: string } | null {
  const auth = req.headers["authorization"];
  if (!validateBearer(typeof auth === "string" ? auth : undefined, deps.auth.bearerToken)) {
    unauthorized(res);
    return null;
  }
  const token = (auth as string).replace(/^Bearer\s+/i, "").trim();
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

// POST /v1/web/messages   body: { sessionId, input, clientId? }
export async function handleMessage(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  const auth = authenticate(req, res, deps);
  if (!auth) return;
  let body: { sessionId?: string; input?: string; clientId?: string };
  try {
    body = await readJsonBody(req);
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
  void deps.store.runSubmit(body.sessionId, auth.userId, body.input);
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
