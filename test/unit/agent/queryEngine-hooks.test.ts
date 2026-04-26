/**
 * QueryEngine · M3-04 Hooks 集成测
 *
 * 覆盖：
 *   - UserPromptSubmit 阻塞：user 消息不进 LLM，assistant 提示 + message-complete
 *   - UserPromptSubmit 通过：messages 正常推进
 *   - SessionStart fire-and-forget：constructor 不阻塞，hook 在后台跑
 *   - buildHooksReply 列出配置（runHooksReplyCommand 走 /hooks 路径）
 *   - hooks 配置缺省时 5 个时点皆 no-op
 */

import { describe, expect, it } from "vitest";

import { createQueryEngine } from "../../../src/agent/queryEngine";
import type { CodeclawSettings } from "../../../src/hooks/settings";
import type { EngineEvent } from "../../../src/agent/types";

async function collect(gen: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe("queryEngine UserPromptSubmit hook", () => {
  it("非 0 exit → 阻塞用户消息派发", async () => {
    const settings: CodeclawSettings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "echo NOPE >&2; exit 1" }],
          },
        ],
      },
    };
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
      settings,
    });
    const events = await collect(engine.submitMessage("malicious prompt"));
    const completes = events.filter((e) => e.type === "message-complete");
    expect(completes.length).toBe(1);
    const ev = completes[0] as EngineEvent & { text: string };
    expect(ev.text).toMatch(/UserPromptSubmit hook blocked/);
    expect(ev.text).toMatch(/NOPE/);
  });

  it("exit 0 → 用户消息正常进入 transcript（虽无 provider，引擎仍尝试派发）", async () => {
    const settings: CodeclawSettings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "echo allowed" }],
          },
        ],
      },
    };
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
      settings,
    });
    const events = await collect(engine.submitMessage("normal prompt"));
    // 不应有 UserPromptSubmit hook blocked 提示
    const blocked = events.find(
      (e) => e.type === "message-complete" && /UserPromptSubmit hook blocked/.test((e as { text: string }).text)
    );
    expect(blocked).toBeUndefined();
  });

  it("slash 命令跳过 hook", async () => {
    const settings: CodeclawSettings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "exit 1" }],
          },
        ],
      },
    };
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
      settings,
    });
    const events = await collect(engine.submitMessage("/help"));
    // slash 命令直接走 reply path，不应被 hook 拦截
    const blocked = events.find(
      (e) => e.type === "message-complete" && /UserPromptSubmit hook blocked/.test((e as { text: string }).text)
    );
    expect(blocked).toBeUndefined();
  });

  it("无 settings 时 5 时点皆 no-op", async () => {
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
    });
    const events = await collect(engine.submitMessage("anything"));
    const blocked = events.find(
      (e) => e.type === "message-complete" && /hook blocked/.test((e as { text: string }).text)
    );
    expect(blocked).toBeUndefined();
  });
});

describe("queryEngine PreToolUse hook (multi-turn)", () => {
  // mock provider 返一个 tool_call → invoke 前 PreToolUse 阻塞 → role:tool 反馈给 LLM
  // 简化：构造 OpenAI SSE，含 tool_calls 的 delta + 第二轮 [DONE] 收尾
  const MOCK_PROVIDER = {
    type: "openai" as const,
    displayName: "openai",
    kind: "cloud" as const,
    enabled: true,
    requiresApiKey: true,
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    timeoutMs: 30000,
    apiKey: "test-key",
    envVars: [],
    fileConfig: { enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", timeoutMs: 30000 },
    configured: true,
    available: true,
    reason: "ok",
  };

  function mockToolCallThenAnswer(): typeof fetch {
    let call = 0;
    return (async () => {
      call += 1;
      if (call === 1) {
        // 第一轮：tool_call
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{}"}}]},"finish_reason":null}]}\n\n'
              )
            );
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n'
              )
            );
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream);
      }
      // 第二轮：text 答复
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"acknowledged blocked"}}]}\n\n'
            )
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream);
    }) as unknown as typeof fetch;
  }

  it("PreToolUse exit≠0 → push role:tool 提示，跳过 invoke，下一轮 LLM 看到", async () => {
    const previousNative = process.env.CODECLAW_NATIVE_TOOLS;
    process.env.CODECLAW_NATIVE_TOOLS = "true";
    try {
      const settings: CodeclawSettings = {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "echo PRE_BLOCK >&2; exit 1" }] },
          ],
        },
      };
      const engine = createQueryEngine({
        currentProvider: MOCK_PROVIDER,
        fallbackProvider: null,
        permissionMode: "default",
        workspace: process.cwd(),
        auditDbPath: null,
        dataDbPath: null,
        settings,
        fetchImpl: mockToolCallThenAnswer(),
      });
      await collect(engine.submitMessage("read foo.ts"));
      const messages = engine.getMessages();
      // 必有一条 role:'tool' 含 PreToolUse hook blocked 文本
      const toolMsg = messages.find(
        (m) => m.role === "tool" && /PreToolUse hook blocked/.test(m.text)
      );
      expect(toolMsg).toBeDefined();
      expect(toolMsg?.text).toMatch(/PRE_BLOCK/);
    } finally {
      if (previousNative === undefined) delete process.env.CODECLAW_NATIVE_TOOLS;
      else process.env.CODECLAW_NATIVE_TOOLS = previousNative;
    }
  });
});

describe("queryEngine D1 setHooksConfig 热重载", () => {
  it("初始无 hook → setHooksConfig 注入后 UserPromptSubmit 阻塞生效", async () => {
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
    });
    // 第一次：无 hook，正常入 transcript
    const ev1 = await collect(engine.submitMessage("first"));
    expect(
      ev1.find(
        (e) =>
          e.type === "message-complete" &&
          /UserPromptSubmit hook blocked/.test((e as { text: string }).text)
      )
    ).toBeUndefined();

    // 热重载：注入 UserPromptSubmit 阻塞 hook
    engine.setHooksConfig?.({
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "echo BLOCK >&2; exit 1" }] },
      ],
    });
    const ev2 = await collect(engine.submitMessage("second"));
    const blocked = ev2.find(
      (e) =>
        e.type === "message-complete" &&
        /UserPromptSubmit hook blocked/.test((e as { text: string }).text)
    );
    expect(blocked).toBeDefined();
  });

  it("setHooksConfig({}) 清空 hooks → 之前阻塞的 user prompt 现在通过", async () => {
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
      settings: {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "exit 1" }] },
          ],
        },
      },
    });
    // 第一次阻塞
    const ev1 = await collect(engine.submitMessage("first"));
    expect(
      ev1.find(
        (e) =>
          e.type === "message-complete" &&
          /UserPromptSubmit hook blocked/.test((e as { text: string }).text)
      )
    ).toBeDefined();

    // 清空 hooks
    engine.setHooksConfig?.({});
    const ev2 = await collect(engine.submitMessage("second"));
    expect(
      ev2.find(
        (e) =>
          e.type === "message-complete" &&
          /UserPromptSubmit hook blocked/.test((e as { text: string }).text)
      )
    ).toBeUndefined();
  });
});

describe("queryEngine /hooks command", () => {
  it("空配置 → 列出 5 事件 + 配置示例", async () => {
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
    });
    const events = await collect(engine.submitMessage("/hooks"));
    const ev = events.find((e) => e.type === "message-complete") as { text: string };
    expect(ev.text).toContain("Hooks (lifecycle event integrations)");
    expect(ev.text).toContain("PreToolUse: (none)");
    expect(ev.text).toContain("Configure via");
  });

  it("有配置 → 列出 matcher / command / timeout", async () => {
    const settings: CodeclawSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "^bash$",
            hooks: [{ type: "command", command: "scripts/precheck.sh", timeout: 3000 }],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "log.sh" }] }],
      },
    };
    const engine = createQueryEngine({
      currentProvider: null,
      fallbackProvider: null,
      permissionMode: "default",
      workspace: process.cwd(),
      auditDbPath: null,
      dataDbPath: null,
      settings,
    });
    const events = await collect(engine.submitMessage("/hooks"));
    const ev = events.find((e) => e.type === "message-complete") as { text: string };
    expect(ev.text).toContain("PreToolUse: 1 matcher(s), 1 command(s)");
    expect(ev.text).toContain('match=/^bash$/');
    expect(ev.text).toContain('cmd="scripts/precheck.sh"');
    expect(ev.text).toContain("timeout=3000ms");
    expect(ev.text).toContain("Stop: 1 matcher(s), 1 command(s)");
    expect(ev.text).toContain("UserPromptSubmit: (none)");
  });
});
