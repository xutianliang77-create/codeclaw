/**
 * loadSettings / parseSettings 单测（M3-04 step 1）
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSettings, parseSettings } from "../../../src/hooks/settings";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = path.join(os.tmpdir(), `settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("parseSettings", () => {
  it("空 hooks → { hooks: {} }", () => {
    expect(parseSettings(JSON.stringify({}), "x")).toEqual({ hooks: {} });
  });

  it("正常 PreToolUse hook", () => {
    const cfg = parseSettings(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "^bash$",
              hooks: [{ type: "command", command: "echo ok", timeout: 3000 }],
            },
          ],
        },
      }),
      "x"
    );
    expect(cfg.hooks.PreToolUse).toEqual([
      {
        matcher: "^bash$",
        hooks: [{ type: "command", command: "echo ok", timeout: 3000 }],
      },
    ]);
  });

  it("未知事件名静默 skip（向前兼容）", () => {
    const cfg = parseSettings(
      JSON.stringify({
        hooks: {
          UnknownEvent: [{ hooks: [{ type: "command", command: "x" }] }],
          Stop: [{ hooks: [{ type: "command", command: "y" }] }],
        },
      }),
      "x"
    );
    expect((cfg.hooks as Record<string, unknown>).UnknownEvent).toBeUndefined();
    expect(cfg.hooks.Stop?.length).toBe(1);
  });

  it("不带 matcher 也合法", () => {
    const cfg = parseSettings(
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "log.sh" }] }] },
      }),
      "x"
    );
    expect(cfg.hooks.Stop?.[0].matcher).toBeUndefined();
  });

  it("非 JSON → 抛错含 source", () => {
    expect(() => parseSettings("not-json", "/p/x.json")).toThrow(/\/p\/x\.json/);
  });

  it("hooks 字段非 object → 抛错", () => {
    expect(() => parseSettings(JSON.stringify({ hooks: [] }), "x")).toThrow(/hooks must be object/);
  });

  it("PreToolUse 非 array → 抛错", () => {
    expect(() => parseSettings(JSON.stringify({ hooks: { PreToolUse: {} } }), "x")).toThrow(
      /PreToolUse must be array/
    );
  });

  it("hook command type 错误 → 抛错", () => {
    expect(() =>
      parseSettings(
        JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: "shell", command: "x" }] }] },
        }),
        "x"
      )
    ).toThrow(/type must be 'command'/);
  });

  it("hook command.command 缺失 → 抛错", () => {
    expect(() =>
      parseSettings(
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command" }] }] } }),
        "x"
      )
    ).toThrow(/command must be non-empty/);
  });

  it("statusLine 字段被解析", () => {
    const cfg = parseSettings(
      JSON.stringify({ statusLine: { command: "echo hi", intervalMs: 2000 } }),
      "x"
    );
    expect(cfg.statusLine).toEqual({ command: "echo hi", intervalMs: 2000 });
  });
});

describe("loadSettings", () => {
  it("无任何文件 → empty", () => {
    expect(loadSettings(tmpRoot, tmpRoot)).toEqual({ hooks: {} });
  });

  it("项目级 .codeclaw/settings.json 优先", () => {
    mkdirSync(path.join(tmpRoot, ".codeclaw"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, ".codeclaw", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "P" }] }] } })
    );
    // 同时给 home 写一份不该被读到
    writeFileSync(
      path.join(tmpRoot, ".codeclaw", "settings.json"), // 已写过，这是 workspace 级（同 dir）
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "P" }] }] } })
    );
    const s = loadSettings(tmpRoot, tmpRoot);
    expect(s.hooks.Stop?.[0].hooks[0].command).toBe("P");
  });

  it("fallback 到 ~/.claude/settings.json（兼容 Claude Code）", () => {
    mkdirSync(path.join(tmpRoot, ".claude"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "audit" }] }] },
      })
    );
    const s = loadSettings(tmpRoot, tmpRoot);
    expect(s.hooks.UserPromptSubmit?.[0].hooks[0].command).toBe("audit");
  });
});
