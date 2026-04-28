/**
 * Plan mode 双阶段单测（M2-03）
 *
 * 覆盖：
 *   - registerPlanModeTool 注册 ExitPlanMode
 *   - ExitPlanMode invoke 成功 → ok=true、content 含 sentinel + plan
 *   - ExitPlanMode 缺 plan / plan 为空 → ok=false
 *   - ToolRegistry.listForMode("plan") 仅暴露 read-only + memory_write + ExitPlanMode
 *   - ToolRegistry.listForMode("default") 全量
 *   - listForMode 接受自定义 allowed 集合（用户扩展场景）
 */

import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../../../src/agent/tools/registry";
import { registerBuiltinTools } from "../../../../src/agent/tools/builtins";
import { registerMemoryTools } from "../../../../src/agent/tools/memoryTools";
import { EXIT_PLAN_SENTINEL, registerPlanModeTool } from "../../../../src/agent/tools/planMode";
import { PermissionManager } from "../../../../src/permissions/manager";

const ctx = () => ({ workspace: "/tmp", permissionManager: new PermissionManager("plan") });

describe("registerPlanModeTool", () => {
  it("注册 ExitPlanMode tool（required: plan）", () => {
    const r = new ToolRegistry();
    registerPlanModeTool(r);
    const ep = r.get("ExitPlanMode");
    expect(ep).toBeDefined();
    expect(ep!.inputSchema.required).toEqual(["plan"]);
  });

  it("invoke 含合法 plan → ok=true、content 以 sentinel 起头", async () => {
    const r = new ToolRegistry();
    registerPlanModeTool(r);
    const result = await r.invoke(
      "ExitPlanMode",
      { plan: "1. Read X\n2. Modify Y\n3. Run tests" },
      ctx()
    );
    expect(result.ok).toBe(true);
    expect(result.content.startsWith(EXIT_PLAN_SENTINEL)).toBe(true);
    expect(result.content).toContain("Read X");
    expect(result.content).toContain("Run tests");
  });

  it("invoke 缺 plan → ok=false", async () => {
    const r = new ToolRegistry();
    registerPlanModeTool(r);
    const result = await r.invoke("ExitPlanMode", {}, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_args");
  });

  it("invoke plan 为空字符串 → ok=false", async () => {
    const r = new ToolRegistry();
    registerPlanModeTool(r);
    const result = await r.invoke("ExitPlanMode", { plan: "   " }, ctx());
    expect(result.ok).toBe(false);
  });
});

describe("ToolRegistry.listForMode", () => {
  it("default mode → 全量", () => {
    const r = new ToolRegistry();
    registerBuiltinTools(r);
    registerMemoryTools(r);
    registerPlanModeTool(r);
    const all = r.listForMode("default");
    const names = all.map((t) => t.name).sort();
    expect(names).toContain("bash");
    expect(names).toContain("write");
    expect(names).toContain("ExitPlanMode");
    expect(all.length).toBe(13); // 10 builtin (含 read_artifact) + 2 memory + 1 plan
  });

  it("plan mode → 仅 read-only + memory_write + ExitPlanMode", () => {
    const r = new ToolRegistry();
    registerBuiltinTools(r);
    registerMemoryTools(r);
    registerPlanModeTool(r);
    const planTools = r.listForMode("plan");
    const names = planTools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ExitPlanMode",
      "definition",
      "glob",
      "memory_write",
      "read",
      "read_artifact",
      "references",
      "symbol",
    ]);
    expect(names).not.toContain("bash");
    expect(names).not.toContain("write");
    expect(names).not.toContain("append");
    expect(names).not.toContain("replace");
    expect(names).not.toContain("memory_remove");
  });

  it("自定义 allowed 集合", () => {
    const r = new ToolRegistry();
    registerBuiltinTools(r);
    const allowed = new Set(["read", "glob"]);
    const filtered = r.listForMode("plan", allowed);
    expect(filtered.map((t) => t.name).sort()).toEqual(["glob", "read"]);
  });

  it("auto / acceptEdits / dontAsk / bypassPermissions → 全量（非 plan）", () => {
    const r = new ToolRegistry();
    registerBuiltinTools(r);
    for (const mode of ["auto", "acceptEdits", "dontAsk", "bypassPermissions"]) {
      const tools = r.listForMode(mode);
      expect(tools.length).toBe(10);
    }
  });
});
