/**
 * builtin 9 个 tool 注册 + invoke 单测（M1-B）
 *
 * 覆盖：
 *   - registerBuiltinTools 注册全 9 个
 *   - 每个 tool 有合法 inputSchema + name + description
 *   - read 通过 runLocalTool 路径执行（基本 round-trip）
 *   - args 类型校验（缺少必填 → invoke 抛错被吞为 ok=false）
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { ToolRegistry } from "../../../../src/agent/tools/registry";
import { BUILTIN_TOOL_NAMES, registerBuiltinTools } from "../../../../src/agent/tools/builtins";
import { PermissionManager } from "../../../../src/permissions/manager";

let workspace: string;

beforeEach(() => {
  workspace = path.join(os.tmpdir(), `bt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const ctx = () => ({
  workspace,
  permissionManager: new PermissionManager("default"),
});

describe("registerBuiltinTools", () => {
  it("注册全 10 个 builtin（含 v0.8.1 read_artifact）", () => {
    const r = new ToolRegistry();
    registerBuiltinTools(r);
    const names = r.list().map((t) => t.name).sort();
    expect(names).toEqual([...BUILTIN_TOOL_NAMES].sort());
    expect(names).toHaveLength(10);
    expect(names).toContain("read_artifact");
  });

  it("每个 tool 都有 inputSchema.type === object 与 required", () => {
    const r = new ToolRegistry();
    registerBuiltinTools(r);
    for (const t of r.list()) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.required && t.inputSchema.required.length > 0).toBe(true);
      expect(t.description.length).toBeGreaterThan(5);
    }
  });

  it("openAiSchemas / anthropicSchemas 数量匹配", () => {
    const r = new ToolRegistry();
    registerBuiltinTools(r);
    expect(r.openAiSchemas()).toHaveLength(10);
    expect(r.anthropicSchemas()).toHaveLength(10);
    const a = r.openAiSchemas()[0];
    expect(a.type).toBe("function");
  });

  it("read tool 通过结构化 args 调用 runLocalTool", async () => {
    writeFileSync(path.join(workspace, "hello.txt"), "hi from file");
    const r = new ToolRegistry();
    registerBuiltinTools(r);
    const result = await r.invoke("read", { file_path: "hello.txt" }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain("hi from file");
  });

  it("read tool 缺 file_path → ok=false", async () => {
    const r = new ToolRegistry();
    registerBuiltinTools(r);
    // missing required field
    const result = await r.invoke("read", {} as unknown, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invoke_failed");
  });
});
