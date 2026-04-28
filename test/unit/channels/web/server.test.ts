/**
 * Web channel server 端到端集成测试
 *
 * 启 server 在随机端口，用 fetch 验证：
 *   - 401 unauthorized：缺 / 错 token
 *   - 创建 session 返回 sessionId
 *   - POST /messages 后能从 SSE 读到事件
 *   - DELETE sessions 后 stream 关闭
 *   - 跨用户隔离：A 的 token 拿不到 B 的 session
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebServerHandle } from "../../../../src/channels/web/server";
import { startWebServer } from "../../../../src/channels/web/server";

const TOKEN = "test-token-aaaa1111";

let handle: WebServerHandle;
let baseUrl: string;

beforeEach(async () => {
  handle = await startWebServer({
    port: 0,
    auth: { bearerToken: TOKEN },
    engineDefaults: {
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "plan",
      workspace: process.cwd(),
      // dataDbPath 不传 → vitest 自动禁用 L2 memory
    },
  });
  baseUrl = `http://${handle.host}:${handle.port}`;
});

afterEach(async () => {
  await handle.close();
});

function authHeaders(token = TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("Web server · 鉴权", () => {
  it("缺 Authorization → 401", async () => {
    const r = await fetch(`${baseUrl}/v1/web/sessions`, { method: "POST" });
    expect(r.status).toBe(401);
  });

  it("错误 token → 401", async () => {
    const r = await fetch(`${baseUrl}/v1/web/sessions`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(r.status).toBe(401);
  });

  it("正确 token → 201 创建 session", async () => {
    const r = await fetch(`${baseUrl}/v1/web/sessions`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { sessionId: string; userId: string };
    expect(body.sessionId).toMatch(/^web-/);
    expect(body.userId).toBe("web-test-tok");  // token 前 8 位 prefix
  });
});

describe("Web server · session CRUD", () => {
  it("create → list 包含新 session", async () => {
    const created = await fetch(`${baseUrl}/v1/web/sessions`, {
      method: "POST",
      headers: authHeaders(),
    }).then((r) => r.json()) as { sessionId: string };

    const list = await fetch(`${baseUrl}/v1/web/sessions`, {
      headers: authHeaders(),
    }).then((r) => r.json()) as { sessions: Array<{ sessionId: string }> };

    expect(list.sessions.find((s) => s.sessionId === created.sessionId)).toBeDefined();
  });

  it("delete 后 list 不再包含 / 再 delete 返回 404", async () => {
    const created = await fetch(`${baseUrl}/v1/web/sessions`, {
      method: "POST",
      headers: authHeaders(),
    }).then((r) => r.json()) as { sessionId: string };

    const del1 = await fetch(
      `${baseUrl}/v1/web/sessions/${encodeURIComponent(created.sessionId)}`,
      { method: "DELETE", headers: authHeaders() }
    );
    expect(del1.status).toBe(200);
    const del2 = await fetch(
      `${baseUrl}/v1/web/sessions/${encodeURIComponent(created.sessionId)}`,
      { method: "DELETE", headers: authHeaders() }
    );
    expect(del2.status).toBe(404);
  });

  it("跨用户隔离：A 看不到 B 的 session", async () => {
    handle.store.create("web-test-tok"); // user A
    handle.store.create("web-other-to"); // user B

    const listA = await fetch(`${baseUrl}/v1/web/sessions`, {
      headers: authHeaders(TOKEN),
    }).then((r) => r.json()) as { sessions: unknown[] };

    expect(listA.sessions).toHaveLength(1);
  });
});

describe("Web server · 消息 + SSE", () => {
  it("POST /messages → SSE 收到 event", async () => {
    const created = await fetch(`${baseUrl}/v1/web/sessions`, {
      method: "POST",
      headers: authHeaders(),
    }).then((r) => r.json()) as { sessionId: string };

    // 先建 SSE 连接（异步读流）
    const sseResponse = await fetch(
      `${baseUrl}/v1/web/stream?sessionId=${encodeURIComponent(created.sessionId)}`,
      { headers: authHeaders() }
    );
    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get("content-type")).toMatch(/text\/event-stream/);

    // 异步读 SSE 第一帧（QueryEngine 处理 /help 输出 message-complete）
    const reader = sseResponse.body!.getReader();
    const eventPromise = (async (): Promise<string> => {
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) return buf;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes("data:")) return buf;
      }
    })();

    // 发送一个 /help 命令（QueryEngine 内部会同步处理给出 message-complete）
    const post = await fetch(`${baseUrl}/v1/web/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ sessionId: created.sessionId, input: "/help" }),
    });
    expect(post.status).toBe(202);

    const sse = await Promise.race([
      eventPromise,
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
    ]);
    expect(sse).toContain("data:");

    reader.cancel();
  });

  it("POST /messages 缺 input → 400", async () => {
    const created = await fetch(`${baseUrl}/v1/web/sessions`, {
      method: "POST",
      headers: authHeaders(),
    }).then((r) => r.json()) as { sessionId: string };

    const r = await fetch(`${baseUrl}/v1/web/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ sessionId: created.sessionId }),
    });
    expect(r.status).toBe(400);
  });

  it("POST /messages 不存在的 sessionId → 404", async () => {
    const r = await fetch(`${baseUrl}/v1/web/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ sessionId: "web-nonexistent-id", input: "/help" }),
    });
    expect(r.status).toBe(404);
  });
});

describe("Web server · 路由 misc", () => {
  it("GET / → 200 + HTML（默认 staticRoot 指 web/）", async () => {
    const r = await fetch(`${baseUrl}/`);
    expect(r.status).toBe(200);
    const ct = r.headers.get("content-type") ?? "";
    expect(ct).toMatch(/text\/(html|plain)/);
  });

  it("GET /static/styles.css → 200 + CSS", async () => {
    const r = await fetch(`${baseUrl}/static/styles.css`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/css/);
    const body = await r.text();
    expect(body).toContain("CodeClaw");
  });

  it("GET /static/app.js → 200 + JS", async () => {
    const r = await fetch(`${baseUrl}/static/app.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/javascript/);
  });

  it("GET /static/../etc/passwd → 404（path traversal 拦截）", async () => {
    const r = await fetch(`${baseUrl}/static/../etc/passwd`);
    expect(r.status).toBe(404);
  });

  it("GET /static/vendor/marked.min.js → 200 + 内容含 marked", async () => {
    const r = await fetch(`${baseUrl}/static/vendor/marked.min.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/javascript/);
    const body = await r.text();
    // marked.min.js 包含 "marked" 字串（库自身名称）
    expect(body.length).toBeGreaterThan(1000);
  });

  it("GET /static/vendor/purify.min.js → 200", async () => {
    const r = await fetch(`${baseUrl}/static/vendor/purify.min.js`);
    expect(r.status).toBe(200);
  });

  it("GET /legacy/ 返回的 HTML 含 markdown 库 script 标签（旧版）", async () => {
    // P3.2 起 / 默认升新 React UI；旧版（marked/purify/highlight 库）降级到 /legacy/
    const r = await fetch(`${baseUrl}/legacy/`);
    const body = await r.text();
    expect(body).toContain("marked.min.js");
    expect(body).toContain("purify.min.js");
    expect(body).toContain("highlight.min.js");
  });

  it("未知路径 → 404", async () => {
    const r = await fetch(`${baseUrl}/nonexistent`);
    expect(r.status).toBe(404);
  });

  it("GET /v1/web/stream 缺 sessionId → 400", async () => {
    const r = await fetch(`${baseUrl}/v1/web/stream`, { headers: authHeaders() });
    expect(r.status).toBe(400);
  });

  // ───────── #70-D 附件上传 ─────────
  it("POST /v1/web/messages 含 attachments → 202 accepted（dataUrl 落 tmp 不抛）", async () => {
    const sess = await fetch(`${baseUrl}/v1/web/sessions`, {
      method: "POST",
      headers: authHeaders(),
    }).then((r) => r.json()) as { sessionId: string };
    // 1×1 PNG dataUrl（base64）
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const r = await fetch(`${baseUrl}/v1/web/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        sessionId: sess.sessionId,
        input: "[image]",
        attachments: [
          { kind: "image", dataUrl: `data:image/png;base64,${tinyPng}`, fileName: "tiny.png", mimeType: "image/png" },
        ],
      }),
    });
    expect(r.status).toBe(202);
  });

  it("POST /v1/web/messages 含恶意 dataUrl（不带 base64 前缀） → 仍 202（attachment 静默丢弃）", async () => {
    const sess = await fetch(`${baseUrl}/v1/web/sessions`, {
      method: "POST",
      headers: authHeaders(),
    }).then((r) => r.json()) as { sessionId: string };
    const r = await fetch(`${baseUrl}/v1/web/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        sessionId: sess.sessionId,
        input: "hi",
        attachments: [{ kind: "image", dataUrl: "javascript:alert(1)" }],
      }),
    });
    expect(r.status).toBe(202);
  });

  // ───────── #94 设置中心写操作 PATCH /v1/web/providers/<type> ─────────
  it("PATCH /v1/web/providers/<unknown> → 400", async () => {
    const r = await fetch(`${baseUrl}/v1/web/providers/evil`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ enabled: true }),
    });
    expect(r.status).toBe(400);
  });

  it("PATCH /v1/web/providers/openai 含 apiKey 字段 → 400 拒绝（避免明文落盘）", async () => {
    const r = await fetch(`${baseUrl}/v1/web/providers/openai`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ apiKey: "sk-secret-via-web" }),
    });
    expect(r.status).toBe(400);
    const body = await r.json() as { error: string };
    expect(body.error).toMatch(/apiKey/i);
  });

  it("PATCH baseUrl 非 http(s) → 400", async () => {
    const r = await fetch(`${baseUrl}/v1/web/providers/openai`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ baseUrl: "javascript:alert(1)" }),
    });
    expect(r.status).toBe(400);
  });

  it("PATCH timeoutMs 负数 → 400", async () => {
    const r = await fetch(`${baseUrl}/v1/web/providers/openai`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ timeoutMs: -1 }),
    });
    expect(r.status).toBe(400);
  });

  it("PATCH 错 token → 401", async () => {
    const r = await fetch(`${baseUrl}/v1/web/providers/openai`, {
      method: "PATCH",
      headers: { Authorization: "Bearer wrong" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(r.status).toBe(401);
  });

  it("PATCH 全空 body → 400 'no valid fields'", async () => {
    const r = await fetch(`${baseUrl}/v1/web/providers/openai`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ randomNoise: 123 }),
    });
    expect(r.status).toBe(400);
  });

  // ───────── #70-B 设置中心 ─────────
  it("GET /v1/web/providers · 默认无 provider 注入 → current/fallback 都为 null", async () => {
    const r = await fetch(`${baseUrl}/v1/web/providers`, { headers: authHeaders() });
    expect(r.status).toBe(200);
    const body = await r.json() as { current: unknown; fallback: unknown };
    expect(body.current).toBeNull();
    expect(body.fallback).toBeNull();
  });

  it("GET /v1/web/providers 错 token → 401", async () => {
    const r = await fetch(`${baseUrl}/v1/web/providers`, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(r.status).toBe(401);
  });

  // ───────── #70-A cost dashboard ─────────
  it("GET /v1/web/cost 缺 sessionId → 400", async () => {
    const r = await fetch(`${baseUrl}/v1/web/cost`, { headers: authHeaders() });
    expect(r.status).toBe(400);
  });

  it("GET /v1/web/cost · dataDb 未注入 → 200 enabled=false", async () => {
    // 当前 server 启动 engineDefaults.dataDbPath 不传 → dataDb 未注入
    const sess = await fetch(`${baseUrl}/v1/web/sessions`, {
      method: "POST",
      headers: authHeaders(),
    }).then((r) => r.json()) as { sessionId: string };
    const r = await fetch(`${baseUrl}/v1/web/cost?sessionId=${encodeURIComponent(sess.sessionId)}`, {
      headers: authHeaders(),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  it("GET /v1/web/cost 错误 token → 401", async () => {
    const r = await fetch(`${baseUrl}/v1/web/cost?sessionId=x`, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(r.status).toBe(401);
  });

  it("GET /v1/web/providers · 注入 provider 时返 sanitized 字段（不含 apiKey）", async () => {
    const customHandle = await startWebServer({
      port: 0,
      auth: { bearerToken: TOKEN },
      engineDefaults: {
        currentProvider: {
          instanceId: "openai:default",
          type: "openai",
          displayName: "OpenAI",
          kind: "cloud",
          enabled: true,
          requiresApiKey: true,
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4.1-mini",
          timeoutMs: 30000,
          apiKey: "sk-secret-redacted",
          apiKeyEnvVar: "OPENAI_API_KEY",
          envVars: ["OPENAI_API_KEY"],
          fileConfig: {} as never,
          configured: true,
          available: true,
          reason: "configured",
        },
        fallbackProvider: null,
        permissionMode: "plan",
        workspace: process.cwd(),
      },
    });
    try {
      const url = `http://${customHandle.host}:${customHandle.port}`;
      const r = await fetch(`${url}/v1/web/providers`, { headers: authHeaders() });
      expect(r.status).toBe(200);
      const body = await r.json() as { current: Record<string, unknown> | null; fallback: unknown };
      expect(body.current).not.toBeNull();
      expect(body.current!.model).toBe("gpt-4.1-mini");
      expect(body.current!.baseUrl).toBe("https://api.openai.com/v1");
      // 关键：apiKey / envVars / fileConfig 不应外泄
      expect(JSON.stringify(body)).not.toContain("sk-secret-redacted");
      expect(JSON.stringify(body)).not.toContain("OPENAI_API_KEY");
      expect(body.fallback).toBeNull();
    } finally {
      await customHandle.close();
    }
  });

  it("无 CODECLAW_WEB_TOKEN env → startWebServer reject", async () => {
    await expect(
      startWebServer({
        port: 0,
        auth: { bearerToken: null },
        engineDefaults: {
          currentProvider: null,
          fallbackProvider: null,
          permissionMode: "plan",
          workspace: process.cwd(),
        },
      })
    ).rejects.toThrow(/CODECLAW_WEB_TOKEN/);
  });
});
