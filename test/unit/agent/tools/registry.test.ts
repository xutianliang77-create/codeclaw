/**
 * ToolRegistry 单测（M1-B）
 *
 * 覆盖：
 *   - register / get / has / list / unregister
 *   - 重名抛错
 *   - openAiSchemas / anthropicSchemas 格式正确
 *   - invoke 路由到 tool；未知 tool 返错；tool 抛错被吞为错误结果
 *   - list 按 name 排序
 */

import { describe, expect, it } from "vitest";
import {
  ToolRegistry,
  createToolRegistry,
  type ToolDefinition,
  type ToolInvokeContext,
} from "../../../../src/agent/tools/registry";
import { PermissionManager } from "../../../../src/permissions/manager";

const dummySchema = {
  type: "object" as const,
  properties: { x: { type: "string" } },
  required: ["x"],
};

const tool = (name: string, fn?: ToolDefinition["invoke"]): ToolDefinition => ({
  name,
  description: `${name} desc`,
  inputSchema: dummySchema,
  invoke:
    fn ??
    (async (args) => ({
      ok: true,
      content: `${name}(${JSON.stringify(args)})`,
    })),
});

const ctx = (): ToolInvokeContext => ({
  workspace: "/tmp",
  permissionManager: new PermissionManager("default"),
});

describe("ToolRegistry", () => {
  it("register / get / has / list", () => {
    const r = new ToolRegistry();
    r.register(tool("read"));
    r.register(tool("bash"));
    expect(r.has("read")).toBe(true);
    expect(r.has("missing")).toBe(false);
    expect(r.get("read")?.name).toBe("read");
    expect(r.list().map((t) => t.name)).toEqual(["bash", "read"]); // sorted
  });

  it("unregister 返 boolean", () => {
    const r = new ToolRegistry();
    r.register(tool("bash"));
    expect(r.unregister("bash")).toBe(true);
    expect(r.unregister("bash")).toBe(false);
    expect(r.has("bash")).toBe(false);
  });

  it("重名抛错", () => {
    const r = new ToolRegistry();
    r.register(tool("read"));
    expect(() => r.register(tool("read"))).toThrow(/already registered/);
  });

  it("openAiSchemas 格式：type:function + function.{name,description,parameters}", () => {
    const r = new ToolRegistry();
    r.register(tool("read"));
    const s = r.openAiSchemas();
    expect(s).toHaveLength(1);
    expect(s[0].type).toBe("function");
    expect(s[0].function.name).toBe("read");
    expect(s[0].function.parameters).toEqual(dummySchema);
  });

  it("anthropicSchemas 格式：{name,description,input_schema}", () => {
    const r = new ToolRegistry();
    r.register(tool("read"));
    const s = r.anthropicSchemas();
    expect(s[0].name).toBe("read");
    expect(s[0].input_schema).toEqual(dummySchema);
  });

  it("invoke 路由到对应 tool", async () => {
    const r = new ToolRegistry();
    r.register(tool("read"));
    const result = await r.invoke("read", { x: "hi" }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain('"x":"hi"');
  });

  it("invoke 未知 tool → ok=false", async () => {
    const r = new ToolRegistry();
    const result = await r.invoke("nope", {}, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("unknown_tool");
    expect(result.content).toContain("unknown tool");
  });

  it("invoke tool 抛错 → ok=false（不向上抛）", async () => {
    const r = new ToolRegistry();
    r.register(
      tool("explode", async () => {
        throw new Error("boom");
      })
    );
    const result = await r.invoke("explode", {}, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invoke_failed");
    expect(result.content).toContain("boom");
  });

  it("createToolRegistry 工厂返空注册表", () => {
    const r = createToolRegistry();
    expect(r.list()).toEqual([]);
  });
});
