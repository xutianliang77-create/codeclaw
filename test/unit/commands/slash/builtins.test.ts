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
  it("loads all batch-1..4 commands into a fresh registry", () => {
    const reg = new SlashRegistry();
    const count = loadBuiltins(reg);
    expect(count).toBeGreaterThanOrEqual(21);
    for (const name of [
      // batch 1+2+3
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
      // batch 4
      "/summary",
      "/export",
      "/reload-plugins",
      "/debug-tool-call",
      "/mcp",
      "/wechat",
      // workflow + help + new commands
      "/help",
      "/plan",
      "/review",
      "/orchestrate",
      "/cost",
      "/commit",
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

  it("/plan delegates to runPlanCommand and forwards rawPrompt", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const planHolder = {
      runPlanCommand: (p: string) => `PLAN_OUT:${p}`,
    };
    const out = await reg.dispatch("/plan refactor auth", planHolder);
    expect(out?.result).toEqual({
      kind: "reply",
      text: "PLAN_OUT:/plan refactor auth",
    });
  });

  it("/plan degrades when runPlanCommand missing", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const out = await reg.dispatch("/plan goal", {});
    if (out?.result.kind !== "reply") throw new Error("expected reply");
    expect(out.result.text).toContain("unavailable");
  });

  it("/review delegates to runReviewCommand (async)", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const holder = {
      runReviewCommand: async (p: string) => `REVIEW:${p}`,
    };
    const out = await reg.dispatch("/review src/api", holder);
    expect(out?.result).toEqual({ kind: "reply", text: "REVIEW:/review src/api" });
  });

  it("/orchestrate delegates to runOrchestrateCommand (async)", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const holder = {
      runOrchestrateCommand: async (p: string) => `ORCH:${p}`,
    };
    const out = await reg.dispatch("/orchestrate add tests", holder);
    expect(out?.result).toEqual({ kind: "reply", text: "ORCH:/orchestrate add tests" });
  });

  it("/cost delegates to runCostCommand", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const out = await reg.dispatch("/cost", {
      runCostCommand: () => "COST_SNAPSHOT_OK",
    });
    expect(out?.result).toEqual({ kind: "reply", text: "COST_SNAPSHOT_OK" });
  });

  it("/cost degrades when runCostCommand missing", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const out = await reg.dispatch("/cost", {});
    if (out?.result.kind !== "reply") throw new Error("expected reply");
    expect(out.result.text).toContain("unavailable");
  });

  it("/review and /orchestrate degrade when method missing", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    for (const cmd of ["/review goal", "/orchestrate goal"]) {
      const out = await reg.dispatch(cmd, {});
      if (out?.result.kind !== "reply") throw new Error("expected reply");
      expect(out.result.text).toContain("unavailable");
    }
  });

  it("/help dispatches to registry.generateHelp via getSlashRegistry()", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const helpHolder = { getSlashRegistry: () => reg };
    const out = await reg.dispatch("/help", helpHolder);
    if (out?.result.kind !== "reply") throw new Error("expected reply");
    expect(out.result.text).toContain("Available commands");
    expect(out.result.text).toContain("/help");
    expect(out.result.text).toContain("/status");
  });

  it("/help degrades when getSlashRegistry missing", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const out = await reg.dispatch("/help", {});
    if (out?.result.kind !== "reply") throw new Error("expected reply");
    expect(out.result.text).toContain("unavailable");
  });

  it("async batch-4 commands resolve via Promise<string>", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const asyncHolder = {
      buildSummaryReply: () => "SUMMARY",
      handleExportCommand: async (p: string) => `EXPORT:${p}`,
      buildReloadPluginsReply: () => "RELOAD",
      buildDebugToolCallReply: (p: string) => `DEBUG:${p}`,
      handleMcpCommand: async (p: string) => `MCP:${p}`,
      handleWechatCommand: async (p: string) => `WECHAT:${p}`,
    };
    expect((await reg.dispatch("/summary", asyncHolder))?.result).toEqual({
      kind: "reply",
      text: "SUMMARY",
    });
    expect((await reg.dispatch("/export to.txt", asyncHolder))?.result).toEqual({
      kind: "reply",
      text: "EXPORT:/export to.txt",
    });
    expect((await reg.dispatch("/reload-plugins", asyncHolder))?.result).toEqual({
      kind: "reply",
      text: "RELOAD",
    });
    expect((await reg.dispatch("/debug-tool-call read", asyncHolder))?.result).toEqual({
      kind: "reply",
      text: "DEBUG:/debug-tool-call read",
    });
    expect((await reg.dispatch("/mcp servers", asyncHolder))?.result).toEqual({
      kind: "reply",
      text: "MCP:/mcp servers",
    });
    expect((await reg.dispatch("/wechat status", asyncHolder))?.result).toEqual({
      kind: "reply",
      text: "WECHAT:/wechat status",
    });
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
