/**
 * P0-W1-13 · doctor 输出扩展单测
 *
 * 覆盖（结构性断言，不依赖具体版本号）：
 *   - 保留原有段（CodeClaw <version>/default-provider/providers）
 *   - 新增 storage / runtime / libs 段
 *   - data.db / audit.db 不存在时显示 "not yet initialized"
 *   - tokenFile 配置时，若文件不存在显示 "(not created)"
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runDoctor } from "../../../src/commands/doctor";
import {
  createDefaultConfig,
  createDefaultProvidersFile,
  writeConfig,
  writeProvidersFile,
  type ConfigPaths,
} from "../../../src/lib/config";
import { VERSION } from "../../../src/version";

let tmpHome: string;
let originalHome: string | undefined;

function sandboxConfigPaths(configDir: string): ConfigPaths {
  return {
    configDir,
    configFile: path.join(configDir, "config.yaml"),
    providersFile: path.join(configDir, "providers.json"),
    sessionsDir: path.join(configDir, "sessions"),
    approvalsDir: path.join(configDir, "approvals"),
    logsDir: path.join(configDir, "logs"),
  };
}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "codeclaw-doctor-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome; // 让 resolveConfigPaths(homedir()) 打到 tmp
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("runDoctor", () => {
  it("preserves legacy sections: CodeClaw <version>, default-provider, providers", async () => {
    const paths = sandboxConfigPaths(path.join(tmpHome, ".codeclaw"));
    await writeConfig(createDefaultConfig(), paths);
    await writeProvidersFile(createDefaultProvidersFile(), paths);

    const out = await runDoctor();
    expect(out).toContain(`CodeClaw ${VERSION}`);
    expect(out).toContain("default-provider:");
    expect(out).toContain("providers:");
  });

  it("includes storage section referring to data.db / audit.db", async () => {
    const paths = sandboxConfigPaths(path.join(tmpHome, ".codeclaw"));
    await writeConfig(createDefaultConfig(), paths);
    await writeProvidersFile(createDefaultProvidersFile(), paths);

    const out = await runDoctor();
    expect(out).toContain("storage:");
    expect(out).toContain("data.db");
    expect(out).toContain("audit.db");
    expect(out).toContain("not yet initialized");
  });

  it("includes runtime probes (at minimum node)", async () => {
    const paths = sandboxConfigPaths(path.join(tmpHome, ".codeclaw"));
    await writeConfig(createDefaultConfig(), paths);
    await writeProvidersFile(createDefaultProvidersFile(), paths);

    const out = await runDoctor();
    expect(out).toContain("runtime:");
    expect(out).toMatch(/- node: v\d+\.\d+\.\d+/);
  });

  it("includes libs section listing core deps", async () => {
    const paths = sandboxConfigPaths(path.join(tmpHome, ".codeclaw"));
    await writeConfig(createDefaultConfig(), paths);
    await writeProvidersFile(createDefaultProvidersFile(), paths);

    const out = await runDoctor();
    expect(out).toContain("libs:");
    expect(out).toContain("better-sqlite3");
    expect(out).toContain("ulid");
    expect(out).toContain("@noble/hashes");
    expect(out).toContain("pino");
  });

  it("reports tokenFile path hint when default is in config but file missing", async () => {
    const paths = sandboxConfigPaths(path.join(tmpHome, ".codeclaw"));
    await writeConfig(createDefaultConfig(), paths);
    await writeProvidersFile(createDefaultProvidersFile(), paths);

    const out = await runDoctor();
    // 默认 config 含 tokenFile=~/.codeclaw/wechat-ibot/default.json；文件未创建
    expect(out).toContain("tokenFile:");
    expect(out).toContain("not created");
  });
});

describe("buildSuggestions · #91", () => {
  it("hasConfig=false → 提示 codeclaw setup", async () => {
    const { buildSuggestions } = await import("../../../src/commands/doctor");
    const r = buildSuggestions({
      hasConfig: false,
      defaultProvider: null,
      providersAvailable: 0,
      providersConfigured: 0,
      hasPython: true,
      auditChainOk: { skipped: true } as never,
    });
    expect(r.some((s) => s.includes("codeclaw setup"))).toBe(true);
  });

  it("有 config 但 0 provider configured → 提示 codeclaw config", async () => {
    const { buildSuggestions } = await import("../../../src/commands/doctor");
    const r = buildSuggestions({
      hasConfig: true,
      defaultProvider: "openai",
      providersAvailable: 0,
      providersConfigured: 0,
      hasPython: true,
      auditChainOk: { skipped: true } as never,
    });
    expect(r.some((s) => s.includes("codeclaw config"))).toBe(true);
  });

  it("provider 全 unavailable → 给常见修复建议", async () => {
    const { buildSuggestions } = await import("../../../src/commands/doctor");
    const r = buildSuggestions({
      hasConfig: true,
      defaultProvider: "lmstudio",
      providersAvailable: 0,
      providersConfigured: 2,
      hasPython: true,
      auditChainOk: { skipped: true } as never,
    });
    expect(r.some((s) => /LM Studio|Ollama|API key|baseUrl/.test(s))).toBe(true);
  });

  it("python 未装 → 提示 setup:lsp 可选项", async () => {
    const { buildSuggestions } = await import("../../../src/commands/doctor");
    const r = buildSuggestions({
      hasConfig: true,
      defaultProvider: "openai",
      providersAvailable: 1,
      providersConfigured: 1,
      hasPython: false,
      auditChainOk: { skipped: true } as never,
    });
    expect(r.some((s) => s.includes("setup:lsp"))).toBe(true);
  });

  it("audit chain BROKEN → 提示 backup + forget --all", async () => {
    const { buildSuggestions } = await import("../../../src/commands/doctor");
    const r = buildSuggestions({
      hasConfig: true,
      defaultProvider: "openai",
      providersAvailable: 1,
      providersConfigured: 1,
      hasPython: true,
      auditChainOk: { ok: false } as never,
    });
    expect(r.some((s) => /BROKEN|backup|forget/.test(s))).toBe(true);
  });

  it("一切正常 → 空建议", async () => {
    const { buildSuggestions } = await import("../../../src/commands/doctor");
    const r = buildSuggestions({
      hasConfig: true,
      defaultProvider: "openai",
      providersAvailable: 1,
      providersConfigured: 1,
      hasPython: true,
      auditChainOk: { ok: true, checked: 0, durationMs: 0 } as never,
    });
    expect(r).toEqual([]);
  });
});
