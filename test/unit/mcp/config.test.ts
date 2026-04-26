/**
 * loadMcpConfig / parseMcpConfig 单测（M3-01 step b）
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadMcpConfig, parseMcpConfig } from "../../../src/mcp/config";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = path.join(os.tmpdir(), `mcp-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("parseMcpConfig", () => {
  it("空 servers → { servers: {} }", () => {
    expect(parseMcpConfig(JSON.stringify({ servers: {} }), "x")).toEqual({ servers: {} });
  });

  it("无 servers 键 → 空", () => {
    expect(parseMcpConfig("{}", "x")).toEqual({ servers: {} });
  });

  it("正常配置 → 字段提取", () => {
    const cfg = parseMcpConfig(
      JSON.stringify({
        servers: {
          fs: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { TOKEN: "abc" },
            cwd: "/data",
            disabled: false,
          },
        },
      }),
      "x"
    );
    expect(cfg.servers.fs).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { TOKEN: "abc" },
      cwd: "/data",
      disabled: false,
    });
  });

  it("非 JSON → 抛错含 source", () => {
    expect(() => parseMcpConfig("not-json", "/path/x.json")).toThrow(/\/path\/x\.json/);
  });

  it("根非 object → 抛错", () => {
    expect(() => parseMcpConfig("[]", "x")).toThrow(/root must be object/);
  });

  it("servers 非 object → 抛错", () => {
    expect(() => parseMcpConfig(JSON.stringify({ servers: [] }), "x")).toThrow(/servers' must be object/);
  });

  it("server.command 缺失 → 抛错", () => {
    expect(() => parseMcpConfig(JSON.stringify({ servers: { x: { args: [] } } }), "x")).toThrow(
      /servers\.x\.command/
    );
  });

  it("server.args 非 array → 抛错", () => {
    expect(() =>
      parseMcpConfig(JSON.stringify({ servers: { x: { command: "ls", args: "no" } } }), "x")
    ).toThrow(/args must be array/);
  });

  it("env 非 object → 抛错", () => {
    expect(() =>
      parseMcpConfig(JSON.stringify({ servers: { x: { command: "ls", env: "no" } } }), "x")
    ).toThrow(/env must be object/);
  });
});

describe("loadMcpConfig", () => {
  it("找不到任何配置 → 空", () => {
    expect(loadMcpConfig(tmpRoot, tmpRoot)).toEqual({ servers: {} });
  });

  it("项目级 .mcp.json 命中", () => {
    writeFileSync(
      path.join(tmpRoot, ".mcp.json"),
      JSON.stringify({ servers: { p: { command: "echo", args: ["proj"] } } })
    );
    const cfg = loadMcpConfig(tmpRoot, tmpRoot);
    expect(cfg.servers.p.command).toBe("echo");
    expect(cfg.servers.p.args).toEqual(["proj"]);
  });

  it("用户级 ~/.codeclaw/mcp.json 命中（无项目级时）", () => {
    mkdirSync(path.join(tmpRoot, ".codeclaw"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, ".codeclaw", "mcp.json"),
      JSON.stringify({ servers: { u: { command: "echo", args: ["user"] } } })
    );
    const cfg = loadMcpConfig(tmpRoot, tmpRoot);
    expect(cfg.servers.u.args).toEqual(["user"]);
  });

  it("项目级 + 用户级 同存在 → 项目级覆盖（不合并）", () => {
    writeFileSync(
      path.join(tmpRoot, ".mcp.json"),
      JSON.stringify({ servers: { p: { command: "proj-cmd" } } })
    );
    mkdirSync(path.join(tmpRoot, ".codeclaw"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, ".codeclaw", "mcp.json"),
      JSON.stringify({ servers: { u: { command: "user-cmd" } } })
    );
    const cfg = loadMcpConfig(tmpRoot, tmpRoot);
    expect(cfg.servers.p?.command).toBe("proj-cmd");
    expect(cfg.servers.u).toBeUndefined();
  });
});
