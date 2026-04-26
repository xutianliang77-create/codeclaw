/**
 * Skill CLI 单测 · #85
 *   覆盖 install / remove 的 happy + 错误路径；list 走真实 registry 不重测
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

import { runSkillSubcommand, listInstalledSkillNames } from "../../../src/cli/skill-cli";

const tempDirs: string[] = [];
let originalHome: string | undefined;

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function setupHome(): string {
  if (originalHome === undefined) originalHome = process.env.HOME;
  const homeOverride = mkdtempSync(path.join(os.tmpdir(), "codeclaw-skill-cli-home-"));
  tempDirs.push(homeOverride);
  process.env.HOME = homeOverride;
  return homeOverride;
}

function makeValidSkill(_skillsParent: string, name = "lint-fix"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-skill-src-"));
  tempDirs.push(dir);
  writeFileSync(
    path.join(dir, "manifest.yaml"),
    yaml.dump({
      name,
      description: "auto fix lint",
      prompt: "Run lint and fix",
      allowedTools: ["read", "write", "bash"],
    })
  );
  return dir;
}

describe("runSkillSubcommand · install", () => {
  it("装合法 skill → 0 + 文件落到 ~/.codeclaw/skills/<name>/", () => {
    const home = setupHome();
    const src = makeValidSkill(home);
    const exitCode = runSkillSubcommand(["install", src]);
    expect(exitCode).toBe(0);
    const target = path.join(home, ".codeclaw", "skills", "lint-fix");
    expect(existsSync(path.join(target, "manifest.yaml"))).toBe(true);
  });

  it("路径不存在 → 退出码 2", () => {
    setupHome();
    expect(runSkillSubcommand(["install", "/nonexistent/path"])).toBe(2);
  });

  it("缺 manifest.yaml → 2", () => {
    setupHome();
    const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-no-manifest-"));
    tempDirs.push(dir);
    expect(runSkillSubcommand(["install", dir])).toBe(2);
  });

  it("manifest 校验失败（与 builtin 重名）→ 2", () => {
    const _home = setupHome();
    void _home;
    const dir = mkdtempSync(path.join(os.tmpdir(), "codeclaw-bad-name-"));
    tempDirs.push(dir);
    writeFileSync(
      path.join(dir, "manifest.yaml"),
      yaml.dump({
        name: "review", // 与 builtin 重名
        description: "fake",
        prompt: "fake",
        allowedTools: ["read"],
      })
    );
    expect(runSkillSubcommand(["install", dir])).toBe(2);
  });

  it("已装的 skill 重复装 → 2 + 提示先 remove", () => {
    const home = setupHome();
    const src = makeValidSkill(home);
    runSkillSubcommand(["install", src]);
    expect(runSkillSubcommand(["install", src])).toBe(2);
  });

  it("缺 path 参数 → 2", () => {
    setupHome();
    expect(runSkillSubcommand(["install"])).toBe(2);
  });
});

describe("runSkillSubcommand · remove", () => {
  it("装后再 remove → 0 + 目录消失", () => {
    const home = setupHome();
    const src = makeValidSkill(home);
    runSkillSubcommand(["install", src]);
    expect(runSkillSubcommand(["remove", "lint-fix"])).toBe(0);
    const target = path.join(home, ".codeclaw", "skills", "lint-fix");
    expect(existsSync(target)).toBe(false);
  });

  it("移 builtin 名称（review）→ 2 拒绝", () => {
    setupHome();
    expect(runSkillSubcommand(["remove", "review"])).toBe(2);
  });

  it("不存在的 skill → 2", () => {
    setupHome();
    expect(runSkillSubcommand(["remove", "no-such-skill"])).toBe(2);
  });
});

describe("runSkillSubcommand · list / help / unknown", () => {
  it("list 不抛错（即便 ~/.codeclaw/skills 不存在）", () => {
    setupHome();
    expect(runSkillSubcommand(["list"])).toBe(0);
  });

  it("无参数 = list", () => {
    setupHome();
    expect(runSkillSubcommand([])).toBe(0);
  });

  it("help → 0", () => {
    setupHome();
    expect(runSkillSubcommand(["help"])).toBe(0);
    expect(runSkillSubcommand(["--help"])).toBe(0);
  });

  it("未知子命令 → 2", () => {
    setupHome();
    expect(runSkillSubcommand(["delete-everything"])).toBe(2);
  });
});

describe("listInstalledSkillNames", () => {
  it("空目录 → []", () => {
    const home = setupHome();
    expect(listInstalledSkillNames(path.join(home, ".codeclaw", "skills"))).toEqual([]);
  });

  it("装过 → 返回名字数组", () => {
    const home = setupHome();
    const src = makeValidSkill(home);
    runSkillSubcommand(["install", src]);
    expect(listInstalledSkillNames(path.join(home, ".codeclaw", "skills"))).toContain("lint-fix");
  });
});
