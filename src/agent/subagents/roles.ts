/**
 * Subagent builtin roles（M3-02 step a）
 *
 * 8 个内置 role 参考 Claude Code 内嵌 subagent 习惯。每个 role 限定：
 *   - 工具集（allowedTools；undefined = 全集）
 *   - 启动 permission mode
 *   - 可选 instructions：在子 engine system prompt 之外再附加给 LLM 的 role 指引
 *
 * 不变量：
 *   - role 名 ASCII 安全（[a-zA-Z0-9_-]），可作为 LLM 调用参数
 *   - allowedTools 名严格匹配 ToolRegistry.list().name；未登记的工具会自动忽略
 *   - readonly 类 role 用 plan mode + read/glob/symbol/definition/references 五件套
 */

import type { PermissionMode } from "../../commands/slash/builtins/mode";

export interface SubagentRole {
  name: string;
  description: string;
  /** 子 agent 能用的 tool 名集合；undefined = 全集（含父 engine 的 mcp__* 桥接） */
  allowedTools?: ReadonlyArray<string>;
  /** 子 agent 启动时的 permission mode；默认 "default" */
  permissionMode?: PermissionMode;
  /** 调用子 agent 时附加给 user prompt 头部的 role 指令；可省 */
  instructions?: string;
}

const READ_ONLY_TOOLS: ReadonlyArray<string> = [
  "read",
  "glob",
  "symbol",
  "definition",
  "references",
];

const READ_ONLY_PLUS_BASH: ReadonlyArray<string> = [...READ_ONLY_TOOLS, "bash"];

const EDIT_TOOLS: ReadonlyArray<string> = ["read", "write", "append", "replace", "bash"];

export const BUILTIN_ROLES: Readonly<Record<string, SubagentRole>> = Object.freeze({
  "general-purpose": {
    name: "general-purpose",
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
    permissionMode: "default",
    // allowedTools 不限：完整工具集
  },
  Explore: {
    name: "Explore",
    description:
      "Fast agent specialized for exploring codebases. Find files, search code, answer questions about the codebase. Read-only.",
    allowedTools: READ_ONLY_TOOLS,
    permissionMode: "plan",
    instructions:
      "You are a read-only explorer. Do not propose edits or write files. Return findings as a concise summary with file:line references.",
  },
  Plan: {
    name: "Plan",
    description:
      "Software architect agent for designing implementation plans. Returns step-by-step plans, identifies critical files, considers trade-offs.",
    allowedTools: [...READ_ONLY_TOOLS, "ExitPlanMode"] as const,
    permissionMode: "plan",
    instructions:
      "You produce a precise implementation plan. End with calling ExitPlanMode tool to submit the plan.",
  },
  "code-reviewer": {
    name: "code-reviewer",
    description:
      "Reviews code for bugs, security issues, code quality, and adherence to project conventions. Read-only.",
    allowedTools: READ_ONLY_TOOLS,
    permissionMode: "plan",
    instructions:
      "Provide a high-signal code review. Cite file:line for each finding. Do not propose edits, only describe issues and risks.",
  },
  "feature-dev": {
    name: "feature-dev",
    description:
      "Designs feature architectures by analyzing existing patterns and providing implementation blueprints with files to create/modify.",
    permissionMode: "default",
    instructions:
      "Analyze codebase first, then propose architecture. May edit files when permission allows.",
  },
  "simple-executor": {
    name: "simple-executor",
    description:
      "Executes well-scoped, low-risk local modifications. Renames, mechanical edits, doc/comment updates.",
    allowedTools: EDIT_TOOLS,
    permissionMode: "acceptEdits",
    instructions:
      "Make minimal, surgical edits scoped to the request. Do not refactor or expand scope.",
  },
  "code-simplifier": {
    name: "code-simplifier",
    description:
      "Simplifies and refines code for clarity, consistency, and maintainability while preserving all functionality.",
    allowedTools: ["read", "append", "replace"] as const,
    permissionMode: "default",
    instructions:
      "Improve readability without changing behavior. Preserve all observable functionality. Cite file:line for each change.",
  },
  "deep-reviewer": {
    name: "deep-reviewer",
    description:
      "High-value, deep judgment review for complex tasks. Detailed design review, root cause analysis, cross-module risk assessment.",
    allowedTools: READ_ONLY_PLUS_BASH,
    permissionMode: "plan",
    instructions:
      "Conduct a deep, careful review. Trace data flow, identify edge cases, surface hidden risks. Cite evidence by file:line.",
  },
});

export function getRole(name: string): SubagentRole | undefined {
  return BUILTIN_ROLES[name];
}

export function listRoleNames(): string[] {
  return Object.keys(BUILTIN_ROLES);
}
