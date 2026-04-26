/**
 * Subagent roles 单测（M3-02 step a）
 */

import { describe, expect, it } from "vitest";

import { getRole, listRoleNames } from "../../../../src/agent/subagents/roles";

describe("BUILTIN_ROLES", () => {
  it("含 8 个 role", () => {
    expect(listRoleNames().sort()).toEqual([
      "Explore",
      "Plan",
      "code-reviewer",
      "code-simplifier",
      "deep-reviewer",
      "feature-dev",
      "general-purpose",
      "simple-executor",
    ]);
  });

  it("getRole 按名查找", () => {
    expect(getRole("Explore")?.permissionMode).toBe("plan");
    expect(getRole("simple-executor")?.permissionMode).toBe("acceptEdits");
    expect(getRole("missing")).toBeUndefined();
  });

  it("read-only role allowedTools 不含写工具", () => {
    const writeTools = new Set(["write", "append", "replace", "bash"]);
    for (const name of ["Explore", "code-reviewer"]) {
      const role = getRole(name);
      expect(role?.allowedTools).toBeDefined();
      for (const t of role!.allowedTools!) {
        // bash 在 deep-reviewer 例外，但这两个 role 不应有 bash/write
        expect(writeTools.has(t)).toBe(false);
      }
    }
  });

  it("simple-executor 允许 bash + write", () => {
    const tools = new Set(getRole("simple-executor")?.allowedTools ?? []);
    expect(tools.has("write")).toBe(true);
    expect(tools.has("bash")).toBe(true);
  });

  it("Plan role 含 ExitPlanMode 工具", () => {
    expect(getRole("Plan")?.allowedTools).toContain("ExitPlanMode");
  });

  it("general-purpose 不限 allowedTools (undefined = 全集)", () => {
    expect(getRole("general-purpose")?.allowedTools).toBeUndefined();
  });

  it("role name 字符集 ASCII 安全（可作 LLM 调用参数）", () => {
    for (const name of listRoleNames()) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});
