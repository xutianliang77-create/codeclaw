/**
 * System Prompt Builder 单测（M1-A）
 *
 * 覆盖：
 *   - 8 段固定结构 + 默认角色
 *   - slash / skill / tool 注入正确
 *   - active skill 内联 prompt
 *   - 用户级 / 项目级 CODECLAW.md 顺序（项目级在后，覆盖优先）
 *   - 缺失 git 不抛错
 *   - agentRole 覆盖默认（subagent path）
 *   - extraSections 注入（M2 hook）
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { buildSystemPrompt } from "../../../src/agent/systemPrompt";
import type { SkillDefinition } from "../../../src/skills/types";
import type { ProviderStatus } from "../../../src/provider/types";

const ORIGINAL_HOME = os.homedir;

let tmpRoot: string;
let tmpHome: string;

beforeEach(() => {
  tmpRoot = path.join(os.tmpdir(), `sp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpHome = path.join(tmpRoot, "home");
  mkdirSync(path.join(tmpHome, ".codeclaw"), { recursive: true });
  mkdirSync(path.join(tmpRoot, "ws"), { recursive: true });
  // hijack homedir 让 loadUserCodeclawMd 默认走 tmp
  (os as unknown as { homedir: () => string }).homedir = () => tmpHome;
});

afterEach(() => {
  (os as unknown as { homedir: () => string }).homedir = ORIGINAL_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const stubSlash = (names: string[]) => ({
  list: () => names.map((n) => ({ name: n, summary: `${n} summary` })),
});

const stubSkills = (names: string[]) => ({
  list: () =>
    names.map((n) => ({
      name: n,
      description: `${n} desc`,
      source: "builtin",
    })),
});

const stubTools = (names: string[]) => ({
  list: () => names.map((n) => ({ name: n, description: `${n} desc` })),
});

describe("buildSystemPrompt", () => {
  it("包含 Role / slash / skills / tools / runtime / cwd / mode", () => {
    const prompt = buildSystemPrompt({
      workspace: path.join(tmpRoot, "ws"),
      permissionMode: "default",
      slashRegistry: stubSlash(["/forget", "/cost"]),
      skillRegistry: stubSkills(["review", "explain"]),
      toolRegistry: stubTools(["read", "bash"]),
      gitSummaryProvider: () => null,
    });
    expect(prompt).toContain("CodeClaw");
    expect(prompt).toContain("## Role");
    expect(prompt).toContain("/forget");
    expect(prompt).toContain("/cost");
    expect(prompt).toContain("review");
    expect(prompt).toContain("explain");
    expect(prompt).toContain("- read");
    expect(prompt).toContain("- bash");
    expect(prompt).toContain(path.join(tmpRoot, "ws"));
    expect(prompt).toContain("Permission mode: default");
  });

  it("merge 用户级 + 项目级 CODECLAW.md（项目级在后）", () => {
    writeFileSync(path.join(tmpHome, ".codeclaw", "CODECLAW.md"), "中文回答");
    writeFileSync(path.join(tmpRoot, "ws", "CODECLAW.md"), "用 pnpm");
    const prompt = buildSystemPrompt({
      workspace: path.join(tmpRoot, "ws"),
      permissionMode: "default",
      gitSummaryProvider: () => null,
    });
    expect(prompt).toContain("中文回答");
    expect(prompt).toContain("用 pnpm");
    expect(prompt.indexOf("用 pnpm")).toBeGreaterThan(prompt.indexOf("中文回答"));
    expect(prompt).toContain("## User Preferences");
    expect(prompt).toContain("## Project Conventions");
  });

  it("activeSkill 内联 prompt", () => {
    const skill: SkillDefinition = {
      name: "review",
      description: "review",
      prompt: "act as reviewer; focus on bugs",
      allowedTools: ["read"],
      source: "builtin",
    };
    const prompt = buildSystemPrompt({
      workspace: path.join(tmpRoot, "ws"),
      permissionMode: "default",
      activeSkill: skill,
      gitSummaryProvider: () => null,
    });
    expect(prompt).toContain("**Active skill**: review");
    expect(prompt).toContain("act as reviewer");
  });

  it("git summary 注入 branch + dirty", () => {
    const prompt = buildSystemPrompt({
      workspace: path.join(tmpRoot, "ws"),
      permissionMode: "default",
      gitSummaryProvider: () => ({ branch: "main", dirty: true }),
    });
    expect(prompt).toContain("Git: branch=main, dirty=true");
  });

  it("git provider 返 null 不抛错且不出现 Git 行", () => {
    const prompt = buildSystemPrompt({
      workspace: path.join(tmpRoot, "ws"),
      permissionMode: "default",
      gitSummaryProvider: () => null,
    });
    expect(prompt).not.toContain("Git:");
  });

  it("agentRole 覆盖默认 codeclaw 角色（subagent）", () => {
    const prompt = buildSystemPrompt({
      workspace: path.join(tmpRoot, "ws"),
      permissionMode: "default",
      agentRole: "你是 reviewer 子 agent，只做评审不做修改。",
      gitSummaryProvider: () => null,
    });
    expect(prompt).toContain("reviewer 子 agent");
    expect(prompt).not.toContain("你是 CodeClaw");
  });

  it("provider 信息注入到 Runtime Context", () => {
    const provider: Partial<ProviderStatus> = {
      type: "lmstudio",
      model: "qwen/qwen3.6-35b-a3b",
    };
    const prompt = buildSystemPrompt({
      workspace: path.join(tmpRoot, "ws"),
      permissionMode: "plan",
      provider: provider as ProviderStatus,
      gitSummaryProvider: () => null,
    });
    expect(prompt).toContain("Active provider: lmstudio (qwen/qwen3.6-35b-a3b)");
    expect(prompt).toContain("Permission mode: plan");
  });

  it("extraSections 注入额外段（M2 / M3 hook）", () => {
    const prompt = buildSystemPrompt({
      workspace: path.join(tmpRoot, "ws"),
      permissionMode: "default",
      extraSections: [{ title: "Memory", body: "user prefers 中文" }],
      gitSummaryProvider: () => null,
    });
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("user prefers 中文");
  });

  it("空 registry 不报错（兼容启动早期阶段）", () => {
    const prompt = buildSystemPrompt({
      workspace: path.join(tmpRoot, "ws"),
      permissionMode: "default",
      gitSummaryProvider: () => null,
    });
    expect(prompt).toContain("## Role");
    expect(prompt).toContain("## Runtime Context");
    expect(prompt).not.toContain("## Available Slash Commands");
    expect(prompt).not.toContain("## Available Tools");
  });
});
