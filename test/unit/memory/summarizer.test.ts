/**
 * L2 Session Memory · summarizer 单测
 *
 * 用 mock SummarizeInvoker 验证：
 *   - 正常摘要流程返回完整 MemoryDigest（digestId/createdAt/tokenEstimate 等字段齐）
 *   - 空对话返回 fallback "(空对话)"
 *   - LLM 抛错返回 fallback 含 error message，**不抛**
 *   - 空字符串返回 fallback "(LLM 返回空)"
 *   - system 消息被滤掉不进 LLM prompt
 *   - messageCount 反映对话长度（不计 system）
 */

import { describe, expect, it, vi } from "vitest";
import type { EngineMessage } from "../../../src/agent/types";
import {
  summarizeSession,
  type SummarizeInvoker,
} from "../../../src/memory/sessionMemory/summarizer";

function meta() {
  return { sessionId: "s-test", channel: "cli" as const, userId: "alice" };
}

function userMsg(id: string, text: string): EngineMessage {
  return { id, role: "user", text, source: "user" };
}
function assistantMsg(id: string, text: string): EngineMessage {
  return { id, role: "assistant", text, source: "model" };
}
function systemMsg(id: string, text: string): EngineMessage {
  return { id, role: "system", text, source: "model" };
}

describe("summarizeSession · 正常路径", () => {
  it("返回完整 MemoryDigest 字段", async () => {
    const mock: SummarizeInvoker = vi.fn(async () => "用户讨论了 audit 链的 hash 设计。");
    const digest = await summarizeSession(
      mock,
      [userMsg("u1", "请讲讲 audit 链"), assistantMsg("a1", "audit 链用 BLAKE3...")],
      meta()
    );

    expect(digest.summary).toBe("用户讨论了 audit 链的 hash 设计。");
    expect(digest.sessionId).toBe("s-test");
    expect(digest.channel).toBe("cli");
    expect(digest.userId).toBe("alice");
    expect(digest.messageCount).toBe(2);
    expect(digest.tokenEstimate).toBeGreaterThan(0);
    expect(digest.digestId).toMatch(/^[0-9A-Z]{26}$/); // ULID
    expect(digest.createdAt).toBeGreaterThan(0);
  });

  it("trim LLM 返回的首尾空白", async () => {
    const mock: SummarizeInvoker = vi.fn(async () => "  \n\n  摘要正文  \n  ");
    const digest = await summarizeSession(mock, [userMsg("u1", "x")], meta());
    expect(digest.summary).toBe("摘要正文");
  });

  it("invoker 被调用时 system 消息已注入 + user 消息含对话原文", async () => {
    let captured: EngineMessage[] = [];
    const mock: SummarizeInvoker = async (msgs) => {
      captured = msgs;
      return "ok";
    };
    await summarizeSession(
      mock,
      [
        userMsg("u1", "什么是 trace_id?"),
        assistantMsg("a1", "ULID 编码的 traceId..."),
      ],
      meta()
    );
    expect(captured).toHaveLength(2);
    expect(captured[0].role).toBe("system");
    expect(captured[0].text).toContain("会话摘要器");
    expect(captured[1].role).toBe("user");
    expect(captured[1].text).toContain("什么是 trace_id?");
    expect(captured[1].text).toContain("ULID 编码的 traceId");
  });

  it("system 消息从输入里被滤掉（不进对话原文）", async () => {
    let captured: EngineMessage[] = [];
    const mock: SummarizeInvoker = async (msgs) => {
      captured = msgs;
      return "ok";
    };
    await summarizeSession(
      mock,
      [
        systemMsg("sys", "你是助手"),
        userMsg("u1", "hello"),
      ],
      meta()
    );
    expect(captured[1].text).not.toContain("你是助手");
    expect(captured[1].text).toContain("hello");
  });
});

describe("summarizeSession · 边界 / 失败路径", () => {
  it("空 messages 返回 fallback 不调 invoker", async () => {
    const mock: SummarizeInvoker = vi.fn(async () => "should not be called");
    const digest = await summarizeSession(mock, [], meta());
    expect(digest.summary).toBe("[LLM 摘要失败] (空对话)");
    expect(digest.messageCount).toBe(0);
    expect(mock).not.toHaveBeenCalled();
  });

  it("仅含 system 消息也算空对话", async () => {
    const mock: SummarizeInvoker = vi.fn(async () => "x");
    const digest = await summarizeSession(
      mock,
      [systemMsg("sys", "you are an ai")],
      meta()
    );
    expect(digest.summary).toBe("[LLM 摘要失败] (空对话)");
    expect(digest.messageCount).toBe(0);
    expect(mock).not.toHaveBeenCalled();
  });

  it("LLM 抛错 → fallback 含 error message，不抛", async () => {
    const mock: SummarizeInvoker = async () => {
      throw new Error("provider timeout");
    };
    const digest = await summarizeSession(mock, [userMsg("u1", "x")], meta());
    expect(digest.summary).toContain("[LLM 摘要失败]");
    expect(digest.summary).toContain("provider timeout");
    expect(digest.messageCount).toBe(1);
  });

  it("LLM 返回空字符串 → fallback (LLM 返回空)", async () => {
    const mock: SummarizeInvoker = async () => "   ";
    const digest = await summarizeSession(mock, [userMsg("u1", "x")], meta());
    expect(digest.summary).toBe("[LLM 摘要失败] (LLM 返回空)");
  });

  it("messageCount 不计 system 消息", async () => {
    const mock: SummarizeInvoker = async () => "ok";
    const digest = await summarizeSession(
      mock,
      [
        systemMsg("sys", "x"),
        userMsg("u1", "a"),
        systemMsg("sys2", "y"),
        assistantMsg("a1", "b"),
      ],
      meta()
    );
    expect(digest.messageCount).toBe(2);
  });
});

describe("summarizeSession · abortSignal 透传", () => {
  it("abortSignal 透传到 invoker 第二参数", async () => {
    let receivedSignal: AbortSignal | undefined;
    const mock: SummarizeInvoker = async (_msgs, signal) => {
      receivedSignal = signal;
      return "ok";
    };
    const ac = new AbortController();
    await summarizeSession(mock, [userMsg("u1", "x")], meta(), ac.signal);
    expect(receivedSignal).toBe(ac.signal);
  });
});
