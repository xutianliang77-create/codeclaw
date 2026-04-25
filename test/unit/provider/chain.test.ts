/**
 * Provider chain · #69 单测
 *
 * 覆盖：
 *   - classifyProviderError 各 status / error 分类
 *   - 单 provider 成功 / transient retry / retry 用尽 → fallback
 *   - auth/content 不 retry 直接 fallback
 *   - abort 立刻抛
 *   - producedAny=true 后失败：不 retry 不 fallback
 *   - 全部失败：ok=false + lastError 字段齐
 */

import { describe, expect, it, vi } from "vitest";

import {
  classifyProviderError,
  runWithProviderChain,
  type ProviderErrorClass,
} from "../../../src/provider/chain";
import { ProviderRequestError } from "../../../src/provider/client";
import type { ProviderStatus } from "../../../src/provider/types";

function fakeProvider(type: string): ProviderStatus {
  return {
    type: type as ProviderStatus["type"],
    displayName: type,
    kind: "cloud",
    enabled: true,
    requiresApiKey: false,
    baseUrl: "http://x",
    model: "m",
    timeoutMs: 1000,
    envVars: [],
    fileConfig: {} as ProviderStatus["fileConfig"],
    configured: true,
    available: true,
    reason: "",
  } as ProviderStatus;
}

async function* gen(...chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

async function collect(
  agen: AsyncGenerator<string, unknown>
): Promise<{ chunks: string[]; ret: unknown }> {
  const chunks: string[] = [];
  let ret: unknown;
  while (true) {
    const r = await agen.next();
    if (r.done) {
      ret = r.value;
      break;
    }
    chunks.push(r.value);
  }
  return { chunks, ret };
}

describe("classifyProviderError", () => {
  it("AbortError → abort", () => {
    const err = new Error("x");
    err.name = "AbortError";
    expect(classifyProviderError(err)).toBe<ProviderErrorClass>("abort");
  });

  it("ProviderRequestError 401/403 → auth", () => {
    expect(classifyProviderError(new ProviderRequestError("forbidden", 401))).toBe("auth");
    expect(classifyProviderError(new ProviderRequestError("forbidden", 403))).toBe("auth");
  });

  it("ProviderRequestError 5xx / 429 / 408 → transient", () => {
    for (const status of [500, 502, 503, 504, 429, 408, 425]) {
      expect(classifyProviderError(new ProviderRequestError("x", status))).toBe<ProviderErrorClass>("transient");
    }
  });

  it("ProviderRequestError 413 / 422 → content", () => {
    expect(classifyProviderError(new ProviderRequestError("too large", 413))).toBe("content");
    expect(classifyProviderError(new ProviderRequestError("invalid", 422))).toBe("content");
  });

  it("ProviderRequestError 其他 4xx → unknown", () => {
    expect(classifyProviderError(new ProviderRequestError("bad", 400))).toBe("unknown");
    expect(classifyProviderError(new ProviderRequestError("not found", 404))).toBe("unknown");
  });

  it("网络层 keyword → transient", () => {
    expect(classifyProviderError(new Error("ECONNRESET"))).toBe("transient");
    expect(classifyProviderError(new Error("fetch failed"))).toBe("transient");
    expect(classifyProviderError(new Error("socket hang up"))).toBe("transient");
  });

  it("aborted message → abort", () => {
    expect(classifyProviderError(new Error("operation aborted"))).toBe("abort");
  });

  it("null / 未知 → unknown", () => {
    expect(classifyProviderError(null)).toBe("unknown");
    expect(classifyProviderError(new Error("???"))).toBe("unknown");
  });
});

describe("runWithProviderChain · 编排", () => {
  it("单 provider 一次成功 → ok=true，1 次 attempt", async () => {
    const onAttempt = vi.fn();
    const result = await collect(
      runWithProviderChain({
        providers: [fakeProvider("openai")],
        invoke: () => gen("hello", " world"),
        onAttempt,
      })
    );
    expect(result.chunks).toEqual(["hello", " world"]);
    const ret = result.ret as { ok: boolean; attempts: unknown[]; succeededProvider?: string };
    expect(ret.ok).toBe(true);
    expect(ret.attempts).toHaveLength(1);
    expect(ret.succeededProvider).toBe("openai");
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  it("transient 第一次失败 → 同 provider retry → 第二次成功", async () => {
    let calls = 0;
    const result = await collect(
      runWithProviderChain({
        providers: [fakeProvider("openai")],
        backoffBaseMs: 1,
        sleepImpl: () => Promise.resolve(),
        invoke: async function* () {
          calls++;
          if (calls === 1) throw new ProviderRequestError("blip", 503);
          yield "ok";
        },
      })
    );
    expect(result.chunks).toEqual(["ok"]);
    const ret = result.ret as { ok: boolean; attempts: { ok: boolean; errorClass?: string }[] };
    expect(ret.ok).toBe(true);
    expect(ret.attempts).toHaveLength(2);
    expect(ret.attempts[0].ok).toBe(false);
    expect(ret.attempts[0].errorClass).toBe("transient");
    expect(ret.attempts[1].ok).toBe(true);
  });

  it("transient retry 用尽 → 切 fallback 成功", async () => {
    const result = await collect(
      runWithProviderChain({
        providers: [fakeProvider("openai"), fakeProvider("anthropic")],
        maxRetriesPerProvider: 1,
        sleepImpl: () => Promise.resolve(),
        invoke: async function* (p) {
          if (p.type === "openai") throw new ProviderRequestError("down", 502);
          yield "from anthropic";
        },
      })
    );
    expect(result.chunks).toEqual(["from anthropic"]);
    const ret = result.ret as { ok: boolean; attempts: { provider: string }[]; succeededProvider?: string };
    expect(ret.ok).toBe(true);
    expect(ret.succeededProvider).toBe("anthropic");
    // openai 试 2 次（1 + 1 retry）+ anthropic 1 次成功 = 3 attempts
    expect(ret.attempts).toHaveLength(3);
    expect(ret.attempts[0].provider).toBe("openai");
    expect(ret.attempts[1].provider).toBe("openai");
    expect(ret.attempts[2].provider).toBe("anthropic");
  });

  it("auth 错误 → 不 retry 直接切 fallback", async () => {
    const result = await collect(
      runWithProviderChain({
        providers: [fakeProvider("openai"), fakeProvider("anthropic")],
        maxRetriesPerProvider: 5,
        sleepImpl: () => Promise.resolve(),
        invoke: async function* (p) {
          if (p.type === "openai") throw new ProviderRequestError("forbidden", 403);
          yield "fallback";
        },
      })
    );
    const ret = result.ret as { attempts: { errorClass?: string }[] };
    // openai 仅 1 次（auth 不 retry）+ anthropic 1 次成功
    expect(ret.attempts).toHaveLength(2);
    expect(ret.attempts[0].errorClass).toBe("auth");
  });

  it("content 错误 → 不 retry，切 fallback", async () => {
    const result = await collect(
      runWithProviderChain({
        providers: [fakeProvider("openai"), fakeProvider("anthropic")],
        sleepImpl: () => Promise.resolve(),
        invoke: async function* (p) {
          if (p.type === "openai") throw new ProviderRequestError("too large", 413);
          yield "fallback";
        },
      })
    );
    const ret = result.ret as { attempts: { errorClass?: string }[]; ok: boolean };
    expect(ret.ok).toBe(true);
    expect(ret.attempts[0].errorClass).toBe("content");
  });

  it("abort → 立刻 throw（不切 fallback）", async () => {
    const ac = new AbortController();
    const agen = runWithProviderChain({
      providers: [fakeProvider("openai"), fakeProvider("anthropic")],
      abortSignal: ac.signal,
      invoke: async function* () {
        const e = new Error("x");
        e.name = "AbortError";
        throw e;
      },
    });
    await expect(collect(agen)).rejects.toThrow();
  });

  it("producedAny=true 后失败 → 不 retry 不 fallback，return ok=false", async () => {
    const result = await collect(
      runWithProviderChain({
        providers: [fakeProvider("openai"), fakeProvider("anthropic")],
        sleepImpl: () => Promise.resolve(),
        invoke: async function* (p) {
          if (p.type === "openai") {
            yield "partial-";
            throw new ProviderRequestError("blip", 503);
          }
          yield "should-not-reach";
        },
      })
    );
    expect(result.chunks).toEqual(["partial-"]);
    const ret = result.ret as { ok: boolean; attempts: { provider: string }[]; lastErrorClass?: string };
    expect(ret.ok).toBe(false);
    expect(ret.attempts).toHaveLength(1);
    expect(ret.attempts[0].provider).toBe("openai");
    expect(ret.lastErrorClass).toBe("transient");
  });

  it("全部失败 → ok=false + lastError 齐", async () => {
    const result = await collect(
      runWithProviderChain({
        providers: [fakeProvider("openai"), fakeProvider("anthropic")],
        maxRetriesPerProvider: 0,
        sleepImpl: () => Promise.resolve(),
        invoke: async function* () {
          throw new ProviderRequestError("forbidden", 401);
        },
      })
    );
    const ret = result.ret as {
      ok: boolean;
      lastError?: Error;
      lastErrorClass?: string;
      attempts: unknown[];
    };
    expect(ret.ok).toBe(false);
    expect(ret.lastError).toBeInstanceOf(Error);
    expect(ret.lastErrorClass).toBe("auth");
    expect(ret.attempts).toHaveLength(2);
  });

  it("retry 间隔指数退避（500/1000/2000）— 通过 sleepImpl 验证", async () => {
    const sleeps: number[] = [];
    await collect(
      runWithProviderChain({
        providers: [fakeProvider("openai")],
        maxRetriesPerProvider: 3,
        backoffBaseMs: 500,
        sleepImpl: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        invoke: async function* () {
          throw new ProviderRequestError("down", 503);
        },
      })
    );
    // 4 次 attempt：1 次原始 + 3 次 retry → sleep 3 次（每次 retry 前 sleep）
    // 但首次失败后 sleep 为 base*2^0=500，第二次 base*2^1=1000，第三次 base*2^2=2000
    expect(sleeps).toEqual([500, 1000, 2000]);
  });
});
