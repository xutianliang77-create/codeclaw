/**
 * bridgeMcpTools / unbridgeMcpTools 单测（M3-01 step c）
 */

import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";

import { bridgeMcpTools, unbridgeMcpTools } from "../../../src/mcp/bridge";
import { McpManager } from "../../../src/mcp/manager";
import { createToolRegistry } from "../../../src/agent/tools/registry";
import { PermissionManager } from "../../../src/permissions/manager";

const FAKE_SERVER = path.resolve(__dirname, "../../fixtures/mcp-fake-server.cjs");
const managers: McpManager[] = [];

function newManager(): McpManager {
  const m = new McpManager();
  managers.push(m);
  return m;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.closeAll().catch(() => undefined)));
});

describe("bridgeMcpTools", () => {
  it("把 fake server 的 4 个 tool 注册成 mcp__<server>__<tool>", async () => {
    const mgr = newManager();
    await mgr.start({ servers: { srv1: { command: "node", args: [FAKE_SERVER] } } });

    const reg = createToolRegistry();
    const report = bridgeMcpTools(mgr, reg);

    expect(report.skipped).toEqual([]);
    expect(report.registered.sort()).toEqual([
      "mcp__srv1__crash",
      "mcp__srv1__echo",
      "mcp__srv1__never-respond",
      "mcp__srv1__raise",
    ]);
    expect(reg.list()).toHaveLength(4);
  });

  it("透传 inputSchema（type=object + properties + required）", async () => {
    const mgr = newManager();
    await mgr.start({ servers: { x: { command: "node", args: [FAKE_SERVER] } } });

    const reg = createToolRegistry();
    bridgeMcpTools(mgr, reg);

    const echo = reg.get("mcp__x__echo");
    expect(echo?.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });

  it("inputSchema 缺失 → 降级为 {type:object, properties:{}}", async () => {
    const mgr = newManager();
    await mgr.start({ servers: { x: { command: "node", args: [FAKE_SERVER] } } });

    const reg = createToolRegistry();
    bridgeMcpTools(mgr, reg);
    const crash = reg.get("mcp__x__crash"); // fake server crash tool 没有 inputSchema
    expect(crash?.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("invoke 转发到 manager.callTool (echo happy path)", async () => {
    const mgr = newManager();
    await mgr.start({ servers: { srv1: { command: "node", args: [FAKE_SERVER] } } });

    const reg = createToolRegistry();
    bridgeMcpTools(mgr, reg);

    const result = await reg.invoke(
      "mcp__srv1__echo",
      { text: "bridge ok" },
      { workspace: "/tmp", permissionManager: new PermissionManager("default") }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toBe("bridge ok");
  });

  it("invoke 在 mcp 工具返回 isError=true 时正确传播", async () => {
    const mgr = newManager();
    await mgr.start({ servers: { srv1: { command: "node", args: [FAKE_SERVER] } } });
    const reg = createToolRegistry();
    bridgeMcpTools(mgr, reg);

    // raise tool 直接走 JSON-RPC error → bridge 捕获成 mcp_invoke_failed
    const result = await reg.invoke(
      "mcp__srv1__raise",
      {},
      { workspace: "/tmp", permissionManager: new PermissionManager("default") }
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("mcp_invoke_failed");
    expect(result.content).toMatch(/deliberate failure/);
  });

  it("server name / tool name 含特殊字符 → sanitize 后注册", async () => {
    const mgr = newManager();
    await mgr.start({
      servers: {
        "weird name with spaces": { command: "node", args: [FAKE_SERVER] },
      },
    });
    const reg = createToolRegistry();
    bridgeMcpTools(mgr, reg);
    const names = reg.list().map((t) => t.name);
    expect(names.every((n) => /^[a-zA-Z0-9_-]+$/.test(n))).toBe(true);
    expect(names.some((n) => n.startsWith("mcp__weird_name_with_spaces__"))).toBe(true);
  });

  it("已存在同名 tool → skipped", async () => {
    const mgr = newManager();
    await mgr.start({ servers: { srv1: { command: "node", args: [FAKE_SERVER] } } });

    const reg = createToolRegistry();
    bridgeMcpTools(mgr, reg);
    const second = bridgeMcpTools(mgr, reg);
    expect(second.registered).toEqual([]);
    expect(second.skipped.length).toBe(4);
    expect(second.skipped[0].reason).toBe("already registered");
  });

  it("空 manager（无 ready server）→ 空 report", () => {
    const mgr = newManager();
    const reg = createToolRegistry();
    const report = bridgeMcpTools(mgr, reg);
    expect(report.registered).toEqual([]);
    expect(report.skipped).toEqual([]);
  });
});

describe("unbridgeMcpTools", () => {
  it("摘掉所有 mcp__ 前缀 tool 不影响 builtin", async () => {
    const mgr = newManager();
    await mgr.start({ servers: { srv1: { command: "node", args: [FAKE_SERVER] } } });

    const reg = createToolRegistry();
    // 模拟 builtin 工具
    reg.register({
      name: "read",
      description: "fake builtin",
      inputSchema: { type: "object", properties: {} },
      async invoke() {
        return { ok: true, content: "" };
      },
    });
    bridgeMcpTools(mgr, reg);

    expect(reg.list()).toHaveLength(5);
    const removed = unbridgeMcpTools(reg);
    expect(removed).toBe(4);
    expect(reg.list().map((t) => t.name)).toEqual(["read"]);
  });

  it("自定义 namespace 隔离", async () => {
    const mgr = newManager();
    await mgr.start({ servers: { srv1: { command: "node", args: [FAKE_SERVER] } } });

    const reg = createToolRegistry();
    bridgeMcpTools(mgr, reg, { namespace: "ext" });
    expect(reg.list()[0].name.startsWith("ext__")).toBe(true);
    // 用 default namespace unbridge 应该 0
    expect(unbridgeMcpTools(reg, "mcp")).toBe(0);
    expect(unbridgeMcpTools(reg, "ext")).toBe(4);
  });
});
