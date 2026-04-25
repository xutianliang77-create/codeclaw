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
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  /** 静态文件根目录；默认 <cwd>/web；测试可传空字符串禁用 */
  staticRoot?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function defaultStaticRoot(): string {
  // 开发时 src/channels/web → ../../../web；build 时 dist/* 由 build.mjs 拷到 dist/public
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromDist = path.resolve(here, "public");
  if (existsSync(fromDist)) return fromDist;
  return path.resolve(here, "../../../web");
}

function serveStaticFile(
  res: ServerResponse,
  staticRoot: string,
  relPath: string
): boolean {
  // 防 path traversal：拼好后 normalize 必须仍在 staticRoot 内
  const requested = path.resolve(staticRoot, relPath.replace(/^\/+/, ""));
  if (!requested.startsWith(staticRoot)) return false;
  if (!existsSync(requested)) return false;
  const st = statSync(requested);
  if (!st.isFile()) return false;
  const ext = path.extname(requested).toLowerCase();
  res.statusCode = 200;
  res.setHeader("content-type", MIME_TYPES[ext] ?? "application/octet-stream");
  res.setHeader("cache-control", "no-cache");
  res.end(readFileSync(requested));
  return true;
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
  deps: HandlerDeps,
  staticRoot: string
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

  // 静态文件
  if (method === "GET" && staticRoot) {
    if (url.pathname === "/") {
      if (serveStaticFile(res, staticRoot, "index.html")) return;
    }
    const staticMatch = /^\/static\/(.+)$/.exec(url.pathname);
    if (staticMatch) {
      if (serveStaticFile(res, staticRoot, staticMatch[1])) return;
    }
  }
  // 静态根禁用 / 文件不存在时给 / 一个占位（保留以前 server.test 兼容）
  if (url.pathname === "/" && method === "GET") {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("CodeClaw Web · static root not configured.");
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
  const staticRoot = opts.staticRoot === "" ? "" : opts.staticRoot ?? defaultStaticRoot();

  const server = http.createServer((req, res) => {
    dispatch(req, res, deps, staticRoot).catch((err) => {
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
