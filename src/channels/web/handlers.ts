/**
 * Web Channel · HTTP handlers
 *
 * 路由分发 + Bearer 鉴权 + JSON / SSE 响应。
 * 每个 handler 是 (req, res) => Promise<void>，独立可测。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "./sessionStore";
import { validateBearer, type WebAuthConfig } from "./auth";

export interface HandlerDeps {
  store: SessionStore;
  auth: WebAuthConfig;
  /** Bearer token → 派生的稳定 userId。默认拿 token 前 8 字符。 */
  deriveUserId?: (token: string) => string;
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

// POST /v1/web/messages   body: { sessionId, input }
export async function handleMessage(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  const auth = authenticate(req, res, deps);
  if (!auth) return;
  let body: { sessionId?: string; input?: string };
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
  // fire-and-forget；events 通过 SSE 推给前端
  void deps.store.runSubmit(body.sessionId, auth.userId, body.input);
  jsonResponse(res, 202, { accepted: true });
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
