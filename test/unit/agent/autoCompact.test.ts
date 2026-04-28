/**
 * autoCompactIfNeeded 单测（M2-01）
 *
 * 覆盖 spec §4.4 列的 9 个 case + 边界保护：
 *   - <95% 不动 messages
 *   - ≥95% 触发，旧 turn 摘要为 role:"assistant" + source:"summary"
 *   - 保留最近 keep 个 user-assistant turn
 *   - splitForCompact 不拆 tool_call_id 链（assistant w/ toolCalls + tool_results 一起留 / 一起砍）
 *   - 摘要后仍 ≥95% → 滑窗硬截 fallback
 *   - persists summary 到 data.db memory_digests（mock db）
 *   - dataDb=null 时 graceful（runner 用法）
 *   - saveMemoryDigest FK 失败时不阻塞 compact（spec patch B3）
 *   - 头部 system message 由 buildSystemPrompt 控制（不在 messages 里）→ 本模块不需要保 system
 *   - splitForCompact 边界 case：少于 keep 个 turn → cutoff=0
 *
 * 不变量：summary message 用 role:"assistant" + source:"summary"（与 performCompact 现网约定一致）
 */

import { describe, expect, it, vi } from "vitest";
import {
  autoCompactIfNeeded,
  splitForCompact,
  slidingWindowHardCut,
  type AutoCompactOptions,
} from "../../../src/agent/autoCompact";
import type { EngineMessage } from "../../../src/agent/types";
import type { ProviderStatus } from "../../../src/provider/types";

const provider = (model: string, ctxOverride?: number): ProviderStatus =>
  ({
    instanceId: "openai:default",
    type: "openai",
    displayName: "x",
    kind: "cloud",
    enabled: true,
    requiresApiKey: false,
    baseUrl: "x",
    model,
    timeoutMs: 1000,
    envVars: [],
    fileConfig: {} as ProviderStatus["fileConfig"],
    configured: true,
    available: true,
    reason: "",
    ...(ctxOverride ? { contextWindow: ctxOverride } : {}),
  } as ProviderStatus);

const userMsg = (id: string, text: string): EngineMessage => ({
  id,
  role: "user",
  text,
  source: "user",
});
const asstMsg = (id: string, text: string, toolCalls?: EngineMessage["toolCalls"]): EngineMessage => ({
  id,
  role: "assistant",
  text,
  source: "model",
  ...(toolCalls ? { toolCalls } : {}),
});
const toolMsg = (id: string, callId: string, text: string): EngineMessage => ({
  id,
  role: "tool",
  text,
  source: "local",
  toolCallId: callId,
});

const baseOpts = (overrides: Partial<AutoCompactOptions> = {}): AutoCompactOptions => ({
  invoker: async () => "[fake summary]",
  sessionId: "sess-1",
  channel: "cli",
  userId: "u1",
  dataDb: null,
  ...overrides,
});

describe("autoCompactIfNeeded", () => {
  it("<70% utilization → 不触发，messages 原样返回", async () => {
    const msgs = [userMsg("u1", "hi"), asstMsg("a1", "hello")];
    const r = await autoCompactIfNeeded(msgs, provider("gpt-4o"), baseOpts());
    expect(r.compacted).toBe(false);
    expect(r.messages).toBe(msgs);
  });

  it("≥95% 触发，旧 turn 摘要为 role:assistant + source:summary", async () => {
    // 构造 messages 使 token 接近 100% × ctxOverride=200
    // 'a '*120 ≈ 121 token + 4 overhead = 125 token；多条堆到 ≥95%
    const longText = "a ".repeat(120);
    const msgs: EngineMessage[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(userMsg(`u${i}`, longText));
      msgs.push(asstMsg(`a${i}`, longText));
    }
    const r = await autoCompactIfNeeded(msgs, provider("gpt-4", 200), baseOpts());
    expect(r.compacted).toBe(true);
    const summaryMsg = r.messages[0];
    expect(summaryMsg.role).toBe("assistant");
    expect(summaryMsg.source).toBe("summary");
    expect(summaryMsg.text).toContain("auto-compact");
    expect(summaryMsg.text).toContain("[fake summary]");
  });

  it("保留最近 keepRecentTurns=2 个 user-assistant turn", async () => {
    const longText = "a ".repeat(120);
    const msgs: EngineMessage[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(userMsg(`u${i}`, longText));
      msgs.push(asstMsg(`a${i}`, longText));
    }
    const r = await autoCompactIfNeeded(
      msgs,
      provider("gpt-4", 200),
      baseOpts({ keepRecentTurns: 2, hardCutFallback: false })
    );
    expect(r.compacted).toBe(true);
    // retained 应当含最后 2 个 user + 它们的 assistant = 4 条；加 summary 共 5
    const userInRetained = r.messages.filter((m) => m.role === "user");
    expect(userInRetained.length).toBe(2);
    expect(userInRetained[0].id).toBe("u4");
    expect(userInRetained[1].id).toBe("u5");
  });

  it("splitForCompact 不拆 tool_call_id 链（assistant.toolCalls + tool 一起保留）", () => {
    const msgs: EngineMessage[] = [
      userMsg("u1", "old1"),
      asstMsg("a1", "answer"),
      userMsg("u2", "now"),
      asstMsg("a2", "let me read", [{ id: "call-1", name: "read", args: { file_path: "x" } }]),
      toolMsg("t1", "call-1", "file content"),
      asstMsg("a3", "the content is..."),
    ];
    const { oldMessages, retained } = splitForCompact(msgs, 1);
    // retained 应该从 u2 起完整保留 a2(toolCalls) + t1 + a3，不能只留 t1 没有它的 assistant
    expect(retained[0].id).toBe("u2");
    expect(retained.find((m) => m.id === "a2")).toBeDefined();
    expect(retained.find((m) => m.id === "t1")).toBeDefined();
    expect(oldMessages.find((m) => m.id === "u2")).toBeUndefined();
  });

  it("少于 keep 个 turn → 不压缩（candidates < 2 short-circuit）", async () => {
    const longText = "a ".repeat(120);
    const msgs = [userMsg("u1", longText), asstMsg("a1", longText)];
    const r = await autoCompactIfNeeded(
      msgs,
      provider("gpt-4", 200),
      baseOpts({ keepRecentTurns: 5 })
    );
    // 阈值触发但 oldMessages 为空 → 不压缩
    expect(r.compacted).toBe(false);
  });

  it("dataDb=null → 不调 saveMemoryDigest，仍正常压缩", async () => {
    const longText = "a ".repeat(120);
    const msgs: EngineMessage[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(userMsg(`u${i}`, longText));
      msgs.push(asstMsg(`a${i}`, longText));
    }
    const r = await autoCompactIfNeeded(msgs, provider("gpt-4", 200), baseOpts({ dataDb: null }));
    expect(r.compacted).toBe(true);
  });

  it("saveMemoryDigest FK 失败 → stderr warn 但不阻塞 compact", async () => {
    const longText = "a ".repeat(120);
    const msgs: EngineMessage[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(userMsg(`u${i}`, longText));
      msgs.push(asstMsg(`a${i}`, longText));
    }
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fakeDb = {
      prepare: () => ({
        run: () => {
          throw new Error("FOREIGN KEY constraint failed");
        },
      }),
    } as unknown as import("better-sqlite3").Database;

    const r = await autoCompactIfNeeded(msgs, provider("gpt-4", 200), baseOpts({ dataDb: fakeDb }));
    expect(r.compacted).toBe(true);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("FOREIGN KEY"));
    stderr.mockRestore();
  });

  it("dataDb 写入：被调用，digest 有 digestId/sessionId/channel/userId 字段", async () => {
    const longText = "a ".repeat(120);
    const msgs: EngineMessage[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(userMsg(`u${i}`, longText));
      msgs.push(asstMsg(`a${i}`, longText));
    }
    const captured: unknown[] = [];
    const fakeDb = {
      prepare: () => ({
        run: (...args: unknown[]) => captured.push(args),
      }),
    } as unknown as import("better-sqlite3").Database;
    const r = await autoCompactIfNeeded(msgs, provider("gpt-4", 200), baseOpts({ dataDb: fakeDb }));
    expect(r.compacted).toBe(true);
    expect(captured.length).toBe(1);
    const args = captured[0] as unknown[];
    // INSERT digest_id, session_id, channel, user_id, summary_text, message_count, token_estimate, created_at
    expect(args[1]).toBe("sess-1");
    expect(args[2]).toBe("cli");
    expect(args[3]).toBe("u1");
  });

  it("compactedTurnCount 字段反映实际被压缩消息数", async () => {
    const longText = "a ".repeat(120);
    const msgs: EngineMessage[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(userMsg(`u${i}`, longText));
      msgs.push(asstMsg(`a${i}`, longText));
    }
    const r = await autoCompactIfNeeded(
      msgs,
      provider("gpt-4", 200),
      baseOpts({ keepRecentTurns: 2 })
    );
    // 12 messages 总 - 2 user × (user+assistant) = 4 retained → oldMessages = 8
    expect(r.compactedTurnCount).toBe(8);
  });
});

describe("splitForCompact", () => {
  it("少于 keep 个 turn → cutoffIndex=0（全保留）", () => {
    const msgs = [userMsg("u1", "x"), asstMsg("a1", "y")];
    const { oldMessages, retained } = splitForCompact(msgs, 5);
    expect(oldMessages).toEqual([]);
    expect(retained).toEqual(msgs);
  });

  it("正好 keep 个 turn → 全保留", () => {
    const msgs = [
      userMsg("u1", "x"),
      asstMsg("a1", "y"),
      userMsg("u2", "z"),
      asstMsg("a2", "w"),
    ];
    const { oldMessages, retained } = splitForCompact(msgs, 2);
    expect(oldMessages).toEqual([]);
    expect(retained.length).toBe(4);
  });

  it("超过 keep → 砍最早的", () => {
    const msgs = [
      userMsg("u1", "x1"),
      asstMsg("a1", "y1"),
      userMsg("u2", "x2"),
      asstMsg("a2", "y2"),
      userMsg("u3", "x3"),
      asstMsg("a3", "y3"),
    ];
    const { oldMessages, retained } = splitForCompact(msgs, 2);
    expect(oldMessages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(retained.map((m) => m.id)).toEqual(["u2", "a2", "u3", "a3"]);
  });
});

describe("slidingWindowHardCut", () => {
  it("从最旧非 summary 开始砍直到 <95%", () => {
    const longText = "a ".repeat(60);
    const msgs: EngineMessage[] = [
      { id: "s", role: "assistant", text: "[summary] short", source: "summary" },
      userMsg("u1", longText),
      asstMsg("a1", longText),
      userMsg("u2", longText),
    ];
    const cut = slidingWindowHardCut(msgs, provider("gpt-4", 100));
    // summary 必须保留
    expect(cut.find((m) => m.source === "summary")).toBeDefined();
  });

  it("orphan tool message 头部清理", () => {
    const longText = "a ".repeat(80);
    const msgs: EngineMessage[] = [
      userMsg("u1", longText),
      asstMsg("a1", longText, [{ id: "c1", name: "x", args: {} }]),
      toolMsg("t1", "c1", "result"),
      userMsg("u2", longText),
    ];
    const cut = slidingWindowHardCut(msgs, provider("gpt-4", 100));
    // 砍 u1 后 a1+t1 也成 orphan 头部 → tool 应被清
    expect(cut.find((m) => m.role === "tool" && m.id === "t1")).toBeUndefined();
  });
});
