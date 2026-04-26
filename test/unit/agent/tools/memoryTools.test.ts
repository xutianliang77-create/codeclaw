/**
 * memory_write / memory_remove tool 单测（M2-02）
 *
 * 覆盖：
 *   - registerMemoryTools 注册 2 个 tool（schema 合法）
 *   - memory_write 成功调用 → ok=true、文件落盘
 *   - memory_write 缺 required arg → ok=false、不抛
 *   - memory_remove 命中 → ok=true；未命中 → ok=false
 *   - 调用 args 转发：args type=feedback 传到 store
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { ToolRegistry } from "../../../../src/agent/tools/registry";
import {
  MEMORY_TOOL_NAMES,
  registerMemoryTools,
} from "../../../../src/agent/tools/memoryTools";
import { _clearMemoryCacheForTest, loadAllMemories } from "../../../../src/memory/projectMemory/store";
import { PermissionManager } from "../../../../src/permissions/manager";

let tmpHome: string;
let workspace: string;

beforeEach(() => {
  tmpHome = path.join(os.tmpdir(), `mt-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.HOME = tmpHome;
  (os as unknown as { homedir: () => string }).homedir = () => tmpHome;
  workspace = path.join(tmpHome, "ws");
  mkdirSync(workspace, { recursive: true });
  _clearMemoryCacheForTest();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const ctx = () => ({
  workspace,
  permissionManager: new PermissionManager("default"),
});

describe("registerMemoryTools", () => {
  it("注册 2 个 tool（memory_write / memory_remove）", () => {
    const r = new ToolRegistry();
    registerMemoryTools(r);
    const names = r.list().map((t) => t.name).sort();
    expect(names).toEqual([...MEMORY_TOOL_NAMES].sort());
  });

  it("schema 合法：memory_write 有 4 个 required fields", () => {
    const r = new ToolRegistry();
    registerMemoryTools(r);
    const wm = r.get("memory_write")!;
    expect(wm.inputSchema.required?.sort()).toEqual(["body", "description", "name", "type"]);
  });
});

describe("memory_write", () => {
  it("成功写入 → ok=true、loadAllMemories 看到", async () => {
    const r = new ToolRegistry();
    registerMemoryTools(r);
    const result = await r.invoke(
      "memory_write",
      {
        name: "user_pref",
        description: "user prefers TypeScript",
        type: "user",
        body: "User has stated they prefer TypeScript over JavaScript.",
      },
      ctx()
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Saved memory: user_pref");
    const all = loadAllMemories(workspace);
    expect(all.length).toBe(1);
    expect(all[0].body).toContain("TypeScript");
  });

  it("缺 body field → ok=false 不抛", async () => {
    const r = new ToolRegistry();
    registerMemoryTools(r);
    const result = await r.invoke(
      "memory_write",
      { name: "x", description: "x", type: "user" },
      ctx()
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("must be strings");
  });

  it("type 为 feedback 正确转发", async () => {
    const r = new ToolRegistry();
    registerMemoryTools(r);
    await r.invoke(
      "memory_write",
      { name: "rule1", description: "test", type: "feedback", body: "always use pnpm" },
      ctx()
    );
    const all = loadAllMemories(workspace);
    expect(all[0].type).toBe("feedback");
  });

  it("type 缺省 → 默认 project", async () => {
    const r = new ToolRegistry();
    registerMemoryTools(r);
    await r.invoke(
      "memory_write",
      { name: "fact", description: "x", body: "test fact" },
      ctx()
    );
    const all = loadAllMemories(workspace);
    expect(all[0].type).toBe("project");
  });
});

describe("memory_remove", () => {
  it("命中 → ok=true、文件被删", async () => {
    const r = new ToolRegistry();
    registerMemoryTools(r);
    await r.invoke("memory_write", { name: "to_del", description: "x", type: "user", body: "x" }, ctx());
    expect(loadAllMemories(workspace).length).toBe(1);
    const result = await r.invoke("memory_remove", { name: "to_del" }, ctx());
    expect(result.ok).toBe(true);
    expect(loadAllMemories(workspace).length).toBe(0);
  });

  it("未命中 → ok=false", async () => {
    const r = new ToolRegistry();
    registerMemoryTools(r);
    const result = await r.invoke("memory_remove", { name: "ghost" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not found");
  });

  it("name 缺失 → ok=false", async () => {
    const r = new ToolRegistry();
    registerMemoryTools(r);
    const result = await r.invoke("memory_remove", {}, ctx());
    expect(result.ok).toBe(false);
  });
});
