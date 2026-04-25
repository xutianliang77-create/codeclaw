/**
 * SkillRegistry 单测 · #71
 *
 * 覆盖：
 *   - createSkillRegistry()：仅 builtin
 *   - createSkillRegistryFromDisk()：合并 builtin + user
 *   - get(name)：builtin 优先；不区分大小写
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

import { createSkillRegistry, createSkillRegistryFromDisk, SkillRegistry } from "../../../src/skills/registry";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function mkDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "codeclaw-skills-reg-"));
  tempDirs.push(d);
  return d;
}

function writeSkill(skillsDir: string, sub: string, manifest: Record<string, unknown>): void {
  const dir = path.join(skillsDir, sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest));
}

describe("createSkillRegistry · 仅 builtin", () => {
  it("list() 返 review/explain/patch", () => {
    const reg = createSkillRegistry();
    const names = reg.list().map((s) => s.name).sort();
    expect(names).toEqual(["explain", "patch", "review"]);
  });

  it("get 用大小写不敏感", () => {
    const reg = createSkillRegistry();
    expect(reg.get("REVIEW")?.name).toBe("review");
    expect(reg.get("  Patch  ")?.name).toBe("patch");
  });

  it("get 不存在 → null", () => {
    expect(createSkillRegistry().get("nonexistent")).toBeNull();
  });
});

describe("createSkillRegistryFromDisk · 合并 user", () => {
  it("空目录 → 仅 builtin", () => {
    const dir = mkDir();
    const reg = createSkillRegistryFromDisk({ skillsDir: dir });
    expect(reg.list()).toHaveLength(3);
    expect(reg.getLoadErrors()).toEqual([]);
  });

  it("有 1 个 user skill → list 含 4 项 builtin first", () => {
    const dir = mkDir();
    writeSkill(dir, "lint-fix", {
      name: "lint-fix",
      description: "auto fix",
      prompt: "fix lint",
      allowedTools: ["read", "write", "bash"],
    });
    const reg = createSkillRegistryFromDisk({ skillsDir: dir });
    const list = reg.list();
    expect(list).toHaveLength(4);
    // builtin 先
    expect(list.slice(0, 3).every((s) => s.source === "builtin")).toBe(true);
    expect(list[3].name).toBe("lint-fix");
    expect(list[3].source).toBe("user");
  });

  it("user skill 与 builtin 重名 → 被 loader 拒，registry 不含", () => {
    const dir = mkDir();
    writeSkill(dir, "review", {
      name: "review",
      description: "fake",
      prompt: "fake",
      allowedTools: ["read"],
    });
    const reg = createSkillRegistryFromDisk({ skillsDir: dir });
    expect(reg.list()).toHaveLength(3); // 仅 builtin
    expect(reg.getLoadErrors().length).toBe(1);
  });

  it("get builtin 名仍优先 builtin（即便 user dir 含同名 — 已被 loader 拒）", () => {
    const dir = mkDir();
    writeSkill(dir, "lint-fix", {
      name: "lint-fix",
      description: "user one",
      prompt: "user prompt",
      allowedTools: ["read"],
    });
    const reg = createSkillRegistryFromDisk({ skillsDir: dir });
    expect(reg.get("review")?.source).toBe("builtin");
    expect(reg.get("lint-fix")?.source).toBe("user");
  });
});

describe("SkillRegistry 直接构造", () => {
  it("接 userSkills 注入", () => {
    const reg = new SkillRegistry({
      userSkills: [
        {
          name: "test-skill",
          description: "t",
          prompt: "p",
          allowedTools: ["read"],
          source: "user",
        },
      ],
    });
    expect(reg.list()).toHaveLength(4); // 3 builtin + 1
    expect(reg.get("test-skill")?.name).toBe("test-skill");
  });
});
