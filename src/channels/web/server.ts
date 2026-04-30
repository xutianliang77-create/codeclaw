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
  handleCost,
  handleCreateSession,
  handleDeleteSession,
  handleListSessions,
  handleMessage,
  handleDeleteProvider,
  handlePatchProvider,
  handleProviders,
  handleStream,
  handleMcpListServers,
  handleMcpListTools,
  handleMcpCall,
  handleHooksGet,
  handleHooksReload,
  handleRagStatus,
  handleRagIndex,
  handleRagEmbed,
  handleRagSearch,
  handleGraphStatus,
  handleGraphBuild,
  handleGraphQuery,
  handleStatusLine,
  handleSubagents,
  handleCronList,
  handleCronAdd,
  handleCronRemove,
  handleCronSetEnabled,
  handleCronRunNow,
  handleCronRuns,
  handleCronTemplates,
  handleCronInstallTemplate,
  handleChartGet,
  type HandlerDeps,
} from "./handlers";
import { SessionStore } from "./sessionStore";
import type { QueryEngineOptions } from "../../agent/types";
import { createQueryEngine } from "../../agent/queryEngine";
import { openDataDb } from "../../storage/db";
import type { McpManager } from "../../mcp/manager";
import type { CodeclawSettings, HookSettings } from "../../hooks/settings";
import { loadSettings } from "../../hooks/settings";

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
  /**
   * MCP manager 引用；A2 修补传入后 web 端 LLM 能用 mcp__<server>__<tool>
   * + 可视面板查 server / tools / call。不传时 MCP 相关 endpoint 返 503。
   */
  mcpManager?: McpManager;
  /**
   * 当前 hooks 配置取值器；返回值随 cli SIGHUP 热重载切换。
   * 不传则 web 端 /v1/web/hooks 返当前 engineDefaults.settings 快照（无热更）。
   */
  hooksConfigRef?: () => HookSettings | undefined;
  /** Cron #116：cronManager 取值器（async 拿 cronHost 引用方便 chicken-egg 顺序）；不传 cron 端点返 503 */
  cronManagerRef?: () => import("../../cron/manager").CronManager | null | undefined;
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

/**
 * #115 阶段 B：返回 React 版静态根（dist/public-react 或开发期 web-react/dist）。
 * 不存在时返 null —— /next 路由 fallthrough 给 404。
 */
function reactStaticRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromDist = path.resolve(here, "public-react");
  if (existsSync(fromDist)) return fromDist;
  const fromDev = path.resolve(here, "../../../web-react/dist");
  if (existsSync(fromDev)) return fromDev;
  return null;
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
  /** SIGHUP 时由 cli 调；遍历所有 active engines 同步 hooks 配置 */
  broadcastSettingsReload(next: CodeclawSettings): void;
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
  // GET /v1/web/providers  #70-B
  if (url.pathname === "/v1/web/providers" && method === "GET") {
    return handleProviders(req, res, deps);
  }
  // PATCH/DELETE /v1/web/providers/<instanceId>  #94 + v0.7.1 多实例
  // instanceId 允许 a-zA-Z0-9 _ : . -（与 ProviderConfigApp 校验一致）
  const providerMatch = /^\/v1\/web\/providers\/([a-zA-Z0-9_:.-]+)$/.exec(url.pathname);
  if (providerMatch && method === "PATCH") {
    return handlePatchProvider(req, res, deps, decodeURIComponent(providerMatch[1]));
  }
  if (providerMatch && method === "DELETE") {
    return handleDeleteProvider(req, res, deps, decodeURIComponent(providerMatch[1]));
  }
  // GET /v1/web/cost?sessionId=<id>  #70-A
  if (url.pathname === "/v1/web/cost" && method === "GET") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (!sessionId) {
      res.statusCode = 400;
      res.end("missing sessionId");
      return;
    }
    return handleCost(req, res, deps, sessionId);
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

  // ===== A.2: M3 + RAG + Graph endpoints =====
  // GET /v1/web/mcp/servers
  if (url.pathname === "/v1/web/mcp/servers" && method === "GET") {
    return handleMcpListServers(req, res, deps);
  }
  // GET /v1/web/mcp/tools?server=<name>
  if (url.pathname === "/v1/web/mcp/tools" && method === "GET") {
    return handleMcpListTools(req, res, deps, url.searchParams.get("server"));
  }
  // POST /v1/web/mcp/call
  if (url.pathname === "/v1/web/mcp/call" && method === "POST") {
    return handleMcpCall(req, res, deps);
  }
  // GET /v1/web/hooks
  if (url.pathname === "/v1/web/hooks" && method === "GET") {
    return handleHooksGet(req, res, deps);
  }
  // POST /v1/web/hooks/reload
  if (url.pathname === "/v1/web/hooks/reload" && method === "POST") {
    return handleHooksReload(req, res, deps);
  }
  // GET /v1/web/rag/status
  if (url.pathname === "/v1/web/rag/status" && method === "GET") {
    return handleRagStatus(req, res, deps);
  }
  // POST /v1/web/rag/index
  if (url.pathname === "/v1/web/rag/index" && method === "POST") {
    return handleRagIndex(req, res, deps);
  }
  // POST /v1/web/rag/embed
  if (url.pathname === "/v1/web/rag/embed" && method === "POST") {
    return handleRagEmbed(req, res, deps);
  }
  // POST /v1/web/rag/search
  if (url.pathname === "/v1/web/rag/search" && method === "POST") {
    return handleRagSearch(req, res, deps);
  }
  // GET /v1/web/graph/status
  if (url.pathname === "/v1/web/graph/status" && method === "GET") {
    return handleGraphStatus(req, res, deps);
  }
  // POST /v1/web/graph/build
  if (url.pathname === "/v1/web/graph/build" && method === "POST") {
    return handleGraphBuild(req, res, deps);
  }
  // POST /v1/web/graph/query
  if (url.pathname === "/v1/web/graph/query" && method === "POST") {
    return handleGraphQuery(req, res, deps);
  }
  // GET /v1/web/status-line
  if (url.pathname === "/v1/web/status-line" && method === "GET") {
    return handleStatusLine(req, res, deps);
  }
  // GET /v1/web/sessions/<id>/subagents
  const subMatch = /^\/v1\/web\/sessions\/(.+)\/subagents$/.exec(url.pathname);
  if (subMatch && method === "GET") {
    return handleSubagents(req, res, deps, decodeURIComponent(subMatch[1]));
  }

  // ===== #116 Cron HTTP API =====
  if (url.pathname === "/v1/web/cron/tasks" && method === "GET") {
    return handleCronList(req, res, deps);
  }
  if (url.pathname === "/v1/web/cron/tasks" && method === "POST") {
    return handleCronAdd(req, res, deps);
  }
  if (url.pathname === "/v1/web/cron/templates" && method === "GET") {
    return handleCronTemplates(req, res, deps);
  }
  const cronInstallMatch = /^\/v1\/web\/cron\/templates\/([^/]+)\/install$/.exec(url.pathname);
  if (cronInstallMatch && method === "POST") {
    return handleCronInstallTemplate(req, res, deps, decodeURIComponent(cronInstallMatch[1]));
  }
  const cronEnableMatch = /^\/v1\/web\/cron\/tasks\/([^/]+)\/enable$/.exec(url.pathname);
  if (cronEnableMatch && method === "POST") {
    return handleCronSetEnabled(req, res, deps, decodeURIComponent(cronEnableMatch[1]));
  }
  const cronRunNowMatch = /^\/v1\/web\/cron\/tasks\/([^/]+)\/run-now$/.exec(url.pathname);
  if (cronRunNowMatch && method === "POST") {
    return handleCronRunNow(req, res, deps, decodeURIComponent(cronRunNowMatch[1]));
  }
  const cronRunsMatch = /^\/v1\/web\/cron\/tasks\/([^/]+)\/runs$/.exec(url.pathname);
  if (cronRunsMatch && method === "GET") {
    return handleCronRuns(req, res, deps, decodeURIComponent(cronRunsMatch[1]));
  }
  const cronTaskMatch = /^\/v1\/web\/cron\/tasks\/([^/]+)$/.exec(url.pathname);
  if (cronTaskMatch && method === "DELETE") {
    return handleCronRemove(req, res, deps, decodeURIComponent(cronTaskMatch[1]));
  }

  // GET /v1/web/charts/<sessionId>/<chartId>.svg
  const chartMatch = /^\/v1\/web\/charts\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (chartMatch && method === "GET") {
    return handleChartGet(
      req,
      res,
      deps,
      decodeURIComponent(chartMatch[1]),
      decodeURIComponent(chartMatch[2])
    );
  }

  // P3.2（v0.7.0 起）：根路径 / 和 /next/ 都服务新 React 版（dist/public-react）；
  // 旧版 /legacy/ 仍可访问 dist/public（保留 1-2 版兼容期，之后可彻底删 web/）
  if (method === "GET") {
    const reactRoot = reactStaticRoot();
    if (reactRoot) {
      // 新版：/ 和 /next/ 都进 React UI
      if (
        url.pathname === "/" ||
        url.pathname === "/next" ||
        url.pathname === "/next/"
      ) {
        if (serveStaticFile(res, reactRoot, "index.html")) return;
      }
      // /next/<asset> 走 React 资源
      const nextMatch = /^\/next\/(.+)$/.exec(url.pathname);
      if (nextMatch) {
        if (serveStaticFile(res, reactRoot, nextMatch[1])) return;
        // SPA fallback：深链未命中具体资源 → 返 index.html 让 React 处理
        if (serveStaticFile(res, reactRoot, "index.html")) return;
      }
      // 兼容：/<asset> 直接走 React assets（vite 默认指向根的 /assets/...）
      const rootAssetMatch = /^\/(assets\/.+|favicon\.ico|robots\.txt|manifest\.webmanifest)$/.exec(
        url.pathname
      );
      if (rootAssetMatch) {
        if (serveStaticFile(res, reactRoot, rootAssetMatch[1])) return;
      }
    }
  }

  // 旧版 /legacy/ 仍服务 dist/public
  if (method === "GET" && staticRoot) {
    if (url.pathname === "/legacy" || url.pathname === "/legacy/") {
      if (serveStaticFile(res, staticRoot, "index.html")) return;
    }
    const legacyMatch = /^\/legacy\/(.+)$/.exec(url.pathname);
    if (legacyMatch) {
      if (serveStaticFile(res, staticRoot, legacyMatch[1])) return;
    }
    // /static/<asset> 旧版资源路径（保留兼容）
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

  if (method !== "GET" && method !== "POST" && method !== "DELETE" && method !== "PATCH") {
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
  // 若 engineDefaults 提供了 dataDbPath，复用同一 db 做 dedup + cost 等
  // singleton 模式让 QueryEngine 内部 open 与此处指向同一实例
  let dataDb: import("better-sqlite3").Database | undefined;
  const dataDbPath = opts.engineDefaults.dataDbPath;
  if (dataDbPath) {
    try {
      dataDb = openDataDb({ path: dataDbPath }).db;
    } catch {
      // singleton 冲突或文件不可用 → 静默降级
    }
  }
  // A2: hooksConfigRef + 静态 fallback；reload 路径在 handler 内调 loadSettings
  let hooksFallback: HookSettings | undefined = opts.engineDefaults.settings?.hooks;
  const deps: HandlerDeps = {
    store,
    auth,
    dataDb,
    providers: {
      current: opts.engineDefaults.currentProvider ?? null,
      fallback: opts.engineDefaults.fallbackProvider ?? null,
    },
    workspace: opts.engineDefaults.workspace,
    ...(opts.mcpManager ? { mcpManager: opts.mcpManager } : {}),
    ...(opts.cronManagerRef ? { cronManagerRef: opts.cronManagerRef } : {}),
    hooksConfigRef: () => opts.hooksConfigRef?.() ?? hooksFallback,
    reloadHooks: () => {
      const next = loadSettings(opts.engineDefaults.workspace);
      hooksFallback = next.hooks;
      // 回填到所有 active engine
      store.forEachEngine((engine) => {
        const e = engine as { setHooksConfig?: (h: HookSettings) => void };
        e.setHooksConfig?.(next.hooks);
      });
      return next;
    },
  };
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
        broadcastSettingsReload(next) {
          hooksFallback = next.hooks;
          store.forEachEngine((engine) => {
            const e = engine as { setHooksConfig?: (h: HookSettings) => void };
            e.setHooksConfig?.(next.hooks);
          });
        },
      });
    });
  });
}
