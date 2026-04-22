import type { PermissionMode } from "../lib/config";

export type ToolRiskLevel = "low" | "medium" | "high";

export type ToolPermissionInput =
  | {
      tool: "read";
      target: string;
    }
  | {
      tool: "glob";
      target: string;
    }
  | {
      tool: "symbol" | "definition" | "references";
      target: string;
    }
  | {
      tool: "write" | "append";
      target: string;
    }
  | {
      tool: "replace";
      target: string;
    }
  | {
      tool: "bash";
      command: string;
    }
  | {
      tool: "mcp-read";
      server: string;
      resource: string;
    }
  | {
      tool: "mcp-call";
      server: string;
      toolName: string;
    };

export interface PermissionDecision {
  behavior: "allow" | "ask" | "deny";
  risk: ToolRiskLevel;
  reason: string;
}

const SAFE_BASH_PREFIXES = [
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "find",
  "rg",
  "grep",
  "git status",
  "git diff"
] as const;

const DANGEROUS_BASH_PATTERNS = [
  /\brm\b/,
  /\bsudo\b/,
  /\bmv\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bgit reset\b/,
  /\bgit checkout --\b/,
  />>?/,
  /\|\|?/,
  /&&/,
  /;/,
  /\btee\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\breboot\b/,
  /\bshutdown\b/
];

function classifyBashCommand(command: string): ToolRiskLevel {
  const normalized = command.trim();

  if (!normalized) {
    return "high";
  }

  if (DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "high";
  }

  if (SAFE_BASH_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `))) {
    return "low";
  }

  return "medium";
}

export class PermissionManager {
  constructor(private mode: PermissionMode) {}

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  evaluate(input: ToolPermissionInput): PermissionDecision {
    const risk =
      input.tool === "read" ||
      input.tool === "glob" ||
      input.tool === "symbol" ||
      input.tool === "definition" ||
      input.tool === "references" ||
      input.tool === "mcp-read"
        ? "low"
        : input.tool === "bash"
          ? classifyBashCommand(input.command)
          : "medium";

    if (this.mode === "bypassPermissions" || this.mode === "dontAsk") {
      return {
        behavior: "allow",
        risk,
        reason: `permission mode ${this.mode} allows ${input.tool}`
      };
    }

    if (this.mode === "auto" || this.mode === "acceptEdits") {
      if (risk === "high") {
        return {
          behavior: "deny",
          risk,
          reason: `permission mode ${this.mode} blocks high-risk ${input.tool}`
        };
      }

      return {
        behavior: "allow",
        risk,
        reason: `permission mode ${this.mode} allows ${risk}-risk ${input.tool}`
      };
    }

    if (risk === "low") {
      return {
        behavior: "allow",
        risk,
        reason: `permission mode ${this.mode} allows low-risk ${input.tool}`
      };
    }

    return {
      behavior: "ask",
      risk,
      reason: `permission mode ${this.mode} requires approval for ${risk}-risk ${input.tool}`
    };
  }
}
