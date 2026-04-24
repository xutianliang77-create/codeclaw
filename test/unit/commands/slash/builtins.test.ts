/**
 * Slash builtins 单测 · pilot 命令 (/mode /doctor) 行为验证
 */

import { describe, expect, it } from "vitest";
import modeCommand, { PERMISSION_MODES } from "../../../../src/commands/slash/builtins/mode";
import doctorCommand from "../../../../src/commands/slash/builtins/doctor";
import { SlashRegistry } from "../../../../src/commands/slash/registry";
import { loadBuiltins } from "../../../../src/commands/slash/loader";

function makeModeHolder(initial: string = "default") {
  const calls: string[] = [];
  const holder = {
    permissionMode: initial,
    permissions: {
      setMode(m: string) {
        calls.push(m);
      },
    },
  };
  return { holder, calls };
}

describe("/mode builtin", () => {
  it("no args returns current mode", async () => {
    const { holder } = makeModeHolder("auto");
    const result = await modeCommand.handler({
      rawPrompt: "/mode",
      commandName: "/mode",
      argsRaw: "",
      argv: [],
      queryEngine: holder,
    });
    expect(result).toEqual({ kind: "reply", text: "current mode: auto" });
  });

  it("switches to valid mode and calls permissions.setMode", async () => {
    const { holder, calls } = makeModeHolder("default");
    const result = await modeCommand.handler({
      rawPrompt: "/mode plan",
      commandName: "/mode",
      argsRaw: "plan",
      argv: ["plan"],
      queryEngine: holder,
    });
    expect(result).toEqual({ kind: "reply", text: "mode set to plan" });
    expect(holder.permissionMode).toBe("plan");
    expect(calls).toEqual(["plan"]);
  });

  it("rejects unknown mode", async () => {
    const { holder } = makeModeHolder("default");
    const result = await modeCommand.handler({
      rawPrompt: "/mode wildcard",
      commandName: "/mode",
      argsRaw: "wildcard",
      argv: ["wildcard"],
      queryEngine: holder,
    });
    if (result.kind !== "reply") throw new Error("expected reply");
    expect(result.text).toContain("unknown mode: wildcard");
    expect(result.text).toContain("available:");
    expect(holder.permissionMode).toBe("default"); // unchanged
  });

  it("gracefully degrades when queryEngine is not a holder", async () => {
    const result = await modeCommand.handler({
      rawPrompt: "/mode",
      commandName: "/mode",
      argsRaw: "",
      argv: [],
      queryEngine: null,
    });
    if (result.kind !== "reply") throw new Error("expected reply");
    expect(result.text).toContain("mode command unavailable");
  });

  it("PERMISSION_MODES exports the canonical 6 modes", () => {
    expect(PERMISSION_MODES).toEqual([
      "default",
      "plan",
      "auto",
      "acceptEdits",
      "bypassPermissions",
      "dontAsk",
    ]);
  });
});

describe("/doctor builtin", () => {
  it("returns a non-empty reply (runDoctor is invoked)", async () => {
    const result = await doctorCommand.handler({
      rawPrompt: "/doctor",
      commandName: "/doctor",
      argsRaw: "",
      argv: [],
      queryEngine: null,
    });
    if (result.kind !== "reply") throw new Error("expected reply");
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("has /diag alias", () => {
    expect(doctorCommand.aliases).toContain("/diag");
  });
});

describe("loadBuiltins", () => {
  it("loads all batch-1+2+3 commands into a fresh registry", () => {
    const reg = new SlashRegistry();
    const count = loadBuiltins(reg);
    expect(count).toBeGreaterThanOrEqual(15);
    for (const name of [
      "/mode",
      "/doctor",
      "/diag",
      "/status",
      "/resume",
      "/session",
      "/providers",
      "/approvals",
      "/context",
      "/memory",
      "/diff",
      "/skills",
      "/hooks",
      "/init",
      "/compact",
      "/model",
    ]) {
      expect(reg.has(name)).toBe(true);
    }
  });

  it("dispatch /mode via loaded registry", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const { holder } = makeModeHolder("default");
    const out = await reg.dispatch("/mode plan", holder);
    expect(out?.result).toEqual({ kind: "reply", text: "mode set to plan" });
  });
});

describe("delegating builtins · duck-type pattern", () => {
  /** 一个 holder 同时实现 batch-1+2 所有 build*Reply */
  const holder = {
    buildStatusReply: () => "STATUS_REPLY_OK",
    buildResumeReply: () => "RESUME_REPLY_OK",
    buildSessionReply: () => "SESSION_REPLY_OK",
    buildProvidersReply: () => "PROVIDERS_REPLY_OK",
    buildApprovalsReply: () => "APPROVALS_REPLY_OK",
    buildContextReply: () => "CONTEXT_REPLY_OK",
    buildMemoryReply: () => "MEMORY_REPLY_OK",
    buildDiffReply: () => "DIFF_REPLY_OK",
    buildSkillsReply: (prompt: string) => `SKILLS_REPLY_OK:${prompt}`,
    buildHooksReply: () => "HOOKS_REPLY_OK",
    buildInitReply: () => "INIT_REPLY_OK",
  };

  it.each([
    ["/status", "STATUS_REPLY_OK"],
    ["/resume", "RESUME_REPLY_OK"],
    ["/session", "SESSION_REPLY_OK"],
    ["/providers", "PROVIDERS_REPLY_OK"],
    ["/approvals", "APPROVALS_REPLY_OK"],
    ["/context", "CONTEXT_REPLY_OK"],
    ["/memory", "MEMORY_REPLY_OK"],
    ["/diff", "DIFF_REPLY_OK"],
    ["/hooks", "HOOKS_REPLY_OK"],
    ["/init", "INIT_REPLY_OK"],
  ])("dispatch %s returns delegated reply", async (cmd, expected) => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const out = await reg.dispatch(cmd, holder);
    expect(out?.result).toEqual({ kind: "reply", text: expected });
  });

  it("/skills passes the raw prompt through (so 'list/activate/off' parsing works)", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const out = await reg.dispatch("/skills my-skill", holder);
    expect(out?.result).toEqual({
      kind: "reply",
      text: "SKILLS_REPLY_OK:/skills my-skill",
    });
  });

  it("/compact and /model both forward rawPrompt to handle*Command", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const compactHolder = {
      handleCompactCommand: (p: string) => `COMPACT:${p}`,
      handleModelCommand: (p: string) => `MODEL:${p}`,
    };
    const c = await reg.dispatch("/compact 50", compactHolder);
    expect(c?.result).toEqual({ kind: "reply", text: "COMPACT:/compact 50" });
    const m = await reg.dispatch("/model gpt-4.1", compactHolder);
    expect(m?.result).toEqual({ kind: "reply", text: "MODEL:/model gpt-4.1" });
  });

  it("each delegated command degrades gracefully when holder lacks the method", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const empty = {};
    const cmds = [
      "/status",
      "/resume",
      "/session",
      "/providers",
      "/approvals",
      "/context",
      "/memory",
      "/diff",
      "/skills",
      "/hooks",
      "/init",
      "/compact",
      "/model",
    ];
    for (const cmd of cmds) {
      const out = await reg.dispatch(cmd, empty);
      if (out?.result.kind !== "reply") throw new Error("expected reply");
      expect(out.result.text).toContain("unavailable");
    }
  });
});
