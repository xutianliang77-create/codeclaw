/**
 * Skill loader 单测 · #71
 *
 * 覆盖：
 *   - loadUserSkillsFromDir：目录不存在 / 空目录 / 多个 manifest / 部分坏 manifest
 *   - validateManifest：name 格式 / builtin 重名 / 必填缺 / allowedTools 白名单 / signature 完整性
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

import { loadUserSkillsFromDir, validateManifest, defaultUserSkillsDir } from "../../../src/skills/loader";

const tempDirs: string[] = [];
const BUILTIN = new Set(["review", "explain", "patch"]);

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function mkSkillsDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-skills-"));
  tempDirs.push(dir);
  return dir;
}

function writeManifest(skillsDir: string, name: string, manifest: unknown): string {
  const sub = path.join(skillsDir, name);
  mkdirSync(sub, { recursive: true });
  const p = path.join(sub, "manifest.yaml");
  writeFileSync(p, yaml.dump(manifest));
  return p;
}

describe("defaultUserSkillsDir", () => {
  it("指向 ~/.codeclaw/skills", () => {
    const d = defaultUserSkillsDir();
    expect(d.endsWith(path.join(".codeclaw", "skills"))).toBe(true);
  });
});

describe("loadUserSkillsFromDir", () => {
  it("目录不存在 → 空结果（不抛）", () => {
    const r = loadUserSkillsFromDir(path.join(os.tmpdir(), "nonexistent-" + Math.random()), BUILTIN);
    expect(r.skills).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("空目录 → 0 skills 0 errors", () => {
    const dir = mkSkillsDir();
    const r = loadUserSkillsFromDir(dir, BUILTIN);
    expect(r.skills).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("有效 manifest → skill 解析成功，source=user", () => {
    const dir = mkSkillsDir();
    writeManifest(dir, "lint-fix", {
      name: "lint-fix",
      description: "Auto-fix lint errors with safe edits.",
      prompt: "Run lint and fix issues with surgical edits.",
      allowedTools: ["read", "write", "bash"],
      version: 1,
      author: "alice",
    });
    const r = loadUserSkillsFromDir(dir, BUILTIN);
    expect(r.errors).toEqual([]);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].name).toBe("lint-fix");
    expect(r.skills[0].source).toBe("user");
    expect(r.skills[0].allowedTools).toEqual(["read", "write", "bash"]);
    expect(r.skills[0].manifestPath).toContain("manifest.yaml");
  });

  it("有 signature 字段 → source=signed", () => {
    const dir = mkSkillsDir();
    writeManifest(dir, "secure-review", {
      name: "secure-review",
      description: "Signed skill demo.",
      prompt: "Review for security issues.",
      allowedTools: ["read", "glob"],
      signature: { algo: "ed25519", publicKey: "AAAA", value: "BBBB" },
    });
    const r = loadUserSkillsFromDir(dir, BUILTIN);
    expect(r.errors).toEqual([]);
    expect(r.skills[0].source).toBe("signed");
    expect(r.skills[0].signature?.algo).toBe("ed25519");
  });

  it("manifest yaml 损坏 → 收到 errors，其他正常 skill 不受影响", () => {
    const dir = mkSkillsDir();
    // 1) 坏的
    const sub = path.join(dir, "bad");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "manifest.yaml"), "name: 'unterminated\nvalue:");
    // 2) 好的
    writeManifest(dir, "good", {
      name: "good",
      description: "ok",
      prompt: "hello",
      allowedTools: ["read"],
    });
    const r = loadUserSkillsFromDir(dir, BUILTIN);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].name).toBe("good");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0].reason).toMatch(/yaml|read|valid/i);
  });

  it("和 builtin 重名 → 拒绝 + 记 error", () => {
    const dir = mkSkillsDir();
    writeManifest(dir, "review", {
      name: "review",
      description: "fake",
      prompt: "fake",
      allowedTools: ["read"],
    });
    const r = loadUserSkillsFromDir(dir, BUILTIN);
    expect(r.skills).toEqual([]);
    expect(r.errors[0].reason).toMatch(/builtin/i);
  });

  it("无 manifest.yaml 的子目录 → 跳过（不报错）", () => {
    const dir = mkSkillsDir();
    mkdirSync(path.join(dir, "skeleton"), { recursive: true });
    const r = loadUserSkillsFromDir(dir, BUILTIN);
    expect(r.skills).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("两个不同目录给同一 name → 第二个被拒，first wins", () => {
    const dir = mkSkillsDir();
    writeManifest(dir, "alpha", {
      name: "shared",
      description: "first",
      prompt: "p1",
      allowedTools: ["read"],
    });
    writeManifest(dir, "beta", {
      name: "shared",
      description: "second",
      prompt: "p2",
      allowedTools: ["read"],
    });
    const r = loadUserSkillsFromDir(dir, BUILTIN);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].description).toBe("first");
    expect(r.errors[0].reason).toMatch(/duplicate/i);
  });
});

describe("validateManifest", () => {
  const baseValid = {
    name: "valid-name",
    description: "test",
    prompt: "go",
    allowedTools: ["read"],
  };

  it("valid → ok", () => {
    const r = validateManifest(baseValid, BUILTIN);
    expect(r.ok).toBe(true);
  });

  it("非对象根 → fail", () => {
    expect(validateManifest("string", BUILTIN).ok).toBe(false);
    expect(validateManifest(null, BUILTIN).ok).toBe(false);
    expect(validateManifest([], BUILTIN).ok).toBe(false);
  });

  it("name 格式不合法 → fail", () => {
    const r = validateManifest({ ...baseValid, name: "1bad" }, BUILTIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/name/);
  });

  it("缺 description → fail", () => {
    const r = validateManifest({ ...baseValid, description: "" }, BUILTIN);
    expect(r.ok).toBe(false);
  });

  it("allowedTools 含非法工具 → fail", () => {
    const r = validateManifest(
      { ...baseValid, allowedTools: ["read", "rm-rf"] },
      BUILTIN
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invalid tool/);
  });

  it("allowedTools 空 → fail", () => {
    const r = validateManifest({ ...baseValid, allowedTools: [] }, BUILTIN);
    expect(r.ok).toBe(false);
  });

  it("signature 不完整（缺 algo）→ fail", () => {
    const r = validateManifest(
      {
        ...baseValid,
        signature: { publicKey: "x", value: "y" },
      },
      BUILTIN
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/signature/);
  });

  it("signature 完整 → ok 并保留", () => {
    const r = validateManifest(
      {
        ...baseValid,
        signature: { algo: "ed25519", publicKey: "x", value: "y" },
      },
      BUILTIN
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.signature?.algo).toBe("ed25519");
  });

  it("version 非法（< 1 或非数字）→ fail", () => {
    expect(validateManifest({ ...baseValid, version: 0 }, BUILTIN).ok).toBe(false);
    expect(validateManifest({ ...baseValid, version: "1" }, BUILTIN).ok).toBe(false);
  });

  // #81 commands[] 校验
  it("#81 commands 数组合法 → ok 并保留", () => {
    const r = validateManifest(
      {
        ...baseValid,
        commands: [
          { name: "/lint", summary: "run lint mode" },
          { name: "/lint-fix" },
        ],
      },
      BUILTIN
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.commands).toEqual([
        { name: "/lint", summary: "run lint mode" },
        { name: "/lint-fix", summary: undefined },
      ]);
    }
  });

  it("#81 command name 缺 / 前缀 → fail", () => {
    const r = validateManifest({ ...baseValid, commands: [{ name: "lint" }] }, BUILTIN);
    expect(r.ok).toBe(false);
  });

  it("#81 command name 含非法字符（如空格 / 特殊符号）→ fail", () => {
    const r = validateManifest({ ...baseValid, commands: [{ name: "/lint fix" }] }, BUILTIN);
    expect(r.ok).toBe(false);
  });

  it("#81 commands 不是数组 → fail", () => {
    const r = validateManifest({ ...baseValid, commands: "not-an-array" }, BUILTIN);
    expect(r.ok).toBe(false);
  });

  it("#81 commands 空数组 → ok 但 commands undefined", () => {
    const r = validateManifest({ ...baseValid, commands: [] }, BUILTIN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.commands).toBeUndefined();
  });
});
