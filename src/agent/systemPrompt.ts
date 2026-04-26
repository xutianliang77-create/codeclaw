/**
 * System Prompt Builder（M1-A）
 *
 * 每次 LLM 调用前重构造（不缓存）。8 段固定结构：
 *   1. Role             角色定义（默认 codeclaw / subagent override）
 *   2. User Preferences ~/.codeclaw/CODECLAW.md
 *   3. Project Conventions <workspace>/CODECLAW.md
 *   4. Available Slash Commands
 *   5. Available Skills（含 active skill 的 prompt 内联）
 *   6. Available Tools  仅 name + 一句 description；详细 schema 走 native tool_use
 *   7. Runtime Context  cwd / permission mode / provider
 *   8. Git              branch + dirty（best effort，失败略过）
 *
 * 给 M2-02 留 hook：sections.push("## Memory") 在第 9 段；agentRole 给 M3-02 subagent。
 */
/* eslint-disable security/detect-child-process */

import { execSync } from "node:child_process";
import type { PermissionMode } from "../lib/config";
import type { ProviderStatus } from "../provider/types";
import type { SkillDefinition } from "../skills/types";
import { loadProjectCodeclawMd, loadUserCodeclawMd } from "./codeclawMd";

/** 结构化最小依赖：M1-B 后 ToolRegistry 类会实现这个接口，M1 测试用 stub */
export interface ToolListSource {
  list(): Array<{ name: string; description: string }>;
}

export interface SlashListSource {
  list(): Array<{ name: string; summary?: string; description?: string }>;
}

export interface SkillListSource {
  list(): Array<{ name: string; description?: string; source?: string }>;
}

export interface SystemPromptInput {
  workspace: string;
  permissionMode: PermissionMode;
  provider?: ProviderStatus | null;
  slashRegistry?: SlashListSource;
  skillRegistry?: SkillListSource;
  toolRegistry?: ToolListSource;
  activeSkill?: SkillDefinition | null;
  /** 子 agent 模式时传入，覆盖默认 codeclaw 角色（M3 用） */
  agentRole?: string;
  /** 注入额外段（M2-02 memory / M3-04 status line 之类） */
  extraSections?: Array<{ title: string; body: string }>;
  /** git summary 探测覆盖（测试用） */
  gitSummaryProvider?: (cwd: string) => GitSummary | null;
}

export interface GitSummary {
  branch: string;
  dirty: boolean;
}

const DEFAULT_ROLE = `你是 CodeClaw —— 一个本地优先的 CLI 编程助手。
你以"工具 + 推理"协作方式帮用户完成编程任务，工具调用必须用 native tool_use 协议（不要在文字里描述要调什么工具）。
你严格遵守用户在 CODECLAW.md 中的约定（项目级优先于用户级）。`;

export function buildSystemPrompt(input: SystemPromptInput): string {
  const sections: string[] = [];

  sections.push("## Role");
  sections.push(input.agentRole ?? DEFAULT_ROLE);

  const userMd = loadUserCodeclawMd();
  if (userMd) {
    sections.push("## User Preferences");
    sections.push(userMd);
  }

  const projectMd = loadProjectCodeclawMd(input.workspace);
  if (projectMd) {
    sections.push("## Project Conventions");
    sections.push(projectMd);
  }

  if (input.slashRegistry) {
    const cmds = input.slashRegistry.list();
    if (cmds.length > 0) {
      sections.push("## Available Slash Commands");
      sections.push(
        cmds
          .map((c) => `- ${c.name}  — ${c.summary ?? c.description ?? "(no description)"}`)
          .join("\n")
      );
    }
  }

  if (input.skillRegistry) {
    const skills = input.skillRegistry.list();
    if (skills.length > 0) {
      sections.push("## Available Skills");
      const lines = skills.map((s) => {
        const tag = s.source === "builtin" ? "[builtin]" : "[user]";
        return `- ${tag} ${s.name}  — ${s.description ?? ""}`;
      });
      sections.push(lines.join("\n"));
    }
  }
  if (input.activeSkill) {
    sections.push(`**Active skill**: ${input.activeSkill.name}\n${input.activeSkill.prompt}`);
  }

  if (input.toolRegistry) {
    const tools = input.toolRegistry.list();
    if (tools.length > 0) {
      sections.push("## Available Tools");
      sections.push(
        tools.map((t) => `- ${t.name}  — ${t.description}`).join("\n")
      );
    }
  }

  const ctxLines: string[] = [];
  ctxLines.push(`- Working directory: ${input.workspace}`);
  ctxLines.push(`- Permission mode: ${input.permissionMode}`);
  if (input.provider) {
    ctxLines.push(`- Active provider: ${input.provider.type} (${input.provider.model})`);
  }
  const gitProvider = input.gitSummaryProvider ?? tryGitSummary;
  const git = gitProvider(input.workspace);
  if (git) {
    ctxLines.push(`- Git: branch=${git.branch}, dirty=${git.dirty}`);
  }
  sections.push("## Runtime Context");
  sections.push(ctxLines.join("\n"));

  if (input.extraSections) {
    for (const ex of input.extraSections) {
      if (!ex.body.trim()) continue;
      sections.push(`## ${ex.title}`);
      sections.push(ex.body);
    }
  }

  return sections.join("\n\n");
}

export function tryGitSummary(cwd: string): GitSummary | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execSync("git status --porcelain", {
      cwd,
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { branch, dirty: status.trim().length > 0 };
  } catch {
    return null;
  }
}
