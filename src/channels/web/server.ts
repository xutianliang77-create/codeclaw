/**
 * Web Channel · HTTP server 入口
 *
 * 基于 Node 内置 http；零额外依赖（不引入 express / koa / ws）。
 *
 * 路由：
 *   POST   /v1/web/sessions          创建 session（返回 sessionId）
 *   GET    /v1/web/sessions          列出当前 user 的 sessions
 *   DELETE /v1/web/sessions/<id>     destroy
 *   POST   /v1/web/messages          提交输入（body: {sessionId, input}）
 *   GET    /v1/web/stream?sessionId  SSE 长连接
 *   GET    /                         静态首页（阶段 C 写）
 *   GET    /static/*                 静态资源（阶段 C 写）
 *   *                                404
 *
 * 不变量：
 *   - 全部 /v1/* 走 Bearer 鉴权（auth.ts），缺/错 token 401
 *   - SessionStore 跨 sessionId 共享一个 in-memory Map；进程重启丢失（P1+ 持久化）
 *   - SSE 心跳 20s；前端 EventSource 自动重连
 */

import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";

import { readWebAuthConfig, type WebAuthConfig } from "./auth";
import {
  handleCreateSession,
  handleDeleteSession,
  handleListSessions,
  handleMessage,
  handleStream,
  type HandlerDeps,
} from "./handlers";
import { SessionStore } from "./sessionStore";
import type { QueryEngineOptions } from "../../agent/types";
import { createQueryEngine } from "../../agent/queryEngine";

export interface StartWebServerOptions {
  /** 监听端口；0 = 随机（测试用）；默认 7180 */
  port?: number;
  /** 监听地址；默认 127.0.0.1（不暴露公网） */
  host?: string;
  /** 鉴权配置；不传从 env 读 */
  auth?: WebAuthConfig;
  /** QueryEngine 默认参数（每次新会话都用此基础） */
  engineDefaults: Omit<QueryEngineOptions, "channel" | "userId">;
}

export interface WebServerHandle {
  server: Server;
  port: number;
  host: string;
  store: SessionStore;
  /** 优雅关闭：停接受新连接 + 关闭现有 session emitters */
  close(): Promise<void>;
}

function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("not found");
}

function methodNotAllowed(res: ServerResponse): void {
  res.statusCode = 405;
  res.end("method not allowed");
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://internal");
  const method = (req.method ?? "GET").toUpperCase();

  // POST /v1/web/sessions
  if (url.pathname === "/v1/web/sessions" && method === "POST") {
    return handleCreateSession(req, res, deps);
  }
  // GET /v1/web/sessions
  if (url.pathname === "/v1/web/sessions" && method === "GET") {
    return handleListSessions(req, res, deps);
  }
  // DELETE /v1/web/sessions/<id>
  const sessMatch = /^\/v1\/web\/sessions\/(.+)$/.exec(url.pathname);
  if (sessMatch && method === "DELETE") {
    return handleDeleteSession(req, res, deps, decodeURIComponent(sessMatch[1]));
  }
  // POST /v1/web/messages
  if (url.pathname === "/v1/web/messages" && method === "POST") {
    return handleMessage(req, res, deps);
  }
  // GET /v1/web/stream
  if (url.pathname === "/v1/web/stream" && method === "GET") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (!sessionId) {
      res.statusCode = 400;
      res.end("missing sessionId");
      return;
    }
    return handleStream(req, res, deps, sessionId);
  }

  // 静态文件（阶段 C 加；这里给最小占位）
  if (url.pathname === "/" && method === "GET") {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("CodeClaw Web · 后端阶段 B 已就位，前端 SPA 由阶段 C 提供。");
    return;
  }

  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    return methodNotAllowed(res);
  }
  notFound(res);
}

export function startWebServer(opts: StartWebServerOptions): Promise<WebServerHandle> {
  const port = opts.port ?? 7180;
  const host = opts.host ?? "127.0.0.1";
  const auth = opts.auth ?? readWebAuthConfig();
  if (!auth.bearerToken) {
    return Promise.reject(
      new Error(
        "CODECLAW_WEB_TOKEN not set; Web channel requires explicit token to start"
      )
    );
  }
  const store = new SessionStore({
    engineFactory: createQueryEngine,
    engineDefaults: opts.engineDefaults,
  });
  const deps: HandlerDeps = { store, auth };

  const server = http.createServer((req, res) => {
    dispatch(req, res, deps).catch((err) => {
      // 兜底：handler 内部未捕获错误
      try {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "internal", detail: String(err) }));
        } else {
          res.end();
        }
      } catch {
        // 连接已断
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        port: actualPort,
        host,
        store,
        async close() {
          await new Promise<void>((r, j) => {
            server.close((err) => (err ? j(err) : r()));
          });
        },
      });
    });
  });
}
