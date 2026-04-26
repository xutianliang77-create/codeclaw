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
import { execSync } from "node:child_process";
import type { PermissionMode } from "../lib/config";
import type { ProviderStatus } from "../provider/types";
import type { SkillDefinition } from "../skills/types";
import { loadProjectCodeclawMd, loadUserCodeclawMd } from "./codeclawMd";
import { loadAllMemoriesCached, type MemoryEntry } from "../memory/projectMemory/store";

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
  /** 注入额外段（M3-04 status line 之类） */
  extraSections?: Array<{ title: string; body: string }>;
  /** git summary 探测覆盖（测试用） */
  gitSummaryProvider?: (cwd: string) => GitSummary | null;
  /** M2-02：memory 提供方覆盖（测试用；不传走 loadAllMemoriesCached(workspace)） */
  memoryProvider?: (workspace: string) => MemoryEntry[];
  /** M2-02：禁用 Project Memory 段（测试 / 启动早期 / privacy 选项；默认 false 即启用） */
  disableMemorySection?: boolean;
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

  // 通用：title + body 双 push；body 为空跳过
  function addSection(title: string, body: string | undefined | null): void {
    if (!body) return;
    sections.push(`## ${title}`);
    sections.push(body);
  }

  // 通用：list-source 渲染成 "- a — b" 列表段，空列表跳过
  function addListSection<T>(
    title: string,
    items: T[] | null | undefined,
    formatLine: (item: T) => string
  ): void {
    if (!items || items.length === 0) return;
    addSection(title, items.map(formatLine).join("\n"));
  }

  addSection("Role", input.agentRole ?? DEFAULT_ROLE);
  addSection("User Preferences", loadUserCodeclawMd());
  addSection("Project Conventions", loadProjectCodeclawMd(input.workspace));

  addListSection(
    "Available Slash Commands",
    input.slashRegistry?.list(),
    (c) => `- ${c.name}  — ${c.summary ?? c.description ?? "(no description)"}`
  );

  addListSection(
    "Available Skills",
    input.skillRegistry?.list(),
    (s) => {
      const tag = s.source === "builtin" ? "[builtin]" : "[user]";
      return `- ${tag} ${s.name}  — ${s.description ?? ""}`;
    }
  );
  if (input.activeSkill) {
    sections.push(`**Active skill**: ${input.activeSkill.name}\n${input.activeSkill.prompt}`);
  }

  addListSection(
    "Available Tools",
    input.toolRegistry?.list(),
    (t) => `- ${t.name}  — ${t.description}`
  );

  // Runtime Context：固定字段 + git 探测（gitSummaryProvider 可被测试覆盖）
  const ctxLines: string[] = [
    `- Working directory: ${input.workspace}`,
    `- Permission mode: ${input.permissionMode}`,
  ];
  if (input.provider) {
    ctxLines.push(`- Active provider: ${input.provider.type} (${input.provider.model})`);
  }
  const git = (input.gitSummaryProvider ?? tryGitSummary)(input.workspace);
  if (git) {
    ctxLines.push(`- Git: branch=${git.branch}, dirty=${git.dirty}`);
  }
  addSection("Runtime Context", ctxLines.join("\n"));

  // M2-02：第 9 段 Project Memory —— 列 entry 索引（每条 1 行 hook，不展开 body）；
  // LLM 用 read tool 读 ~/.codeclaw/projects/<hash>/memory/<name>.md 取全文；
  // 用 memory_write tool 落新条目
  if (!input.disableMemorySection) {
    const memoryFn = input.memoryProvider ?? loadAllMemoriesCached;
    let memories: MemoryEntry[] = [];
    try {
      memories = memoryFn(input.workspace);
    } catch {
      memories = []; // 读失败不阻塞 prompt 构造
    }
    if (memories.length > 0) {
      const lines = memories.map((m) => `- **${m.name}** (${m.type}): ${m.description}`);
      lines.push(
        "\n_To read full content of a memory, use the `read` tool with " +
        "`~/.codeclaw/projects/<hash>/memory/<name>.md`. " +
        "To save new memory, call `memory_write`._"
      );
      addSection("Project Memory", lines.join("\n"));
    }
  }

  // M3 hook：调用方注入额外段（如 status line）
  if (input.extraSections) {
    for (const ex of input.extraSections) {
      if (!ex.body.trim()) continue;
      addSection(ex.title, ex.body);
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
