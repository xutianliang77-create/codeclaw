/**
 * Skill SDK · registry · #71
 *
 * 合并 builtin skills + user skills（来自 ~/.codeclaw/skills/）：
 *   - get(name) 优先 builtin（防 user manifest 覆盖；loader 也已拒重名）
 *   - list() 返合并集合：builtin 先，user 后
 *   - createSkillRegistryFromDisk() 同步从默认 skills dir 加载
 *
 * 不变量：
 *   - SkillDefinition.source 反映来源（builtin / user / signed）
 *   - 加载错误不阻塞启动；调用方可读 loadErrors 决定 doctor / log 显示
 */

import type { SkillDefinition } from "./types";
import { defaultUserSkillsDir, loadUserSkillsFromDir, type LoadResult } from "./loader";

// 旧调用方仍从 registry 拿 SkillDefinition；保持向后兼容
export type { SkillDefinition, SkillManifest, SkillSource, SkillSignature } from "./types";

const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    name: "review",
    description: "Bug-focused code review with read-only investigation.",
    prompt:
      "Act in review mode. Focus on bugs, regressions, risks, and missing validation. Prefer concrete evidence from files, symbols, references, and safe verification commands before concluding.",
    allowedTools: ["read", "glob", "symbol", "definition", "references", "bash"],
    source: "builtin",
  },
  {
    name: "explain",
    description: "Codebase explanation and architecture walkthrough mode.",
    prompt:
      "Act in explanation mode. Prioritize clarity, file references, symbol navigation, and concise mental models over editing. Only inspect and explain unless the user later changes the skill.",
    allowedTools: ["read", "glob", "symbol", "definition", "references"],
    source: "builtin",
  },
  {
    name: "patch",
    description: "Guided patching mode with edit-capable tools.",
    prompt:
      "Act in patch mode. Inspect first, then propose or execute the smallest targeted code edits needed to satisfy the request. Keep changes surgical and validate with safe commands when available.",
    allowedTools: ["read", "glob", "symbol", "definition", "references", "bash", "write", "append", "replace"],
    source: "builtin",
  },
];

const BUILTIN_NAMES = new Set(BUILTIN_SKILLS.map((s) => s.name));

export class SkillRegistry {
  private readonly userSkills: SkillDefinition[];
  private readonly loadErrors: LoadResult["errors"];

  constructor(opts: { userSkills?: SkillDefinition[]; loadErrors?: LoadResult["errors"] } = {}) {
    this.userSkills = opts.userSkills ?? [];
    this.loadErrors = opts.loadErrors ?? [];
  }

  list(): SkillDefinition[] {
    return [...BUILTIN_SKILLS, ...this.userSkills];
  }

  /** name 不区分大小写；builtin 优先 */
  get(name: string): SkillDefinition | null {
    const normalizedName = name.trim().toLowerCase();
    const builtin = BUILTIN_SKILLS.find((s) => s.name === normalizedName);
    if (builtin) return builtin;
    return this.userSkills.find((s) => s.name === normalizedName) ?? null;
  }

  getLoadErrors(): LoadResult["errors"] {
    return this.loadErrors;
  }
}

/** 同步构造：仅 builtin（向后兼容） */
export function createSkillRegistry(): SkillRegistry {
  return new SkillRegistry();
}

/** 同步构造：扫盘 ~/.codeclaw/skills 加载 user skills */
export function createSkillRegistryFromDisk(opts: { skillsDir?: string } = {}): SkillRegistry {
  const dir = opts.skillsDir ?? defaultUserSkillsDir();
  const result = loadUserSkillsFromDir(dir, BUILTIN_NAMES);
  return new SkillRegistry({
    userSkills: result.skills,
    loadErrors: result.errors,
  });
}
