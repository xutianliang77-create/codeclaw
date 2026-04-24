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
  it("loads both pilots into a fresh registry", () => {
    const reg = new SlashRegistry();
    const count = loadBuiltins(reg);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(reg.has("/mode")).toBe(true);
    expect(reg.has("/doctor")).toBe(true);
    expect(reg.has("/diag")).toBe(true);
  });

  it("dispatch /mode via loaded registry", async () => {
    const reg = new SlashRegistry();
    loadBuiltins(reg);
    const { holder } = makeModeHolder("default");
    const out = await reg.dispatch("/mode plan", holder);
    expect(out?.result).toEqual({ kind: "reply", text: "mode set to plan" });
  });
});
