/**
 * Web 阶段 A 新端点测试（#114 step A.2）
 *
 * 覆盖：
 *   - MCP servers / tools / call（无 mcpManager → 503）
 *   - hooks GET / reload
 *   - RAG status / index / search（mini workspace fixture）
 *   - Graph status / build / query（mini workspace fixture）
 *   - status-line / sessions/:id/subagents
 *   - 鉴权一致性（缺 token → 401）
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  startWebServer,
  type WebServerHandle,
} from "../../../../src/channels/web/server";

const TOKEN = "stagea-token-aaaa1111";

let tmpDir: string;
let handle: WebServerHandle;
let baseUrl: string;

function authHeaders(token = TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `web-staga-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tmpDir, { recursive: true });
  // 写一个 minimal TS 源便于 graph build 不空集
  writeFileSync(
    path.join(tmpDir, "sample.ts"),
    "export function hello() { return 'world'; }\nexport function caller() { return hello(); }\n"
  );
  // settings.json：含一组 PreToolUse hook，用于 hooks 端点回显
  mkdirSync(path.join(tmpDir, ".codeclaw"), { recursive: true });
  writeFileSync(
    path.join(tmpDir, ".codeclaw", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "^bash$", hooks: [{ type: "command", command: "echo guard" }] }],
      },
    })
  );

  handle = await startWebServer({
    port: 0,
    auth: { bearerToken: TOKEN },
    engineDefaults: {
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace: tmpDir,
      auditDbPath: null,
      dataDbPath: null,
    },
  });
  baseUrl = `http://${handle.host}:${handle.port}`;
});

afterEach(async () => {
  await handle.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MCP 端点（无 mcpManager 注入）", () => {
  it("GET /v1/web/mcp/servers → 503", async () => {
    const r = await fetch(`${baseUrl}/v1/web/mcp/servers`, { headers: authHeaders() });
    expect(r.status).toBe(503);
    const body = (await r.json()) as Record<string, any>;
    expect(body.error.code).toBe("mcp-disabled");
  });

  it("GET /v1/web/mcp/tools → 503", async () => {
    const r = await fetch(`${baseUrl}/v1/web/mcp/tools`, { headers: authHeaders() });
    expect(r.status).toBe(503);
  });

  it("POST /v1/web/mcp/call → 503", async () => {
    const r = await fetch(`${baseUrl}/v1/web/mcp/call`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ server: "x", tool: "y" }),
    });
    expect(r.status).toBe(503);
  });
});

describe("Hooks 端点", () => {
  it("GET /v1/web/hooks → 默认空（未注入 hooksConfigRef）", async () => {
    const r = await fetch(`${baseUrl}/v1/web/hooks`, { headers: authHeaders() });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, any>;
    expect(body.events).toEqual({});
  });

  it("POST /v1/web/hooks/reload → 200 + 含 PreToolUse", async () => {
    // settings.json 在 tmpDir 顶层；reloadHooks 默认从 workspace 读
    const r = await fetch(`${baseUrl}/v1/web/hooks/reload`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.events.PreToolUse).toBeDefined();
  });
});

describe("RAG 端点", () => {
  it("status / index / search 闭环", async () => {
    const status1 = await fetch(`${baseUrl}/v1/web/rag/status`, {
      headers: authHeaders(),
    }).then((r) => r.json() as Promise<Record<string, any>>);
    expect(typeof status1.chunkCount).toBe("number");

    const idx = await fetch(`${baseUrl}/v1/web/rag/index`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(idx.status).toBe(200);

    const search = await fetch(`${baseUrl}/v1/web/rag/search`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ query: "hello", topK: 3 }),
    });
    expect(search.status).toBe(200);
    const body = (await search.json()) as Record<string, any>;
    expect(body.mode).toBe("bm25");
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it("search 空 query → 400", async () => {
    const r = await fetch(`${baseUrl}/v1/web/rag/search`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it("embed 无 baseUrl 配置 → 503", async () => {
    const r = await fetch(`${baseUrl}/v1/web/rag/embed`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(503);
  });
});

describe("Graph 端点", () => {
  it("status / build / query 闭环", async () => {
    const status1 = await fetch(`${baseUrl}/v1/web/graph/status`, {
      headers: authHeaders(),
    }).then((r) => r.json() as Promise<Record<string, any>>);
    expect(typeof status1.symbols).toBe("number");

    const build = await fetch(`${baseUrl}/v1/web/graph/build`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(build.status).toBe(200);

    const q = await fetch(`${baseUrl}/v1/web/graph/query`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "callers", arg: "hello" }),
    });
    expect(q.status).toBe(200);
    const body = (await q.json()) as Record<string, any>;
    expect(body.result).toBeDefined();
  });

  it("非法 type → 400", async () => {
    const r = await fetch(`${baseUrl}/v1/web/graph/query`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "bogus", arg: "x" }),
    });
    expect(r.status).toBe(400);
  });

  it("缺 arg → 400", async () => {
    const r = await fetch(`${baseUrl}/v1/web/graph/query`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "callers" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("?token= query 鉴权 fallback（#115 SSE 适配）", () => {
  it("query token 正确 → 200", async () => {
    const r = await fetch(`${baseUrl}/v1/web/status-line?token=${encodeURIComponent(TOKEN)}`);
    expect(r.status).toBe(200);
  });
  it("query token 错误 → 401", async () => {
    const r = await fetch(`${baseUrl}/v1/web/status-line?token=wrong`);
    expect(r.status).toBe(401);
  });
  it("query 与 header 都缺 → 401", async () => {
    const r = await fetch(`${baseUrl}/v1/web/status-line`);
    expect(r.status).toBe(401);
  });
});

describe("/next 双 URL（#115 阶段 B 静态资源）", () => {
  it("GET /next → 200 + index.html（若 web-react 已构建）", async () => {
    const r = await fetch(`${baseUrl}/next/`);
    // 构建过 → 200；未构建（CI 干净环境）→ 404；都是合法状态
    expect([200, 404]).toContain(r.status);
    if (r.status === 200) {
      const ct = r.headers.get("content-type") ?? "";
      expect(ct).toMatch(/text\/html/);
    }
  });

  it("GET /next/missing.x → SPA fallback 仍返 index 或 404", async () => {
    const r = await fetch(`${baseUrl}/next/some-deep-link`);
    expect([200, 404]).toContain(r.status);
  });

  it("GET /legacy → 200（vanilla）或 404（无 web/）", async () => {
    const r = await fetch(`${baseUrl}/legacy`);
    expect([200, 404]).toContain(r.status);
  });
});

describe("status-line + subagents", () => {
  it("GET /v1/web/status-line → 200 + 默认文本", async () => {
    const r = await fetch(`${baseUrl}/v1/web/status-line`, { headers: authHeaders() });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, any>;
    expect(body.kind).toBe("default");
    expect(body.text).toContain("no-provider");
    expect(typeof body.lastUpdate).toBe("number");
  });

  it("GET /v1/web/sessions/<id>/subagents → 占位 200", async () => {
    const created = (await fetch(`${baseUrl}/v1/web/sessions`, {
      method: "POST",
      headers: authHeaders(),
    }).then((r) => r.json())) as { sessionId: string };
    const r = await fetch(
      `${baseUrl}/v1/web/sessions/${encodeURIComponent(created.sessionId)}/subagents`,
      { headers: authHeaders() }
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, any>;
    expect(body.subagents).toEqual([]);
    expect(body.note).toMatch(/stage A/);
  });

  it("subagents 不存在 session → 404", async () => {
    const r = await fetch(
      `${baseUrl}/v1/web/sessions/nope/subagents`,
      { headers: authHeaders() }
    );
    expect(r.status).toBe(404);
  });
});

describe("鉴权一致性", () => {
  const endpoints = [
    ["GET", "/v1/web/mcp/servers"],
    ["GET", "/v1/web/mcp/tools"],
    ["POST", "/v1/web/mcp/call"],
    ["GET", "/v1/web/hooks"],
    ["POST", "/v1/web/hooks/reload"],
    ["GET", "/v1/web/rag/status"],
    ["POST", "/v1/web/rag/index"],
    ["POST", "/v1/web/rag/embed"],
    ["POST", "/v1/web/rag/search"],
    ["GET", "/v1/web/graph/status"],
    ["POST", "/v1/web/graph/build"],
    ["POST", "/v1/web/graph/query"],
    ["GET", "/v1/web/status-line"],
    ["GET", "/v1/web/sessions/dummy/subagents"],
  ] as const;

  for (const [method, p] of endpoints) {
    it(`${method} ${p} 缺 token → 401`, async () => {
      const r = await fetch(`${baseUrl}${p}`, { method, body: method === "POST" ? "{}" : undefined });
      expect(r.status).toBe(401);
    });
  }
});
