/**
 * M1-B.2 · queryEngine native tool_use multi-turn 派发循环
 *
 * 端到端覆盖：
 *   - env CODECLAW_NATIVE_TOOLS=true 时 toolRegistry 注册 9 个 builtin
 *   - 第 1 回合 LLM 发 tool_calls(read foo.txt) → engine 调 toolRegistry.invoke
 *     → push role:"tool" 消息（含 toolCallId）→ 触发第 2 次 LLM 调用
 *   - 第 2 回合 LLM 发文字 → 主流程结束、yield message-complete + phase=completed
 *   - 第 2 次 fetch 的 messages 含完整 turn 1 上下文（assistant w/ toolCalls + tool result）
 *   - MAX_TOOL_TURNS 防无限循环
 *   - env 关闭时（默认）零行为变化、不发 tools schema
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { createQueryEngine } from "../../../src/agent/queryEngine";
import type { ProviderStatus } from "../../../src/provider/types";

function provider(): ProviderStatus {
  return {
    type: "openai",
    displayName: "OpenAI",
    kind: "cloud",
    enabled: true,
    requiresApiKey: false,
    baseUrl: "http://x",
    model: "gpt-4",
    timeoutMs: 1000,
    envVars: [],
    fileConfig: {} as ProviderStatus["fileConfig"],
    configured: true,
    available: true,
    reason: "",
  };
}

function sseFrames(frames: object[]): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n`).join("") + "data: [DONE]\n";
}

function sseResponse(body: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    })
  );
}

async function collect(
  gen: AsyncGenerator<unknown>
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

let workspace: string;
const ORIGINAL_ENV = process.env.CODECLAW_NATIVE_TOOLS;

beforeEach(() => {
  workspace = path.join(os.tmpdir(), `nt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workspace, { recursive: true });
  process.env.CODECLAW_NATIVE_TOOLS = "true";
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  if (ORIGINAL_ENV === undefined) delete process.env.CODECLAW_NATIVE_TOOLS;
  else process.env.CODECLAW_NATIVE_TOOLS = ORIGINAL_ENV;
});

describe("queryEngine native tool_use multi-turn", () => {
  it("turn 1 tool_call(read) → engine 派发 → turn 2 final answer", async () => {
    writeFileSync(path.join(workspace, "foo.txt"), "secret-content-42");

    const requests: Array<{ messages: Array<Record<string, unknown>>; tools?: unknown }> = [];
    let callIndex = 0;

    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<Record<string, unknown>>;
        tools?: unknown;
      };
      requests.push(body);
      callIndex += 1;

      if (callIndex === 1) {
        // turn 1：LLM 调 read 工具
        return sseResponse(
          sseFrames([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read" } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":"foo.txt"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ])
        );
      }
      // turn 2：LLM 看到 tool 结果后回答
      return sseResponse(
        sseFrames([
          { choices: [{ delta: { content: "Found content: secret-content-42" }, finish_reason: "stop" }] },
        ])
      );
    }) as unknown as typeof fetch;

    const engine = createQueryEngine({
      currentProvider: provider(),
      fallbackProvider: null,
      permissionMode: "default",
      workspace,
      fetchImpl,
    });

    await collect(engine.submitMessage("read foo.txt 看看"));

    // 两次 fetch：每个 turn 一次
    expect(callIndex).toBe(2);

    // 第 1 次 request 含 tools schema
    expect(Array.isArray(requests[0].tools)).toBe(true);
    const tools0 = requests[0].tools as Array<{ type: string; function: { name: string } }>;
    expect(tools0.map((t) => t.function.name)).toContain("read");

    // 第 2 次 request 的 messages 含 assistant.tool_calls + role:"tool" 结果
    const turn2Msgs = requests[1].messages as Array<{
      role: string;
      tool_calls?: Array<{ id: string; function: { name: string } }>;
      tool_call_id?: string;
      content?: string;
    }>;
    const assistantToolUse = turn2Msgs.find((m) => m.role === "assistant" && m.tool_calls);
    expect(assistantToolUse?.tool_calls?.[0].function.name).toBe("read");
    expect(assistantToolUse?.tool_calls?.[0].id).toBe("call_1");

    const toolResult = turn2Msgs.find((m) => m.role === "tool");
    expect(toolResult).toBeDefined();
    expect(toolResult?.tool_call_id).toBe("call_1");
    expect(String(toolResult?.content)).toContain("secret-content-42");

    // engine.getMessages 含 user / assistant(turn1, toolCalls) / tool / assistant(turn2)
    const all = engine.getMessages();
    const roles = all.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles.filter((r) => r === "assistant").length).toBeGreaterThanOrEqual(2);
    expect(roles).toContain("tool");
    expect(all.at(-1)?.text).toContain("secret-content-42");
  });

  it("env 关闭时（默认）不发 tools schema、走单回合（向后兼容）", async () => {
    process.env.CODECLAW_NATIVE_TOOLS = "false";
    const requests: Array<{ tools?: unknown }> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as { tools?: unknown });
      return sseResponse(
        sseFrames([
          { choices: [{ delta: { content: "plain answer" }, finish_reason: "stop" }] },
        ])
      );
    }) as unknown as typeof fetch;

    const engine = createQueryEngine({
      currentProvider: provider(),
      fallbackProvider: null,
      permissionMode: "default",
      workspace,
      fetchImpl,
    });

    await collect(engine.submitMessage("hi"));

    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toBeUndefined();
    expect(engine.getMessages().at(-1)?.text).toBe("plain answer");
  });

  it("LLM 没有调工具时 multi-turn 退化为单回合（即使 env 开启）", async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount += 1;
      return sseResponse(
        sseFrames([
          { choices: [{ delta: { content: "no tool needed" }, finish_reason: "stop" }] },
        ])
      );
    }) as unknown as typeof fetch;

    const engine = createQueryEngine({
      currentProvider: provider(),
      fallbackProvider: null,
      permissionMode: "default",
      workspace,
      fetchImpl,
    });

    await collect(engine.submitMessage("hi"));

    expect(callCount).toBe(1);
    expect(engine.getMessages().at(-1)?.text).toBe("no tool needed");
  });
});
