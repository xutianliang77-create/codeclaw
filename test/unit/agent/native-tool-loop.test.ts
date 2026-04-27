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

  it("env=false 显式关闭时不发 tools schema、走单回合（向后兼容）", async () => {
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

  it("v0.7.0: env 未设时默认启用 native tools（注册 builtin tools）", async () => {
    delete process.env.CODECLAW_NATIVE_TOOLS;
    const requests: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(
        JSON.parse(String(init?.body)) as { tools?: Array<{ function: { name: string } }> }
      );
      return sseResponse(
        sseFrames([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])
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

    expect(Array.isArray(requests[0].tools)).toBe(true);
    const names = (requests[0].tools as Array<{ function: { name: string } }>).map(
      (t) => t.function.name
    );
    expect(names).toContain("read");
  });

  it("M2-03：plan mode → LLM 调 ExitPlanMode → engine 切 default mode + 后续轮次拿全工具", async () => {
    let callIndex = 0;
    const requests: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as { tools?: Array<{ function: { name: string } }> });
      callIndex += 1;
      if (callIndex === 1) {
        // turn 1 (plan mode)：LLM 调 ExitPlanMode 提交 plan
        return sseResponse(
          sseFrames([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "ep_1", function: { name: "ExitPlanMode" } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"plan":"1. read foo.txt\\n2. modify it"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ])
        );
      }
      // turn 2 (default mode)：LLM 看到 tool 结果就回答（mode 已切，工具全量可见）
      return sseResponse(
        sseFrames([
          { choices: [{ delta: { content: "Plan accepted, executing now." }, finish_reason: "stop" }] },
        ])
      );
    }) as unknown as typeof fetch;

    const engine = createQueryEngine({
      currentProvider: provider(),
      fallbackProvider: null,
      permissionMode: "plan",
      workspace,
      fetchImpl,
    });
    await collect(engine.submitMessage("帮我修个 bug"));

    expect(callIndex).toBe(2);
    // turn 1 在 plan mode：tools 数组只含 read-only + memory_write + ExitPlanMode；不含 bash/write
    const turn1Tools = (requests[0].tools ?? []).map((t) => t.function.name);
    expect(turn1Tools).toContain("ExitPlanMode");
    expect(turn1Tools).toContain("read");
    expect(turn1Tools).not.toContain("bash");
    expect(turn1Tools).not.toContain("write");
    // turn 2 mode 切到 default：tools 全量含 bash/write
    const turn2Tools = (requests[1].tools ?? []).map((t) => t.function.name);
    expect(turn2Tools).toContain("bash");
    expect(turn2Tools).toContain("write");
    // engine 当前 permissionMode 已切回 default
    expect(engine.getRuntimeState().permissionMode).toBe("default");
  });

  it("M2-04：evaluate(deny) → push role:tool 否决 + 不调 invoke", async () => {
    let callIndex = 0;
    const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> });
      callIndex += 1;
      if (callIndex === 1) {
        // turn 1：LLM 调 bash 高危命令（含 rm 触发 deny）
        return sseResponse(
          sseFrames([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "b1", function: { name: "bash" } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"rm -rf /"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ])
        );
      }
      // turn 2：LLM 看到 deny 改口
      return sseResponse(
        sseFrames([
          { choices: [{ delta: { content: "Sorry, I cannot do that." }, finish_reason: "stop" }] },
        ])
      );
    }) as unknown as typeof fetch;

    const engine = createQueryEngine({
      currentProvider: provider(),
      fallbackProvider: null,
      permissionMode: "acceptEdits", // high risk → deny
      workspace,
      fetchImpl,
    });
    await collect(engine.submitMessage("clean up everything"));

    expect(callIndex).toBe(2);
    // turn 2 messages 含一条 role:"tool" 且 content 含 denial reason
    const turn2Msgs = requests[1].messages as Array<{ role: string; content?: string }>;
    const denialTool = turn2Msgs.find((m) => m.role === "tool");
    expect(denialTool).toBeDefined();
    expect(String(denialTool?.content)).toMatch(/User policy denied|denied this tool call/);
    // engine.getMessages 含 tool role + 最终 assistant
    expect(engine.getMessages().filter((m) => m.role === "tool").length).toBeGreaterThanOrEqual(1);
    expect(engine.getMessages().at(-1)?.text).toContain("cannot");
  });

  it("M2-04：evaluate(ask) → 同样 push role:tool 阻 LLM 重试（保守降级）", async () => {
    let callIndex = 0;
    const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> });
      callIndex += 1;
      if (callIndex === 1) {
        // turn 1：default mode + write tool（medium → ask）
        return sseResponse(
          sseFrames([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "w1", function: { name: "write" } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":"x.ts","content":"y"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ])
        );
      }
      return sseResponse(
        sseFrames([
          { choices: [{ delta: { content: "OK skipping" }, finish_reason: "stop" }] },
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
    await collect(engine.submitMessage("write x.ts"));

    const turn2Msgs = requests[1].messages as Array<{ role: string; content?: string }>;
    const askTool = turn2Msgs.find((m) => m.role === "tool");
    expect(askTool).toBeDefined();
    expect(String(askTool?.content)).toContain("Approval required");
  });

  it("M2-04：evaluate(allow) → 正常 invoke（read low risk 在 default mode）", async () => {
    writeFileSync(path.join(workspace, "ok.txt"), "all-good-content");
    let callIndex = 0;
    const fetchImpl = (async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return sseResponse(
          sseFrames([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "r1", function: { name: "read" } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":"ok.txt"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ])
        );
      }
      return sseResponse(
        sseFrames([
          { choices: [{ delta: { content: "Got: all-good-content" }, finish_reason: "stop" }] },
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
    await collect(engine.submitMessage("read ok.txt"));
    // tool message 是真读到的内容，不是 denial
    const toolMsg = engine.getMessages().find((m) => m.role === "tool");
    expect(toolMsg?.text).toContain("all-good-content");
    expect(toolMsg?.text).not.toContain("denied");
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
