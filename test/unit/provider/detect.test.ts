/**
 * P2.2 · provider 自动探测单测
 */

import { describe, expect, it } from "vitest";

import {
  detectAllProviders,
  detectEnvProviders,
  detectLocalProviders,
} from "../../../src/provider/detect";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("detectEnvProviders", () => {
  it("ANTHROPIC_API_KEY 设了 → 推 anthropic", () => {
    const r = detectEnvProviders({ ANTHROPIC_API_KEY: "sk-ant-xxx" } as NodeJS.ProcessEnv);
    expect(r).toHaveLength(1);
    expect(r[0].type).toBe("anthropic");
    expect(r[0].source).toBe("env");
    expect(r[0].envVar).toBe("ANTHROPIC_API_KEY");
  });

  it("CODECLAW_ANTHROPIC_API_KEY 优先于原生 ANTHROPIC_API_KEY", () => {
    const r = detectEnvProviders({
      CODECLAW_ANTHROPIC_API_KEY: "sk-cc-xxx",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    } as NodeJS.ProcessEnv);
    expect(r[0].envVar).toBe("CODECLAW_ANTHROPIC_API_KEY");
  });

  it("OPENAI_API_KEY 设了 → 推 openai", () => {
    const r = detectEnvProviders({ OPENAI_API_KEY: "sk-xxx" } as NodeJS.ProcessEnv);
    expect(r).toHaveLength(1);
    expect(r[0].type).toBe("openai");
    expect(r[0].baseUrl).toBe("https://api.openai.com/v1");
  });

  it("两边 env 都设 → 两个 provider", () => {
    const r = detectEnvProviders({
      ANTHROPIC_API_KEY: "x",
      OPENAI_API_KEY: "y",
    } as NodeJS.ProcessEnv);
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.type).sort()).toEqual(["anthropic", "openai"]);
  });

  it("无 env → 空数组", () => {
    expect(detectEnvProviders({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("空白字符串等于未设", () => {
    expect(
      detectEnvProviders({ ANTHROPIC_API_KEY: "   " } as NodeJS.ProcessEnv)
    ).toEqual([]);
  });
});

describe("detectLocalProviders", () => {
  it("LM Studio + Ollama 都通 → 都返回", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes(":1234")) return jsonResponse({ data: [{ id: "qwen3-test" }] });
      if (url.includes(":11434")) return jsonResponse({ models: [{ name: "llama3.1" }] });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const r = await detectLocalProviders({ fetchImpl, timeoutMs: 100 });
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.type).sort()).toEqual(["lmstudio", "ollama"]);
    expect(r.find((x) => x.type === "lmstudio")?.model).toBe("qwen3-test");
    expect(r.find((x) => x.type === "ollama")?.model).toBe("llama3.1");
  });

  it("一个通一个不通", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes(":1234")) return jsonResponse({ data: [{ id: "abc" }] });
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const r = await detectLocalProviders({ fetchImpl, timeoutMs: 100 });
    expect(r).toHaveLength(1);
    expect(r[0].type).toBe("lmstudio");
  });

  it("两个都不通 → 空数组", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const r = await detectLocalProviders({ fetchImpl, timeoutMs: 100 });
    expect(r).toEqual([]);
  });

  it("HTTP 5xx → 视作未探测到", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const r = await detectLocalProviders({ fetchImpl, timeoutMs: 100 });
    expect(r).toEqual([]);
  });

  it("data.data 缺失 → 仍认为 endpoint 在；model 为空", async () => {
    const fetchImpl = (async () =>
      jsonResponse({})) as unknown as typeof fetch;
    const r = await detectLocalProviders({ fetchImpl, timeoutMs: 100 });
    // 两个端点都返回空 body → 都"在"
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].model).toBeUndefined();
  });
});

describe("detectAllProviders", () => {
  it("local + env 合并；local 在前", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes(":1234")) return jsonResponse({ data: [{ id: "qwen" }] });
      throw new Error("none");
    }) as unknown as typeof fetch;

    const r = await detectAllProviders({
      fetchImpl,
      env: { OPENAI_API_KEY: "x" } as NodeJS.ProcessEnv,
      timeoutMs: 100,
    });
    expect(r.map((x) => x.type)).toEqual(["lmstudio", "openai"]);
  });
});
