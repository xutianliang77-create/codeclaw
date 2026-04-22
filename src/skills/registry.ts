import type { LocalToolName } from "../tools/local";

export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  allowedTools: LocalToolName[];
  source: "builtin";
}

const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    name: "review",
    description: "Bug-focused code review with read-only investigation.",
    prompt:
      "Act in review mode. Focus on bugs, regressions, risks, and missing validation. Prefer concrete evidence from files, symbols, references, and safe verification commands before concluding.",
    allowedTools: ["read", "glob", "symbol", "definition", "references", "bash"],
    source: "builtin"
  },
  {
    name: "explain",
    description: "Codebase explanation and architecture walkthrough mode.",
    prompt:
      "Act in explanation mode. Prioritize clarity, file references, symbol navigation, and concise mental models over editing. Only inspect and explain unless the user later changes the skill.",
    allowedTools: ["read", "glob", "symbol", "definition", "references"],
    source: "builtin"
  },
  {
    name: "patch",
    description: "Guided patching mode with edit-capable tools.",
    prompt:
      "Act in patch mode. Inspect first, then propose or execute the smallest targeted code edits needed to satisfy the request. Keep changes surgical and validate with safe commands when available.",
    allowedTools: ["read", "glob", "symbol", "definition", "references", "bash", "write", "append", "replace"],
    source: "builtin"
  }
];

export class SkillRegistry {
  list(): SkillDefinition[] {
    return [...BUILTIN_SKILLS];
  }

  get(name: string): SkillDefinition | null {
    const normalizedName = name.trim().toLowerCase();
    return this.list().find((skill) => skill.name === normalizedName) ?? null;
  }
}

export function createSkillRegistry(): SkillRegistry {
  return new SkillRegistry();
}

