/**
 * Task tool 单测（M3-02 step c）
 */

import { describe, expect, it } from "vitest";

import { registerTaskTool } from "../../../../src/agent/tools/taskTool";
import { createToolRegistry } from "../../../../src/agent/tools/registry";
import { PermissionManager } from "../../../../src/permissions/manager";
import { SubagentRegistry } from "../../../../src/agent/subagents/registry";
import type { ProviderStatus } from "../../../../src/provider/types";

const MOCK_PROVIDER: ProviderStatus = {
  instanceId: "openai:default",
  type: "openai",
  displayName: "openai",
  kind: "cloud",
  enabled: true,
  requiresApiKey: true,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  timeoutMs: 30000,
  apiKey: "test",
  envVars: [],
  fileConfig: { enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", timeoutMs: 30000 },
  configured: true,
  available: true,
  reason: "ok",
};

function mockOpenAi(text: string): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
            )
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      })
    )) as unknown as typeof fetch;
}

const ctx = (): { workspace: string; permissionManager: PermissionManager } => ({
  workspace: process.cwd(),
  permissionManager: new PermissionManager("default"),
});

describe("registerTaskTool", () => {
  it("注册到 registry 后 has + list 含 'Task'", () => {
    const reg = createToolRegistry();
    registerTaskTool(reg, {
      currentProvider: MOCK_PROVIDER,
      fallbackProvider: null,
      workspace: process.cwd(),
    });
    expect(reg.has("Task")).toBe(true);
    expect(reg.list().some((t) => t.name === "Task")).toBe(true);
  });

  it("重复 register 不抛错", () => {
    const reg = createToolRegistry();
    const deps = {
      currentProvider: MOCK_PROVIDER,
      fallbackProvider: null,
      workspace: process.cwd(),
    };
    registerTaskTool(reg, deps);
    expect(() => registerTaskTool(reg, deps)).not.toThrow();
    expect(reg.list().filter((t) => t.name === "Task").length).toBe(1);
  });

  it("Task description 列出所有 8 个 builtin role", () => {
    const reg = createToolRegistry();
    registerTaskTool(reg, {
      currentProvider: MOCK_PROVIDER,
      fallbackProvider: null,
      workspace: process.cwd(),
    });
    const desc = reg.get("Task")?.description ?? "";
    for (const name of [
      "general-purpose",
      "Explore",
      "Plan",
      "code-reviewer",
      "feature-dev",
      "simple-executor",
      "code-simplifier",
      "deep-reviewer",
    ]) {
      expect(desc).toContain(name);
    }
  });

  it("inputSchema 含 role enum + prompt required", () => {
    const reg = createToolRegistry();
    registerTaskTool(reg, {
      currentProvider: MOCK_PROVIDER,
      fallbackProvider: null,
      workspace: process.cwd(),
    });
    const schema = reg.get("Task")?.inputSchema;
    expect(schema?.required).toEqual(["role", "prompt"]);
    const roleProp = (schema?.properties.role as { enum?: string[] }) ?? {};
    expect(roleProp.enum).toContain("Explore");
    expect(roleProp.enum).toContain("general-purpose");
  });
});

describe("Task tool · invoke", () => {
  it("缺 role → invalid_args", async () => {
    const reg = createToolRegistry();
    registerTaskTool(reg, {
      currentProvider: MOCK_PROVIDER,
      fallbackProvider: null,
      workspace: process.cwd(),
    });
    const result = await reg.invoke("Task", { prompt: "hi" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_args");
    expect(result.content).toMatch(/role/);
  });

  it("缺 prompt → invalid_args", async () => {
    const reg = createToolRegistry();
    registerTaskTool(reg, {
      currentProvider: MOCK_PROVIDER,
      fallbackProvider: null,
      workspace: process.cwd(),
    });
    const result = await reg.invoke("Task", { role: "Explore" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_args");
  });

  it("happy path：spawn subagent → 返回 content + 头部含统计", async () => {
    const reg = createToolRegistry();
    registerTaskTool(reg, {
      currentProvider: MOCK_PROVIDER,
      fallbackProvider: null,
      workspace: process.cwd(),
      fetchImpl: mockOpenAi("explore result"),
    });
    const result = await reg.invoke(
      "Task",
      { role: "Explore", prompt: "find files" },
      ctx()
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("[Task Explore]");
    expect(result.content).toContain("explore result");
  });

  it("subagentRegistry 注入时 happy path 写入一条 completed 记录（B.8）", async () => {
    const reg = createToolRegistry();
    const subagents = new SubagentRegistry();
    registerTaskTool(reg, {
      currentProvider: MOCK_PROVIDER,
      fallbackProvider: null,
      workspace: process.cwd(),
      fetchImpl: mockOpenAi("done"),
      subagentRegistry: subagents,
    });
    expect(subagents.size()).toBe(0);
    await reg.invoke("Task", { role: "Explore", prompt: "find" }, ctx());
    expect(subagents.size()).toBe(1);
    const rec = subagents.list()[0];
    expect(rec.role).toBe("Explore");
    expect(rec.status).toBe("completed");
    expect(rec.toolCallCount).toBeGreaterThanOrEqual(0);
  });

  it("subagentRegistry 失败路径写 failed 记录", async () => {
    const reg = createToolRegistry();
    const subagents = new SubagentRegistry();
    registerTaskTool(reg, {
      currentProvider: MOCK_PROVIDER,
      fallbackProvider: null,
      workspace: process.cwd(),
      fetchImpl: mockOpenAi("x"),
      subagentRegistry: subagents,
    });
    // 未知 role：runSubagent 直接 ok=false
    await reg.invoke(
      "Task",
      { role: "definitely-not-a-role", prompt: "stuff" },
      ctx()
    );
    // 注：未知 role 在 runSubagent 内即返 error，registry 仍 start+finish 写一条
    // 但 invalid 'role' 字符串会被 parseArgs 接受，runSubagent 才返 unknown
    expect(subagents.size()).toBe(1);
    expect(subagents.list()[0].status).toBe("failed");
  });

  it("未知 role → subagent_failed errorCode", async () => {
    const reg = createToolRegistry();
    registerTaskTool(reg, {
      currentProvider: MOCK_PROVIDER,
      fallbackProvider: null,
      workspace: process.cwd(),
      fetchImpl: mockOpenAi("x"),
    });
    const result = await reg.invoke(
      "Task",
      { role: "definitely-not-a-role", prompt: "stuff" },
      ctx()
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("subagent_failed");
    expect(result.content).toMatch(/unknown subagent role/);
  });
});
