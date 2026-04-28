/**
 * streamProviderResponse · native tool_use 流式解析（M1-B）
 *
 * 覆盖：
 *   - OpenAI: 单工具 tool_calls 流式分片（id/name 第一帧，arguments 多帧累加）→ onToolCall fired with parsed args
 *   - OpenAI: 多工具单回合（同一帧 finish_reason="tool_calls" 时 yield 多个事件）
 *   - OpenAI: arguments JSON 解析失败 → args:null + raw 保留
 *   - Anthropic: tool_use content_block_start + input_json_delta + content_block_stop → onToolCall
 *   - tools 未传时不在 body 加 tools 字段（向后兼容）
 *   - tools 传入时 OpenAI body 含 tools[]，Anthropic body 含 tools[]
 */

import { describe, expect, it, vi } from "vitest";
import { streamProviderResponse, type ToolSchemaSpec } from "../../../src/provider/client";
import type { ToolCallEvent } from "../../../src/agent/tools/registry";
import type { ProviderStatus } from "../../../src/provider/types";

function fakeProvider(type: ProviderStatus["type"]): ProviderStatus {
  return {
    instanceId: `${type}:default`,
    type,
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
  };
}

function sseResponse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const dummyTool: ToolSchemaSpec = {
  name: "read",
  description: "read a file",
  inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
};

async function consume(gen: AsyncGenerator<string>): Promise<string> {
  let s = "";
  for await (const chunk of gen) s += chunk;
  return s;
}

describe("streamProviderResponse · OpenAI tool_calls", () => {
  it("分片累加 arguments，finish_reason='tool_calls' 时 yield ToolCallEvent", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read" } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"fil' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'e_path":"foo.ts"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(frames));
    const calls: ToolCallEvent[] = [];
    await consume(
      streamProviderResponse(fakeProvider("openai"), [{ id: "u1", role: "user", text: "hi" }], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        tools: [dummyTool],
        onToolCall: (c) => calls.push(c),
      })
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read");
    expect(calls[0].id).toBe("call-1");
    expect(calls[0].args).toEqual({ file_path: "foo.ts" });
    expect(calls[0].raw).toBe('{"file_path":"foo.ts"}');
  });

  it("多工具单回合 yield 多个事件", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "c1", function: { name: "read", arguments: '{"file_path":"a"}' } },
        { index: 1, id: "c2", function: { name: "bash", arguments: '{"command":"ls"}' } },
      ] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(frames));
    const calls: ToolCallEvent[] = [];
    await consume(
      streamProviderResponse(fakeProvider("openai"), [{ id: "u1", role: "user", text: "hi" }], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        tools: [dummyTool],
        onToolCall: (c) => calls.push(c),
      })
    );
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.name).sort()).toEqual(["bash", "read"]);
  });

  it("arguments 不合 JSON → args:null，raw 保留", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{not json" } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(frames));
    const calls: ToolCallEvent[] = [];
    await consume(
      streamProviderResponse(fakeProvider("openai"), [{ id: "u1", role: "user", text: "hi" }], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        tools: [dummyTool],
        onToolCall: (c) => calls.push(c),
      })
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toBeNull();
    expect(calls[0].raw).toBe("{not json");
  });

  it("M1-F：onContent 仅收 delta.content，onReasoning 仅收 reasoning_content/reasoning", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { reasoning_content: "let me think... " } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: "OK I got it. " } }] }),
      JSON.stringify({ choices: [{ delta: { content: "The answer is 42." } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(frames));
    let contentBuf = "";
    let reasoningBuf = "";
    const yieldedChunks: string[] = [];
    for await (const c of streamProviderResponse(fakeProvider("openai"), [{ id: "u1", role: "user", text: "hi" }], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onContent: (c) => (contentBuf += c),
      onReasoning: (r) => (reasoningBuf += r),
    })) {
      yieldedChunks.push(c);
    }
    expect(contentBuf).toBe("The answer is 42.");
    expect(reasoningBuf).toBe("let me think... OK I got it. ");
    // generator 仍 yield 合并流（向后兼容 CLI）
    expect(yieldedChunks.join("")).toBe("let me think... OK I got it. The answer is 42.");
  });

  it("M1-F：reasoning 路径降级 yield（content 空时 generator 仍 yield reasoning）", async () => {
    const frames = [
      JSON.stringify({ choices: [{ delta: { reasoning: "thinking only..." } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(frames));
    let contentBuf = "";
    let reasoningBuf = "";
    const yielded = await consume(
      streamProviderResponse(fakeProvider("openai"), [{ id: "u1", role: "user", text: "hi" }], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onContent: (c) => (contentBuf += c),
        onReasoning: (r) => (reasoningBuf += r),
      })
    );
    expect(contentBuf).toBe("");
    expect(reasoningBuf).toBe("thinking only...");
    // generator yield = combined fallback（content 空时 reasoning）
    expect(yielded).toBe("thinking only...");
  });

  it("不传 tools 时 body 不含 tools 字段", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
    ]));
    await consume(
      streamProviderResponse(fakeProvider("openai"), [{ id: "u1", role: "user", text: "hi" }], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tools).toBeUndefined();
  });

  it("传 tools 时 OpenAI body 含 tools[].type='function'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
    ]));
    await consume(
      streamProviderResponse(fakeProvider("openai"), [{ id: "u1", role: "user", text: "hi" }], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        tools: [dummyTool],
      })
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("read");
  });
});

describe("streamProviderResponse · Anthropic tool_use", () => {
  it("content_block_start + input_json_delta + content_block_stop → onToolCall", async () => {
    const frames = [
      JSON.stringify({ type: "message_start", message: { model: "claude-3", usage: { input_tokens: 10 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path"' } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"foo.ts"}' } }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({ type: "message_delta", usage: { output_tokens: 5 } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(frames));
    const calls: ToolCallEvent[] = [];
    await consume(
      streamProviderResponse(fakeProvider("anthropic"), [{ id: "u1", role: "user", text: "hi" }], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        tools: [dummyTool],
        onToolCall: (c) => calls.push(c),
      })
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read");
    expect(calls[0].id).toBe("tu_1");
    expect(calls[0].args).toEqual({ file_path: "foo.ts" });
  });

  it("Anthropic body 含 tools[].input_schema", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ type: "message_start", message: { model: "c", usage: { input_tokens: 1 } } }),
      JSON.stringify({ type: "message_stop" }),
    ]));
    await consume(
      streamProviderResponse(fakeProvider("anthropic"), [{ id: "u1", role: "user", text: "hi" }], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        tools: [dummyTool],
      })
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("read");
    expect(body.tools[0].input_schema).toBeDefined();
  });
});
